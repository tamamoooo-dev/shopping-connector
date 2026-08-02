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
import { PRODUCT_CLASS, isNonGrocery } from '../lexicon/productClass.js';
import {
  COMPARABLE_QUANTITY_STATUS,
  comparableQuantityFromStructured,
  resolveComparableQuantity,
} from '../lexicon/comparableQuantity.js';

// ---------------------------------------------------------------------------
// v2 · 2026-07-30 — PRODUCT-CLASS-AWARE M2 (user directive: "non grocery items
// i.e. mobile / bags / tv should be accepted with less strict rule").
//
// THE MANDATORY SET IS UNCHANGED. Still exactly price, comparable quantity and
// English name; R3's "a fourth condition is v2, never an edit of v1" is not
// being exercised, because nothing was added or removed. What changed is what
// COUNTS as a resolved comparable quantity: for non-grocery stock the projection
// gains a UNIT basis (comparableQuantity.js), because M2's own justification —
// "without it a price is a number with no denominator" — is a statement about
// groceries. A television's denominator is one television.
//
// The version is still bumped, and it must be: `offer_acceptance_verdicts.version`
// exists so a verdict is always attributable to the rule that produced it, and
// the same television legitimately yields ABSENT under v1 and RESOLVED under v2.
// Sharing a version string would erase that distinction permanently.
//
// EFFECTIVELY MONOTONIC, which is why it ships live rather than behind a flag:
// leniency is opt-in per retailer category and an unknown category stays strict
// (productClass.js), so v2 can turn a non-grocery REJECT into an ACCEPT and
// cannot turn any grocery ACCEPT into a reject. Measured on the live catalogue:
// 2,071 current non-grocery offers flip to accepted, all of them previously
// blocked on `comparable_quantity` ALONE.
//
// REVERTING is two edits with no migration: restore the version string and stop
// passing `nonGrocery` below. Stored v1 verdicts are untouched either way.
//
// ---------------------------------------------------------------------------
// v3 · 2026-08-02 — PRICE-BASIS-AWARE M2.
//
// THE MANDATORY SET IS AGAIN UNCHANGED, and for the same reason as v2: what
// changed is what COUNTS as a resolved comparable quantity. `comparableQuantity`
// v3 gains a PRICE_BASIS basis (lexicon/priceBasis.js), because M2's own
// justification — "without it a price is a number with no denominator" — is
// precisely satisfied by a price that STATES its denominator. "APPLE ROYAL GALA
// — PER KG — 7.99" is not a price without a denominator; it is the clearest
// denominator in the catalogue, and v2 rejected it.
//
// MEASURED on the live catalogue (2026-08-01): 4,747 offers were rejected on
// `comparable_quantity` ABSENT, of which 710 carry a legible per-kilo or
// per-piece basis and flip to accepted here. Fresh produce, butchery, fish,
// nuts and deli are the bulk of them.
//
// EFFECTIVELY MONOTONIC for acceptance, which is why it ships live rather than
// behind a flag: a basis can only ADD a resolved quantity where there was none,
// or replace a magnitude that came out of the same expression as the basis
// marker itself. No offer that v2 accepted is rejected by v3.
//
// REVERTING is one edit and no migration: restore the version string and stop
// threading `unit`/`text` at the call sites. Stored v1/v2 verdicts are
// untouched either way.
export const BUSINESS_ACCEPTANCE_VERSION = 'business-acceptance-v3';

// The mandatory set, ordered. This array IS the contract: adding to it is a new
// version, and the per-condition `missing` list is derived from it so the two
// can never disagree.
export const MANDATORY_CONDITIONS = Object.freeze([
  'price',
  'comparable_quantity',
  'english_name',
]);

// Grocery M3 reuses S3's verdict rather than re-judging the name. Non-grocery
// additionally accepts the retailer's existing source name under the explicit
// as-is rule; it does not ask a paid model to validate a TV label twice.
function englishNameAdmitted(acceptedFields, offer, nonGrocery) {
  if (Array.isArray(acceptedFields) && acceptedFields.includes('name_en')) return true;
  // User directive 2026-07-30: non-grocery stock is accepted as the retailer
  // supplied it when it already has a name and price. Requiring Vision to
  // independently accept the same name buys no grocery quality and is exactly
  // what filled Recovery with TVs, bags and shoes. Grocery remains unchanged:
  // only S3's accepted English name satisfies M3 there.
  if (!nonGrocery) return false;
  return [offer?.name, offer?.name_ar].some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
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
  productClass = null,
} = {}) {
  // v3 · the two evidence channels the price basis reads that neither the
  // Structured Product nor the stored observation carries as a typed field:
  // the extractor's `unit` (Expanded JSON, §44 — preserved but never consumed
  // until now) and the offer's own bilingual text. Read from the OFFER ROW for
  // the text, exactly like price and product class (C-2): "للكيلو" is stated by
  // the retailer, not by the model, and 899 live offers state it nowhere else.
  const basisUnit = observation?.unit ?? structured?.observed?.unit ?? null;
  const basisText = [offer?.name_ar, offer?.searchText ?? offer?.search_text]
    .filter((value) => typeof value === 'string' && value.trim())
    .join(' ') || null;
  // v2 · read from the OFFER ROW, like price (C-2), and never from the model.
  // The retailer already told us this is a phone; asking a vision model to
  // re-derive that would be paying for a fact we were given for free, and would
  // make the gate's leniency depend on an extraction that may itself have
  // failed. `productClass` stays overridable so a caller holding a better
  // classification (or a test) can supply one.
  const nonGrocery = productClass != null
    ? productClass === PRODUCT_CLASS.NON_GROCERY
    : isNonGrocery(offer?.category);

  const quantity = comparableQuantity
    ?? (structured
      ? comparableQuantityFromStructured(structured, { nonGrocery, unit: basisUnit, text: basisText })
      : resolveComparableQuantity({
        ...(observation || {}), nonGrocery, unit: basisUnit, text: basisText,
      }));

  const mandatory = Object.freeze({
    price: hasUsableCommercePrice(offer || {}),
    comparable_quantity: quantity.status === COMPARABLE_QUANTITY_STATUS.RESOLVED,
    english_name: englishNameAdmitted(acceptedFields, offer, nonGrocery),
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
