// lexicon/transliterate.js — Latin -> Arabic SCRIPT rendering, deterministic.
//
// POLICY REVERSAL (user, 2026-07-30). The Arabic Builder's original directive
// (2026-07-26) was that anything the lexicon has no Arabic term for is DROPPED
// rather than transliterated. Measured consequence once built names went live:
// "Doritos Tortilla Chips" served as "شيبس" and "Rabea Ice Tea" as "شاي" —
// the product word survived and everything that identified WHICH product did
// not. The user's revised directive is that a name or object with no Arabic
// term is written AS IS, in Arabic letters.
//
// THIS IS A LAST RESORT, NOT A FIRST CHOICE. The order is always:
//   1. the lexicon's real Arabic term  (شاي, جبن, زيتون)
//   2. the brand lexicon's Arabic form (المراعي, بوك)
//   3. THIS — a phonetic rendering     (دوريتوس, تورتيلا)
// Transliteration cannot know that "Rabea" is the brand ربيع; only the brand
// lexicon can. So a term that earns a real Arabic form should be ADDED to
// brands.js or shopping.js, and this module is what covers the long tail that
// never will be.
//
// DISPLAY ONLY. The built Arabic name reaches `nameAr` through
// enrichStore.enrichmentNameArSql(); the search haystack is `match_text`, which
// is composed from the OBSERVED names at enrich time and is untouched by this.
// So a phonetic rendering can never pollute matching or registry token profiles.
//
// Pure, table-driven, no network, no data files.

// Multi-letter sequences first — order matters, longest wins.
const DIGRAPHS = [
  ['tch', 'تش'], ['sch', 'ش'],
  ['ch', 'تش'], ['sh', 'ش'], ['th', 'ث'], ['ph', 'ف'], ['gh', 'غ'], ['kh', 'خ'],
  ['ck', 'ك'], ['qu', 'كو'], ['wh', 'و'],
  ['oo', 'و'], ['ou', 'و'], ['ow', 'او'], ['au', 'و'], ['aw', 'او'],
  ['ee', 'ي'], ['ea', 'ي'], ['ie', 'ي'], ['ei', 'ي'], ['ey', 'ي'],
  ['oa', 'و'], ['oe', 'و'], ['ai', 'اي'], ['ay', 'اي'],
];

const SINGLES = {
  a: 'ا', b: 'ب', c: 'ك', d: 'د', e: 'ي', f: 'ف', g: 'ج', h: 'ه', i: 'ي',
  j: 'ج', k: 'ك', l: 'ل', m: 'م', n: 'ن', o: 'و', p: 'ب', q: 'ق', r: 'ر',
  s: 'س', t: 'ت', u: 'و', v: 'ف', w: 'و', x: 'كس', y: 'ي', z: 'ز',
};

// A word-initial vowel needs a carrier alef: "ice" -> ايس, not يس.
const INITIAL_VOWEL = { a: 'ا', e: 'ا', i: 'اي', o: 'او', u: 'او' };

const isLatin = (s) => /[A-Za-z]/.test(s);

// `c` is س before e/i/y (ice, cent), ك otherwise (cola, chips handled by digraph).
// `g` is ج throughout: Arabic has no hard-g letter in standard orthography and
// Gulf usage writes ج for both (جرين for "green").
function softC(word, i) {
  const next = word[i + 1];
  return next === 'e' || next === 'i' || next === 'y' ? 'س' : 'ك';
}

export function transliterateWord(input) {
  const raw = String(input || '').trim();
  // A fragment with no letters at all ("---", "/", "&") is not a word and must
  // not survive into a product name; a non-Latin word is already in the target
  // script and passes through untouched.
  if (!raw || !/\p{L}/u.test(raw)) return null;
  if (!isLatin(raw)) return raw;
  const word = raw.toLowerCase().replace(/[^a-z]/g, '');
  if (!word) return null;

  let out = '';
  let i = 0;
  // A trailing silent `e` is dropped whenever the word can spare it: "ice" ->
  // ايس, "sauce" -> سوس, "analogue" -> انالوجو. An earlier version kept it after
  // a vowel, which produced انالوجوي for "analogue" — the `ue`/`gue` endings are
  // exactly the case that rule got wrong, and English has no common word where
  // a final `e` is voiced.
  const end = word.length > 2 && word.endsWith('e') ? word.length - 1 : word.length;

  while (i < end) {
    // Collapse doubled consonants: "tortilla" -> تورتيلا, not تورتيللا.
    if (i > 0 && word[i] === word[i - 1] && !'aeiou'.includes(word[i])) {
      i += 1;
      continue;
    }
    if (i === 0 && INITIAL_VOWEL[word[i]]) {
      // Only when the vowel is not the head of a digraph that already carries
      // its own alef ("ai"/"aw" -> اي/او).
      const digraph = DIGRAPHS.find((d) => word.startsWith(d[0], i));
      if (digraph && digraph[1].startsWith('ا')) {
        out += digraph[1];
        i += digraph[0].length;
        continue;
      }
      out += INITIAL_VOWEL[word[i]];
      i += 1;
      continue;
    }
    const digraph = DIGRAPHS.find((d) => word.startsWith(d[0], i));
    if (digraph) {
      out += digraph[1];
      i += digraph[0].length;
      continue;
    }
    const ch = word[i];
    out += ch === 'c' ? softC(word, i) : (SINGLES[ch] ?? '');
    i += 1;
  }
  return out || null;
}

// A whole phrase, word by word. Non-Latin words pass through untouched so a
// mixed fragment never gets mangled.
export function transliteratePhrase(input) {
  const words = String(input || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const out = words.map((w) => (isLatin(w) ? transliterateWord(w) : w)).filter(Boolean);
  return out.length ? out.join(' ') : null;
}
