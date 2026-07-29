// lexicon/comparableQuantity.js — the COMPARABLE QUANTITY projection.
//
// VISION-PIPELINE.md §4.3. This is condition M2 of the Business Acceptance Gate:
// "is there enough quantity information here for this product to sit beside
// another one?"
//
// A PROJECTION, NOT A PARSER. Every number below comes from `parsePackageSize()`
// or `resolvePackageType()` unchanged. Nothing here re-reads a size string,
// re-derives a total, or converts a unit. The project forbids a third
// interpretation of a size (`packageSize.js` header), and this module is not
// one — it re-expresses two existing outputs in the single shape the gate needs.
//
// WHY IT EXISTS AT ALL. The gate must not care whether a size arrived as
// "330 ml", "40's" or "bag". Those are three different parser paths with three
// different output shapes, and a gate that branched on all three would slowly
// become a fourth parser. The projection collapses them to one question with
// one answer shape, and keeps the branching here where it is testable.
//
// THE TWO BITS ARE SEPARATE, AND MUST STAY SEPARATE.
//
//   status: 'RESOLVED'        — enough quantity to ADMIT the product (M2)
//   unitPriceComparable: true — enough quantity to do ARITHMETIC on it
//
// A carton with no printed magnitude is a real, comparable product: a shopper
// can group it with other cartons and compare prices. It is not a product you
// can compute a price-per-litre for. Collapsing these two bits would let a later
// stage divide a price by "1 bag"; keeping them apart is why the gate can be
// generous without the unit-price ranker becoming wrong.
//
// FAILURE MODE: 'ABSENT', never an invented quantity. Inherited, not
// re-implemented — `parsePackageSize()` already refuses a weak count (the
// `…26S` fridge model number), so anything that reaches here is as trustworthy
// as the parser that produced it.
//
// KNOWN LIMIT (VISION-PIPELINE.md §4.3, C-5): this answers *resolved*, never
// *correct*. "HONOR 5G" projects to a perfectly well-formed 5 g, because
// `parseSize` read the model designator as a measure. No correctness oracle
// exists at this stage; the gate is a presence conjunction and the limitation
// is documented rather than hidden behind a confidence number.

import { parsePackageSize } from './packageSize.js';
import { resolvePackageType } from './shopping.js';

export const COMPARABLE_QUANTITY_VERSION = 'comparable-quantity-v1';

export const COMPARABLE_QUANTITY_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  ABSENT: 'ABSENT',
});

export const COMPARABLE_QUANTITY_BASIS = Object.freeze({
  MEASURE: 'measure',     // a printed magnitude in a measurement unit
  COUNT: 'count',         // a printed number of countable units
  CONTAINER: 'container', // a named package with no printed magnitude
});

// The measurement units `parsePackageSize()` can emit. `oz` is deliberately
// absent: `matching.js` has no ounce support anywhere, and an ounce appears in
// 0 of the 1,000-row production corpus, so adding one here would create a
// display unit with no comparison behind it (VISION-PIPELINE.md §9 R7,
// withdrawn 2026-07-26).
export const MEASURE_UNITS = Object.freeze(['ml', 'l', 'g', 'kg']);

const ABSENT = Object.freeze({
  status: COMPARABLE_QUANTITY_STATUS.ABSENT,
  basis: null,
  quantity: null,
  unit: null,
  pack: 1,
  unitPriceComparable: false,
  source: null,
  version: COMPARABLE_QUANTITY_VERSION,
});

const positive = (value) => Number.isFinite(value) && value > 0;

function resolved({ basis, quantity, unit, pack, unitPriceComparable, source }) {
  return Object.freeze({
    status: COMPARABLE_QUANTITY_STATUS.RESOLVED,
    basis,
    quantity,
    unit,
    pack: Math.max(1, Number(pack) || 1),
    unitPriceComparable,
    source,
    version: COMPARABLE_QUANTITY_VERSION,
  });
}

// The projection itself: parser outputs in, one shape out. Ordered — first hit
// wins — so a product that printed a magnitude is never demoted to its
// container word.
export function projectComparableQuantity(parsedSize = null, packageType = null) {
  // 1 · measure — "330 ml", "6 x 250 ml". The strongest basis: a magnitude and
  //     a unit, so both grouping and arithmetic are possible.
  if (parsedSize?.present && parsedSize.unit && positive(parsedSize.quantity)) {
    return resolved({
      basis: COMPARABLE_QUANTITY_BASIS.MEASURE,
      quantity: parsedSize.quantity,
      unit: parsedSize.unit,
      pack: parsedSize.pack,
      unitPriceComparable: true,
      source: parsedSize.source,
    });
  }

  // 2 · count — "40's", "12 Rolls", a bonus pack resolved to a piece count.
  //     The comparable fact is the integer, so the count word itself is not
  //     carried: 40 rolls and 40 pieces compare identically at 40, and
  //     `parsePackageSize()` has already collapsed both to a count for display.
  if (parsedSize?.present && positive(parsedSize.count)) {
    return resolved({
      basis: COMPARABLE_QUANTITY_BASIS.COUNT,
      quantity: parsedSize.count,
      unit: 'piece',
      pack: parsedSize.pack,
      unitPriceComparable: true,
      source: parsedSize.source,
    });
  }

  // 3 · container — "bag", "carton". Admits the product; supports grouping but
  //     NOT arithmetic, which is the whole reason `unitPriceComparable` is a
  //     separate bit.
  if (packageType?.id) {
    return resolved({
      basis: COMPARABLE_QUANTITY_BASIS.CONTAINER,
      quantity: null,
      unit: packageType.id,
      pack: 1,
      unitPriceComparable: false,
      source: 'package_type',
    });
  }

  return ABSENT;
}

// Convenience adapter for callers holding a raw observation rather than parser
// output. Parses, then projects. Callers that already hold a Structured Product
// should use `comparableQuantityFromStructured` instead and parse once.
export function resolveComparableQuantity({
  size = null,
  name = null,
  packCount = null,
  packageType = null,
} = {}) {
  return projectComparableQuantity(
    parsePackageSize({ size, name, packCount }),
    resolvePackageType(packageType),
  );
}

// The Structured Product already holds both parser outputs (`size` is
// `parsePackageSize()` output, `package_type` is `resolvePackageType()` output),
// so this re-parses nothing.
export function comparableQuantityFromStructured(structured) {
  return projectComparableQuantity(
    structured?.size ?? null,
    structured?.package_type ?? null,
  );
}
