import assert from 'node:assert/strict';
import { buildStructuredProduct } from '../lexicon/structuredProduct.js';
import {
  COMMERCE_SCORE_VERSION,
  COMMERCE_SCORE_WEIGHTS,
  calculateCommerceScore,
  hasUsableCommercePrice,
} from './commerceScore.js';

let tests = 0;
const test = (name, fn) => {
  fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Commerce Score:');

const complete = buildStructuredProduct({
  name_en: 'Almarai Fresh Laban 1.5 L',
  name_ar: 'لبن المراعي',
  brand: 'Almarai',
  size: '1.5 L',
});

test('the approved deterministic weights sum to 100', () => {
  assert.equal(
    Object.values(COMMERCE_SCORE_WEIGHTS).reduce((sum, value) => sum + value, 0),
    100,
  );
});

test('a commercially complete offer scores 100', () => {
  const result = calculateCommerceScore(complete, { price: 6.95, currency: 'SAR' });
  assert.equal(result.version, COMMERCE_SCORE_VERSION);
  assert.equal(result.score, 100);
  assert.equal(result.breakdown.price.points, 35);
  assert.equal(result.breakdown.package_size.points, 25);
  assert.equal(result.breakdown.brand.points, 20);
  assert.equal(result.breakdown.english_identity.points, 10);
  assert.equal(result.breakdown.category.points, 5);
  assert.equal(result.breakdown.descriptors_flavor.points, 5);
});

test('price usability is strict, deterministic, and currency-aware', () => {
  assert.equal(hasUsableCommercePrice({ price: 10, currency: 'SAR' }), true);
  assert.equal(hasUsableCommercePrice({ price: '10.50', currency: 'sar' }), true);
  assert.equal(hasUsableCommercePrice({ price: 0, currency: 'SAR' }), false);
  assert.equal(hasUsableCommercePrice({ price: -1, currency: 'SAR' }), false);
  assert.equal(hasUsableCommercePrice({ price: 10, currency: null }), false);
});

test('AI confidence and corroboration cannot affect Commerce Score', () => {
  const low = calculateCommerceScore(complete, {
    price: 6.95,
    currency: 'SAR',
    confidence: 0,
    corroboration: 0,
  });
  const high = calculateCommerceScore(complete, {
    price: 6.95,
    currency: 'SAR',
    confidence: 1,
    corroboration: 1,
  });
  assert.deepEqual(low, high);
});

test('model-shaped price fields are ignored', () => {
  const result = calculateCommerceScore(complete, {
    current_price: 6.95,
    old_price: 8.5,
    currency: 'SAR',
  });
  assert.equal(result.breakdown.price.resolved, false);
  assert.equal(result.breakdown.price.points, 0);
});

test('missing commercial fields lose exactly their approved weights', () => {
  const sparse = buildStructuredProduct({ name_en: 'Unknown Gizmo' });
  const result = calculateCommerceScore(sparse, { price: 9, currency: 'SAR' });
  assert.equal(result.score, 45);
  assert.equal(result.breakdown.price.resolved, true);
  assert.equal(result.breakdown.english_identity.resolved, true);
  assert.equal(result.breakdown.package_size.resolved, false);
  assert.equal(result.breakdown.brand.resolved, false);
  assert.equal(result.breakdown.category.resolved, false);
  assert.equal(result.breakdown.descriptors_flavor.resolved, false);
});

test('same deterministic input always yields the same frozen breakdown', () => {
  const a = calculateCommerceScore(complete, { price: 6.95, currency: 'SAR' });
  const b = calculateCommerceScore(complete, { price: 6.95, currency: 'SAR' });
  assert.deepEqual(a, b);
  assert.equal(Object.isFrozen(a), true);
  assert.equal(Object.isFrozen(a.breakdown), true);
});

console.log(`Commerce Score: ${tests} tests passed`);
