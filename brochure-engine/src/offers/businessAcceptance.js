// businessAcceptance.js — S4, the BUSINESS ACCEPTANCE GATE.
//
// VISION-PIPELINE.md §4. One boolean, asked once: may this product enter
// commerce?
//
// WHAT MAKES THIS DIFFERENT FROM S3. `validateVisionOutput` answers a per-field
// question — did the model return something admissible for THIS field? It emits
// no business verdict and must not: a name can be perfectly admissible on a
// product with no price, and that product still cannot be compared with
// anything. S4 is the first stage allowed to have an opinion about the product
// as a whole, and it is the ONLY one.
//
// A CONJUNCTION, NEVER A SCORE. Three independent presence facts, all of which
// must hold. Deliberately not a weighted score, because a score is compensatory:
// `commerce_score >= X` would let brand's 20 points stand in for package size's
// 25, and a product would enter commerce because it was well-branded rather than
// because it was comparable. It would also be circular — Commerce Score reads
// price and size, the same two facts this gate tests (QUALITY-SCORES.md §5).
//
// WHY EXACTLY THESE THREE (C-5). Each earns its place by a different argument,
// which is the test for whether the set is right:
//
//   M1 price               — the fact the whole product exists to compare, and
//                            free: we already own it (C-2), measured usable on
//                            1000/1000 production rows
//   M2 comparable quantity — what makes two prices comparable at all; without
//                            it a price is a number with no denominator
//   M3 english name        — the identity anchor, reusing S3's own verdict
//                            rather than inventing a second bar (99% available)
//
// A fourth condition is `business-acceptance-v2`, never an edit of v1 (R3).
//
// WHAT IT MUST NEVER READ (§4.4): Commerce Score or any threshold on it,
// Builder Score / Identity Readiness, model self-reported confidence (measured
// at 0.98 on misreads), or registry state (structurally unavailable — resolution
// runs in a later Worker invocation).
//
// KNOWN CEILING, WRITTEN DOWN RATHER THAN HIDDEN. Every condition is a PRESENCE
// test, so the gate answers "resolved", never "correct". "HONOR 5G" passes M2
// with a confidently wrong 5 g. A presence gate recovers ABSENT fields; it
// cannot recover WRONG ones, and no correctness oracle exists at this stage
// (VISION-PIPELINE.md C-1, C-5).

import { hasUsableCommercePrice } from './commerceScore.js';
import {
  COMPARABLE_QUANTITY_STATUS,
  comparableQuantityFromStructured,
  resolveComparableQuantity,
} from '../lexicon/comparableQuantity.js';

export const BUSINESS_ACCEPTANCE_VERSION = 'business-acceptance-v1';

// The mandatory set, ordered. This array IS the contract: adding to it is a new
// version, and the per-condition `missing` list is derived from it so the two
// can never disagree.
export const MANDATORY_CONDITIONS = Object.freeze([
  'price',
  'comparable_quantity',
  'english_name',
]);

// M3 reuses S3's verdict rather than re-judging the name. The gate asks the
// validator what it already decided; it does not look at the string.
function englishNameAdmitted(acceptedFields) {
  return Array.isArray(acceptedFields) && acceptedFields.includes('name_en');
}

/**
 * The gate. Pure, total, deterministic — it never throws and depends on exactly
 * three facts.
 *
 * @param {object}   input
 * @param {object}   input.offer            `{ price, currency }` from the OFFER ROW. Never Vision (C-2).
 * @param {string[]} input.acceptedFields   S3's `acceptedFields` verdict.
 * @param {object}   [input.comparableQuantity] Pre-computed projection.
 * @param {object}   [input.structured]     Structured Product, if the projection is not supplied.
 * @param {object}   [input.observation]    Raw observation, if neither of the above is.
 */
export function evaluateBusinessAcceptance({
  offer = {},
  acceptedFields = [],
  comparableQuantity = null,
  structured = null,
  observation = null,
} = {}) {
  const quantity = comparableQuantity
    ?? (structured
      ? comparableQuantityFromStructured(structured)
      : resolveComparableQuantity(observation || {}));

  const mandatory = Object.freeze({
    price: hasUsableCommercePrice(offer || {}),
    comparable_quantity: quantity.status === COMPARABLE_QUANTITY_STATUS.RESOLVED,
    english_name: englishNameAdmitted(acceptedFields),
  });

  // Per-condition, never aggregated. `missing: ['comparable_quantity']` is
  // actionable and is how the mandatory set gets calibrated against real
  // traffic; `accepted: false` tells an operator nothing (R5, R6).
  const missing = MANDATORY_CONDITIONS.filter((condition) => !mandatory[condition]);

  return Object.freeze({
    accepted: missing.length === 0,
    version: BUSINESS_ACCEPTANCE_VERSION,
    mandatory,
    missing: Object.freeze(missing),
    comparableQuantity: quantity,
  });
}

// S1 · EXTRACTION ADMISSION — "is this crop worth one model call?"
//
// Shares M1 with the gate on purpose. A priceless offer can never be accepted
// at S4, so paying for a model call on it is pure waste; asserting price BEFORE
// the call is strictly cheaper than discovering it after (C-2). The remaining
// conditions are today's `listDebris` WHERE clause, kept here so the predicate
// is testable in one place even while the query does the real filtering (R4).
export function isExtractionCandidate({
  imageUrl = null,
  validTo = null,
  currentOn = null,
  attempted = false,
  price = null,
  currency = null,
} = {}) {
  const reasons = [];
  if (!imageUrl) reasons.push('no_crop');
  if (validTo && currentOn && String(validTo) < String(currentOn)) reasons.push('expired');
  if (attempted) reasons.push('already_attempted');
  if (!hasUsableCommercePrice({ price, currency })) reasons.push('no_usable_price');
  return Object.freeze({
    admitted: reasons.length === 0,
    reasons: Object.freeze(reasons),
  });
}
