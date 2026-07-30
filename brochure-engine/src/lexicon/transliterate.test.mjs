// lexicon/transliterate.test.mjs — the Latin -> Arabic script fallback.
// Run: node src/lexicon/transliterate.test.mjs
//
// The 2026-07-30 policy reversal made this the last stop before a term is lost,
// so the cases below are the ones that actually reach it in production plus the
// letter rules that were wrong on the first pass.

import { transliterateWord, transliteratePhrase } from './transliterate.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok  ${label}`);
  else { failures += 1; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (label, got, want) => check(`${label}  (${want})`, got === want, `got ${got}`);

console.log('the user\'s own examples:');
eq('Doritos', transliterateWord('Doritos'), 'دوريتوس');
eq('Tortilla', transliterateWord('Tortilla'), 'تورتيلا');
eq('Chips', transliterateWord('Chips'), 'تشيبس');
eq('Ice', transliterateWord('Ice'), 'ايس');
eq('Tea', transliterateWord('Tea'), 'تي');
eq('phrase', transliteratePhrase('Doritos Tortilla Chips'), 'دوريتوس تورتيلا تشيبس');

console.log('\nletter rules that were wrong on the first pass:');
// A final `e` is always silent. The original rule kept it after a vowel, which
// rendered "analogue" as انالوجوي.
eq('silent final e after a vowel', transliterateWord('analogue'), 'انالوجو');
eq('silent final e after a consonant', transliterateWord('sauce'), 'سوس');
// A word-initial vowel needs a carrier alef, or "ice" becomes يس.
eq('initial vowel carries an alef', transliterateWord('Express'), 'اكسبريس');
// Doubled consonants collapse, or "tortilla" becomes تورتيللا.
eq('doubled consonants collapse', transliterateWord('Coffee'), 'كوفي');
// `c` softens before e/i/y.
eq('soft c', transliterateWord('Cent'), 'سينت');
eq('hard c', transliterateWord('Cola'), 'كولا');

console.log('\nsafety:');
check('a non-Latin word passes through untouched', transliterateWord('جبن') === 'جبن');
check('a mixed phrase keeps its Arabic words',
  transliteratePhrase('Green شاي') === 'جرين شاي');
check('empty input is null', transliterateWord('') === null && transliteratePhrase('  ') === null);
check('punctuation-only yields null', transliterateWord('---') === null);
check('output never contains Latin script — the invariant that makes this safe',
  ['Doritos', 'Mughal', 'XXL', 'Zoflora', 'Keqiwear']
    .every((w) => !/[A-Za-z]/.test(transliterateWord(w) || '')));

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll transliteration tests passed.');
