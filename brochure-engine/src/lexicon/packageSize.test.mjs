// Offline tests for the Package Size Parser (lexicon/packageSize.js, §47).
//
// Run: node src/lexicon/packageSize.test.mjs

import { PACKAGE_SIZE_VERSION, formatSizeArabic, parsePackageSize } from './packageSize.js';
import { parseSize } from '../matching.js';

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}
const ar = (input) => parsePackageSize(input)?.display_ar ?? null;
const en = (input) => parsePackageSize(input)?.display_en ?? null;

console.log('printed measurements keep the unit the flyer printed:');
check('330 ml', ar({ size: '330 ml' }) === '330 مل');
check('1Ltr stays litres — NOT back-converted to 1000 مل', ar({ size: '1Ltr' }) === '1 لتر');
check('1.5 L keeps its decimal', ar({ size: '1.5 L' }) === '1.5 لتر');
check('5kg', ar({ size: '5kg' }) === '5 كجم');
check('190G', ar({ size: '190G' }) === '190 جم');
check('500 GM', ar({ size: '500 GM' }) === '500 جم');
check('a trailing .0 is dropped', ar({ size: '2.0 Ltr' }) === '2 لتر');
check('Arabic-Indic digits parse', ar({ size: '٥٠٠ مل' }) === '500 مل');
check('the English label is produced too', en({ size: '330 ml' }) === '330 ml');

console.log('\nmultipacks:');
check('6x250ml', ar({ size: '6x250ml' }) === '6 × 250 مل');
check('2 X 1.5 LTR', ar({ size: '2 X 1.5 LTR' }) === '2 × 1.5 لتر');
check('250 ml x 6 (reverse spelling) reads the same', ar({ size: '250 ml x 6' }) === '6 × 250 مل');
check('4 x 85g', ar({ size: '4 x 85g' }) === '4 × 85 جم');
check('the per-unit quantity is the unit, not the total',
  parsePackageSize({ size: '6x250ml' }).quantity === 250 && parsePackageSize({ size: '6x250ml' }).pack === 6);

console.log('\ncounts (Arabic numeral agreement: 3–10 plural, otherwise singular):');
check('40 pcs is singular', ar({ size: "40's" }) === '40 حبة');
check('6 pcs is plural', ar({ size: '6 pcs' }) === '6 حبات');
check('1 pc is singular', ar({ size: '1 pc' }) === '1 حبة');
check('12 rolls uses the roll word', ar({ size: '12 Rolls' }) === '12 لفة');
check('4 rolls is plural', ar({ size: '4 rolls' }) === '4 لفات');
check('50 tablets', ar({ size: '50 tablets' }) === '50 قرص');
check('a bonus pack has no unit word but parseSize resolves the count',
  ar({ size: '8 + 2' }) === '10 حبات');

console.log('\nsource precedence and absence:');
check('the size FIELD is read before the name',
  ar({ size: '250 ml', name: 'Juice 1 Ltr Special' }) === '250 مل');
check('the name is read when the field is empty',
  ar({ size: null, name: 'Galaxy Chocolates 80g' }) === '80 جم');
check('a name with no size yields null', parsePackageSize({ name: 'Refrigerator NRF110N26S' }) === null);
check('an empty observation yields null', parsePackageSize({}) === null);
check('nothing is invented from a bare number', parsePackageSize({ size: '9090' }) === null);
check('a model code is not a size', parsePackageSize({ name: 'Nebo Makeup Kit -9090' }) === null);

console.log('\nthe canonical view stays matching.js parseSize (one size interpretation):');
{
  const parsed = parsePackageSize({ size: '1Ltr' });
  const canonical = parseSize('', '1Ltr');
  check('canonical is parseSize output verbatim',
    parsed.canonical.unit === canonical.unit && parsed.canonical.total === canonical.total);
  check('the comparable total is in base units even though the label is not',
    parsed.canonical.total === 1000 && parsed.display_ar === '1 لتر');
  check('the version is stamped', parsed.version === PACKAGE_SIZE_VERSION);
}
check('formatSizeArabic is the label-only twin',
  formatSizeArabic(parsePackageSize({ size: '330 ml' })) === '330 مل');
check('formatSizeArabic tolerates null', formatSizeArabic(null) === null);

console.log('\npurity:');
check('same input, same output',
  JSON.stringify(parsePackageSize({ size: '6x250ml' })) === JSON.stringify(parsePackageSize({ size: '6x250ml' })));


console.log('\nspellings the COMPARISON reader accepted but the PRINTED reader did not (2026-08-02):');
{
  // Objective parsing defects, not judgement calls: `matching.js unitFor()` has
  // always read these, so `parsePackageSize` refusing them meant the two readers
  // disagreed about whether a size EXISTS. Measured on the live catalogue, that
  // cost 104 offers their comparable quantity and 26 their unit price.
  const cases = [
    ['450 غ', 450, 'g', 1, 'a bare Arabic gram abbreviation'],
    ['36.8 غ', 36.8, 'g', 1, 'the same with a decimal'],
    ['700 GRM', 700, 'g', 1, 'the GRM spelling'],
    ['360ml×24', 360, 'ml', 24, 'a multiplier written with ×'],
    ['٤٠٠ جرام*٢', 400, 'g', 2, 'an Arabic unit followed by a * multiplier'],
    ['٩٠ مل*٤', 90, 'ml', 4, 'the same in millilitres'],
  ];
  for (const [size, quantity, unit, pack, why] of cases) {
    const parsed = parsePackageSize({ size });
    check(`${why}: "${size}"`,
      parsed?.quantity === quantity && parsed?.unit === unit && parsed?.pack === pack);
  }
  // The multiplier fix removed a `(?![a-z])` guard from MEASURE_PACK_RE only.
  // `foldSizeText` turns × and * into the ASCII letter `x`, which that guard
  // then treated as the start of a longer unit word.
  check('the guard is still enforced where it is needed (plain measure)',
    parsePackageSize({ size: '5 gallons' })?.unit !== 'g');
  check('a short unit still cannot eat a longer word',
    parsePackageSize({ size: '400 grams' })?.quantity === 400);
}

console.log('\nthe two readers must never disagree about whether a size exists:');
{
  // The invariant the fixes above restore. A printed reader that refuses what
  // the comparison reader accepts produces exactly the bug this fixed: a
  // product admitted with no denominator, or served with no unit price.
  for (const size of ['450 غ', '700 GRM', '360ml×24', '٤٠٠ جرام*٢', '1Ltr', '330 ml', '5kg']) {
    const printed = parsePackageSize({ size });
    const canonical = parseSize('', size);
    check(`"${size}": both readers see a size`,
      !!(printed?.unit || printed?.count) === !!canonical.unit);
  }
}

console.log(failures ? `\n${failures} FAILED` : '\nAll Package Size tests passed.');
process.exit(failures ? 1 : 0);
