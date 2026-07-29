// recovery/processors/human.js — S7, the Human Review processor (C-7, C-8, C-9).
//
// THE PROOF OF THE PLATFORM PROPERTY. This file plus one line in ./index.js is
// the entire cost of adding the human rung: no queue code, no schema, no
// migration, no new status value, no runner change. C-9 predicted that; this is
// it being collected. Everything that makes a human rung special was already
// built and is merely USED here:
//
//   • `RECOVERY_KIND.HUMAN` — the runner already skips the C-7 accepted-field
//     check for this kind, so a reviewer may correct a confident machine misread
//     (the defect class no presence gate can catch — businessAcceptance.js).
//   • `EXTRACTION_PROVENANCE.HUMAN` — already self-evidencing, so a reviewed
//     name yields corroboration and the row is genuinely servable (R1).
//   • `applyHumanReview` — already written and tested (humanProvenance.test.mjs).
//   • `offer_recovery_attempts.actor` — already there for "who reviewed it".
//
// WHY THIS PROCESSOR IS SYNCHRONOUS WHEN REVIEW IS NOT. A human takes minutes;
// `run()` takes milliseconds. They are reconciled by making the DECISION the
// input rather than the work: the console renders the review surface, the
// reviewer submits, and only THEN is the processor run with that decision in
// `ctx.review`. So `run()` never waits for a human — it applies one. Without a
// decision it DECLINES, which is what keeps `human` safe to arm in an Auto
// policy: an unattended drain that reaches this processor does nothing, costs
// nothing, and consumes no attempt.
//
// WHAT THIS FILE STILL MAY NOT DO, exactly like every machine processor:
//   • decide whether it is allowed to run (C-8 — the operator opening the item
//     and pressing Approve IS the authorisation)
//   • decide whether it succeeded (C-9 — only S4 closes an item, and a human
//     approval that does not clear the gate leaves the item queued, honestly)
//
// REJECT and SEND BACK are deliberately NOT here. They are queue transitions,
// not extraction outcomes: a processor may not close its own item, so they are
// operator acts performed by the console against `close(DISMISSED)` and
// `release()` — both of which already existed.

import {
  EXTRACTION_PROVENANCE,
  EXTRACTION_STRATEGIES,
  finalizeValidatedExtraction,
} from '../../offers/smartExtraction.js';
import {
  DEFAULT_MODEL,
  canonicalRowFromResult,
  servable,
} from '../../offers/enrich.js';
import {
  DEFAULT_IDENTITY_NORMALIZATION_MODE,
  normalizeIdentityMode,
} from '../../offers/identityBuilder.js';
import { defineProcessor, RECOVERY_KIND, REVIEW_DECISION } from '../registry.js';

export const HUMAN_PROCESSOR_ID = 'human';

// Validation-vocabulary field -> the key the same field carries on a finalized
// extraction result. The two vocabularies already exist and disagree; this is
// the single place the human rung crosses between them.
const FIELD_TO_RESULT_KEY = Object.freeze({
  name_en: 'productName',
  name_ar: 'arabicName',
  brand: 'brand',
  size: 'size',
  pack_count: 'packCount',
});

// S4 condition -> the fields a REVIEWER can actually move it with.
//
// `price` maps to NOTHING, and that is the important entry. M1 reads
// `offer.price`/`offer.currency` from the OFFER ROW — retailer-sourced commerce
// data (C-2) — not from extraction. §44 keeps extracted prices out of
// `offer_enrichments` entirely (`preservedObservation`) precisely because the
// deterministic current-price guard is still owed, and a crossed-out "was"
// price was measured being returned as the selling price at 0.99 confidence.
// Letting a reviewer type a price here would route a human-keyed number into
// the commerce path the whole design keeps sealed. It is shown as blocking and
// explained, never edited.
const CONDITION_FIELDS = Object.freeze({
  english_name: Object.freeze(['name_en']),
  comparable_quantity: Object.freeze(['size', 'pack_count']),
  price: Object.freeze([]),
});

const CONDITION_WHY = Object.freeze({
  price: 'Price comes from the retailer feed, not from extraction, so review cannot set it. '
    + 'This offer needs a usable price and currency on the offer row before any processor can clear S4.',
  english_name: 'S4 admits the English name from the validator verdict; typing one here is self-evidencing (C-7).',
  comparable_quantity: 'Needs a magnitude and unit (e.g. "330 ml", "1 kg") or a pack count that resolves.',
});

const FIELD_LABEL = Object.freeze({
  name_en: 'English name',
  name_ar: 'Arabic name',
  brand: 'Brand',
  size: 'Package size',
  pack_count: 'Pack count',
});

const FIELD_HINT = Object.freeze({
  name_en: 'The identity anchor. Read it off the crop verbatim.',
  size: 'A magnitude and a unit — "330 ml", "1 kg", "6 x 250 ml".',
  pack_count: 'Only when the pack itself is the quantity, e.g. "6".',
});

const text = (value) => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Read the current best-known value for a validation field out of the attempt
 * journal. The canonical enrichment carries only the two names, so brand/size
 * have to come from whichever processor last validated them.
 */
function prefillValue(item, field) {
  if (field === 'name_en' && item?.enrichment?.name != null) return item.enrichment.name;
  if (field === 'name_ar' && item?.enrichment?.name_ar != null) return item.enrichment.name_ar;
  for (const attempt of Object.values(item?.attemptsBySource || {})) {
    const value = attempt?.validation?.fields?.[field]?.value;
    if (value != null && String(value).trim() !== '') return value;
  }
  return null;
}

/**
 * THE UX CONTRACT: what is blocking, and nothing else.
 *
 * A reviewer's time is the scarcest input the recovery platform has, so this
 * returns ONLY the fields that currently stand between this offer and a servable
 * canonical product. Brand is a worked example of what is deliberately absent:
 * the Quality Gate triggers on a missing brand and it may well be listed in
 * `reasons`, but brand is not in the S4 mandatory set, so editing it cannot
 * close the item and showing it as an input would spend review time buying
 * nothing.
 *
 * Exported (rather than kept private) because the console renders it: the review
 * surface IS this processor's UI, so the field taxonomy stays here, in the
 * processor, instead of being duplicated into the ops layer where the queue
 * would end up learning what a package size is (C-9).
 */
export function buildReviewPlan(item) {
  const missing = [...(item?.verdict?.missing || [])];
  const identityBlocked = !servable(item?.enrichment || null);
  // Servability is a conjunct of the admission rule alongside S4 (C-9), so an
  // offer can sit here with an empty `missing` list purely because it has no
  // canonical identity. `name_en` is what a reviewer can move that with.
  if (identityBlocked && !missing.includes('english_name')) missing.push('english_name');

  const seen = new Set();
  const fields = [];
  const readOnly = [];
  for (const condition of missing) {
    const editable = CONDITION_FIELDS[condition];
    if (!editable || editable.length === 0) {
      readOnly.push({
        condition,
        editable: false,
        why: CONDITION_WHY[condition] || 'This condition cannot be resolved by review.',
      });
      continue;
    }
    for (const field of editable) {
      if (seen.has(field)) continue;
      seen.add(field);
      fields.push({
        field,
        label: FIELD_LABEL[field] || field,
        hint: FIELD_HINT[field] || null,
        value: prefillValue(item, field),
        condition,
      });
    }
  }

  // ADVANCED — every other field a reviewer MAY edit, none of which is blocking.
  // Secondary by construction, not by styling: the primary list above is derived
  // from the gate, so a field can only appear here by failing to be a blocker.
  // Brand is the canonical inhabitant — the Quality Gate fires on a missing
  // brand and it often shows up in `reasons`, but brand is not in the S4
  // mandatory set, so editing it cannot close the item. It stays reachable for
  // the reviewer who can see the answer on the crop and wants to fix it in
  // passing, and stays out of the way of the reviewer who just wants the item
  // gone.
  const advanced = Object.keys(FIELD_TO_RESULT_KEY)
    .filter((field) => !seen.has(field))
    .map((field) => ({
      field,
      label: FIELD_LABEL[field] || field,
      hint: FIELD_HINT[field] || null,
      value: prefillValue(item, field),
      condition: null,
    }));

  return {
    offerId: item?.offerId ?? null,
    imageUrl: item?.offer?.image_url ?? null,
    // WHY IT IS HERE — the enqueue-time snapshot, untouched by recovery.
    reasons: item?.reasons ?? {},
    verdict: item?.verdict ?? null,
    blocking: missing,
    // THE COMMON CASE. Prefilled, and only these — the fields that currently
    // stand between this offer and a servable canonical product.
    fields,
    // Everything else that is editable, for the uncommon case. Never required.
    advanced,
    // Blocking but NOT fixable by review — shown so the reviewer knows to send
    // it back or reject rather than hunting for a field that is not there.
    readOnly,
    // Enough orientation to judge the crop, and no more.
    context: {
      name: item?.offer?.name ?? null,
      nameAr: item?.offer?.name_ar ?? null,
      price: item?.offer?.price ?? null,
      currency: item?.offer?.currency ?? null,
      validTo: item?.offer?.valid_to ?? null,
      attempts: item?.attempts ?? 0,
      attemptedBy: Object.keys(item?.attemptsBySource || {}),
    },
    // A reviewer cannot make this servable no matter what they type.
    resolvable: readOnly.length === 0 && fields.length > 0,
  };
}

export default defineProcessor({
  id: HUMAN_PROCESSOR_ID,
  label: 'Human review',
  description:
    'A reviewer reads the crop and supplies the fields that are blocking servability. '
    + 'The terminal processor: self-evidencing, free, and the only rung allowed to '
    + 'correct a confident machine misread.',
  kind: RECOVERY_KIND.HUMAN,
  provenance: EXTRACTION_PROVENANCE.HUMAN,
  // ADVISORY (registry.js). A reviewer can move both conditions that extraction
  // owns; `price` is absent because no reviewer can fix it here — see
  // CONDITION_FIELDS.
  addresses: ['english_name', 'comparable_quantity'],
  // Zero provider requests. Recorded so the effectiveness read can compare a
  // free rung against a paid one honestly rather than showing a blank.
  costHint: { per: 'offer', requests: 0, tier: 'human' },
  // NEEDS NO PROVIDER AT ALL. The runner hands `credential: null` processors no
  // key chain, which is exactly why engine.js resolves credentials per
  // processor — a shared chain would have handed the human rung a live API key.
  credential: null,

  // A crop is the whole evidence base for a review. Unlike OCR this needs NO
  // prior machine attempt: a reviewer reads the image directly, which is what
  // makes this the terminal rung rather than another merge step.
  supports: (item) => !!item?.offer?.image_url,

  // DECLARED CAPABILITY, not an exported helper the console reaches for. This
  // is what makes `human` render a review surface while `ocr` renders a
  // dispatch button, with the ops layer branching on `processor.reviewPlan`
  // rather than on any processor's id.
  reviewPlan: buildReviewPlan,

  async run(item, ctx = {}) {
    const {
      review = null,
      identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE,
      model = DEFAULT_MODEL,
    } = ctx;

    // NO DECISION, NO WORK. This is the guard that makes `human` safe to arm in
    // an Auto policy: an unattended drain reaching this processor declines every
    // item instead of blocking, throwing, or inventing an edit. A decline
    // consumes no attempt (runner.js), so nothing is spent and nothing is burnt.
    if (!review || review.decision !== REVIEW_DECISION.APPROVE) {
      return { declined: true, error: 'human review requires a submitted approval' };
    }

    // Only fields the reviewer actually submitted become edits. `applyHumanReview`
    // treats an ABSENT key and an explicit null differently on purpose — absent
    // leaves the machine value alone, null clears it — so the payload is passed
    // through with that distinction intact rather than normalized away.
    const submitted = review.fields && typeof review.fields === 'object' ? review.fields : {};
    const edits = {};
    for (const field of Object.keys(FIELD_TO_RESULT_KEY)) {
      if (!Object.hasOwn(submitted, field)) continue;
      edits[field] = text(submitted[field]);
    }
    if (Object.keys(edits).length === 0) {
      return { declined: true, error: 'human review submitted no field edits' };
    }

    const actor = text(review.actor) || 'unknown';
    const attemptedAt = new Date().toISOString();
    const prior = item.attemptsBySource || {};

    // Replay the persisted machine journal and lay the review on top of it. The
    // earlier rungs are NEVER re-read from their models (§6 S6) — the whole
    // point of the journal is that a later rung merges against what was already
    // paid for. `?? undefined` so finalize applies its own empty-source default:
    // an offer may reach review with no machine attempt at all.
    const result = finalizeValidatedExtraction({
      strategy: EXTRACTION_STRATEGIES.VISION_FIRST,
      visionOutput: prior.vision?.output ?? null,
      visionValidation: prior.vision?.validation ?? undefined,
      ocrOutput: prior.ocr?.output ?? null,
      ocrValidation: prior.ocr?.validation ?? undefined,
      // ZERO requests: this rung called no provider. It also keeps the
      // corroboration guard's `visionRequests > 0` branch out of the way, which
      // would otherwise judge this attempt on a machine overwrite count that
      // describes a different rung's work.
      visionRequests: 0,
      ocrRequests: 0,
      visionAttemptPresent: !!prior.vision,
      ocrAttemptPresent: !!prior.ocr,
      processingTimeMs: 0,
      humanReview: { fields: edits, actor, at: attemptedAt },
    });

    // THE HUMAN IS THE VALIDATOR FOR THE HUMAN RUNG. S4 admits the English name
    // from `acceptedFields` (M3 reuses S3's verdict rather than re-judging the
    // string), so a review that supplies a name must say so here or approving
    // could never satisfy the gate. A field counts as admitted when a reviewer
    // vouched for it OR a machine validator already had — never merely because
    // it holds a value.
    const priorAccepted = new Set([
      ...(prior.vision?.validation?.acceptedFields || []),
      ...(prior.ocr?.validation?.acceptedFields || []),
    ]);
    const fields = {};
    const acceptedFields = [];
    for (const [field, resultKey] of Object.entries(FIELD_TO_RESULT_KEY)) {
      const value = result.extraction?.[resultKey] ?? null;
      const provenance = result.provenance?.[resultKey] ?? null;
      const admitted = value != null
        && (provenance === EXTRACTION_PROVENANCE.HUMAN || priorAccepted.has(field));
      fields[field] = {
        status: admitted ? 'Accepted' : (value == null ? 'Missing' : 'Unvalidated'),
        value,
        candidate: value,
        provenance,
        reasons: [],
      };
      if (admitted) acceptedFields.push(field);
    }
    const validation = {
      source: EXTRACTION_PROVENANCE.HUMAN,
      confidence: null,
      fields,
      acceptedFields,
      triggerReasons: [],
      ocrRequired: false,
    };

    const canonicalRow = canonicalRowFromResult(
      item.offerId,
      { cropUrl: item.offer?.image_url ?? null },
      result,
      {
        model: prior.vision?.model || model,
        identityNormalizationMode: normalizeIdentityMode(identityNormalizationMode),
        enrichedAt: attemptedAt,
        commerceContext: item.offer,
      },
    );

    return {
      canonicalRow,
      attempt: {
        offerId: item.offerId,
        // The processor id IS the journal source (C-9) — writable as plain data
        // only because S5.0 removed the `source` CHECK. Before that migration
        // this single line would have needed a table rebuild.
        source: HUMAN_PROCESSOR_ID,
        // The submission itself is the observation: what the reviewer saw and
        // typed, kept so an approval is auditable after the fact.
        output: { decision: review.decision, edits, note: text(review.note), actor },
        validation,
        confidence: null,
        model: null,
        cropUrl: item.offer?.image_url ?? null,
        accepted: acceptedFields.length > 0,
        attemptedAt,
      },
      // Threaded into offer_recovery_attempts.actor by the runner — the "who"
      // the column was added for.
      actor,
      cost: { requests: 0, tier: 'human', actor },
    };
  },
});
