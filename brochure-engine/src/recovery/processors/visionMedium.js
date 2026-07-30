// recovery/processors/visionMedium.js — re-read the crop with Vision MEDIUM.
//
// WHY THIS EXISTS, measured 2026-07-30 against the production queue (4,107
// current items, all blocked on `comparable_quantity`):
//
//   • OCR is not the tool for this defect and cannot be tuned into it. Across
//     256 stored OCR attempts the `size` field came back **Missing 210 times,
//     Accepted 45, Rejected 1**. One rejection in 256 means there is no
//     validation headroom to recover — the OCR markdown simply carries no size
//     candidate. Retained per C-6 as the cheapest processor; it is just aimed at
//     a defect it cannot see.
//
//   • Every queued item was extracted by a SMALL model — 5,095 by
//     `mistral-small-2603`, 1,758 by `mistral-small-latest`, 16 by Medium. The
//     backlog is not a Medium-failure backlog: Medium has never read these
//     crops. See [[vision-model-selection-policy]] — the selector is armed to
//     Small, and Small is the model the project REJECTED on measurement.
//
// So this processor is not a better guess at the same evidence; it is the first
// look by the frozen baseline model at crops only a rejected model has seen.
//
// ⚠️ IT PINS ITS OWN MODEL, AND MUST. `processorContext` in ops/console.js
// forwards the armed Vision selection as `ctx.model`, which in production is
// `mistral-small-2603`. A processor whose entire identity IS the model must not
// let the selector redefine it — reading `ctx.model` here would silently make
// "run Medium recovery" mean "run Small again", and the report would claim a
// Medium pass that never happened. `ctx.model` is deliberately ignored;
// `ctx.recoveryModel` is the only override, so a future operator can move the
// rung to a newer model without touching the primary selector.
//
// WHAT KEEPS IT INSIDE C-7 WITHOUT THE RUNNER HAVING TO REFUSE IT. A fresh
// Medium read of a whole crop will routinely disagree with Small on name and
// brand, and a canonical row carrying Medium's name would be an accepted-field
// overwrite — the runner's commit boundary would refuse the write and record a
// `failed` attempt, so a naive full-re-read processor would spend Medium money
// and recover nothing. Instead this merges exactly as ocr.js does: the PERSISTED
// prior attempt is authoritative and Medium occupies the gap-filling slot, so
// Medium can only complete fields the prior rung did not have accepted. The
// runner's C-7 check then passes by construction rather than by luck.
//
// THE COST OF REUSING THE GAP-FILLING SLOT, stated rather than hidden: that slot
// is named `ocr*` throughout smartExtraction.js, so a field Medium fills is
// labelled provenance `OCR` in the merge diagnostics. That is a naming
// inaccuracy, and it is the deliberate price of changing nothing in the
// extraction core — `validatedExtractionCorroboration` resolves provenance
// against exactly two accepted-field sets (Vision, OCR), so inventing a third
// label would make every Medium-filled name NON-SERVABLE. The truth is recorded
// where it is queryable anyway: the attempt journal carries
// `source='vision-medium'` with `model='mistral-medium-latest'`, and the
// enrichment's `model` column becomes `<prior>+mistral-medium-latest`, the same
// shape that makes `mistral-small-2603+mistral-ocr-latest` calibratable today.
//
// WHAT THIS FILE MAY NOT DO, and does not — identical to every processor:
// decide whether it is allowed to run (C-8), decide whether it succeeded (only
// S4 closes an item, C-9), or protect accepted fields (the runner's commit
// boundary does, C-7).

import {
  canonicalRowFromResult,
  extractWithFailover,
} from '../../offers/enrich.js';
import {
  EXTRACTION_STRATEGIES,
  EXTRACTION_PROVENANCE,
  finalizeValidatedExtraction,
} from '../../offers/smartExtraction.js';
import {
  DEFAULT_IDENTITY_NORMALIZATION_MODE,
  normalizeIdentityMode,
} from '../../offers/identityBuilder.js';
import { defineProcessor, RECOVERY_KIND } from '../registry.js';

export const VISION_MEDIUM_PROCESSOR_ID = 'vision-medium';

// The FROZEN production baseline (2026-07-25): mistral-medium-latest + Verbatim
// Prompt + Expanded JSON. Named here as a constant rather than imported from
// enrich.js's DEFAULT_MODEL because the two are independent facts that merely
// happen to coincide: DEFAULT_MODEL is "what the primary path runs absent a
// stored selection", this is "the model this rung IS". If the primary default
// ever moves, this rung must not move with it silently.
export const RECOVERY_VISION_MODEL = 'mistral-medium-latest';

/** True when a prior attempt already used a Medium-class model. */
function alreadyMedium(model) {
  return typeof model === 'string' && model.toLowerCase().includes('medium');
}

export default defineProcessor({
  id: VISION_MEDIUM_PROCESSOR_ID,
  label: 'Vision Medium',
  description:
    'Re-reads the crop with the frozen baseline Vision model (mistral-medium-latest) and '
    + 'completes only the fields the primary read left unaccepted. Aimed at the size / '
    + 'comparable-quantity failures that OCR measurably cannot see.',
  kind: RECOVERY_KIND.MACHINE,
  provenance: EXTRACTION_PROVENANCE.VISION,
  // ADVISORY ONLY (registry.js): orders operator choices and reads
  // effectiveness, never gates a run. Whether Medium actually recovers these is
  // answered by missing_before/after, not by this list.
  addresses: ['comparable_quantity', 'english_name'],
  // One vision request per offer, on the medium tier — materially dearer than
  // the OCR rung, which is exactly why C-8 leaves the spend to the operator.
  costHint: { per: 'offer', requests: 1, tier: 'vision-medium' },
  // Reuses the EXISTING vision credential (the mistral-medium pool), so adding
  // this rung costs no console change at all — the C-9 property at its
  // strongest: one module plus one registry line.
  credential: 'vision',

  // PRECONDITIONS THIS PROCESSOR OWNS (C-9).
  //   • a crop to read
  //   • a persisted prior vision attempt — it is the authoritative half of the
  //     merge, and §6 S6 forbids re-reading an earlier rung's model, so the
  //     prior observation is replayed from the journal and never re-requested
  //   • the prior read was NOT already Medium. Paying Medium twice for the same
  //     crop cannot produce new evidence, and the 16 Medium-extracted items
  //     sitting in the queue are precisely the ones for which no model has an
  //     answer. They belong to the human rung, or to nobody.
  supports: (item) => {
    const prior = item?.attemptsBySource?.vision;
    return !!item?.offer?.image_url && !!prior && !alreadyMedium(prior.model);
  },

  async run(item, ctx = {}) {
    const {
      keyChain,
      fetchImpl = fetch,
      // NOT `ctx.model` — see the header. The armed selector must not be able to
      // redefine what this rung is.
      recoveryModel = RECOVERY_VISION_MODEL,
      identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE,
      maxRateRetries = 0,
    } = ctx;

    // DECLINE, never throw, on a missing credential — a configuration state, not
    // a failure of this offer. Throwing would burn the item's attempt budget and
    // back it off for hours over something no retry can fix. `hasKeys()` matters
    // as much as the null check: a chain built from absent env vars is a real
    // object holding nothing.
    if (!keyChain || keyChain.hasKeys?.() === false) {
      return { declined: true, error: 'no Vision credential bound' };
    }

    const prior = item.attemptsBySource.vision;

    // VISION_ONLY: one read, at the model this rung names. The strategy matters
    // — VISION_FIRST would let a failed validation trigger an OCR call this rung
    // never asked for and whose cost it would not report.
    const observed = await extractWithFailover(
      { id: item.offerId, name: null, nameAr: null, imageUrl: item.offer.image_url },
      {
        keyChain,
        model: recoveryModel,
        strategy: EXTRACTION_STRATEGIES.VISION_ONLY,
        fetchImpl,
        maxRateRetries,
      },
    );
    if (!observed) throw new Error('Offer crop was unavailable');
    const { crop, result: mediumResult } = observed;

    const mediumOutput = mediumResult.diagnostics.visionOutput;
    const mediumValidation = mediumResult.diagnostics.validationResult;

    // THE MERGE. Prior attempt in the authoritative slot, Medium in the
    // gap-filling slot — the same call ocr.js makes, with a vision-shaped
    // validation in the second position. `mergeValidatedExtractions` reads only
    // `.fields[f].status/.value`, `.acceptedFields` and `.confidence` from that
    // slot, all of which a vision validation carries, so no core change is
    // needed for a vision observation to fill gaps.
    //
    // `visionRequests: 0` is honest and load-bearing: the prior observation was
    // REPLAYED from the journal, not paid for again. The single request this
    // rung actually made is reported as the second-slot request, which is also
    // what makes `extractionModel()` stamp `<prior>+mistral-medium-latest`.
    const result = finalizeValidatedExtraction({
      strategy: EXTRACTION_STRATEGIES.VISION_FIRST,
      visionOutput: prior.output,
      visionValidation: prior.validation,
      ocrOutput: mediumOutput,
      ocrValidation: mediumValidation,
      visionRequests: 0,
      ocrRequests: mediumResult.diagnostics.visionRequests || 1,
      visionAttemptPresent: true,
      ocrAttemptPresent: true,
      processingTimeMs: mediumResult.diagnostics.processingTimeMs,
    });

    const attemptedAt = new Date().toISOString();
    const canonicalRow = canonicalRowFromResult(item.offerId, crop, result, {
      model: prior.model || null,
      ocrModel: recoveryModel,
      identityNormalizationMode: normalizeIdentityMode(identityNormalizationMode),
      enrichedAt: attemptedAt,
      commerceContext: item.offer,
    });

    return {
      canonicalRow,
      attempt: {
        offerId: item.offerId,
        // The processor id IS the journal source (C-9). Writable only because
        // S5.0 removed the `source` CHECK — see
        // migrate-2026-07-27-extraction-source-open.sql.
        source: VISION_MEDIUM_PROCESSOR_ID,
        output: mediumOutput,
        validation: mediumValidation,
        confidence: mediumResult.confidence,
        model: recoveryModel,
        cropUrl: crop.cropUrl,
        accepted: (mediumValidation.acceptedFields || []).length > 0,
        attemptedAt,
      },
      cost: { requests: mediumResult.diagnostics.visionRequests || 1, tier: 'vision-medium' },
    };
  },
});
