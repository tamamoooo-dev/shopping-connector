// lexicon/packageSize.js — the PACKAGE SIZE PARSER: the printed sale size as
// structured data, plus its Arabic rendering.
//
// Phase 2 of the post-extraction lexicon work (HISTORY §47). Third layer of the
// pipeline, after the Brand Lexicon (§45) and the Shopping Lexicon.
//
// WHY THIS EXISTS ALONGSIDE matching.js parseSize(). `parseSize()` answers a
// COMPARISON question — it converts every spelling to ONE base unit so two
// offers can be ranked by unit price ("1 Ltr" and "1000 ml" must both become
// 1000 ml). That is exactly the wrong answer for DISPLAY: a shopper reading
// "١٠٠٠ مل" of milk when the bottle says 1 Ltr is a worse label than the one
// the flyer printed. So this module reads the PRINTED magnitude and unit, and
// delegates the comparable numbers to parseSize() unchanged.
//
// There is deliberately NO third interpretation of a size anywhere in the
// project: `canonical` below IS parseSize()'s output, and nothing here
// recomputes a total, a pack count or a unit conversion. If the two ever
// disagree about whether a size exists, parseSize() wins (`present`).
//
// FAILURE MODE: "no size", never "invented size". Nothing is derived from a
// number that the crop did not print.

import { parseSize } from '../matching.js';

export const PACKAGE_SIZE_VERSION = 'package-size-v1';

// Printed measurement units -> the canonical Arabic unit word. Keys are
// lowercase and punctuation-free; the ORDER matters only within a shared
// prefix (longest first), so the alternation never truncates a word.
// `label` is the English word the display uses; `en` are the spellings the
// parser accepts, INCLUDING the Arabic ones — a size field can arrive in either
// script ("٥٠٠ مل"), and a size is the one field where that is common.
const MEASURE_UNITS = [
  { label: 'L', en: ['litres', 'litre', 'liters', 'liter', 'ltr', 'lt', 'l', 'لتر', 'ليتر'], ar: 'لتر', unit: 'l' },
  { label: 'ml', en: ['ml', 'millilitre', 'milliliter', 'مل', 'مليلتر'], ar: 'مل', unit: 'ml' },
  { label: 'kg', en: ['kgs', 'kg', 'kilos', 'kilo', 'kilogram', 'كجم', 'كغم', 'كيلو', 'كيلوجرام'], ar: 'كجم', unit: 'kg' },
  // ORDER IS LOAD-BEARING within a shared prefix: longest first, so 'grm' is
  // tried before 'gr' and the Arabic 'غرام'/'غم' before the bare 'غ'. Getting
  // this wrong truncates the word and silently changes the magnitude's unit.
  // `grm`/`غ` added 2026-08-02: both appear in the live corpus ("700 GRM",
  // "450 غ") and `matching.js unitFor()` already accepted them, so the PRINTED
  // reader was refusing sizes the COMPARISON reader could read — the two must
  // not disagree about whether a size exists.
  { label: 'g', en: ['grams', 'gram', 'grms', 'grm', 'gms', 'gm', 'gr', 'g', 'جم', 'جرام', 'غرام', 'غم', 'غ'], ar: 'جم', unit: 'g' },
];

// Count words -> Arabic singular/plural. Arabic numeral agreement is a real
// grammar rule, not decoration: 3–10 takes the PLURAL, 1–2 and 11+ take the
// SINGULAR ("6 حبات" but "40 حبة"). Deterministic, so it lives here.
const COUNT_UNITS = [
  { en: ['pieces', 'piece', 'pcs', 'pc'], one: 'حبة', few: 'حبات' },
  { en: ['rolls', 'roll'], one: 'لفة', few: 'لفات' },
  { en: ['tablets', 'tablet', 'tabs', 'tab'], one: 'قرص', few: 'أقراص' },
  { en: ['capsules', 'capsule'], one: 'كبسولة', few: 'كبسولات' },
  { en: ['sachets', 'sachet'], one: 'ظرف', few: 'أظرف' },
  { en: ['bottles', 'bottle'], one: 'قارورة', few: 'قوارير' },
  { en: ['cans', 'can'], one: 'علبة', few: 'علب' },
  { en: ['bags', 'bag'], one: 'كيس', few: 'أكياس' },
  { en: ['diapers', 'diaper'], one: 'حفاضة', few: 'حفاضات' },
  { en: ['packs', 'pack', 'pk'], one: 'عبوة', few: 'عبوات' },
  { en: ['portions', 'portion', 'servings', 'serving'], one: 'حصة', few: 'حصص' },
];

const DEFAULT_COUNT = Object.freeze({ one: 'حبة', few: 'حبات' });

const MEASURE_BY_KEY = new Map(MEASURE_UNITS.flatMap((u) => u.en.map((k) => [k, u])));
const COUNT_BY_KEY = new Map(COUNT_UNITS.flatMap((u) => u.en.map((k) => [k, u])));

const MEASURE_ALT = MEASURE_UNITS.flatMap((u) => u.en).join('|');
const COUNT_ALT = COUNT_UNITS.flatMap((u) => u.en).join('|');

// Arabic-Indic digits are folded to ASCII for parsing. The Arabic RENDERING
// keeps ASCII digits too: that is what Saudi flyers, store apps and the
// project's own Arabic aisle labels print, and it keeps a built name
// byte-comparable with the size strings already stored on offers.
const AR_INDIC = /[٠-٩۰-۹]/gu;
function asciiDigits(value) {
  return String(value || '').replace(AR_INDIC, (d) => {
    const code = d.codePointAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

function foldSizeText(value) {
  return asciiDigits(value)
    .toLowerCase()
    .replace(/[ـً-ْ]/gu, '')
    .replace(/[×*]/gu, 'x')
    .replace(/\s+/gu, ' ')
    .trim();
}

const NUM = '\\d+(?:[.,]\\d+)?';
// "6 x 250 ml" / "2 X 1.5 Ltr" — a pack multiplier followed by a measurement.
const PACK_MEASURE_RE = new RegExp(`(\\d{1,3})\\s*x\\s*(${NUM})\\s*(${MEASURE_ALT})(?![a-z])`, 'iu');
// "250 ml x 6" — the reverse spelling.
//
// NO `(?![a-z])` HERE, unlike the plain measure below. That guard exists to stop
// a short unit matching the head of a longer word ('g' inside 'gram'), and the
// required `x<digits>` suffix already provides that boundary. With the guard in
// place the multiplier itself defeated the match — `foldSizeText` turns `×`/`*`
// into `x`, so "360ml×24" and "٤٠٠ جرام*٢" fold to "360mlx24" and "400 جرام x2",
// whose unit is followed by an ASCII letter. Measured: those two spellings alone
// account for live rows whose pack size the printed reader could not see.
const MEASURE_PACK_RE = new RegExp(`(${NUM})\\s*(${MEASURE_ALT})\\s*x\\s*(\\d{1,3})`, 'iu');
// "330 ml", "5kg", "190G"
const MEASURE_RE = new RegExp(`(${NUM})\\s*(${MEASURE_ALT})(?![a-z])`, 'iu');
// "40's", "12 Rolls", "6 pcs"
const COUNT_WORD_RE = new RegExp(`(\\d{1,3})\\s*(${COUNT_ALT})(?![a-z])`, 'iu');
const APOSTROPHE_COUNT_RE = /(\d{1,3})\s*['’]s(?![a-z])/iu;

// --- network generations are not grams ----------------------------------------
//
// "Vivo Y31s 8GB/256GB 5G" resolved to a confidently well-formed FIVE GRAMS,
// because MEASURE_RE reads the trailing `5G` exactly as it reads `190G`.
// `comparableQuantity.js` documents this as the known ceiling ("HONOR 5G
// projects to a perfectly well-formed 5 g"); measured 2026-07-30 it is not
// theoretical — 235 live offers carry a name-derived `5g`, and 80 of them are
// S4-ACCEPTED on it, i.e. servable with a five-gram denominator.
//
// WHY THE GUARD IS NARROW. `5 g` is a perfectly real grocery size — yeast,
// saffron, spice sachets — so `Ng` can NEVER be banned outright. Only two
// things distinguish the cellular sense, and both are required to be safe:
//
//   1 · the number is a network generation (2/3/4/5) and the unit is bare `g`
//   2 · AND the surrounding text is a device — either it carries another device
//       specification, or the caller told us the product class is non-grocery
//
// A yeast sachet satisfies neither. A phone satisfies at least one: measured on
// the 291 live cases, 143 carry a `GB`/`mAh`/`RAM` token in the name and the
// remaining 148 ("Oppo A6T 5G", "Samsung Tab A11+ 5G") are caught by the
// product class. Neither signal alone is sufficient, which is exactly why both
// are here.
const NETWORK_GENERATION_RE = /^[2-5]$/;
// Storage, battery, camera, refresh rate, cellular radio — the company `5G`
// keeps. Deliberately NOT a general "has a number" test.
const DEVICE_SPEC_RE = /\d+\s*gb\b|\d+\s*tb\b|\d+\s*mah\b|\d+\s*mp\b|\d+\s*hz\b|\blte\b|\bwifi\b|\bram\b|\brom\b|\bdual\s*sim\b/iu;

/**
 * True when a `MEASURE_RE` hit is a cellular generation rather than a mass.
 * `unitKey` is the RAW matched unit text, so `5G`/`5g` qualify and `5kg` — a
 * different unit entirely — never reaches this test as a candidate.
 */
function isNetworkGeneration(quantityText, unitKey, text, nonGrocery) {
  if (!NETWORK_GENERATION_RE.test(String(quantityText).trim())) return false;
  if (String(unitKey).trim().toLowerCase() !== 'g') return false;
  return nonGrocery || DEVICE_SPEC_RE.test(text);
}

// --- KNOWN RESIDUAL: a grade range that carries its own unit -------------------
//
// "SHRIMP 50 / 60 KG" is a grade (pieces per kilo) priced by the kilo, and
// MEASURE_RE reads the 60 as a sixty-kilo package. A guard for `N-N UNIT` was
// built and MEASURED against the live catalogue on 2026-08-02, then withdrawn:
// it corrected 2 offers and broke 2 others, because "Ethiopian Lamb Whole
// (7 - 9 Kg)" and "Alyoum Fresh Chicken (1100/1200g)" use the identical
// notation for the true weight of the single item being sold, priced as an
// item. The two readings are structurally indistinguishable and the project
// refuses to guess (see the `5G` guard above, which ships only because TWO
// independent signals separate the cases).
//
// Most of this class is already handled without a parser change: wherever the
// grade sits beside an explicit basis marker ("Sea Bream 200-300 /Kg",
// "CASHEW W320/KG"), `lexicon/priceBasis.js` reads the marker and the price
// basis outranks the fabricated magnitude. What remains is the handful whose
// range and unit touch with no marker at all. Written down rather than hidden.

// --- a package that holds TWO different magnitudes ------------------------------
//
// "MELLO GLASS CLEANER 2 x 650ml + 400ml FREE" is a real live size expression,
// and the printed reader sees only its first term: pack 2 of 650 ml. What the
// shopper carries home is three bottles and 1.7 litres, so BOTH the pack count
// and the total are understated.
//
// This flag does not repair either number — the unit price for these rows is
// knowingly left exactly as it is served today (a repair would change 270-odd
// live values and needs its own measurement). It exists so that a consumer which
// must not be wrong about "one item" can decline: a per-item price computed from
// pack 2 would advertise 11.49 SAR for a bottle in a pack that also contains a
// different bottle.
//
// THE CONNECTOR IS THE WHOLE RULE, and it is `+` alone:
//
//   "2 x 650ml + 400ml FREE"  — ADDITION. Two different things in one package.
//   "5 x 83g / 90g"           — ALTERNATIVE. One packet, printed either way,
//                               because the flyer covers two flavours. Measured
//                               on the live catalogue this spelling is common
//                               and its per-item price (7.50 / 5 = 1.50) is
//                               correct, so a `/` must never raise the flag.
//
// A `+` that joins COUNTS rather than measures is likewise not this case:
// "300mL (2 + 1 FREE)" is three identical 300 ml cans and "10 + 2 rolls" is
// twelve identical rolls — `matching.js` bonusPack() already resolves both, and
// they are homogeneous packages whatever the total turns out to be. So the test
// requires a second MEASURE, not merely a second number.
function isHeterogeneous(text) {
  const segments = String(text).split('+');
  if (segments.length < 2) return false;
  const magnitudes = [];
  for (const segment of segments) {
    const m = MEASURE_RE.exec(segment);
    if (!m) continue;
    const unit = measureFor(m[2]);
    if (!unit) continue;
    // Compared in ONE base unit per family, so "2 x 1.5L + 500ML" is seen for
    // what it is: 1500 against 500, not 1.5 against 500.
    const base = unit.unit === 'l' || unit.unit === 'kg' ? 1000 : 1;
    magnitudes.push({ value: number(m[1]) * base, family: unit.unit === 'l' || unit.unit === 'ml' ? 'volume' : 'mass' });
  }
  if (magnitudes.length < 2) return false;
  return magnitudes.some((a) => magnitudes.some((b) => a.family === b.family && a.value !== b.value));
}

const number = (raw) => Number.parseFloat(String(raw).replace(',', '.'));

// Trailing ".0" is noise on a shelf label: 1.0 L reads as 1 L.
function formatNumber(value) {
  if (!Number.isFinite(value)) return null;
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

function measureFor(key) {
  return MEASURE_BY_KEY.get(String(key).toLowerCase()) ?? null;
}

// The printed size, read from the model's size field first and the English name
// second. Field-first is deliberate: the extractor typed that field as a size,
// so it needs no disambiguation, while a name can also contain a model number.
function readPrinted(sizeField, name, { nonGrocery = false, context = '' } = {}) {
  for (const [source, raw] of [['size_field', sizeField], ['name', name]]) {
    const text = foldSizeText(raw);
    if (!text) continue;
    // The device signal is read from the WHOLE product context, not just the
    // fragment being parsed: a model that put "5G" in the size field alone
    // ("size": "5G") gives that field no device markers of its own, while the
    // name beside it is unmistakably a phone. Measured: 14 of the live false
    // positives arrived exactly that way.
    const deviceText = `${text} ${context}`;

    // Computed from the expression the reading is taken FROM, so the flag always
    // describes the same text as the magnitude beside it.
    const heterogeneous = isHeterogeneous(text);

    const packMeasure = PACK_MEASURE_RE.exec(text);
    if (packMeasure) {
      const unit = measureFor(packMeasure[3]);
      if (unit) return { source, kind: 'pack_measure', quantity: number(packMeasure[2]), unit, pack: Number(packMeasure[1]), printed: packMeasure[0].trim(), heterogeneous };
    }
    const measurePack = MEASURE_PACK_RE.exec(text);
    if (measurePack) {
      const unit = measureFor(measurePack[2]);
      if (unit) return { source, kind: 'pack_measure', quantity: number(measurePack[1]), unit, pack: Number(measurePack[3]), printed: measurePack[0].trim(), heterogeneous };
    }
    const measure = MEASURE_RE.exec(text);
    if (measure) {
      const unit = measureFor(measure[2]);
      // A network generation is refused OUTRIGHT rather than falling through to
      // the count branches: "5G" is not a count either, and letting it continue
      // would only swap one invented quantity for another.
      if (unit && !isNetworkGeneration(measure[1], measure[2], deviceText, nonGrocery)) {
        return { source, kind: 'measure', quantity: number(measure[1]), unit, pack: 1, printed: measure[0].trim(), heterogeneous };
      }
    }
    const countWord = COUNT_WORD_RE.exec(text);
    if (countWord) {
      return {
        source, kind: 'count', quantity: Number(countWord[1]), unit: null, pack: Number(countWord[1]),
        countUnit: COUNT_BY_KEY.get(String(countWord[2]).toLowerCase()) ?? DEFAULT_COUNT, printed: countWord[0].trim(),
      };
    }
    const apostrophe = APOSTROPHE_COUNT_RE.exec(text);
    if (apostrophe) {
      return {
        source, kind: 'count', quantity: Number(apostrophe[1]), unit: null, pack: Number(apostrophe[1]),
        countUnit: DEFAULT_COUNT, printed: apostrophe[0].trim(),
      };
    }
  }
  return null;
}

// Arabic count agreement (see COUNT_UNITS): 3–10 plural, everything else
// singular.
function countWordFor(count, countUnit = DEFAULT_COUNT) {
  return count >= 3 && count <= 10 ? countUnit.few : countUnit.one;
}

// --- the entry point -----------------------------------------------------------
// Returns null when nothing was printed — never a zero, never a guess.
//
//   quantity   — the printed magnitude of ONE unit (330 for "6 x 330 ml")
//   unit       — 'ml' | 'l' | 'g' | 'kg' | null (null = a countable package)
//   pack       — how many units the package holds (1 when not a multipack)
//   printed    — the source expression, verbatim-ish (folded, lowercased)
//   heterogeneous — the expression ADDS a second, different magnitude
//                ("2 x 650ml + 400ml FREE"), so `quantity`/`pack` describe only
//                its first term. Reported, never repaired (see isHeterogeneous).
//   display_en — the shopper-facing English label
//   display_ar — the shopper-facing Arabic label
//   canonical  — matching.js parseSize() output, unchanged (the comparison view)
// `nonGrocery` is DISAMBIGUATION CONTEXT, not policy. It never changes what a
// magnitude means; it only tells the reader that a bare `5G` on this product is
// a radio, not five grams — the same kind of hint `size_field`-before-`name`
// precedence already encodes. Callers that do not know the product class omit
// it and get byte-identical behaviour to before this option existed.
export function parsePackageSize({
  size = null, name = null, packCount = null, nonGrocery = false,
} = {}) {
  const canonical = parseSize(name || '', [size, packCount].filter(Boolean).join(' '));
  const context = `${name || ''} ${size || ''}`;
  const printed = readPrinted(size, name, { nonGrocery, context })
    || readPrinted(packCount, null, { nonGrocery, context });
  if (!printed) {
    if (!canonical?.unit) return null;
    // A bonus pack ("8 + 2") prints no unit word, so nothing above matches it —
    // but parseSize() already resolved it to a piece count, and a COUNT needs
    // no unit conversion, so rendering it here cannot misstate the package the
    // way converting 1 Ltr to 1000 ml would. Measures are deliberately left
    // undisplayed instead of being back-converted.
    //
    // `src === 'count'` is load-bearing, not defensive: parseSize's trust ladder
    // marks a bare "…26s" suffix 'count-weak', and the model code NRF110N26S
    // reaches here as a 26-piece pack if that distinction is ignored. A weak
    // count is comparable enough to rank on and nowhere near good enough to
    // print on a product card.
    if (canonical.unit === 'pcs' && canonical.src !== 'count') return null;
    const count = canonical.unit === 'pcs' && canonical.pack > 1 ? canonical.pack : null;
    return {
      present: true,
      quantity: null,
      unit: null,
      count,
      pack: canonical.pack ?? 1,
      printed: null,
      // Nothing was printed to be heterogeneous ABOUT: this branch exists because
      // no measure expression matched at all.
      heterogeneous: false,
      source: 'canonical',
      display_en: count ? `${count} pcs` : null,
      display_ar: count ? `${count} ${countWordFor(count)}` : null,
      canonical,
      version: PACKAGE_SIZE_VERSION,
    };
  }

  // A pack count the model reported separately can only ADD information: it
  // never overrides a multiplier the crop itself printed.
  const explicitPack = printed.kind === 'measure' && canonical?.pack > 1 ? canonical.pack : printed.pack;
  const pack = Math.max(1, explicitPack || 1);
  const quantityText = formatNumber(printed.quantity);

  let display_en = null;
  let display_ar = null;
  if (printed.kind === 'count') {
    display_en = `${printed.quantity} ${printed.quantity === 1 ? 'pc' : 'pcs'}`;
    display_ar = `${printed.quantity} ${countWordFor(printed.quantity, printed.countUnit)}`;
  } else if (quantityText && printed.unit) {
    const base = `${quantityText} ${printed.unit.label}`;
    const baseAr = `${quantityText} ${printed.unit.ar}`;
    display_en = pack > 1 ? `${pack} x ${base}` : base;
    display_ar = pack > 1 ? `${pack} × ${baseAr}` : baseAr;
  }

  return {
    present: true,
    quantity: printed.kind === 'count' ? null : printed.quantity,
    unit: printed.unit?.unit ?? null,
    count: printed.kind === 'count' ? printed.quantity : null,
    pack,
    printed: printed.printed,
    heterogeneous: !!printed.heterogeneous,
    source: printed.source,
    display_en,
    display_ar,
    canonical,
    version: PACKAGE_SIZE_VERSION,
  };
}

// The Arabic label alone, for callers that already hold a parsed size.
export function formatSizeArabic(parsed) {
  return parsed?.display_ar ?? null;
}
