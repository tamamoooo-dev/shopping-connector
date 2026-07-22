// Offline tests + representative historical-output benchmark for Identity Builder.

import {
  buildIdentityCandidate,
  normalizeIdentityMode,
  normalizeObservationText,
} from './identityBuilder.js';
import { parseSize as previousParseSize, productFamily as previousProductFamily } from '../matching.js';
import { handleIdentityBuilderDebug, IDENTITY_DEBUG_PATH } from './identityDebug.js';

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

const build = (input, mode = 'strict') => buildIdentityCandidate(input, { mode, now: () => 100 });

console.log('normalization:');
check('strict is the default runtime mode', normalizeIdentityMode() === 'strict');
check('relaxed mode is configurable', normalizeIdentityMode('RELAXED') === 'relaxed');
check('Arabic glyphs, tatweel, digits, and whitespace normalize deterministically',
  normalizeObservationText('  کـیـلو ۹۰۰  ی ') === 'كيلو 900 ي');
check('punctuation variants normalize deterministically', normalizeObservationText('A—B ’ C') === "A-B ' C");

console.log('candidate construction:');
{
  const input = {
    brand: '  SADIA ',
    productName: 'Tender Chicken Breasts',
    arabicName: 'صدور دجاج طري',
    size: '900 g',
    confidence: 0.92,
  };
  const result = build(input);
  check('example becomes deterministic evidence',
    result.identityCandidate.brand === 'Sadia' &&
    result.identityCandidate.family === 'Chicken' &&
    result.identityCandidate.cut === 'Breast' &&
    result.identityCandidate.size.value === 900 &&
    result.identityCandidate.size.unit === 'g' &&
    result.identityCandidate.count === 1);
  check('missing processing is not hallucinated', result.identityCandidate.processing === null);
  check('original observation is preserved verbatim', result.diagnostics.extractionInput.brand === '  SADIA ');
  check('missing candidate fields remain explicitly unresolved', result.diagnostics.unresolvedFields.includes('processing'));
}
{
  const result = build({
    brand: 'Sadia', productName: 'Fresh Chicken Breast', arabicName: null,
    processing: 'fresh', size: '6×200 ml',
  });
  check('direct processing evidence is classified', result.identityCandidate.processing === 'Fresh');
  check('multiplier package parses into per-item size and count',
    result.identityCandidate.size.value === 200 && result.identityCandidate.size.unit === 'ml' &&
    result.identityCandidate.count === 6 &&
    result.identityCandidate.package.type === 'Pack' &&
    result.identityCandidate.package.expression === '6x200 ml');
}
{
  const bonus = build({ productName: 'Tea Bags', size: '10+2' });
  check('bonus package count is additive', bonus.identityCandidate.count === 12 && bonus.identityCandidate.package.expression === '10+2');
  const pack = build({ productName: 'Tissues 3 Pack', size: '3 Pack' });
  check('pack expression parses deterministically', pack.identityCandidate.count === 3 && pack.identityCandidate.package.type === 'Pack');
  const arabic = build({ productName: 'Rice', arabicName: 'أرز', size: '١٫٥ كجم' });
  check('Arabic decimal and unit normalize', arabic.identityCandidate.size.value === 1.5 && arabic.identityCandidate.size.unit === 'kg');
}

console.log('validation and non-inference:');
{
  const malformed = build({ brand: ['not', 'text'], productName: 7, size: '900 stones', confidence: 4 });
  check('malformed fields are rejected without throwing', malformed.diagnostics.rejectedFields.length >= 4);
  check('valid partial candidate survives malformed siblings', malformed.identityCandidate.brand === null && malformed.identityCandidate.size === null);
}
{
  const strict = build({ productName: 'Frozen Chicken Breast', size: '80 ml + 20 ml' });
  const relaxed = build({ productName: 'Frozen Chicken Breast', size: '80 ml + 20 ml' }, 'relaxed');
  check('strict mode rejects conflicting measurements', strict.identityCandidate.size === null && strict.diagnostics.rejectedFields.some((item) => item.field === 'size'));
  check('relaxed mode selects visible first measurement with a warning', relaxed.identityCandidate.size.value === 80 && relaxed.diagnostics.validationResult.warnings.length === 1);
}
{
  const conflict = build({ productName: 'Fresh Frozen Chicken Breast', size: '1 kg' });
  check('conflicting processing remains null', conflict.identityCandidate.processing === null && conflict.diagnostics.rejectedFields.some((item) => item.field === 'processing'));
  const impossible = build({ productName: 'Chicken', size: '1 kg', count: 0 });
  check('impossible explicit count is rejected while size remains usable', impossible.identityCandidate.count === null && impossible.identityCandidate.size.value === 1);
  const root = buildIdentityCandidate('not an object', { now: () => 100 });
  check('malformed root returns an invalid all-null partial', root.diagnostics.validationResult.status === 'invalid' && Object.values(root.identityCandidate).every((value) => value === null));
}
{
  const first = build({ brand: 'SADIA', productName: 'Fresh Chicken Breast', size: '900g' });
  const second = build({ brand: 'SADIA', productName: 'Fresh Chicken Breast', size: '900g' });
  check('candidate and decisions are deterministic', JSON.stringify(first) === JSON.stringify(second));
}

// Frozen representative structured outputs from the historical Smart Vision
// crop set. Expected values are direct, human-readable observations only.
const fixtures = [
  {
    name: 'Sadia chicken',
    input: { brand: 'Sadia', productName: 'Tender Chicken Breasts', arabicName: 'صدور دجاج طري', size: '900 g' },
    expected: { brand: 'Sadia', family: 'Chicken', cut: 'Breast', processing: null, size: { value: 900, unit: 'g' }, count: 1 },
  },
  {
    name: 'smoked turkey',
    input: { brand: 'Lapiana', productName: 'Lapiana Smoked Turkey Breast', arabicName: null, size: null },
    expected: { family: 'Turkey', cut: 'Breast', processing: 'Smoked', size: null, count: null },
  },
  {
    name: 'tea count',
    input: { brand: 'AL KBOUS', productName: "AL KBOUS TEA BAGS 100'S", arabicName: null, size: "100'S" },
    expected: { family: 'Tea', package: { type: 'Bag', expression: "100's" }, size: null, count: 100 },
  },
  {
    name: 'Kinder chocolate',
    input: { brand: 'Kinder', productName: 'Kinder Chocolate mini', arabicName: null, size: 'Mini Chocolate 120g' },
    expected: { family: 'Chocolate', size: { value: 120, unit: 'g' }, count: 1 },
  },
  {
    name: 'Activia conflict',
    input: { brand: 'ACTIVIA', productName: 'ACTIVIA FRESH LABAN FULL FAT / LOW FAT 1750ML', arabicName: null, size: '1750ML' },
    expected: { processing: 'Fresh', variety: null, size: { value: 1750, unit: 'ml' }, count: 1 },
  },
  {
    name: 'frozen multipack',
    input: { brand: 'Seara', productName: 'Frozen Chicken Breast 6×200 ml', arabicName: null, size: '6×200 ml' },
    expected: { family: 'Chicken', cut: 'Breast', processing: 'Frozen', package: { type: 'Pack', expression: '6x200 ml' }, size: { value: 200, unit: 'ml' }, count: 6 },
  },
];

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedScore(candidate, expected) {
  const entries = Object.entries(expected);
  return entries.reduce((sum, [field, value]) => sum + (same(candidate[field], value) ? 1 : 0), 0);
}

function previousCandidate(input) {
  const parsed = previousParseSize(input.productName || '', input.size || '');
  const family = previousProductFamily([input.productName, input.arabicName].filter(Boolean).join(' '));
  return {
    brand: input.brand ? titleForBenchmark(input.brand) : null,
    family: family ? titleForBenchmark(family) : null,
    cut: null,
    processing: null,
    variety: null,
    package: null,
    size: parsed?.src ? { value: parsed.each, unit: parsed.unit } : null,
    count: parsed?.src ? parsed.pack : null,
  };
}

function titleForBenchmark(value) {
  return String(value).toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

let normalized = 0;
let invalid = 0;
let sizeCorrect = 0;
let packageCorrect = 0;
const comparison = { Better: 0, Comparable: 0, Worse: 0 };
let elapsed = 0;
for (const fixture of fixtures) {
  const started = performance.now();
  const result = buildIdentityCandidate(fixture.input);
  elapsed += performance.now() - started;
  if (result.diagnostics.validationResult.valid) normalized += 1;
  else invalid += 1;
  if (Object.hasOwn(fixture.expected, 'size') && same(result.identityCandidate.size, fixture.expected.size)) sizeCorrect += 1;
  if (Object.hasOwn(fixture.expected, 'package') && same(result.identityCandidate.package, fixture.expected.package)) packageCorrect += 1;
  const current = expectedScore(result.identityCandidate, fixture.expected);
  const previous = expectedScore(previousCandidate(fixture.input), fixture.expected);
  comparison[current > previous ? 'Better' : current < previous ? 'Worse' : 'Comparable'] += 1;
}

console.log('historical structured-output benchmark:');
console.log(JSON.stringify({
  samples: fixtures.length,
  successfulNormalization: normalized,
  invalidCandidates: invalid,
  unresolvedFields: fixtures.reduce((sum, fixture) => sum + build(fixture.input).diagnostics.unresolvedFields.length, 0),
  sizeAccuracy: `${sizeCorrect}/${fixtures.filter((fixture) => Object.hasOwn(fixture.expected, 'size')).length}`,
  packageAccuracy: `${packageCorrect}/${fixtures.filter((fixture) => Object.hasOwn(fixture.expected, 'package')).length}`,
  averageProcessingMs: Math.round((elapsed / fixtures.length) * 1000) / 1000,
  comparison,
}));
check('representative benchmark has no regression', comparison.Worse === 0 && comparison.Better > 0);

console.log('development debug panel:');
{
  const hidden = await handleIdentityBuilderDebug(new Request(`https://x${IDENTITY_DEBUG_PATH}`), { isDevelopment: false });
  check('debug route is absent outside development', hidden === null);
  const page = await handleIdentityBuilderDebug(new Request(`https://x${IDENTITY_DEBUG_PATH}`), { isDevelopment: true });
  check('development panel displays every requested section',
    page.status === 200 && /Normalized fields/.test(await page.text()));
  const built = await handleIdentityBuilderDebug(new Request(`https://x${IDENTITY_DEBUG_PATH}/build?mode=relaxed`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ brand: 'SADIA', productName: 'Fresh Chicken Breast', size: '900g' }),
  }), { isDevelopment: true });
  const body = await built.json();
  check('debug build endpoint returns candidate and diagnostics',
    body.identityCandidate.family === 'Chicken' && body.diagnostics.mode === 'relaxed');
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll Identity Builder tests passed.');
