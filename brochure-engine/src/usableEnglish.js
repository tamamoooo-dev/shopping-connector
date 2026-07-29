// usableEnglish.js — the ONE definition of "this string carries enough English
// to be a product name".
//
// WHY THIS IS ITS OWN MODULE. Two stages need the identical bar and neither may
// own it:
//
//   S3 Field Admission Validator  — rejects a `name_en` candidate below the bar
//   S8d Structured Product        — refuses to build English structure below it
//   S4 Business Acceptance (M3)   — reuses S3's verdict, which rests on the bar
//
// Before this module the rule existed twice, written out longhand in
// `offers/smartExtraction.js` and again in `lexicon/structuredProduct.js`, with
// a comment in each promising to stay identical to the other. Two copies of one
// rule drift silently; a shared predicate cannot (VISION-PIPELINE.md §8.5, R10).
//
// It is a dependency-free LEAF on purpose. Extraction must not import the
// lexicon tree to ask a one-line question, and the lexicon must not import the
// extraction module to ask it either — both directions would buy a heavy
// dependency, and one of them would invert P4.
//
// THE BAR: at least two Latin letters. Deliberately crude, and that is the
// point. It is an evidence test, not a quality test: it separates "there is an
// English name here" from "there is a digit, a symbol, or Arabic here". Judging
// whether the name is any GOOD belongs to stages that have more to go on.

// At least this many Latin letters for a string to count as English evidence.
export const MIN_LATIN_LETTERS = 2;

// ASCII-only by intent. A Latin-1 accented letter is vanishingly rare in this
// catalogue and would not change a verdict — a name with "é" in it has other
// Latin letters too.
const LATIN_LETTER = /[A-Za-z]/g;

export function latinLetterCount(value) {
  return (String(value ?? '').match(LATIN_LETTER) || []).length;
}

// Non-empty AND carrying the minimum English evidence. Both halves matter:
// a whitespace-only string has zero letters, but so does "١٢٣", and neither is
// a usable English name.
export function hasUsableEnglish(value) {
  return typeof value === 'string'
    && value.trim().length > 0
    && latinLetterCount(value) >= MIN_LATIN_LETTERS;
}
