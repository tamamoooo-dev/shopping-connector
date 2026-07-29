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
  { label: 'g', en: ['grams', 'gram', 'gms', 'gm', 'gr', 'g', 'جم', 'جرام', 'غرام', 'غم'], ar: 'جم', unit: 'g' },
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
const MEASURE_PACK_RE = new RegExp(`(${NUM})\\s*(${MEASURE_ALT})(?![a-z])\\s*x\\s*(\\d{1,3})`, 'iu');
// "330 ml", "5kg", "190G"
const MEASURE_RE = new RegExp(`(${NUM})\\s*(${MEASURE_ALT})(?![a-z])`, 'iu');
// "40's", "12 Rolls", "6 pcs"
const COUNT_WORD_RE = new RegExp(`(\\d{1,3})\\s*(${COUNT_ALT})(?![a-z])`, 'iu');
const APOSTROPHE_COUNT_RE = /(\d{1,3})\s*['’]s(?![a-z])/iu;

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
function readPrinted(sizeField, name) {
  for (const [source, raw] of [['size_field', sizeField], ['name', name]]) {
    const text = foldSizeText(raw);
    if (!text) continue;

    const packMeasure = PACK_MEASURE_RE.exec(text);
    if (packMeasure) {
      const unit = measureFor(packMeasure[3]);
      if (unit) return { source, kind: 'pack_measure', quantity: number(packMeasure[2]), unit, pack: Number(packMeasure[1]), printed: packMeasure[0].trim() };
    }
    const measurePack = MEASURE_PACK_RE.exec(text);
    if (measurePack) {
      const unit = measureFor(measurePack[2]);
      if (unit) return { source, kind: 'pack_measure', quantity: number(measurePack[1]), unit, pack: Number(measurePack[3]), printed: measurePack[0].trim() };
    }
    const measure = MEASURE_RE.exec(text);
    if (measure) {
      const unit = measureFor(measure[2]);
      if (unit) return { source, kind: 'measure', quantity: number(measure[1]), unit, pack: 1, printed: measure[0].trim() };
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
//   display_en — the shopper-facing English label
//   display_ar — the shopper-facing Arabic label
//   canonical  — matching.js parseSize() output, unchanged (the comparison view)
export function parsePackageSize({ size = null, name = null, packCount = null } = {}) {
  const canonical = parseSize(name || '', [size, packCount].filter(Boolean).join(' '));
  const printed = readPrinted(size, name) || readPrinted(packCount, null);
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
