// identity/spec.js — the FLEXIBLE WATCH specification.
//
// Two kinds of watch, two kinds of anchor:
//
//   STRICT    anchored to an INSTANCE — a registry product id (`pr_`).
//             "this product, wherever it is sold."       -> identity/verify.js
//   FLEXIBLE  anchored to a CLASS — a set of pinned identity dimensions.
//             "any chicken breast, per kg, under 20 SAR."-> this module
//
// They are deliberately NOT the same mechanism with a flag. A strict watch
// survives things a spec cannot — registry merges, wording drift, a size the
// extractor stops reading — because a `pr_` carries evidence accumulated over
// many sightings while a spec carries only what was declared once.
//
// A SPEC IS AN OPEN MAP over the Identity Candidate's own dimensions:
//
//     { family: 'chicken', cut: 'breast' }        any brand, size, variety
//     { family: 'milk', brand: ['almarai','nadec'] }
//
// Keys PRESENT are pinned; keys ABSENT are free. There is no null-overloading,
// so "any brand" and "brand unknown" can never be confused. Nothing in this
// module enumerates dimensions: the key list comes from
// registry/candidate.js CANDIDATE_DIMENSIONS, so when the Identity Candidate
// grows a field (organic, gluten-free, a future Vision attribute) it becomes
// pinnable with NO change here.
//
// THE DISCIPLINE THAT KEEPS THIS FROM DECAYING: a spec may only test canonical
// extracted dimensions. Never raw text, never product names, never lexical
// relevance scores. Retrieval may be lexical; identity never is.
//
// UNKNOWN DOES NOT SATISFY A PIN — the opposite of strict watches, on purpose.
// A strict watch abstains on a missing signal because the resolver aggregates
// other evidence; a predicate has no other evidence, so a candidate whose
// family cannot be read genuinely cannot be shown to be in the class. To stop
// that becoming a new silent failure, every exclusion is COUNTED and reported
// (see `emptyExclusions` / `countExclusion`).

import { CANDIDATE_DIMENSIONS } from '../registry/candidate.js';
import { normalizeText } from '../matching.js';

// Dimensions a Flexible Watch may pin TODAY. This is the extractor-coverage
// gate, not a schema list: a dimension becomes pinnable only once EVERY
// extractor in a watch's scope can produce it. If Vision learns `organic` and
// the online-listing extractor does not, pinning it would match flyer products
// and silently never match online listings — so it stays out of this set until
// both sides can read it. Adding a name here is the deliberate act of saying
// "all extractors now produce this".
export const PINNABLE = Object.freeze([
  'brand', 'family', 'cut', 'processing', 'variety', 'package', 'size', 'count',
]);

// A spec must pin something, or it is a watch on "everything".
export const MIN_PINS = 1;

const asArray = (v) => (Array.isArray(v) ? v : [v]);
const textOf = (v) => normalizeText(String(v ?? '')).trim();

// --- per-dimension comparison ---------------------------------------------------
// Comparison dispatches PER DIMENSION, which is the seam that lets a future
// dimension bring its own comparator (a numeric range for fat percentage, say)
// without touching the spec model. `size` already proves the seam is needed:
// it has always required tolerance rather than equality.

const SIZE_TOLERANCE = 0.03; // the engine-wide size-equivalence figure

function baseSize(size) {
  if (!size || typeof size !== 'object') return null;
  const value = Number(size.value);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = String(size.unit || '');
  if (unit === 'kg') return { unit: 'g', value: value * 1000 };
  if (unit === 'l') return { unit: 'ml', value: value * 1000 };
  if (unit === 'g' || unit === 'ml') return { unit, value };
  return null;
}

function sizeMatches(pin, observed) {
  const a = baseSize(pin);
  const b = baseSize(observed);
  if (!a || !b || a.unit !== b.unit) return false;
  const hi = Math.max(a.value, b.value);
  const lo = Math.min(a.value, b.value);
  return hi > 0 && (hi - lo) / hi <= SIZE_TOLERANCE;
}

function packageMatches(pin, observed) {
  const wanted = typeof pin === 'string' ? pin : pin?.type;
  return textOf(wanted) === textOf(observed?.type);
}

const COMPARATORS = {
  size: sizeMatches,
  package: packageMatches,
  count: (pin, observed) => Number(pin) === Number(observed),
};

// Default: canonical text equality. A pin may be a SET, which costs nothing to
// support (`some` vs `===`) and is how a class defined by a property of a
// RELATED entity is expressed — "private label" resolves to a brand set at
// watch-creation time, then pins membership.
function dimensionMatches(dimension, pin, observed) {
  if (observed == null || observed === '') return false; // unknown never satisfies a pin
  const compare = COMPARATORS[dimension];
  return asArray(pin).some((value) =>
    compare ? compare(value, observed) : textOf(value) === textOf(observed),
  );
}

// --- validation -----------------------------------------------------------------

export function validateSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { valid: false, errors: ['A watch specification must be an object'] };
  }
  const errors = [];
  const keys = Object.keys(spec).filter((k) => spec[k] != null);
  for (const key of keys) {
    if (!CANDIDATE_DIMENSIONS.includes(key)) {
      errors.push(`'${key}' is not a product identity dimension`);
    } else if (!PINNABLE.includes(key)) {
      // Refused rather than silently ineffective: pinning a dimension some
      // extractor cannot read would produce a watch that never matches.
      errors.push(`'${key}' cannot be pinned yet — not every source can read it`);
    } else if (Array.isArray(spec[key]) && spec[key].length === 0) {
      errors.push(`'${key}' was pinned to an empty set`);
    }
  }
  if (keys.length < MIN_PINS) errors.push('Pin at least one product dimension');
  return { valid: errors.length === 0, errors, pins: keys };
}

// Is a spec free of a size pin? Then pack prices are not comparable across
// candidates and the target MUST be a unit price. This is derived from the
// spec rather than configured beside it — one source of truth, one less
// setting, and it can never disagree with the pins.
export function comparesByUnitPrice(spec) {
  return !spec || spec.size == null;
}

// --- evaluation -------------------------------------------------------------------

export const emptyExclusions = () => ({});

// Exclusions are counted per dimension so a watch can always say WHY its pool
// emptied: "23 candidates, 6 excluded: family unreadable" is a visible number,
// never a disappearance.
export function countExclusion(counters, dimension) {
  if (!dimension) return counters;
  counters[dimension] = (counters[dimension] || 0) + 1;
  return counters;
}

export function describeExclusions(counters) {
  const parts = Object.entries(counters || {})
    .sort((a, b) => b[1] - a[1])
    .map(([dimension, n]) => `${dimension} ×${n}`);
  return parts.length ? parts.join(', ') : null;
}

// Does this extracted candidate belong to the class the spec describes?
// Returns { matched, failed } — `failed` names the first unsatisfied dimension
// so the caller can count it.
export function matchesSpec(candidate, spec) {
  if (!candidate) return { matched: false, failed: 'candidate' };
  for (const [dimension, pin] of Object.entries(spec || {})) {
    if (pin == null) continue;
    if (!dimensionMatches(dimension, pin, candidate[dimension])) {
      return { matched: false, failed: dimension };
    }
  }
  return { matched: true, failed: null };
}

// The spec the watch dialog's three toggles describe, built from the LISTING
// the user is looking at. A checked toggle pins that attribute; an unchecked
// one leaves it free ("any brand", "any size").
//
// This is derived server-side ON PURPOSE. The spec must come from the same
// extractor that will classify candidates at check time — if the frontend
// derived it from its own taxonomy mirror, the watch would be pinned in one
// vocabulary and tested in another, which is exactly the corpus asymmetry that
// made the previous design fail silently.
//
// `cut` always pins when known: it is what distinguishes chicken BREAST from
// chicken NUGGETS, and no toggle ever meant "any cut".
export function specFromListing(candidate, { matchBrand = true, matchSize = true, matchVariant = true } = {}) {
  if (!candidate) return {};
  const spec = {};
  if (candidate.family) spec.family = candidate.family;
  if (candidate.cut) spec.cut = candidate.cut;
  if (candidate.processing) spec.processing = candidate.processing;
  if (matchBrand && candidate.brand) spec.brand = candidate.brand;
  if (matchSize && candidate.size) spec.size = candidate.size;
  if (matchVariant && candidate.variety) spec.variety = candidate.variety;
  return spec;
}

// The spec an existing v2 "flexible" watch row describes. The mapping is
// mechanical because the old row already stored the derived class: a gate that
// was STRICT pinned its attribute, a gate that was RELAXED left it free.
export function specFromLegacyWatch(watch = {}) {
  const spec = {};
  if (watch.identityFamily) spec.family = watch.identityFamily;
  if (watch.identityType) spec.cut = watch.identityType;
  if (watch.matchBrand !== false && watch.brandId) spec.brand = watch.brandId;
  if (watch.matchSize !== false && watch.sizeUnit && Number(watch.sizeTotal) > 0) {
    spec.size = { value: Number(watch.sizeTotal), unit: watch.sizeUnit };
  }
  if (watch.matchVariant !== false && watch.variantKey) {
    spec.variety = String(watch.variantKey).split('|').filter(Boolean).join(' ');
  }
  return spec;
}
