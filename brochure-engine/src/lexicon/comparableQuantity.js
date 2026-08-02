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
//   reference: { … } | null   — enough quantity to do ARITHMETIC on it
//
// A carton with no printed magnitude is a real, comparable product: a shopper
// can group it with other cartons and compare prices. It is not a product you
// can compute a price-per-litre for. Collapsing these two bits would let a later
// stage divide a price by "1 bag"; keeping them apart is why the gate can be
// generous without the unit-price ranker becoming wrong.
//
// --- v4 · THREE ORTHOGONAL FACTS, NOT ONE ------------------------------------
//
// v3 modelled a per-kilo price as a distinct PRICING MODE, with a `pricing`
// bit ('per_pack' | 'per_unit') telling consumers which arithmetic to use. That
// was wrong, and measurably so: both branches reduce to ONE division once the
// quantity is expressed in the unit a shopper compares in, and the bit existed
// only because `parseSize` stores grams/millilitres while a price basis stores
// kilograms/litres. Worse, treating it as a mode produced a real defect — the
// promotion path scaled the price by a multi-buy and refused to scale a stated
// denominator, so "buy 2 get 1" on a per-kilo product reported EIGHT SAR/kg
// against an undiscounted four.
//
// The three facts that genuinely vary independently:
//
//   reference    — WHAT IS THE DENOMINATOR? `{ quantity, unit }`, or null when
//                  no arithmetic is possible. The ONLY input to a unit price.
//   sellingMode  — 'discrete' (you buy whole things: a bag, a carton, one
//                  lettuce) or 'continuous' (you buy an amount you choose).
//                  This is what a cart needs to know: count or measure.
//   evidence     — WHERE the reference came from: a printed measure, a count, a
//                  price basis, a container word, the product class.
//
// A reference quantity asserts NOTHING about packaging or about how much the
// shopper buys. A 1.7 kg bag has reference 1.7 kg; loose potatoes at 4 SAR/kg
// have reference 1 kg; neither is a purchased quantity. That the bag's
// reference happens to equal its contents is a coincidence, not an identity —
// "olives per 100 g sold in a 400 g tub" has a 0.1 kg reference and 0.4 kg of
// contents, and both are true at once.
//
// `package_type` stays where it was and answers the third question — what is it
// packed IN — so nothing here needs a 'bag' vs 'piece' distinction. Encoding it
// again in `sellingMode` would put one fact in the model twice, which is the
// mistake v3 made with `pricing`.
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
import { PRICE_BASIS_STATUS, resolvePriceBasis } from './priceBasis.js';

// v2 (2026-07-30) adds the UNIT basis for non-grocery stock. The version is
// bumped rather than edited because every stored projection must stay
// attributable to the rule that produced it — a v1 `ABSENT` on a television and
// a v2 `RESOLVED/unit` on the same television are both correct answers to
// different questions, and a shared version string would make that
// indistinguishable forever.
//
// v3 (2026-08-02) adds the PRICE_BASIS basis. Same argument, same bump: a
// per-kilo apple is v2-ABSENT and v3-RESOLVED, and both verdicts are correct
// answers to different questions.
//
// v4 (2026-08-02) splits the output into `reference` / `sellingMode` /
// `evidence` and DELETES `pricing`. The stored `evidence` values are byte-
// identical to v3's `basis` values, so `offer_acceptance_verdicts.quantity_basis`
// keeps its meaning and needs no migration; the version still bumps because the
// SHAPE changed and a v3 reader must not silently mis-read a v4 row.
export const COMPARABLE_QUANTITY_VERSION = 'comparable-quantity-v4';

export const COMPARABLE_QUANTITY_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  ABSENT: 'ABSENT',
});

// v4 · WHERE the reference quantity came from. Renamed from `BASIS` because it
// was answering a provenance question all along, and calling it a "basis" beside
// a "price basis" made two different ideas share a word. The VALUES are
// unchanged, so every stored `quantity_basis` row keeps its meaning.
export const COMPARABLE_QUANTITY_EVIDENCE = Object.freeze({
  MEASURE: 'measure',     // a printed magnitude in a measurement unit
  COUNT: 'count',         // a printed number of countable units
  CONTAINER: 'container', // a named package with no printed magnitude
  // v2 · sold as ONE INDIVISIBLE ITEM — a television, a phone, a bag. Admits
  // the product; supports grouping and direct price comparison but NOT
  // arithmetic, exactly like CONTAINER, so `reference` stays null.
  //
  // This is not a relaxation of the M2 argument, it is the M2 argument applied
  // honestly: "without a quantity a price is a number with no denominator" is
  // true of rice and false of a television, whose denominator IS one
  // television. Two 65" TVs at 1,999 and 2,499 are already comparable, and no
  // ml/g figure would make them more so.
  UNIT: 'unit',
  // v3 · the price states its OWN denominator — "PER KG", "/PC", "للكيلو". Not
  // a package fact at all, which is why it needed a reader of its own
  // (lexicon/priceBasis.js) rather than another branch in the size parser.
  //
  // It yields a reference quantity like any other evidence — 1 kg, 0.5 kg for
  // "per 500 g" — and the division that follows is the SAME division. v3 treated
  // it as a special arithmetic; v4 treats it as a special SOURCE.
  PRICE_BASIS: 'price_basis',
  // v4 · TWO magnitude-bearing facts, from DIFFERENT fields, that disagree — a
  // stated per-kilo price beside a printed package magnitude. The product is
  // still admitted (a real, groupable product with a real price) but NO
  // reference is emitted, so nothing downstream can compute a unit price from
  // evidence the platform cannot adjudicate.
  //
  // MEASURED (2026-08-02, on the 65 live offers where the two disagree):
  // preferring the package is right 40 times and wrong 22; preferring the basis
  // inverts that. BOTH rules therefore serve a confidently wrong SAR/kg on about
  // a third of the population — "Pears Rosemary Per KG" at 1.00 SAR/kg because
  // the "10 KG" in its size field is a PURCHASE LIMIT, or "Sea Bream 200-300
  // /Kg" at 0.09 because "٣٠٠ كيلو" is OCR debris. A missing unit price is
  // recoverable; a fabricated one is not. Same discipline that withdrew the
  // grade-range guard in packageSize.js at 2 fixes for 2 regressions.
  //
  // Recorded as its own value rather than as a silent null so the population
  // stays countable in `acceptanceSummary` and `quantity_basis`: it is the
  // measurable backlog for whatever eventually adjudicates these — a purchase-
  // limit reader, a second extraction, or the human rung.
  CONTRADICTED: 'contradicted',
});

// The measurement units `parsePackageSize()` can emit. `oz` is deliberately
// absent: `matching.js` has no ounce support anywhere, and an ounce appears in
// 0 of the 1,000-row production corpus, so adding one here would create a
// display unit with no comparison behind it (VISION-PIPELINE.md §9 R7,
// withdrawn 2026-07-26).
export const MEASURE_UNITS = Object.freeze(['ml', 'l', 'g', 'kg']);

// v4 · HOW the product is sold. Two states, because only two things actually
// vary here: does a purchase get you WHOLE THINGS, or an amount you choose?
//
// Deliberately NOT four ('package' | 'weight' | 'volume' | 'piece'). Measured on
// the 43,854-row corpus, `weight` occurred with a kilogram reference 1,880 times
// out of 1,880 and `volume` with a litre reference 2 out of 2 — those two values
// ARE `reference.unit` spelled a second time, and only the discrete/continuous
// split spread across every unit. Whether a discrete thing is a bag, a carton or
// a bare lettuce is `package_type`'s question, already answered elsewhere:
// "Garlic Bag Small /Pc" is a live offer that is a BAG priced PER PIECE, and a
// mode value of 'piece' would have mis-stated it.
export const SELLING_MODE = Object.freeze({
  DISCRETE: 'discrete',     // whole units — a bag, a carton, one lettuce
  CONTINUOUS: 'continuous', // an amount the shopper chooses — loose, by weight
});

// The units a REFERENCE quantity may be expressed in. Same vocabulary the wire
// contract already uses (`offer.unitPrice.unit`), so nothing translates.
export const REFERENCE_UNITS = Object.freeze(['kg', 'l', 'piece']);

const ABSENT = Object.freeze({
  status: COMPARABLE_QUANTITY_STATUS.ABSENT,
  evidence: null,
  quantity: null,
  unit: null,
  pack: 1,
  reference: null,
  sellingMode: null,
  unitPriceComparable: false,
  source: null,
  version: COMPARABLE_QUANTITY_VERSION,
});

const positive = (value) => Number.isFinite(value) && value > 0;

function resolved({
  evidence, quantity, unit, pack, source, reference = null, sellingMode = null,
}) {
  return Object.freeze({
    status: COMPARABLE_QUANTITY_STATUS.RESOLVED,
    evidence,
    quantity,
    unit,
    pack: Math.max(1, Number(pack) || 1),
    reference: reference ? Object.freeze({ ...reference }) : null,
    sellingMode,
    // Kept as a convenience for readers that only want the yes/no, but it is now
    // DERIVED and can no longer disagree with the thing it describes. It used to:
    // a "40's" tissue pack reported `unitPriceComparable: true` while the pricing
    // function refused the same product as a weak count.
    unitPriceComparable: reference != null,
    source,
    version: COMPARABLE_QUANTITY_VERSION,
  });
}

// --- the reference projection --------------------------------------------------
// The denominator, expressed once, in the unit a shopper compares in.
//
// It reads `canonical` — `matching.js parseSize()`'s output — and NOT the printed
// magnitude beside it, for two measured reasons. It keeps the arithmetic
// byte-identical to what the engine already serves (that function has always
// divided by canonical), and canonical is simply more correct on a whole class:
// a bonus pack "10 + 2 rolls" prints as 2 and canonicalises to 12, and 661 rows
// (2.1%) differ that way. The printed magnitude remains what the shopper SEES
// (`display_en`); canonical remains what the shopper COMPARES on. Same division
// of labour packageSize.js has documented since it was written.
//
// Returns null whenever arithmetic would be dishonest — which now includes the
// weak count, inherited rather than re-implemented.
function referenceFrom(canonical) {
  if (!canonical?.unit || !positive(canonical.total)) return null;
  if (canonical.unit === 'g') return { quantity: canonical.total / 1000, unit: 'kg' };
  if (canonical.unit === 'ml') return { quantity: canonical.total / 1000, unit: 'l' };
  // A bare "6's"/"12x" suffix is enough to rank on and nowhere near enough to
  // advertise a price on (matching.js trust ladder). The gate still ADMITS such
  // a product — status and reference are separate answers.
  if (canonical.unit === 'pcs' && canonical.src !== 'count-weak') {
    return { quantity: canonical.total, unit: 'piece' };
  }
  return null;
}

// One division, every product. This is the whole of unit pricing.
const UNIT_LABEL = Object.freeze({
  kg: 'SAR/kg', l: 'SAR/L', piece: 'SAR/Piece', '100-sheets': 'SAR/100 Sheets',
});

export function unitPriceFromReference(price, reference) {
  const p = Number(price);
  const q = Number(reference?.quantity);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(q) || q <= 0) return null;
  const label = UNIT_LABEL[reference.unit];
  if (!label) return null;
  return { value: p / q, unit: reference.unit, label };
}

// Did the size parser find a printed magnitude (a measure or a real count)?
// The projection asks this in two places and they must agree exactly.
const sizePresent = (parsedSize) => !!(parsedSize?.present
  && ((parsedSize.unit && positive(parsedSize.quantity)) || positive(parsedSize.count)));

// May a resolved price basis OVERRIDE a printed package magnitude?
//
// Only when the two were read from the SAME field, and that is the whole rule.
// It separates the two cases that look identical and are not:
//
//   "CASHEW NUT SALTED W 320 /KG", size "320 /KG"  — one expression. It cannot
//       both weigh 320 kg and be priced per kilo; the "320" is a kernel grade,
//       and the basis is the only true reading. 26 live offers, previously
//       served at 0.13 SAR/kg instead of 40.99.
//
//   "Lemon Pickle/Kg", size "500 gm"               — two independent fields,
//       two independent facts: a deli line labelled by the kilo, sold in a
//       500 g tub. The tub is what the price buys, so the package wins and the
//       basis is recorded but not used. 436 live offers, all of which the
//       earlier draft of this rule would have halved.
//
// MEASURED (2026-08-01, 43,854 enriched offers): this rule changes 26 already-
// served unit prices, every one of them a correction; the previous rule changed
// 462 and broke most of them.
function basisOverridesPackage(priceBasis, parsedSize) {
  if (!sizePresent(parsedSize)) return true;
  return !!priceBasis.source && priceBasis.source === parsedSize.source;
}

// Do a package reference and a stated basis answer the SAME question the same
// way? Tolerance is 3%, the figure `matching.js sizeContradicts()` already uses
// to decide that two sizes are the same size — one tolerance for "these agree",
// not a second one invented here.
function referencesAgree(packReference, priceBasis) {
  if (packReference.unit !== priceBasis.unit) return false;
  const a = packReference.quantity;
  const b = priceBasis.quantity;
  if (!positive(a) || !positive(b)) return false;
  return Math.abs(a - b) / Math.max(a, b) <= 0.03;
}

// The projection itself: parser outputs in, one shape out. Ordered — first hit
// wins — so a product that printed a magnitude is never demoted to its
// container word.
export function projectComparableQuantity(parsedSize = null, packageType = null, {
  nonGrocery = false, priceBasis = null,
} = {}) {
  const basisResolved = priceBasis?.status === PRICE_BASIS_STATUS.RESOLVED;
  const basisProjection = () => resolved({
    evidence: COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS,
    quantity: priceBasis.quantity,
    unit: priceBasis.unit,
    pack: 1,
    // The stated denominator IS the reference — no conversion, because the
    // reader already emits kg/l/piece.
    reference: { quantity: priceBasis.quantity, unit: priceBasis.unit },
    // A price per kilogram or litre can only belong to something sold by an
    // amount the shopper chooses; you cannot buy "one 1 kg" as an object. A
    // price per PIECE is the opposite — it names a whole thing.
    sellingMode: priceBasis.unit === 'piece'
      ? SELLING_MODE.DISCRETE
      : SELLING_MODE.CONTINUOUS,
    source: `price_basis:${priceBasis.source}`,
  });

  // 0 · a MEASURE price basis — "PER KG", "/KG", "per 500 g", "للكيلو". Ahead of
  //     the package measure, because a stated denominator and a printed package
  //     are the same KIND of fact and the flyer told us which one the price is
  //     against — but ONLY when the two came out of the same expression, which
  //     is the one case where they cannot both be true.
  //
  //     A PIECE basis deliberately does NOT sit here — see step 3.
  if (basisResolved && priceBasis.unit !== 'piece') {
    if (basisOverridesPackage(priceBasis, parsedSize)) return basisProjection();
    // Two magnitude-bearing facts from different fields. They are only in
    // CONFLICT if they disagree about the answer — and measured on the live
    // catalogue, 204 of 261 such pairs AGREE: "BLACK CHANA /KG" beside
    // `size: "1 kg"` is one fact stated twice, not two facts fighting. Refusing
    // those would withdraw 204 unit prices that were never in doubt.
    //
    // Only the 57 that genuinely disagree are refused (see CONTRADICTED above).
    // "Refuse rather than guess" applies where there IS a guess to make.
    const packReference = referenceFrom(parsedSize.canonical);
    if (packReference && !referencesAgree(packReference, priceBasis)) {
      return resolved({
        evidence: COMPARABLE_QUANTITY_EVIDENCE.CONTRADICTED,
        // The printed magnitude is still what a shopper SEES on the card, so it
        // stays as the display quantity. Only the arithmetic is withheld.
        quantity: parsedSize.quantity ?? null,
        unit: parsedSize.unit ?? null,
        pack: parsedSize.pack,
        reference: null,
        // The two facts disagree about this too — a per-kilo price says
        // continuous, a printed package says discrete. Unknown, not guessed.
        sellingMode: null,
        source: `contradicted:${priceBasis.source}|${parsedSize.source}`,
      });
    }
    // A printed magnitude that canonicalises to nothing leaves the basis as the
    // only reference there is; nothing to contradict it.
    if (!packReference) return basisProjection();
    // They agree — fall through to the package branches below, which carry the
    // richer display fields. Either reference would give the same number.
  }

  // 1 · measure — "330 ml", "6 x 250 ml". A magnitude and a unit, so both
  //     grouping and arithmetic are possible.
  if (parsedSize?.present && parsedSize.unit && positive(parsedSize.quantity)) {
    return resolved({
      evidence: COMPARABLE_QUANTITY_EVIDENCE.MEASURE,
      quantity: parsedSize.quantity,
      unit: parsedSize.unit,
      pack: parsedSize.pack,
      reference: referenceFrom(parsedSize.canonical),
      // A printed magnitude means a pre-defined thing: you buy the 330 ml can,
      // not 330 ml of it.
      sellingMode: SELLING_MODE.DISCRETE,
      source: parsedSize.source,
    });
  }

  // 2 · count — "40's", "12 Rolls", a bonus pack resolved to a piece count.
  //     The comparable fact is the integer, so the count word itself is not
  //     carried: 40 rolls and 40 pieces compare identically at 40, and
  //     `parsePackageSize()` has already collapsed both to a count for display.
  if (parsedSize?.present && positive(parsedSize.count)) {
    return resolved({
      evidence: COMPARABLE_QUANTITY_EVIDENCE.COUNT,
      quantity: parsedSize.count,
      unit: 'piece',
      pack: parsedSize.pack,
      // May be null: a bare "6's" is admissible as a count and refused as a
      // denominator, and that refusal now lives in ONE place.
      reference: referenceFrom(parsedSize.canonical),
      sellingMode: SELLING_MODE.DISCRETE,
      source: parsedSize.source,
    });
  }

  // 3 · a PIECE price basis — "/PC", "Per Pcs", "للحبة". BELOW measure and
  //     count on purpose. "ENTAJ FRESH WHOLE CHICKEN CUT UP 800 GM" arrives with
  //     `unit: "Each"` beside a real 800 g package: both are true, and SAR/kg is
  //     strictly the more useful of the two answers. A piece basis carries no
  //     magnitude, so it may fill a gap but must never displace one that does.
  //
  //     NON-GROCERY IS EXCLUDED. "Samsung 65 inch TV Each" would resolve here
  //     on a perfectly real per-piece basis and then advertise a unit price
  //     identical to the price — precisely the "number that merely looks like a
  //     unit price" the UNIT basis below refuses to compute. A television's
  //     denominator is already one television; saying so twice does not make it
  //     more comparable, and it would silently reclassify every as-is
  //     non-grocery verdict away from the basis that explains it.
  if (basisResolved && priceBasis.unit === 'piece' && !nonGrocery) {
    return basisProjection();
  }

  // 4 · container — "bag", "carton". Admits the product; supports grouping but
  //     NOT arithmetic, which is the whole reason `unitPriceComparable` is a
  //     separate bit.
  if (packageType?.id) {
    return resolved({
      evidence: COMPARABLE_QUANTITY_EVIDENCE.CONTAINER,
      quantity: null,
      unit: packageType.id,
      pack: 1,
      // A named container with no magnitude: groupable, not divisible.
      reference: null,
      sellingMode: SELLING_MODE.DISCRETE,
      source: 'package_type',
    });
  }

  // 5 · unit (v2) — LAST, and last on purpose. A non-grocery product that DID
  //     print a real magnitude keeps it: a 1.7 l kettle and a 7 kg washing
  //     machine are genuinely measure-comparable, and 627 live non-grocery
  //     offers currently resolve that way. This branch is a floor for the ones
  //     that print nothing at all, never a ceiling on the ones that do.
  if (nonGrocery) {
    return resolved({
      evidence: COMPARABLE_QUANTITY_EVIDENCE.UNIT,
      quantity: 1,
      unit: 'item',
      pack: 1,
      // Grouping and price comparison: yes. Price-per-unit arithmetic: no —
      // dividing by "1 item" would produce a number that merely looks like a
      // unit price, which is worse than declining to compute one.
      reference: null,
      sellingMode: SELLING_MODE.DISCRETE,
      source: 'product_class',
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
  // Defaults false, so every existing caller keeps v1 behaviour exactly.
  nonGrocery = false,
  // v3 · the extractor's `unit` field and any further free text (the Arabic
  // display name, the offer's own OCR). Both default to null, so a caller that
  // supplies neither gets exactly v2 behaviour plus whatever basis the name and
  // size field alone can prove.
  unit = null,
  text = null,
} = {}) {
  // The parser runs FIRST and its verdict is an input to the basis reader: a
  // bare "KG" is a basis on "SALMON FILLET KG" and the unit of a magnitude on
  // "AL OSRA SUGAR 10KG", and only the parser can tell the two apart.
  const parsedSize = parsePackageSize({
    // The class reaches the PARSER too, not just the projection: on a phone it
    // is what stops a trailing "5G" becoming five grams and winning the measure
    // branch before the unit branch is ever reached. Passing it to only one of
    // the two would leave mobiles — the directive's own first example —
    // resolving on a fabricated mass.
    size, name, packCount, nonGrocery,
  });
  return projectComparableQuantity(
    parsedSize,
    resolvePackageType(packageType),
    {
      nonGrocery,
      priceBasis: resolvePriceBasis({
        unit, size, name, text, sizeResolved: sizePresent(parsedSize),
      }),
    },
  );
}

// The Structured Product already holds both parser outputs (`size` is
// `parsePackageSize()` output, `package_type` is `resolvePackageType()` output),
// so this re-parses nothing.
//
// The basis is read from the Structured Product's OBSERVED fields — the
// verbatim strings the extractor returned — because that is where a basis
// expression survives. `structured.size` is the parsed size and by construction
// holds no basis: "Per Kg" produced no magnitude, which is the entire bug.
export function comparableQuantityFromStructured(structured, {
  nonGrocery = false, unit = null, text = null,
} = {}) {
  const parsedSize = structured?.size ?? null;
  return projectComparableQuantity(
    parsedSize,
    structured?.package_type ?? null,
    {
      nonGrocery,
      priceBasis: resolvePriceBasis({
        unit,
        size: structured?.observed?.size ?? null,
        name: structured?.observed?.name_en ?? null,
        text,
        sizeResolved: sizePresent(parsedSize),
      }),
    },
  );
}
