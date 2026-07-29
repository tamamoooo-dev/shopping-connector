// recovery/processors/ocr.js — the OCR recovery processor (C-6, C-8, C-9).
//
// THE FIRST REAL PLUG-IN, and the shape every later one should copy. It is
// deliberately thin: the extraction work is the SAME proven path
// `drainOcrEnrichment` has run in production since 2026-07-18, lifted here
// unchanged. What the port removes is everything that was never OCR's business —
// claiming, retry state, queue transitions, verdict re-judgement, closure — all
// of which now belong to the runner and are identical for every processor.
//
// Retained by explicit act (C-6): OCR is the cheapest processor, so it stays the
// sensible first drain whenever the operator does decide to spend.
//
// WHAT THIS FILE MAY NOT DO, and does not:
//   • decide whether it is allowed to run (execution policy, C-8)
//   • decide whether it succeeded (only S4 closes an item, C-9)
//   • protect accepted fields (the runner's commit boundary does, C-7) —
//     `finalizeValidatedExtraction` happens to enforce it internally too, and
//     that redundancy is fine: the boundary is what makes it a guarantee rather
//     than a property of this particular implementation.

import {
  DEFAULT_MODEL,
  DEFAULT_OCR_MODEL,
  canonicalRowFromResult,
  extractWithFailover,
} from '../../offers/enrich.js';
import {
  EXTRACTION_STRATEGIES,
  finalizeValidatedExtraction,
} from '../../offers/smartExtraction.js';
import {
  DEFAULT_IDENTITY_NORMALIZATION_MODE,
  normalizeIdentityMode,
} from '../../offers/identityBuilder.js';
import { defineProcessor, RECOVERY_KIND } from '../registry.js';

export const OCR_PROCESSOR_ID = 'ocr';

export default defineProcessor({
  id: OCR_PROCESSOR_ID,
  label: 'OCR',
  description:
    'Reads the crop with the OCR model and fills fields the primary extractor left missing. '
    + 'The cheapest processor, and the sensible first drain.',
  kind: RECOVERY_KIND.MACHINE,
  provenance: 'OCR',
  // ADVISORY ONLY (see registry.js): used to order operator choices and to read
  // effectiveness, never to gate a run. Whether OCR actually recovers these is
  // measured by missing_before/after, not asserted here.
  addresses: ['english_name', 'comparable_quantity'],
  costHint: { per: 'offer', requests: 1, tier: 'ocr' },
  // Declares WHAT it needs; the caller resolves it to a key chain. OCR keys are
  // rotated independently of the Vision ones (MISTRAL_OCR_API_KEY), which is
  // exactly why this is named rather than assumed.
  credential: 'ocr',

  // PRECONDITIONS THE PROCESSOR OWNS (C-9). These are exactly the conditions the
  // old `listPendingOcr` WHERE clause encoded in SQL — moved here so the queue
  // does not have to know that OCR needs a crop and a prior Vision read to merge
  // against. The runner over-fetches and filters; that is the cost of keeping
  // the queue agnostic, and it is the intended trade.
  supports: (item) => !!item?.offer?.image_url && !!item?.attemptsBySource?.vision,

  async run(item, ctx = {}) {
    const {
      keyChain,
      fetchImpl = fetch,
      model = DEFAULT_MODEL,
      ocrModel = DEFAULT_OCR_MODEL,
      identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE,
      maxRateRetries = 0,
    } = ctx;

    // DECLINE, never throw, when there is no credential. A missing OCR key is a
    // configuration state, not a failure of this offer: throwing would burn the
    // item's attempt budget and back it off for hours over something no retry
    // can fix. `drainOcrEnrichment` made the same distinction at the drain level
    // (`report.unavailable`); here it is per item, which is strictly better.
    // `hasKeys()` matters as much as the null check: a chain constructed from
    // absent env vars is a real object holding nothing, and the legacy drain's
    // `!mistralOcrKey && !keyChain` guard would have missed it here.
    if (!keyChain || keyChain.hasKeys?.() === false) {
      return { declined: true, error: 'no OCR credential bound' };
    }

    const prior = item.attemptsBySource.vision;
    const observed = await extractWithFailover(
      { id: item.offerId, name: null, nameAr: null, imageUrl: item.offer.image_url },
      {
        keyChain,
        ocrModel,
        strategy: EXTRACTION_STRATEGIES.OCR_ONLY,
        fetchImpl,
        maxRateRetries,
      },
    );
    if (!observed) throw new Error('Offer crop was unavailable');
    const { crop, result: ocrResult } = observed;

    // The merge, byte for byte as the production drain does it: the persisted
    // Vision attempt is replayed from the journal rather than re-read from the
    // model (§6 S6 — "never a re-read of an earlier rung's model").
    const result = finalizeValidatedExtraction({
      strategy: EXTRACTION_STRATEGIES.VISION_FIRST,
      visionOutput: prior.output,
      visionValidation: prior.validation,
      ocrOutput: ocrResult.diagnostics.ocrOutput,
      ocrValidation: ocrResult.diagnostics.ocrValidationResult,
      visionRequests: 0,
      ocrRequests: ocrResult.diagnostics.ocrRequests || 0,
      visionAttemptPresent: true,
      ocrAttemptPresent: true,
      processingTimeMs: ocrResult.diagnostics.processingTimeMs,
    });

    const attemptedAt = new Date().toISOString();
    const canonicalRow = canonicalRowFromResult(item.offerId, crop, result, {
      model: prior.model || model,
      ocrModel,
      identityNormalizationMode: normalizeIdentityMode(identityNormalizationMode),
      enrichedAt: attemptedAt,
      commerceContext: item.offer,
    });

    return {
      canonicalRow,
      attempt: {
        offerId: item.offerId,
        // The processor id IS the journal source (C-9). Unchanged from the
        // legacy path, which already wrote 'ocr' here — the id was always a
        // processor name; only the CHECK constraint pretending otherwise is gone.
        source: OCR_PROCESSOR_ID,
        output: ocrResult.diagnostics.ocrOutput,
        validation: ocrResult.diagnostics.ocrValidationResult,
        confidence: ocrResult.confidence,
        model: ocrModel,
        cropUrl: crop.cropUrl,
        accepted: ocrResult.diagnostics.ocrValidationResult.acceptedFields.length > 0,
        attemptedAt,
      },
      cost: { requests: ocrResult.diagnostics.ocrRequests || 0, tier: 'ocr' },
    };
  },
});
