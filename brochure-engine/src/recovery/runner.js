// recovery/runner.js — the generic queue processor loop (C-8, C-9).
//
// One runner, every processor, forever. It contains no knowledge of any
// particular processor and gains none when one is added: it takes a descriptor,
// asks the queue for work, and enforces the guarantees a processor is not
// allowed to be trusted with.
//
//   claim (lease) -> processor.run() -> COMMIT BOUNDARY -> S4 re-judge -> close
//
// THE TWO GUARANTEES THAT LIVE HERE AND NOT IN PROCESSORS (C-9):
//
//  1. ACCEPTED-FIELD IMMUTABILITY (C-7). A machine processor may not overwrite a
//     field an earlier machine rung accepted; the human rung may. Checked below
//     against the persisted attempt journal, INDEPENDENTLY of whatever merge
//     logic the processor used internally. If every processor had to implement
//     this itself, one eventually would not — and the failure is silent, since
//     an overwritten good field looks exactly like a recovered one.
//
//  2. ONLY S4 CLOSES AN ITEM. A processor reports what it produced; it never
//     reports success. The runner re-runs the gate on the result and closes the
//     item only when the offer is genuinely a servable canonical product. This
//     is what makes the closure condition identical for every processor that
//     will ever exist, and it is why a processor cannot flatter itself.
//
// MANUAL vs AUTO IS NOT VISIBLE HERE, by design (C-8). Both modes call this
// same function; they differ only in who supplied `offerIds` — an operator
// dispatching explicitly, or an armed policy draining. The spend decision is
// made before this function is entered and is never re-litigated inside it.

import {
  RECOVERY_OUTCOME,
  RECOVERY_STATUS,
  DECLINE_BACKOFF_MINUTES,
  isStaleClaimError,
} from '../storage/recoveryQueue.js';
import { RECOVERY_KIND } from './registry.js';
import { servable, recoveryAdmission } from '../offers/enrich.js';
import { evaluateBusinessAcceptance } from '../offers/businessAcceptance.js';

// S3 validation field -> canonical enrichment column. Extraction vocabulary,
// not processor vocabulary, so it belongs at the boundary. `pack_count` has no
// canonical column and is intentionally absent rather than mapped to nothing.
const FIELD_TO_COLUMN = Object.freeze({
  name_en: 'name',
  name_ar: 'name_ar',
  brand: 'brand',
  size: 'size',
});

/**
 * C-7 at the boundary. Compares the proposed canonical row against every field
 * an earlier attempt recorded as Accepted, using the persisted journal as the
 * source of truth.
 *
 * Returns the violations rather than throwing: a violation is a processor bug,
 * and the right response is to refuse the write, record a `failed` attempt with
 * the evidence, and leave the item queued — not to abort the whole drain and
 * lose the other items in it.
 */
export function acceptedFieldViolations(item, canonicalRow) {
  const violations = [];
  for (const attempt of Object.values(item?.attemptsBySource || {})) {
    for (const field of attempt?.validation?.acceptedFields || []) {
      const column = FIELD_TO_COLUMN[field];
      if (!column) continue;
      const prior = attempt?.validation?.fields?.[field]?.value;
      if (prior == null) continue;
      const next = canonicalRow?.[column];
      // A processor CLEARING an accepted field is not an overwrite — the merge
      // simply had nothing to say — so only a differing non-null value counts.
      if (next != null && String(next) !== String(prior)) {
        violations.push({ field, source: attempt.source, prior, next });
      }
    }
  }
  return violations;
}

/**
 * Run one processor over the queue.
 *
 * `processor.run(item, ctx)` must resolve to:
 *   { canonicalRow?, attempt?, cost?, providerLimit?, declined?, error? }
 * — what it produced, never whether it succeeded. `declined: true` means the
 * processor ran and refused (no credential, nothing to work with); a thrown
 * error means it failed. Neither closes the item.
 */
export async function runRecovery(
  { queue, processor, enrichStore, ctx = {} },
  {
    limit = 10,
    currentOn,
    offerIds = null,
    maxAttemptsPerItem = 2,
    leaseMs,
    now = () => new Date(),
  } = {},
) {
  const startedAt = new Date().toISOString();
  const report = {
    processor: processor.id,
    startedAt,
    scanned: 0,
    unsupported: 0,
    attempted: 0,
    recovered: 0,
    noChange: 0,
    declined: 0,
    failed: 0,
    exhausted: 0,
    blockedByImmutability: 0,
    staleClaims: 0,
    providerLimit: null,
    errors: [],
  };

  if (!(await queue.ready())) {
    report.unavailable = true;
    report.reason = 'recovery_queue_migration_missing';
    report.finishedAt = new Date().toISOString();
    return report;
  }

  // Explicit dispatch (Manual) selects items by id; a drain (Auto) takes the
  // ready set. `excludeProcessor` stops an Auto pass paying the same processor
  // twice for the same crop — generic, since the id is opaque.
  //
  // `null` AND `[]` ARE DIFFERENT ANSWERS. `null` is "you pick"; `[]` is "these
  // ones", answered with none. Collapsing them — the natural `if (offerIds?.length)`
  // — turns the narrowest possible instruction into the widest one, and the
  // widened version spends money on items the caller never named. An empty
  // explicit selection does nothing, which is what it asked for.
  let items;
  if (Array.isArray(offerIds)) {
    items = offerIds.length
      ? (await Promise.all(offerIds.map((id) => queue.get(id)))).filter(Boolean)
      : [];
  } else {
    items = await queue.list({ currentOn, limit, excludeProcessor: processor.id });
  }
  report.scanned = items.length;

  for (const candidate of items) {
    if (candidate.status === RECOVERY_STATUS.DISMISSED) continue;
    // `supports()` is PROCESSOR knowledge, asked here rather than pushed into
    // the queue's SQL (C-9). The cost of that separation is over-fetching a few
    // rows per pass; it is paid deliberately and is why the queue can stay
    // ignorant of what a crop is for.
    if (!processor.supports(candidate)) {
      report.unsupported += 1;
      continue;
    }
    // CLAIM BEFORE READING THE STATE YOU ACT ON. The listed snapshot was taken
    // before the lease existed, so between the two another worker may have
    // recovered the offer, an operator may have dismissed it, or a fresh
    // extraction may have re-enqueued it on new evidence. Acting on the stale
    // snapshot would re-run C-7 against the wrong journal and re-judge against
    // the wrong verdict. One extra read per item; recovery is measured in tens
    // of items per pass, not thousands.
    const token = await queue.claim({
      offerId: candidate.offerId, processor: processor.id, leaseMs, now: now(),
    });
    if (!token) continue;
    const item = (await queue.get(candidate.offerId)) || candidate;

    // Attempt budget, checked under the lease so a worker whose own lease has
    // expired cannot retire an item another worker is actively running.
    if (item.attempts >= maxAttemptsPerItem) {
      await queue.close(item.offerId, RECOVERY_STATUS.EXHAUSTED, { now: now(), token });
      report.exhausted += 1;
      continue;
    }

    const attemptStartedAt = now().toISOString();
    const missingBefore = item.verdict?.missing ?? null;
    let result = null;
    try {
      result = await processor.run(item, ctx);
    } catch (err) {
      report.failed += 1;
      report.errors.push(String(err?.message || err).slice(0, 200));
      if (err?.rateLimit) report.providerLimit = err.rateLimit;
      // Exponential backoff on the ITEM, matching the OCR queue's existing
      // ladder, so a persistently bad crop stops consuming the drain. A failure
      // is RETRYABLE: the item stays selectable and `attempts` is what bounds
      // it, which is only true because the attempt counter and the release
      // commit together below.
      const minutes = Math.min(360, 2 ** Math.min(item.attempts + 1, 8));
      await queue.recordAttempt({
        offerId: item.offerId,
        processor: processor.id,
        outcome: RECOVERY_OUTCOME.FAILED,
        missingBefore,
        error: err?.message,
        startedAt: attemptStartedAt,
        finishedAt: now().toISOString(),
        token,
        releaseAfter: {
          error: err?.message,
          retryAt: new Date(now().getTime() + minutes * 60_000).toISOString(),
          at: now().toISOString(),
        },
      });
      // A provider-level fault will hit every remaining item identically.
      if (err?.rateLimit || err?.stopDrain) break;
      continue;
    }

    if (result?.declined) {
      report.declined += 1;
      // A decline consumes no attempt (the processor never ran), so a cool-off
      // is the only thing bounding it. Without one, an unbound credential would
      // have every armed drain re-decline the same items forever.
      await queue.recordAttempt({
        offerId: item.offerId,
        processor: processor.id,
        outcome: RECOVERY_OUTCOME.DECLINED,
        missingBefore,
        error: result.error || null,
        startedAt: attemptStartedAt,
        finishedAt: now().toISOString(),
        token,
        releaseAfter: {
          error: result.error || null,
          retryAt: new Date(now().getTime() + DECLINE_BACKOFF_MINUTES * 60_000).toISOString(),
          at: now().toISOString(),
        },
      });
      continue;
    }

    // ---- COMMIT BOUNDARY ----------------------------------------------------
    const canonicalRow = result?.canonicalRow || null;
    const allowOverride = processor.kind === RECOVERY_KIND.HUMAN;
    const violations = allowOverride ? [] : acceptedFieldViolations(item, canonicalRow);
    if (violations.length) {
      // Structural refusal (C-7). The processor's own merge said this was fine;
      // the boundary disagrees, and the boundary wins.
      const detail = violations
        .map((v) => `${v.field}: '${v.prior}' -> '${v.next}' (accepted by ${v.source})`)
        .join('; ');
      report.blockedByImmutability += 1;
      report.failed += 1;
      report.errors.push(`accepted-field overwrite refused — ${detail}`);
      await queue.recordAttempt({
        offerId: item.offerId,
        processor: processor.id,
        outcome: RECOVERY_OUTCOME.FAILED,
        missingBefore,
        error: `C-7 accepted-field overwrite refused — ${detail}`,
        startedAt: attemptStartedAt,
        finishedAt: now().toISOString(),
        token,
        releaseAfter: { error: 'accepted_field_overwrite', at: now().toISOString() },
      });
      continue;
    }

    // ---- S4 RE-JUDGEMENT — the ONLY thing that closes an item ---------------
    // Re-run the gate on what the processor produced, exactly as the pipeline
    // ran it at S4. Same function, same three conditions: a recovered offer
    // must clear the same bar as one that never needed recovery.
    const acceptance = evaluateBusinessAcceptance({
      offer: item.offer,
      acceptedFields: result?.attempt?.validation?.acceptedFields || [],
      structured: canonicalRow?.structured_product ?? null,
      observation: canonicalRow ? null : (result?.observation ?? null),
    });
    const admission = recoveryAdmission({ canonicalRow, acceptance });
    const complete = admission.complete;
    const finishedAt = now().toISOString();

    // ONE TRANSACTION FOR THE WHOLE OUTCOME. Canonical row, re-judged verdict,
    // queue closure or release, AND the attempt journal all commit together,
    // fenced by the lease token. Split across calls, a Worker eviction between
    // them loses the cost/outcome record of work that was paid for — and the
    // canonical row that did land makes the item unselectable, so the loss is
    // permanent rather than merely delayed.
    const history = {
      offerId: item.offerId,
      processor: processor.id,
      outcome: complete ? RECOVERY_OUTCOME.RECOVERED : RECOVERY_OUTCOME.NO_CHANGE,
      missingBefore,
      // The after-state is recorded even when nothing was recovered — partial
      // progress ("price is still missing but the size resolved") is exactly the
      // signal that tells an operator which processor to pay for next.
      missingAfter: [...acceptance.missing],
      cost: result?.cost ?? null,
      actor: result?.actor ?? null,
      startedAt: attemptStartedAt,
      finishedAt,
    };
    const fence = { offerId: item.offerId, token, at: finishedAt };

    try {
      if (result?.attempt || canonicalRow) {
        await enrichStore.saveRecoveryOutcome({
          attempt: result.attempt,
          canonicalRow,
          acceptance,
          resolve: complete,
          fence,
          history,
          release: complete ? null : { at: finishedAt },
        });
      } else {
        // Nothing to persist about the extraction itself, but the outcome still
        // has to be recorded and the item still has to move.
        await queue.recordAttempt({
          ...history,
          token,
          releaseAfter: complete ? null : { at: finishedAt },
        });
        if (complete) {
          await queue.close(item.offerId, RECOVERY_STATUS.RESOLVED, { now: now(), token });
        }
      }
    } catch (err) {
      // THE FENCE FIRED: this worker's lease was taken while it was running, so
      // its result describes a state that no longer exists and the whole batch
      // rolled back. Not an error — it is the protection working. Someone else
      // owns the item; leave it entirely alone, including the release.
      if (isStaleClaimError(err)) {
        report.staleClaims += 1;
        continue;
      }
      throw err;
    }

    if (complete) {
      report.recovered += 1;
    } else {
      report.noChange += 1;
    }
    if (result?.providerLimit) report.providerLimit = result.providerLimit;
    report.attempted += 1;
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/**
 * AUTO drain. The single place the execution policy is consulted, and it is a
 * hard gate: a disarmed policy performs no work and, critically, makes no
 * provider call. Manual dispatch does not pass through here at all — it calls
 * runRecovery directly with explicit ids, because an operator choosing an item
 * IS the authorisation (C-8).
 */
export async function drainRecovery(
  { queue, registry, enrichStore, policy, ctx = {}, contextFor = null },
  { currentOn, now = () => new Date() } = {},
) {
  const report = {
    startedAt: new Date().toISOString(),
    mode: policy?.mode ?? 'manual',
    armed: !!policy?.armed,
    runs: [],
  };
  if (!policy?.armed) {
    report.skipped = true;
    // Named so an operator can tell "I never armed this" from "the thing I
    // armed no longer exists".
    report.reason = policy?.unknownProcessors?.length
      ? 'unknown_processors'
      : 'not_armed';
    report.finishedAt = new Date().toISOString();
    return report;
  }
  for (const id of policy.processors) {
    const processor = registry.get(id);
    if (!processor) continue;
    // CONTEXT IS BUILT PER PROCESSOR. A descriptor declares WHICH credential it
    // needs (registry.js), and the caller resolves that declaration to a key
    // chain — so one context reused across a multi-processor policy hands every
    // processor the first one's credentials. With a single processor armed that
    // is invisible; the moment a second is added it is a silent auth failure
    // that looks like a provider outage. `ctx` remains the single-processor
    // shorthand and the fallback when no resolver is supplied.
    const processorCtx = contextFor ? await contextFor(processor) : ctx;
    report.runs.push(await runRecovery(
      { queue, processor, enrichStore, ctx: processorCtx },
      {
        currentOn,
        limit: policy.maxItemsPerRun,
        maxAttemptsPerItem: policy.maxAttemptsPerItem,
        now,
      },
    ));
  }
  report.finishedAt = new Date().toISOString();
  return report;
}
