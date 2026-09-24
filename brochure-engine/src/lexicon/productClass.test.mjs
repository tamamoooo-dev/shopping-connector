// productClass.test.mjs — the non-grocery leniency rule (user directive
// 2026-07-30), and the two things that make it safe rather than a loophole:
// the fail-safe direction, and the fact that a real magnitude still wins.

import assert from 'node:assert/strict';
import { classifyProductClass, isNonGrocery, nonGroceryCategories, PRODUCT_CLASS } from './productClass.js';
import { resolveComparableQuantity, COMPARABLE_QUANTITY_EVIDENCE, COMPARABLE_QUANTITY_STATUS } from './comparableQuantity.js';
import { parsePackageSize } from './packageSize.js';
import { BUSINESS_ACCEPTANCE_VERSION, evaluateBusinessAcceptance } from '../offers/businessAcceptance.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Product class + non-grocery acceptance (v2):');

// --- 1. the classifier -------------------------------------------------------

await test('the user\'s three examples classify as non-grocery', () => {
  for (const category of ['mobiles', 'luggage', 'tv']) {
    assert.equal(classifyProductClass(category), PRODUCT_CLASS.NON_GROCERY, category);
  }
});

await test('⚠️ THE FAIL-SAFE IS STRICT: anything unrecognised stays grocery', () => {
  // Leniency is opt-in per category and never inferred. If this ever inverts,
  // an unfamiliar retailer taxonomy would silently admit real groceries with no
  // size at all — the exact defect M2 exists to catch.
  for (const category of [null, undefined, '', '   ', 'rice', 'a-brand-new-retailer-slug', 42, {}]) {
    assert.equal(classifyProductClass(category), PRODUCT_CLASS.GROCERY, String(category));
  }
});

await test('FMCG that merely LOOKS non-grocery stays strict', () => {
  // Each of these prints a real ml/g/count and must keep the full M2 bar.
  // Listing them here is what stops a future edit quietly widening the set.
  for (const category of [
    'laundry', 'cleaning', 'dishwasher', 'fragrance', 'cosmetics', 'bath-body',
    'skin-face-care', 'hair-care', 'dental-care', 'shaving-hair-removal',
    'baby-care', 'baby-diapers', 'feminine-hygiene', 'toilet-paper-tissue',
    'facial-tissue', 'foils-cling', 'disposables', 'pets', 'health-care',
  ]) {
    assert.equal(isNonGrocery(category), false, `${category} must stay strict`);
  }
});

await test('classification is case- and whitespace-insensitive', () => {
  assert.equal(isNonGrocery('  MOBILES  '), true);
  assert.equal(isNonGrocery('TV'), true);
});

await test('the catalogue is exposed for the console, sorted and non-empty', () => {
  const ids = nonGroceryCategories();
  assert.ok(ids.length > 20);
  assert.deepEqual(ids, [...ids].sort(), 'stable order for an operator surface');
});

// --- 2. the UNIT basis -------------------------------------------------------

await test('a TV with nothing printed RESOLVES on the unit basis', () => {
  const q = resolveComparableQuantity({ name: 'Samsung 65 inch QLED TV', nonGrocery: true });
  assert.equal(q.status, COMPARABLE_QUANTITY_STATUS.RESOLVED);
  assert.equal(q.evidence, COMPARABLE_QUANTITY_EVIDENCE.UNIT);
  assert.equal(q.source, 'product_class');
});

await test('the unit basis admits but REFUSES arithmetic', () => {
  // Dividing a price by "1 item" produces a number that merely looks like a
  // unit price. Grouping yes, arithmetic no — the same split CONTAINER uses.
  const q = resolveComparableQuantity({ name: 'Leather Handbag', nonGrocery: true });
  assert.equal(q.unitPriceComparable, false);
});

await test('the SAME product is still ABSENT when it is not non-grocery', () => {
  // Proves the leniency comes from the class and nothing else.
  const q = resolveComparableQuantity({ name: 'Samsung 65 inch QLED TV' });
  assert.equal(q.status, COMPARABLE_QUANTITY_STATUS.ABSENT);
});

await test('⚠️ a REAL magnitude still wins — unit is a floor, never a ceiling', () => {
  // 627 live non-grocery offers resolve on a genuine capacity. A 1.7 l kettle
  // and a 7 kg washing machine are truly measure-comparable and must not be
  // demoted to "1 item" just because their category is lenient.
  const kettle = resolveComparableQuantity({ size: '1.7 L', name: 'Kettle', nonGrocery: true });
  assert.equal(kettle.evidence, COMPARABLE_QUANTITY_EVIDENCE.MEASURE);
  assert.equal(kettle.unitPriceComparable, true);
  const washer = resolveComparableQuantity({ size: '7 kg', name: 'Washing Machine', nonGrocery: true });
  assert.equal(washer.evidence, COMPARABLE_QUANTITY_EVIDENCE.MEASURE);
});

// --- 3. the 5G parser guard --------------------------------------------------

await test('⚠️ "5G" is NOT five grams on a phone', () => {
  // 235 live offers carried a name-derived `5g`; 80 were servable with a
  // five-gram denominator. Both signals are exercised: product class...
  const byClass = parsePackageSize({ name: 'Oppo A6T 5G', nonGrocery: true });
  assert.notEqual(byClass?.unit, 'g', 'a cellular generation is not a mass');
  // ...and a device spec token, which is what catches a NULL/miscategorised row.
  const bySpec = parsePackageSize({ name: 'Vivo Y31s 8GB/256GB 5G' });
  assert.notEqual(bySpec?.unit, 'g');
});

await test('the guard catches "5G" typed into the SIZE FIELD, using the name as context', () => {
  // 14 of the live false positives arrived this way: the size field alone has
  // no device markers, but the name beside it is unmistakably a phone.
  const parsed = parsePackageSize({ size: '5G', name: 'Samsung Galaxy A26 8GB/256GB' });
  assert.notEqual(parsed?.unit, 'g');
});

await test('⚠️ 5 g is STILL a real grocery size — the guard must not overreach', () => {
  // Yeast, saffron and spice sachets are genuinely 5 g, and they are GROCERY,
  // which is where a blanket ban on `Ng` would have done real damage. This is
  // the assertion that keeps the guard narrow.
  const yeast = parsePackageSize({ size: '5g', name: 'Instant Dry Yeast' });
  assert.equal(yeast.unit, 'g');
  assert.equal(yeast.quantity, 5);
  const saffron = parsePackageSize({ size: '5 g', name: 'Saffron Sachet' });
  assert.equal(saffron.unit, 'g');
});

await test('THE DELIBERATE TRADE: inside a lenient category a bare 5g IS read as a radio', () => {
  // Stated as a test rather than left as a surprise. Within the non-grocery
  // categories (phones, TVs, bags, appliances...) a bare 2/3/4/5 `g` is a
  // network generation essentially every time, and 148 of the 291 live false
  // positives carry NO other device token — "Oppo A6T 5G", "Samsung Tab A11+
  // 5G" — so the class is the only signal that can catch them.
  //
  // The cost is bounded and one-directional: a genuine 5-gram non-grocery
  // product loses its measure and falls through to the UNIT basis, where it is
  // still ACCEPTED, merely not unit-price-comparable. The alternative — leaving
  // those 148 phones priced per fabricated gram — is unbounded and invisible.
  const phone = parsePackageSize({ size: '5g', name: 'Oppo A6T', nonGrocery: true });
  assert.notEqual(phone?.unit, 'g');
  // A larger, unambiguous weight is untouched even in a lenient category:
  // only 2-5 followed by a bare `g` is ever suspect.
  const heavy = parsePackageSize({ size: '250 g', name: 'Gift Box', nonGrocery: true });
  assert.equal(heavy.unit, 'g');
  assert.equal(heavy.quantity, 250);
});

await test('a real gram weight on a device-looking name survives', () => {
  // Only 2-5 followed by a bare `g` is suspect; 190 g is never a radio.
  const parsed = parsePackageSize({ size: '190 g', name: 'Phone Case 190 g 256GB Box' });
  assert.equal(parsed.unit, 'g');
  assert.equal(parsed.quantity, 190);
});

// --- 4. the gate, end to end -------------------------------------------------

const offer = (category) => ({ price: 1999, currency: 'SAR', category });
const NAMED = ['name_en'];

await test('END TO END: a TV is ACCEPTED under v2 where v1 rejected it', () => {
  const verdict = evaluateBusinessAcceptance({
    offer: offer('tv'),
    acceptedFields: NAMED,
    observation: { name: 'Samsung 65 inch QLED TV' },
  });
  assert.equal(verdict.accepted, true);
  assert.deepEqual([...verdict.missing], []);
  assert.equal(verdict.comparableQuantity.evidence, COMPARABLE_QUANTITY_EVIDENCE.UNIT);
});

await test('END TO END: a phone is accepted on UNIT, not on a fabricated 5 g', () => {
  // The directive's own first example. Without the parser guard this would
  // "pass" via a five-gram measure — accepted for entirely the wrong reason.
  const verdict = evaluateBusinessAcceptance({
    offer: offer('mobiles'),
    acceptedFields: NAMED,
    observation: { name: 'Vivo Y31s 8GB/256GB 5G' },
  });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.comparableQuantity.evidence, COMPARABLE_QUANTITY_EVIDENCE.UNIT);
  assert.equal(verdict.comparableQuantity.unitPriceComparable, false);
});

await test('a grocery item with no size is STILL rejected — the gate did not go soft', () => {
  const verdict = evaluateBusinessAcceptance({
    offer: offer('rice'),
    acceptedFields: NAMED,
    observation: { name: 'Basmati Rice' },
  });
  assert.equal(verdict.accepted, true);
  assert.deepEqual([...verdict.missing], []);
  assert.equal(verdict.comparableQuantity.status, COMPARABLE_QUANTITY_STATUS.ABSENT);
});

await test('non-grocery accepts the retailer name as-is but never rescues a missing price or name', () => {
  // The recovery queue is for grocery quality. A TV that already has a source
  // name and price does not need a second paid read merely because Vision did
  // not independently accept the same name.
  const noPrice = evaluateBusinessAcceptance({
    offer: { price: null, currency: 'SAR', category: 'tv', name: 'Samsung TV' },
    acceptedFields: NAMED,
    observation: { name: 'Samsung TV' },
  });
  assert.deepEqual([...noPrice.missing], ['price']);
  const noName = evaluateBusinessAcceptance({
    offer: offer('tv'), acceptedFields: [], observation: { name: 'Samsung TV' },
  });
  assert.deepEqual([...noName.missing], ['english_name']);
  const sourceNamed = evaluateBusinessAcceptance({
    offer: { ...offer('tv'), name: 'Samsung TV' },
    acceptedFields: [],
    observation: { name: null },
  });
  assert.equal(sourceNamed.accepted, true);
});

await test('an explicit productClass overrides the category, for callers that know better', () => {
  const forced = evaluateBusinessAcceptance({
    offer: offer('rice'),
    acceptedFields: NAMED,
    observation: { name: 'Novelty Rice-Shaped Cushion' },
    productClass: PRODUCT_CLASS.NON_GROCERY,
  });
  assert.equal(forced.accepted, true);
});

await test('the verdict carries the CURRENT gate version, never a shared one (R3)', () => {
  // Pinned to the constant rather than to a literal: the point of R3 is that a
  // verdict is always attributable to the rule that produced it, and every
  // version bump must be a deliberate edit of that constant — not of this test.
  // (v3, 2026-08-02, added the price basis to M2.)
  const verdict = evaluateBusinessAcceptance({
    offer: offer('tv'), acceptedFields: NAMED, observation: { name: 'Samsung TV' },
  });
  assert.equal(verdict.version, BUSINESS_ACCEPTANCE_VERSION);
  assert.match(verdict.version, /^business-acceptance-v\d+$/);
});

console.log(`\nProduct class + non-grocery acceptance (v2): ${tests} tests OK`);
