// recovery/processors/visionSmallRetry.js — retry a rejected Small read once.
//
// This is the first rung of the automatic recovery ladder. It deliberately
// reuses the EXACT Small model recorded by the primary Vision attempt. The
// persisted primary observation remains authoritative; the retry may only fill
// fields that the first read did not accept. The queue journal makes the retry
// one-shot: once this processor records recovered/no_change, Auto excludes it
// for the current evidence generation and advances to the next configured rung.

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

export const VISION_SMALL_RETRY_PROCESSOR_ID = 'vision-small-retry';

function isSmall(model) {
  return typeof model === 'string' && model.toLowerCase().includes('small');
}

const ACCEPTED_FIELD_COLUMNS = Object.freeze({
  name_en: 'name',
  name_ar: 'name_ar',
  brand: 'brand',
  size: 'size',
});

// The recovery queue can contain accepted evidence from more than the primary
// Vision attempt (for example, an earlier OCR observation). The two-slot merge
// below protects the primary observation; this final overlay protects every
// accepted journal value before the runner enforces C-7 at the commit boundary.
function preserveAcceptedJournalFields(item, canonicalRow) {
  for (const attempt of Object.values(item?.attemptsBySource || {})) {
    for (const field of attempt?.validation?.acceptedFields || []) {
      const column = ACCEPTED_FIELD_COLUMNS[field];
      const value = attempt?.validation?.fields?.[field]?.value;
      if (column && value != null) canonicalRow[column] = value;
    }
  }
  return canonicalRow;
}

export default defineProcessor({
  id: VISION_SMALL_RETRY_PROCESSOR_ID,
  label: 'Vision Small Retry',
  description:
    'Retries the same Small model once and fills only fields the first Small read left unaccepted.',
  kind: RECOVERY_KIND.MACHINE,
  provenance: EXTRACTION_PROVENANCE.VISION,
  addresses: ['english_name', 'comparable_quantity'],
  costHint: { per: 'offer', requests: 1, tier: 'vision-small' },
  credential: 'vision-small',

  supports: (item) => {
    const prior = item?.attemptsBySource?.vision;
    return !!item?.offer?.image_url && !!prior && isSmall(prior.model);
  },

  async run(item, ctx = {}) {
    const {
      keyChain,
      fetchImpl = fetch,
      identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE,
      maxRateRetries = 0,
    } = ctx;
    if (!keyChain || keyChain.hasKeys?.() === false) {
      return { declined: true, error: 'no Small Vision credential bound' };
    }

    const prior = item.attemptsBySource.vision;
    const retryModel = prior.model;
    const observed = await extractWithFailover(
      { id: item.offerId, name: null, nameAr: null, imageUrl: item.offer.image_url },
      {
        keyChain,
        model: retryModel,
        strategy: EXTRACTION_STRATEGIES.VISION_ONLY,
        fetchImpl,
        maxRateRetries,
      },
    );
    if (!observed) throw new Error('Offer crop was unavailable');
    const { crop, result: retryResult } = observed;
    const retryOutput = retryResult.diagnostics.visionOutput;
    const retryValidation = retryResult.diagnostics.validationResult;

    // Keep fields accepted by the first read immutable. The retry occupies the
    // validated gap-filling slot, exactly like the later Medium/OCR rungs.
    const result = finalizeValidatedExtraction({
      strategy: EXTRACTION_STRATEGIES.VISION_FIRST,
      visionOutput: prior.output,
      visionValidation: prior.validation,
      ocrOutput: retryOutput,
      ocrValidation: retryValidation,
      visionRequests: 0,
      ocrRequests: retryResult.diagnostics.visionRequests || 1,
      visionAttemptPresent: true,
      ocrAttemptPresent: true,
      processingTimeMs: retryResult.diagnostics.processingTimeMs,
    });

    const attemptedAt = new Date().toISOString();
    const canonicalRow = preserveAcceptedJournalFields(item, canonicalRowFromResult(item.offerId, crop, result, {
      model: prior.model || null,
      ocrModel: retryModel,
      identityNormalizationMode: normalizeIdentityMode(identityNormalizationMode),
      enrichedAt: attemptedAt,
      commerceContext: item.offer,
    }));

    return {
      canonicalRow,
      attempt: {
        offerId: item.offerId,
        source: VISION_SMALL_RETRY_PROCESSOR_ID,
        output: retryOutput,
        validation: retryValidation,
        confidence: retryResult.confidence,
        model: retryModel,
        cropUrl: crop.cropUrl,
        accepted: (retryValidation.acceptedFields || []).length > 0,
        attemptedAt,
      },
      cost: { requests: retryResult.diagnostics.visionRequests || 1, tier: 'vision-small' },
    };
  },
});
