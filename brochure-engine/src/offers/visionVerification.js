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
  evaluateBusinessAcceptance,
} from './businessAcceptance.js';
import {
  visionVerificationFingerprint,
  visionVerificationFingerprintHash,
} from '../storage/visionVerificationStore.js';

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
