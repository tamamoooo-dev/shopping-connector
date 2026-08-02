// lexicon/priceBasis.js — the PRICE BASIS reader: what does this printed price
// actually buy?
//
// WHY THIS EXISTS. Saudi flyers price in two different modes, and until now the
// project modelled only one of them:
//
//   PACK pricing   "ALMARAI HALLOUMI 200 g — 12.95"   price OF the package
//   BASIS pricing  "APPLE ROYAL GALA — PER KG — 7.99" price PER unit
//
// Every unit-price path in the project (priceWatch.unitPriceFor, the frontend's
// match.js unitPrice) is a DIVISION: price ÷ package size. That is the right
// arithmetic for pack pricing and the wrong QUESTION for basis pricing, where
// there is no package and the printed price already IS the unit price. With no
// representation for "per kg", `parsePackageSize()` looked for a magnitude in
// "Per Kg", found none, and reported no size — so the most valuable field in the
// product was dropped for the one class of offer that states it most explicitly.
//
// Measured on production D1 (2026-08-01, 43,854 vision-enriched offers):
// 12,011 offers resolved no unit price at all, 1,701 of them carrying a
// legible basis marker; 4,747 offers were REJECTED outright by the Business
// Acceptance Gate on `comparable_quantity`; and 144 offers were served a unit
// price wrong by 30-320x because a grade number beside the basis marker
// ("Sea Bream 200-300 /Kg", "Cashew W320/Kg") was read as a package magnitude.
//
// A READER, NOT A PARSER OF SIZES. This module never produces a package size and
// never converts one. It answers one question with one answer shape, and it is
// the ONLY place in the project allowed to have an opinion about a price's
// denominator. `packageSize.js`'s rule — no third interpretation of a size —
// still holds: a basis is not a size, which is exactly why it needed its own
// module rather than another branch inside the size parser.
//
// FAILURE MODE: 'ABSENT', never an invented basis. Nothing here is derived from
// a token the crop did not print, and the classifier is an ALLOW-LIST for the
// reason below.
//
// WHY AN ALLOW-LIST AND NOT A UNIT PARSER. The extractor's `unit` field is a
// mixed bag in production: alongside "Per Kg" and "KILO" it holds currencies
// (SAR 32, AED, sfr) and device specifications (watts 13, mah 7, oz 6, btu,
// sqft, meter, inch). A permissive reader would emit "SAR/SAR" and "SAR/watt"
// on real shopper cards. Only the tokens below can ever produce a basis.

const AR_INDIC = /[٠-٩۰-۹]/gu;

export const PRICE_BASIS_VERSION = 'price-basis-v1';

export const PRICE_BASIS_STATUS = Object.freeze({
  RESOLVED: 'RESOLVED',
  ABSENT: 'ABSENT',
});

// The units a basis may be stated in. MEASURE bases carry a magnitude and are
// therefore rankable against a package measure; PIECE does not, which is why
// `comparableQuantity.js` orders the two differently (see the header there).
export const PRICE_BASIS_UNITS = Object.freeze(['kg', 'l', 'piece']);

// Where the basis was read, in precedence order. Recorded on every result so a
// verdict is always attributable to the evidence that produced it — a basis read
// from the extractor's own `unit` field and one recovered from mangled Arabic
// OCR are both correct answers with very different provenance.
export const PRICE_BASIS_SOURCES = Object.freeze(['unit_field', 'size_field', 'name', 'text']);

const ABSENT = Object.freeze({
  status: PRICE_BASIS_STATUS.ABSENT,
  unit: null,
  quantity: null,
  printed: null,
  source: null,
  version: PRICE_BASIS_VERSION,
});

function resolved({ unit, quantity, printed, source }) {
  return Object.freeze({
    status: PRICE_BASIS_STATUS.RESOLVED,
    unit,
    quantity,
    printed,
    source,
    version: PRICE_BASIS_VERSION,
  });
}

// Same folding discipline as packageSize.js: Arabic-Indic digits to ASCII,
// diacritics dropped, whitespace collapsed. Punctuation is DELIBERATELY kept —
// "/" and "(" are the two most common basis markers in the corpus and stripping
// them would erase the very signal this module reads.
function fold(value) {
  return String(value || '')
    .replace(AR_INDIC, (d) => {
      const code = d.codePointAt(0);
      return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
    })
    .toLowerCase()
    .replace(/[ـً-ْ]/gu, '')
    .replace(/ی/gu, 'ي')
    .replace(/ک/gu, 'ك')
    .replace(/\s+/gu, ' ')
    .trim();
}

// --- the allow-list ------------------------------------------------------------
// Spellings that name a MASS basis. Bare `g`/`gm`/`ml` are deliberately absent:
// no flyer in the corpus prices by the gram, and those spellings appear in the
// `unit` field thousands of times meaning "the unit of the package size".
const KG_WORD = '(?:kgs?|kg\\.|k\\.g\\.?|kilos?|kilogram(?:me)?s?|كجم|كغم|كيلو(?:جرام)?)';
const L_WORD = '(?:l|lt|ltrs?|lit(?:re|er)s?|لتر|ليتر)';
const PIECE_WORD = '(?:pcs?|piece|pieces|each|ea|unit|حبه|حبة)';
// Sub-kilo mass words, for the "per 500 gm" family. `quantity` is expressed in
// KILOGRAMS so a 500 g basis and a per-kg basis are directly rankable.
const G_WORD = '(?:g|gm|gms|gr|grs|grams?|جم|جرام|غرام|غم)';

// A script-agnostic right-hand word boundary. `\b` is defined over ASCII \w, so
// it does not close an Arabic word: `/جرام\b/u` fails at end of input, which is
// exactly where a folded size field ends. Every unit alternation above can be
// followed by either script, so all of them use this instead.
const END = '(?![\\p{L}\\p{N}])';

// A basis is UNAMBIGUOUS when the text says so structurally: an explicit "per",
// a slash, or a parenthetical. These fire wherever they appear, including in the
// middle of a name, because no package size is ever spelled this way.
const EXPLICIT = [
  // "per 500 gm", "per 100g" — a magnitude-bearing basis. FIRST, so the bare
  // "per kg" rule below can never swallow the number.
  {
    unit: 'kg',
    re: new RegExp(`\\bper\\s*(\\d+(?:[.,]\\d+)?)\\s*${G_WORD}${END}`, 'iu'),
    quantity: (m) => Number.parseFloat(m[1].replace(',', '.')) / 1000,
  },
  {
    unit: 'kg',
    re: new RegExp(`\\bper\\s*(\\d+(?:[.,]\\d+)?)\\s*${KG_WORD}${END}`, 'iu'),
    quantity: (m) => Number.parseFloat(m[1].replace(',', '.')),
  },
  // "per kg", "per kilo", "/kg", "(kg)", "لكل كيلو", "للكيلو", "بالكيلو".
  // The Arabic forms attach the preposition to the noun, so they are matched as
  // whole words rather than as a preposition plus a unit.
  { unit: 'kg', re: new RegExp(`\\bper\\s*${KG_WORD}${END}`, 'iu'), quantity: () => 1 },
  { unit: 'kg', re: new RegExp(`/\\s*${KG_WORD}${END}`, 'iu'), quantity: () => 1 },
  { unit: 'kg', re: new RegExp(`\\(\\s*${KG_WORD}\\s*\\)`, 'iu'), quantity: () => 1 },
  { unit: 'kg', re: /(?:للكيلو|بالكيلو|لكل\s*كيلو|للكجم)/u, quantity: () => 1 },

  { unit: 'l', re: new RegExp(`\\bper\\s*${L_WORD}${END}`, 'iu'), quantity: () => 1 },
  { unit: 'l', re: /(?:للتر|باللتر|لكل\s*لتر)/u, quantity: () => 1 },

  { unit: 'piece', re: new RegExp(`\\bper\\s*${PIECE_WORD}${END}`, 'iu'), quantity: () => 1 },
  { unit: 'piece', re: new RegExp(`/\\s*${PIECE_WORD}${END}`, 'iu'), quantity: () => 1 },
  { unit: 'piece', re: new RegExp(`\\(\\s*${PIECE_WORD}\\s*\\)`, 'iu'), quantity: () => 1 },
  { unit: 'piece', re: /(?:للحبة|للحبه|لكل\s*حبة)/u, quantity: () => 1 },
];

// A basis is AMBIGUOUS when the text is a bare unit word — "SALMON FILLET KG",
// or `unit: "KG"` on its own. The same token is a package size in "SUGAR 10KG",
// so these fire only when NO package magnitude was resolved (see
// `sizeResolved` below) and only when no digit immediately precedes them.
const BARE = [
  { unit: 'kg', re: new RegExp(`(?:^|[^0-9.,\\p{L}])${KG_WORD}\\.?\\s*$`, 'iu'), quantity: () => 1 },
  { unit: 'piece', re: new RegExp(`(?:^|[^0-9.,\\p{L}])${PIECE_WORD}\\.?\\s*$`, 'iu'), quantity: () => 1 },
  // A trailing Arabic basis noun ("... للكيلو") needs no preceding separator
  // rule: the word itself carries the preposition, so it cannot be a magnitude.

];

// A whole FIELD that is nothing but a bare unit word — `unit: "KG"`, `size: "kg"`.
// Common (736 rows carry the basis in the `unit` field alone) but AMBIGUOUS in
// exactly the same way as a bare trailing word, and for the same reason: on
// "AL OSRA SUGAR 10KG" the extractor writes `size: "10KG", unit: "KG"`, where
// `unit` names the unit OF the magnitude. Measured cost of ignoring that: 19 live
// offers flipped to a per-kilo price they do not have. So this rule is gated on
// `sizeResolved` too. An explicit per-form ("Per Kg") is not gated, because it is
// not ambiguous — it reaches the EXPLICIT rules above instead.
const WHOLE_FIELD = [
  { unit: 'kg', re: new RegExp(`^${KG_WORD}\\.?$`, 'iu'), quantity: () => 1 },
  { unit: 'piece', re: new RegExp(`^${PIECE_WORD}\\.?$`, 'iu'), quantity: () => 1 },
];

function matchAll(rules, text) {
  for (const rule of rules) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const quantity = rule.quantity(m);
    if (!Number.isFinite(quantity) || quantity <= 0) continue;
    return { unit: rule.unit, quantity, printed: m[0].trim() };
  }
  return null;
}

/**
 * Read the price basis out of one observation.
 *
 * @param {object}  input
 * @param {string}  [input.unit]  the extractor's `unit` field (Expanded JSON).
 * @param {string}  [input.size]  the extractor's `package_size` field.
 * @param {string}  [input.name]  the English product name.
 * @param {string}  [input.text]  any further evidence — the Arabic name and the
 *                                offer's own OCR text. Read LAST and only for
 *                                explicit markers, because it is the noisiest
 *                                source in the corpus.
 * @param {boolean} [input.sizeResolved] did `parsePackageSize()` find a printed
 *                                magnitude? Bare unit words are refused when it
 *                                did — "SUGAR 10 KG" is a package, not a basis.
 */
export function resolvePriceBasis({
  unit = null, size = null, name = null, text = null, sizeResolved = false,
} = {}) {
  const fields = [
    ['unit_field', fold(unit)],
    ['size_field', fold(size)],
    ['name', fold(name)],
  ];

  // 1 · an explicit per-form anywhere in a field. Unambiguous, so it fires even
  //     when a package magnitude exists: "Sea Bream 200-300 /Kg" lands here, and
  //     it is how the 144 wrong unit prices are corrected — the basis is read
  //     from the "/Kg", and the grade number is never asked to be a size.
  //     Whether it OVERRIDES that magnitude is not decided here; that is the
  //     projection's ordering call (comparableQuantity.js).
  for (const [source, value] of fields) {
    if (!value) continue;
    const hit = matchAll(EXPLICIT, value);
    if (hit) return resolved({ ...hit, source });
  }

  // 2 · a bare unit word — a whole field of one, or a trailing one. Ambiguous
  //     with the unit OF a magnitude, so both forms stand down the moment
  //     `parsePackageSize()` reports one.
  if (!sizeResolved) {
    for (const [source, value] of fields) {
      if (!value) continue;
      const hit = matchAll(WHOLE_FIELD, value) || matchAll(BARE, value);
      if (hit) return resolved({ ...hit, source });
    }
  }

  // 4 · the free-text channel (Arabic display name + raw OCR), explicit markers
  //     ONLY. 650 per-kg and 249 per-piece production rows state their basis
  //     nowhere else, but the same text is full of unrelated retailer copy, so
  //     it never gets the benefit of the bare-word or whole-field rules.
  const free = fold(text);
  if (free) {
    const hit = matchAll(EXPLICIT, free);
    if (hit) return resolved({ ...hit, source: 'text' });
  }

  return ABSENT;
}

// --- NO ARITHMETIC LIVES HERE -------------------------------------------------
// v3 exported `unitPriceFromBasis()` beside this reader, which made a stated
// denominator look like a second kind of unit price with a second formula. It
// is not. This module's whole output is a REFERENCE QUANTITY — 1 kg for
// "PER KG", 0.5 kg for "per 500 g", 1 piece for "/PC" — and the single division
// that turns any reference quantity into a unit price lives in
// `lexicon/comparableQuantity.js unitPriceFromReference()`, shared with printed
// package sizes and with counts.
