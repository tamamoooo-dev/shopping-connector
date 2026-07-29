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

console.log(failures ? `\n${failures} FAILED` : '\nAll Package Size tests passed.');
process.exit(failures ? 1 : 0);
