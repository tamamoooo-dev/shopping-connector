// offers/visionVerification.js — stage-two repeated Vision verification.

import {
  canonicalRowFromResult,
  DEFAULT_MODEL,
  extractWithFailover,
} from './enrich.js';
import { EXTRACTION_STRATEGIES } from './smartExtraction.js';
import { DEFAULT_IDENTITY_NORMALIZATION_MODE } from './identityBuilder.js';
import {
  classifyMistral429,
  classifyMistralError,
  createKeyChain,
  mistralErrorDetails,
} from './mistralKeys.js';
import {
  BUSINESS_ACCEPTANCE_VERSION,
  evaluateBusinessAcceptance,
} from './businessAcceptance.js';
import {
  visionVerificationFingerprint,
  visionVerificationFingerprintHash,
} from '../storage/visionVerificationStore.js';
import { CORROBORATION_FLOOR } from './servingFloor.js';

// RE-JUDGE STORED EVIDENCE (2026-10-09). A rule change must not cost a new
// model call for a crop that was already read: when the admission contract
// moves (business-acceptance-v5 admits a validated Arabic-only name), the
// newest stored read of the CURRENT crop is judged again under the current
// rule first. Pure: returns `{ row, acceptance, validation, key }` for a read
// that now passes, else null. A flagged offer is never re-judged — the flag
// says its stored read is the suspect.
export function rejudgeStoredAttempt(record, item) {
  const candidate = record?.candidate;
  if (!candidate || item?.flagged) return null;
  if (record.crop_url && item?.imageUrl && record.crop_url !== item.imageUrl) return null;
  const validation = record.validation || {};
  const acceptedFields = Array.isArray(validation.acceptedFields) ? validation.acceptedFields : [];
  // validatedExtractionCorroboration, replayed: English keeps its stored
  // verdict; an Arabic-only read is admitted by S3's accepted `name_ar`.
  const corroboration = candidate.name != null
    ? candidate.corroboration ?? null
    : candidate.name_ar != null && acceptedFields.includes('name_ar') ? 1 : null;
  const row = { ...candidate, corroboration };
  const acceptance = evaluateBusinessAcceptance({
    offer: item,
    acceptedFields,
    structured: candidate.structured_product ?? null,
    observation: candidate.structured_product ? null : candidate.extraction_json ?? null,
  });
  const passes = (row.name != null || row.name_ar != null)
    && acceptance.accepted
    && Number(row.corroboration) >= CORROBORATION_FLOOR;
  return passes ? { row, acceptance, validation, key: record.key || null } : null;
}

// The newest passing stored read of one queue item, or null.
export async function findRejudgeableAttempt(verificationHistoryStore, item) {
  if (!verificationHistoryStore?.readAttempts || item?.flagged) return null;
  const records = await verificationHistoryStore.readAttempts(item.offerId, { limit: 4 });
  for (const record of records) {
    const rejudged = rejudgeStoredAttempt(record, item);
    if (rejudged) return rejudged;
  }
  return null;
}

// Commit a re-judged read through the normal Stage 2 boundary. No read
// happened, so the read count is left as it was.
async function commitRejudged({ enrichStore }, item, token, rejudged) {
  const attemptedAt = new Date().toISOString();
  const fingerprint = visionVerificationFingerprint(rejudged.row);
  return enrichStore.saveVisionVerificationOutcome({
    fence: { offerId: item.offerId, token, at: attemptedAt },
    priorFingerprintHashes: [...(item.fingerprintHashes || [])],
    attempt: {
      offerId: item.offerId,
      source: 'vision-verification-rejudge',
      validation: rejudged.validation,
      accepted: true,
      attemptedAt,
    },
    candidateRow: { ...rejudged.row, enriched_at: attemptedAt },
    fingerprint,
    fingerprintHash: await visionVerificationFingerprintHash(fingerprint),
    nextAttemptNo: Math.max(1, Number(item.attempts) || 1),
    acceptance: rejudged.acceptance,
  });
}

// The backlog pass behind the ops `verification/rejudge` action: unsettled
// items — past the read cap too, since a re-judge is free — whose stored read
// now passes are published with ZERO model calls. A dry run reports what would
// publish and writes nothing. Paged: pass the returned `nextCursor` as
// `after` until it is null.
export async function rejudgeVerificationBacklog(
  { verificationStore, verificationHistoryStore, enrichStore },
  { currentOn, limit = 50, dryRun = true, after = '' } = {},
) {
  const report = { scanned: 0, passing: 0, published: 0, skipped: 0, staleClaims: 0, errors: [], samples: [], nextCursor: null };
  if (!verificationStore || !(await verificationStore.ready())) return { ...report, unavailable: true };
  const pending = verificationStore.listRejudgeCandidates
    ? await verificationStore.listRejudgeCandidates({ currentOn, limit, after })
    : await verificationStore.listPending({ currentOn, limit });
  report.scanned = pending.length;
  if (verificationStore.listRejudgeCandidates && pending.length >= Math.max(1, Math.min(Number(limit) || 50, 200))) {
    report.nextCursor = pending[pending.length - 1].offerId;
  }
  for (const item of pending) {
    try {
      const rejudged = await findRejudgeableAttempt(verificationHistoryStore, item);
      if (!rejudged) { report.skipped += 1; continue; }
      report.passing += 1;
      if (report.samples.length < 12) {
        report.samples.push({
          offerId: item.offerId,
          name: rejudged.row.name ?? null,
          nameAr: rejudged.row.name_ar ?? null,
          brand: rejudged.row.brand ?? null,
          size: rejudged.row.size ?? null,
        });
      }
      if (dryRun) continue;
      const token = await verificationStore.claim({ offerId: item.offerId });
      if (!token) { report.staleClaims += 1; continue; }
      const outcome = await commitRejudged({ enrichStore }, item, token, rejudged);
      if (outcome?.verified) report.published += 1;
    } catch (err) {
      if (err?.staleClaim) { report.staleClaims += 1; continue; }
      report.errors.push(String(err?.message || err).slice(0, 200));
    }
  }
  return report;
}

// THE AUTOMATIC RE-JUDGE SWEEP (2026-10-09). When the admission rule changes
// version, every unsettled queue row is re-judged ONCE against its stored
// read — in pages, from the Stage 2 coordinator, before any paid read. The
// cursor and totals live in one small object-store record, so the sweep
// resumes across fires, survives deploys, and runs exactly once per rule
// version: a future rule change re-judges stored evidence with no manual step.
export const REJUDGE_SWEEP_KEY = 'ops/vision-rejudge-sweep.json';
export const REJUDGE_SWEEP_PAGE = 200;

export async function runRejudgeSweep(stores, {
  objectStore,
  currentOn,
  version = BUSINESS_ACCEPTANCE_VERSION,
  limit = REJUDGE_SWEEP_PAGE,
  now = new Date(),
} = {}) {
  if (!objectStore?.get || !objectStore?.put) return { skipped: 'no-object-store' };
  const rec = await objectStore.get(REJUDGE_SWEEP_KEY).catch(() => null);
  let state = null;
  if (rec?.bytes) {
    try { state = JSON.parse(new TextDecoder().decode(rec.bytes)); } catch { state = null; }
  }
  if (state?.version === version && state.done) return { skipped: 'done', state };
  const resume = state?.version === version
    ? state
    : { version, cursor: '', scanned: 0, published: 0, errors: 0, startedAt: now.toISOString() };
  const report = await rejudgeVerificationBacklog(stores, {
    currentOn, limit, dryRun: false, after: resume.cursor || '',
  });
  if (report.unavailable) return { skipped: 'unavailable' };
  const next = {
    version,
    startedAt: resume.startedAt,
    updatedAt: now.toISOString(),
    cursor: report.nextCursor,
    // A page with errors still advances: its rows stay unsettled, and the
    // drain re-judges the due ones before reading them anyway.
    done: !report.nextCursor,
    pages: (Number(resume.pages) || 0) + 1,
    scanned: (Number(resume.scanned) || 0) + report.scanned,
    published: (Number(resume.published) || 0) + report.published,
    errors: (Number(resume.errors) || 0) + report.errors.length,
  };
  await objectStore.put(REJUDGE_SWEEP_KEY, new TextEncoder().encode(JSON.stringify(next)), {
    contentType: 'application/json',
  });
  return { ...report, state: next };
}

function finish(report, chain) {
  report.failedOver = chain?.failedOver?.() || false;
  report.keyUsage = chain?.snapshot?.() || [];
  report.finishedAt = new Date().toISOString();
  return report;
}

export async function drainVisionVerification(
  {
    verificationStore,
    verificationHistoryStore,
    enrichStore,
    mistralKey,
    mistralKeyBackup,
    keyChain,
  },
  {
    limit = 15,
    currentOn,
    model = DEFAULT_MODEL,
    identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE,
    fetchImpl = fetch,
    maxRateRetries = 3,
    offerIds = null,
  } = {},
) {
  const report = {
    startedAt: new Date().toISOString(),
    scanned: 0,
    attempted: 0,
    verified: 0,
    unmatched: 0,
    rejudged: 0,
    failed: 0,
    staleClaims: 0,
    providerLimit: null,
    providerError: null,
    errors: [],
    visionRequests: 0,
    failedOver: false,
    keyUsage: [],
  };
  if (!verificationStore || !(await verificationStore.ready())) {
    report.unavailable = true;
    report.reason = 'vision_verification_migration_missing';
    return finish(report, keyChain);
  }
  if (!enrichStore || typeof enrichStore.saveVisionVerificationOutcome !== 'function') {
    throw new Error('Vision verification commit boundary is unavailable');
  }

  const chain = keyChain || createKeyChain([mistralKey, mistralKeyBackup]);
  const pending = Array.isArray(offerIds)
    ? await verificationStore.listPendingByIds({ ids: offerIds, currentOn })
    : await verificationStore.listPending({ currentOn, limit });
  report.scanned = pending.length;

  for (const item of pending) {
    const token = await verificationStore.claim({ offerId: item.offerId });
    if (!token) continue;
    try {
      // Stored evidence first: a read that passes the current rule is
      // published without a new model call.
      const rejudged = await findRejudgeableAttempt(verificationHistoryStore, item).catch(() => null);
      if (rejudged) {
        const outcome = await commitRejudged({ enrichStore }, item, token, rejudged);
        report.rejudged += 1;
        if (outcome?.verified) report.verified += 1;
        else report.unmatched += 1;
        continue;
      }
      const observed = await extractWithFailover(
        {
          id: item.offerId,
          name: null,
          nameAr: null,
          imageUrl: item.imageUrl,
        },
        {
          keyChain: chain,
          model,
          strategy: EXTRACTION_STRATEGIES.VISION_ONLY,
          fetchImpl,
          maxRateRetries,
        },
      );
      if (!observed) throw new Error('Offer crop was unavailable');
      const { crop, result } = observed;
      report.visionRequests += Number(result?.diagnostics?.visionRequests || 0);
      const validation = result.diagnostics.validationResult;
      const attemptedAt = new Date().toISOString();
      const candidateRow = canonicalRowFromResult(item.offerId, crop, result, {
        model,
        identityNormalizationMode,
        enrichedAt: attemptedAt,
        commerceContext: item,
      });
      const fingerprint = visionVerificationFingerprint(candidateRow);
      const fingerprintHash = await visionVerificationFingerprintHash(fingerprint);
      // Backlog compatibility: pre-v4 queue hashes included Arabic and raw
      // size. When the quarantined Stage-1 row still exists, rebuild that first
      // observation under the current English+brand+count contract so the next
      // matching read can verify immediately. New rows already carry v4 hashes.
      const priorFingerprintHashes = [...(item.fingerprintHashes || [])];
      if (item.initialCandidate) {
        const initialHash = await visionVerificationFingerprintHash(item.initialCandidate);
        if (initialHash && !priorFingerprintHashes.includes(initialHash)) {
          priorFingerprintHashes.push(initialHash);
        }
      }
      const accepted = !!candidateRow?.corroboration;
      const acceptance = evaluateBusinessAcceptance({
        offer: item,
        acceptedFields: validation.acceptedFields || [],
        structured: candidateRow?.structured_product ?? null,
        observation: candidateRow?.extraction_json ?? null,
      });
      const attemptNo = item.attempts + 1;
      const attempt = {
        offerId: item.offerId,
        source: 'vision-verification',
        output: result.diagnostics.visionOutput,
        validation,
        confidence: result.confidence,
        model,
        cropUrl: crop.cropUrl,
        accepted,
        attemptedAt,
      };
      if (verificationHistoryStore) {
        if (!verificationHistoryStore.available) {
          throw new Error('Vision Verification R2 history is unavailable');
        }
        await verificationHistoryStore.recordAttempt({
          offerId: item.offerId,
          initialOutcome: item.initialOutcome,
          attemptNo,
          fingerprint,
          fingerprintHash,
          candidateRow,
          attempt,
          token,
        });
      }
      const outcome = await enrichStore.saveVisionVerificationOutcome({
        fence: { offerId: item.offerId, token, at: attemptedAt },
        priorFingerprintHashes,
        attempt,
        candidateRow,
        fingerprint,
        fingerprintHash,
        nextAttemptNo: attemptNo,
        acceptance,
      });
      report.attempted += 1;
      if (outcome?.verified) report.verified += 1;
      else report.unmatched += 1;
    } catch (err) {
      if (err?.staleClaim) {
        report.staleClaims += 1;
        continue;
      }
      report.failed += 1;
      report.errors.push(String(err?.message || err).slice(0, 200));
      if (err?.rateLimit) report.providerLimit = {
        ...err.rateLimit,
        category: err.mistralCategory || err.rateLimit.category || classifyMistral429(err),
      };
      report.providerError = mistralErrorDetails(err);
      await verificationStore.release(item.offerId, {
        token,
        error: err?.message || String(err),
      }).catch(() => {});
      const kind = classifyMistralError(err);
      if (kind === 'auth' || kind === 'rate' || kind === 'restriction' || kind === 'transient') break;
    }
  }
  return finish(report, chain);
}
