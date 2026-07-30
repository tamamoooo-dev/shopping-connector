// lexicon/observedArabic.test.mjs — the SERVED Arabic name.
// Run: node src/lexicon/observedArabic.test.mjs
//
// Every fixture is a real observed string from production. The rule this module
// must never break: it only SUBTRACTS. A word in the output is a word the model
// wrote, except the brand, which comes from the brand lexicon.

import { cleanObservedArabic, observedIsClean } from './observedArabic.js';

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok  ${label}`);
  else { failures += 1; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};
const eq = (label, got, want) => check(label, got === want, `got "${got}" want "${want}"`);

console.log('Latin debris is removed:');
eq('a bare Latin word goes',
  cleanObservedArabic('نuggets صدر دجاج Sadia', { brandAr: 'ساديا' }), 'صدر دجاج ساديا');
eq('an Arabic letter glued to a Latin word goes with it',
  cleanObservedArabic('دجاج نuggets أو أصابع الدجاج', { brandAr: 'دوكس' }),
  'دجاج أو أصابع الدجاج دوكس');
eq('a Latin brand prefix goes',
  cleanObservedArabic('Heart of Nature ورق عنب 1 كجم', { brandAr: null }), 'ورق عنب 1 كجم');

console.log('\nthe brand is appended only when it is missing:');
eq('appended when absent',
  cleanObservedArabic('شيبية جبنة كريم مطبوخة (2 × 500 جم)', { brandAr: 'بوك' }),
  'شيبية جبنة كريم مطبوخة (2 × 500 جم) بوك');
eq('NOT appended when already there',
  cleanObservedArabic('أيس تي ربيع (6 × 320 مل)', { brandAr: 'ربيع' }),
  'أيس تي ربيع (6 × 320 مل)');
eq('matched through Arabic normalization (ى/ي)',
  cleanObservedArabic('قشدة الطبخ المراعى', { brandAr: 'المراعي' }), 'قشدة الطبخ المراعى');

console.log('\nsizes survive intact — the defect the first version had:');
// Filtering on letter count destroyed sizes: "(2 × 500 جم)" came back as
// "500 جم)" because "(2" and "×" carry no letters.
eq('Latin digits, × and brackets all survive',
  cleanObservedArabic('جبنة (2 × 500 جم)', { brandAr: null }), 'جبنة (2 × 500 جم)');
// Arabic-Indic digits are not \d, so ٩٣٦ vanished.
eq('Arabic-Indic digits survive',
  cleanObservedArabic('زيتون شرائح (الكيلو ٩٣٦ جرام)', { brandAr: null }),
  'زيتون شرائح (الكيلو ٩٣٦ جرام)');

console.log('\ntidying:');
eq('a bracket orphaned by a removed token is dropped, not left dangling',
  cleanObservedArabic('جبنة (Squeeze', { brandAr: null }), 'جبنة');
eq('a repeated word is kept once',
  cleanObservedArabic('سعر دجاج دجاج طازج', { brandAr: null }), 'دجاج طازج');
eq('flyer price furniture is dropped', cleanObservedArabic('وفر عرض حليب طازج', { brandAr: null }), 'حليب طازج');

console.log('\nrefusing is safe — the caller keeps the observed text:');
check('nothing usable returns null', cleanObservedArabic('Reg. Price', { brandAr: null }) === null);
check('numbers alone are not a name', cleanObservedArabic('14.99 2 × 500', { brandAr: null }) === null);
check('empty input returns null',
  cleanObservedArabic('', { brandAr: 'بوك' }) === null && cleanObservedArabic(null) === null);

console.log('\nobservedIsClean reports what needed no repair:');
check('clean text with its brand', observedIsClean('حليب المراعي 1 لتر', { brandAr: 'المراعي' }));
check('Latin makes it unclean', !observedIsClean('نuggets دجاج', { brandAr: null }));
check('a missing brand makes it unclean', !observedIsClean('حليب طازج', { brandAr: 'المراعي' }));

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll observed-Arabic tests passed.');
