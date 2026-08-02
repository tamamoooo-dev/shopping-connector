import assert from 'node:assert/strict';
import { buildStructuredProduct } from '../lexicon/structuredProduct.js';
import { calculateCommerceScore } from './commerceScore.js';
import {
  BUSINESS_ACCEPTANCE_VERSION,
  MANDATORY_CONDITIONS,
  evaluateBusinessAcceptance,
  isExtractionCandidate,
} from './businessAcceptance.js';

let tests = 0;
const test = (name, fn) => {
  fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Business Acceptance Gate:');

const offer = { price: 5.99, currency: 'SAR' };
const accepted = ['name_en', 'brand', 'size'];
const complete = buildStructuredProduct({
  name_en: 'Arwa Bottled Water 330 ml', name_ar: 'مياه أروى', brand: 'Arwa', size: '330 ml',
});

test('all three conditions present accepts, with an empty missing list', () => {
  const verdict = evaluateBusinessAcceptance({
    offer, acceptedFields: accepted, structured: complete,
  });
  assert.equal(verdict.accepted, true);
  assert.deepEqual([...verdict.missing], []);
  assert.equal(verdict.version, BUSINESS_ACCEPTANCE_VERSION);
});

test('each condition can reject ALONE, and names itself', () => {
  const noPrice = evaluateBusinessAcceptance({
    offer: { price: null, currency: 'SAR' }, acceptedFields: accepted, structured: complete,
  });
  assert.deepEqual([...noPrice.missing], ['price']);

  const noQuantity = evaluateBusinessAcceptance({
    offer, acceptedFields: accepted, structured: buildStructuredProduct({ name_en: 'Fresh Tomato' }),
  });
  assert.deepEqual([...noQuantity.missing], ['comparable_quantity']);

  const noName = evaluateBusinessAcceptance({
    offer, acceptedFields: ['brand'], structured: complete,
  });
  assert.deepEqual([...noName.missing], ['english_name']);
});

test('reject reasons are per-condition and never aggregated (R6)', () => {
  const verdict = evaluateBusinessAcceptance({
    offer: { price: 0, currency: null }, acceptedFields: [], structured: null, observation: {},
  });
  assert.equal(verdict.accepted, false);
  assert.deepEqual([...verdict.missing], [...MANDATORY_CONDITIONS]);
});

test('it is a CONJUNCTION — two strong conditions never carry a missing third', () => {
  const verdict = evaluateBusinessAcceptance({
    offer, acceptedFields: accepted, structured: buildStructuredProduct({ name_en: 'Fresh Tomato' }),
  });
  assert.equal(verdict.accepted, false, 'price + name must not compensate for quantity');
});

test('a container-basis product PASSES the gate and scores 0 on package_size (R8)', () => {
  // Pinned deliberately: acceptance is a floor, Commerce Score is a
  // measurement. They answer different questions and must be allowed to
  // disagree. Someone will eventually try to "fix" one to agree with the other.
  const structured = buildStructuredProduct({ name_en: 'Fresh Tomato', package_type: 'bag' });
  const verdict = evaluateBusinessAcceptance({
    offer, acceptedFields: accepted, structured,
  });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.comparableQuantity.evidence, 'container');
  assert.equal(verdict.comparableQuantity.unitPriceComparable, false);

  const commerce = calculateCommerceScore(structured, offer);
  assert.equal(commerce.breakdown.package_size.points, 0, 'no canonical unit, so no points');
});

test('the gate reads NO score — Commerce Score cannot change a verdict (§4.4, P8)', () => {
  const structured = buildStructuredProduct({ name_en: 'Fresh Tomato', package_type: 'bag' });
  const verdict = evaluateBusinessAcceptance({ offer, acceptedFields: accepted, structured });
  const commerce = calculateCommerceScore(structured, offer);
  assert.ok(commerce.score < 100, 'this row is commercially incomplete');
  assert.equal(verdict.accepted, true, 'and the gate accepts it anyway');
  assert.ok(!('commerce_score' in verdict), 'no score is echoed into the verdict');
  assert.ok(!('builder_score' in verdict), 'and certainly not the linguistic axis');
});

test('model confidence is not an input at any confidence value', () => {
  const high = evaluateBusinessAcceptance({
    offer, acceptedFields: [], structured: complete, confidence: 0.99,
  });
  const low = evaluateBusinessAcceptance({
    offer, acceptedFields: [], structured: complete, confidence: 0.01,
  });
  assert.deepEqual(high, low, 'confidence must be inert');
  assert.equal(high.accepted, false, 'and a rejected name stays rejected at 0.99');
});

test('M3 reuses S3\'s verdict rather than re-judging the string', () => {
  // The name is a perfectly good English string, but S3 did not accept it.
  // The gate must defer, not form a second opinion.
  const verdict = evaluateBusinessAcceptance({
    offer, acceptedFields: [], structured: complete,
  });
  assert.equal(verdict.mandatory.english_name, false);
});

test('the verdict is frozen, versioned and deterministic', () => {
  const once = evaluateBusinessAcceptance({ offer, acceptedFields: accepted, structured: complete });
  const twice = evaluateBusinessAcceptance({ offer, acceptedFields: accepted, structured: complete });
  assert.deepEqual(once, twice);
  assert.ok(Object.isFrozen(once));
  assert.ok(Object.isFrozen(once.missing));
  assert.ok(Object.isFrozen(once.mandatory));
});

test('it is total — no input shape throws', () => {
  assert.doesNotThrow(() => evaluateBusinessAcceptance());
  assert.doesNotThrow(() => evaluateBusinessAcceptance({ offer: null, acceptedFields: null }));
  assert.equal(evaluateBusinessAcceptance().accepted, false);
});

test('a price the gate cannot use is not a price', () => {
  for (const bad of [
    { price: 0, currency: 'SAR' },
    { price: -1, currency: 'SAR' },
    { price: 5, currency: null },
    { price: 5, currency: 'SARS' },
    { price: 'free', currency: 'SAR' },
  ]) {
    const verdict = evaluateBusinessAcceptance({
      offer: bad, acceptedFields: accepted, structured: complete,
    });
    assert.equal(verdict.mandatory.price, false, JSON.stringify(bad));
  }
});

console.log('S1 Extraction Admission:');

test('a complete candidate is admitted', () => {
  const verdict = isExtractionCandidate({
    imageUrl: 'https://example/crop.jpg', validTo: '2026-08-01', currentOn: '2026-07-26',
    attempted: false, price: 5.99, currency: 'SAR',
  });
  assert.equal(verdict.admitted, true);
  assert.deepEqual([...verdict.reasons], []);
});

test('a priceless offer never costs a model call (C-2)', () => {
  const verdict = isExtractionCandidate({
    imageUrl: 'https://example/crop.jpg', validTo: '2026-08-01', currentOn: '2026-07-26',
    price: null, currency: 'SAR',
  });
  assert.equal(verdict.admitted, false);
  assert.deepEqual([...verdict.reasons], ['no_usable_price']);
});

test('every blocking reason is reported, not just the first', () => {
  const verdict = isExtractionCandidate({
    imageUrl: null, validTo: '2026-07-01', currentOn: '2026-07-26', attempted: true,
  });
  assert.deepEqual(
    [...verdict.reasons],
    ['no_crop', 'expired', 'already_attempted', 'no_usable_price'],
  );
});

test('S1 and S4 agree about what a usable price is', () => {
  const bad = { price: 0, currency: 'SAR' };
  assert.equal(isExtractionCandidate({ imageUrl: 'x', ...bad }).admitted, false);
  assert.equal(
    evaluateBusinessAcceptance({ offer: bad, acceptedFields: accepted, structured: complete })
      .mandatory.price,
    false,
  );
});

console.log(`Business Acceptance: ${tests} tests passed`);
