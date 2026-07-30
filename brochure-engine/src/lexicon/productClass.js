// lexicon/productClass.js — is this a thing you buy BY QUANTITY, or BY THE ITEM?
//
// USER DIRECTIVE 2026-07-30: "non grocery items i.e. mobile / bags / tv should
// be accepted with less strict rule." This module is the *only* place that
// question is answered, so the leniency has exactly one definition and one
// place to audit it.
//
// WHY THE DISTINCTION IS REAL AND NOT A LOOPHOLE. The Business Acceptance gate
// demands a comparable quantity because "without it a price is a number with no
// denominator" (businessAcceptance.js M2). That argument is airtight for
// groceries and simply does not apply to a television: a TV's denominator IS one
// television. Two 65" TVs at 1,999 and 2,499 are perfectly comparable, and no
// magnitude in ml/l/g/kg would make them more so. So the gate was not too
// strict by accident — it was applying a grocery premise to non-grocery stock.
//
// MEASURED, 2026-07-30: 2,071 current non-grocery offers are rejected on
// `comparable_quantity` ALONE — price and English name both present. They are
// roughly half the entire recovery backlog, and no processor can ever fix them,
// because there is nothing on the crop to find.
//
// ⚠️ THE FAIL-SAFE IS *STRICT*, AND MUST STAY THAT WAY. An unknown category, a
// null category, a new retailer's unfamiliar taxonomy — every one of them
// resolves to GROCERY, i.e. today's behaviour, unchanged. Leniency is opt-in per
// category and never inferred. Getting this backwards would let an unrecognised
// slug quietly admit real groceries with no size at all, which is precisely the
// defect the gate exists to catch. `classify(null)` returning GROCERY is a test,
// not an implementation detail.
//
// ⚠️ THIS IS RETAILER TAXONOMY, not our own. The slugs below are D4D's, observed
// on the live catalogue. A second retailer with different slugs does not break
// anything — its offers simply stay strict until its vocabulary is added here.
// That is the intended failure mode: under-applying leniency is recoverable,
// over-applying it is not.

export const PRODUCT_CLASS = Object.freeze({
  // Bought by quantity. The full M2 argument applies: no size, no admission.
  GROCERY: 'grocery',
  // Bought by the item. Admitted on a UNIT basis (comparableQuantity.js), which
  // supports grouping and price comparison but NOT price-per-unit arithmetic.
  NON_GROCERY: 'non_grocery',
});

// Non-grocery categories, grouped by why they qualify. Every one of these is
// stock a shopper buys as "one of", where a printed ml/g figure would be either
// absent or a specification rather than a package size.
//
// DELIBERATELY EXCLUDED, and each exclusion is load-bearing — these LOOK
// non-grocery but are bought by quantity and must stay strict:
//   laundry, cleaning, dishwasher   — detergents print real volumes/weights
//   fragrance, cosmetics, bath-body, skin-face-care, hair-care, dental-care,
//   shaving-hair-removal            — FMCG, all print ml/g
//   baby-care, baby-diapers, baby-feeding, feminine-hygiene — counts and weights
//   toilet-paper-tissue, facial-tissue, foils-cling, disposables — counts
//   pets, health-care               — pet food and supplements print weights/counts
// If one of these is ever moved, it needs its own evidence, not a hunch.
const NON_GROCERY_CATEGORIES = Object.freeze(new Set([
  // Consumer electronics — the user's "mobile / tv".
  'mobiles', 'tv', 'tabs', 'smart-watch', 'computer-laptop', 'printer',
  'monitors-projectors', 'camera', 'gaming',
  // Appliances. NOTE these frequently DO print a real capacity (a 1.7 l kettle,
  // a 7 kg washing machine) — and that is fine and wanted: the measure basis
  // still wins when a genuine magnitude is present. Listing them here only
  // supplies a floor for the ones that print nothing.
  'large-appliances', 'small-appliances', 'kitchen-appliance',
  // Home, kitchen and furniture.
  'cookware', 'dining-serving', 'home-furnishing-decor', 'furniture',
  'lighting', 'household-essentials', 'tools-hardware', 'outdoors-garden',
  // Fashion and bags — the user's "bags".
  'luggage', 'footwear', 'men-clothing', 'women-clothing', 'kids-wear',
  'sports-wear', 'accessories', 'accessories-fashion',
  // Toys, gifts and stationery.
  'gifts-toys', 'baby-toys-accesories', 'school-stationary',
]));

/**
 * Classify a retailer category slug.
 *
 * TOTAL and case-insensitive: never throws, and every unrecognised input —
 * null, undefined, a number, an empty string, a slug from a retailer we have
 * not catalogued — lands on GROCERY.
 */
export function classifyProductClass(category) {
  const slug = String(category ?? '').trim().toLowerCase();
  return NON_GROCERY_CATEGORIES.has(slug)
    ? PRODUCT_CLASS.NON_GROCERY
    : PRODUCT_CLASS.GROCERY;
}

/** Convenience predicate; the same fail-safe applies. */
export function isNonGrocery(category) {
  return classifyProductClass(category) === PRODUCT_CLASS.NON_GROCERY;
}

/** Operator-facing, so the console can show what leniency is configured. */
export function nonGroceryCategories() {
  return [...NON_GROCERY_CATEGORIES].sort();
}
