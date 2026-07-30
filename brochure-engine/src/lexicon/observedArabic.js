// lexicon/observedArabic.js — the SERVED Arabic name: the model's own Arabic,
// cleaned of Latin debris, with the brand appended.
//
// WHY THIS AND NOT THE BUILT NAME (user decision, 2026-07-30, after seeing both
// live). The Arabic Builder composes a name from the English structure. It is
// consistent and always Latin-free, but it can only say what the lexicon knows:
// "Doux Chicken Nuggets or Fingers" became "ناجتس دجاج 500 جم" (brand and
// "fingers" gone) and "Rabea Ice Tea" became "شاي". Adding transliteration to
// stop the loss made it worse, not better — "Puck Processed Analogue Cream
// Cheese Spread" rendered as "جبن كريمي بروسيسيد انالوجو سبريد بوك", a wall of
// phonetic noise.
//
// The model's OWN Arabic is natural language written by something that looked
// at the package, so it phrases products the way a shelf label does. Its two
// defects are narrow and mechanical:
//   1. Latin fragments bleed in — "نuggets صدر دجاج Sadia", "Reg. Price".
//   2. The brand is often missing (measured 29% of Puck rows).
// Both are fixable HERE without inventing a single word, which is what the
// builder could not promise.
//
// NOTHING IS INVENTED. Every word served is a word the model wrote, minus the
// Latin, plus a brand from the brand lexicon. When cleaning would leave nothing,
// the caller keeps the observed text untouched — a bad name beats no name.
//
// Display only: `match_text` is composed at enrich time from the observed names
// and is not touched, so nothing here reaches search or registry identity.

import { normalizeText } from '../matching.js';

const HAS_LATIN = /[A-Za-z]/;
const LATIN_RUN = /[A-Za-z]+/g;

// Flyer furniture the model transcribes along with the product. Deliberately
// SHORT: every word here is one a product name can never need, because dropping
// a real product word is the failure mode this module exists to avoid.
const PROMO_DEBRIS = new Set([
  'سعر', 'السعر', 'اسعار', 'ريال', 'ريالا', 'وفر', 'عرض', 'عروض', 'مجانا',
  'فقط', 'خصم', 'تخفيض', 'تخفيضات', 'الحبه', 'للحبه', 'حبه', 'الكرتون',
].map((w) => normalizeText(w)));

// SUBTRACTIVE ONLY. A token is dropped, never rewritten — the first version
// filtered on letter count and destroyed sizes: "(2 × 500 جم)" came back as
// "500 جم)" because "(2" and "×" carry no letters, and "٩٣٦" vanished because
// Arabic-Indic digits are not \d. Numbers, units and separators are part of the
// name; only three things are debris.
const letterCount = (s) => (s.match(/\p{L}/gu) || []).length;
const digitCount = (s) => (s.match(/\p{Nd}/gu) || []).length;

function cleanToken(token) {
  const stripped = token.replace(LATIN_RUN, '').trim();
  if (!stripped) return null;                       // was pure Latin ("Sadia")
  const letters = letterCount(stripped);
  // Anything numeric stays: sizes, counts, and the × / x that joins them.
  if (digitCount(stripped) || /^[×xX*/+-]+$/.test(stripped)) return stripped;
  // A lone Arabic letter is the residue of a Latin word the model glued one
  // character onto ("نuggets" -> "ن"), not a word.
  if (letters < 2) return null;
  if (PROMO_DEBRIS.has(normalizeText(stripped.replace(/[^\p{L}]/gu, '')))) return null;
  return stripped;
}

// Brackets orphaned by a removed token, and separators left stranded at either
// end, are tidied AFTER filtering — doing it per token cannot see the pair.
function tidyPunctuation(text) {
  let out = text;
  const opens = (out.match(/\(/g) || []).length;
  const closes = (out.match(/\)/g) || []).length;
  if (opens !== closes) out = out.replace(/[()]/g, '');
  return out
    .replace(/\s*\(\s*/g, ' (')
    .replace(/\s*\)\s*/g, ') ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s/×x*+,-]+|[\s/×x*+,-]+$/g, '')
    .trim();
}

// Is the brand already in the text? Compared on the normalized form so
// "المراعي" and "المراعى" count as the same mention.
function mentionsBrand(text, brandAr) {
  if (!brandAr) return true;
  const hay = normalizeText(text);
  const needle = normalizeText(brandAr);
  return !!needle && hay.includes(needle);
}

// cleanObservedArabic(observed, { brandAr }) -> string | null
//   null when there is nothing usable at all; the caller then serves whatever
//   the model wrote, untouched.
export function cleanObservedArabic(observed, { brandAr = null } = {}) {
  const raw = typeof observed === 'string' ? observed.trim() : '';
  if (!raw) return null;

  const out = [];
  const seen = new Set();
  for (const token of raw.split(/\s+/)) {
    const cleaned = cleanToken(token);
    if (!cleaned) continue;
    // The model repeats itself when a flyer prints a price twice
    // ("سعر مري 14.99 الحبه سعر مري 14.99"). Keep the first mention of each
    // WORD; numbers and separators are exempt because "2 × 500" needs both
    // numbers and "6 × 6" is a legitimate repeat.
    const key = letterCount(cleaned) >= 2
      ? normalizeText(cleaned.replace(/[^\p{L}]/gu, ''))
      : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(cleaned);
  }

  if (!out.length) return null;
  const text = tidyPunctuation(out.join(' '));
  // Nothing but numbers and separators survived — that is not a product name.
  if (!text || letterCount(text) < 2) return null;
  return mentionsBrand(text, brandAr) ? text : `${text} ${brandAr}`;
}

// True when the observed text needed no repair at all — used by the shadow to
// report how much of the catalogue the model already writes cleanly.
export function observedIsClean(observed, { brandAr = null } = {}) {
  const raw = typeof observed === 'string' ? observed.trim() : '';
  if (!raw) return false;
  return !HAS_LATIN.test(raw) && mentionsBrand(raw, brandAr);
}
