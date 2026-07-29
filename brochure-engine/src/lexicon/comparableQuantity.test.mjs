import assert from 'node:assert/strict';
import { buildStructuredProduct } from './structuredProduct.js';
import {
  COMPARABLE_QUANTITY_BASIS,
  COMPARABLE_QUANTITY_STATUS,
  COMPARABLE_QUANTITY_VERSION,
  comparableQuantityFromStructured,
  projectComparableQuantity,
  resolveComparableQuantity,
} from './comparableQuantity.js';

let tests = 0;
const test = (name, fn) => {
  fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Comparable Quantity:');

test('a printed measure resolves on the measure basis and supports arithmetic', () => {
  const cq = resolveComparableQuantity({ size: '330 ml', name: 'Arwa Bottled Water 330 ml' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.RESOLVED);
  assert.equal(cq.basis, COMPARABLE_QUANTITY_BASIS.MEASURE);
  assert.equal(cq.quantity, 330);
  assert.equal(cq.unit, 'ml');
  assert.equal(cq.pack, 1);
  assert.equal(cq.unitPriceComparable, true);
});

test('a multipack keeps the ONE-unit magnitude and reports the pack separately', () => {
  const cq = resolveComparableQuantity({ size: '6 x 250 ml', name: 'Nadec Milk' });
  assert.equal(cq.quantity, 250, 'quantity is the magnitude of one unit, never the total');
  assert.equal(cq.pack, 6);
  assert.equal(cq.unitPriceComparable, true);
});

test('a printed count resolves on the count basis', () => {
  const cq = resolveComparableQuantity({ size: "40's", name: 'Fine Tissue' });
  assert.equal(cq.basis, COMPARABLE_QUANTITY_BASIS.COUNT);
  assert.equal(cq.quantity, 40);
  assert.equal(cq.unit, 'piece');
  assert.equal(cq.unitPriceComparable, true);
});

test('a container admits the product but refuses arithmetic', () => {
  const cq = resolveComparableQuantity({ name: 'Fresh Tomato', packageType: 'bag' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.RESOLVED, 'a carton is a real product');
  assert.equal(cq.basis, COMPARABLE_QUANTITY_BASIS.CONTAINER);
  assert.equal(cq.quantity, null);
  assert.equal(cq.unit, 'bag');
  assert.equal(cq.source, 'package_type');
  assert.equal(
    cq.unitPriceComparable, false,
    'nothing may ever compute a price per "1 bag"',
  );
});

test('no size and no package type is ABSENT, never an invented quantity', () => {
  const cq = resolveComparableQuantity({ name: 'Fresh Tomato' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.ABSENT);
  assert.equal(cq.basis, null);
  assert.equal(cq.quantity, null);
  assert.equal(cq.pack, 1);
  assert.equal(cq.unitPriceComparable, false);
});

test('first hit wins — a printed measure is never demoted to its container word', () => {
  const cq = resolveComparableQuantity({
    size: '1.5 L', name: 'Water', packageType: 'bottle',
  });
  assert.equal(cq.basis, COMPARABLE_QUANTITY_BASIS.MEASURE);
  assert.equal(cq.unit, 'l');
});

test('an unknown package type resolves to nothing rather than a guess', () => {
  const cq = resolveComparableQuantity({ name: 'Mystery Item', packageType: 'blister' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.ABSENT);
});

test('the weak-count guard is INHERITED, not re-implemented', () => {
  // parseSize marks a bare "…26S" model-number suffix 'count-weak', and
  // parsePackageSize refuses to surface it. The projection must not resurrect
  // it from some other field.
  const cq = resolveComparableQuantity({ name: 'Hisense Fridge NRF110N26S' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.ABSENT);
});

test('the projection re-parses nothing when a Structured Product exists', () => {
  const structured = buildStructuredProduct({
    name_en: 'Almarai Fresh Laban 1.5 L', brand: 'Almarai', size: '1.5 L',
  });
  const fromStructured = comparableQuantityFromStructured(structured);
  const fromRaw = resolveComparableQuantity({ size: '1.5 L', name: 'Almarai Fresh Laban 1.5 L' });
  assert.deepEqual(fromStructured, fromRaw, 'both paths must agree exactly');
});

test('output is frozen and version-stamped', () => {
  const cq = resolveComparableQuantity({ size: '330 ml' });
  assert.equal(cq.version, COMPARABLE_QUANTITY_VERSION);
  assert.ok(Object.isFrozen(cq));
});

test('the same input always yields the same output', () => {
  const once = resolveComparableQuantity({ size: '6 x 250 ml', name: 'Nadec Milk' });
  const twice = resolveComparableQuantity({ size: '6 x 250 ml', name: 'Nadec Milk' });
  assert.deepEqual(once, twice);
});

test('a null or empty observation is safe and ABSENT', () => {
  assert.equal(resolveComparableQuantity().status, COMPARABLE_QUANTITY_STATUS.ABSENT);
  assert.equal(projectComparableQuantity(null, null).status, COMPARABLE_QUANTITY_STATUS.ABSENT);
  assert.equal(comparableQuantityFromStructured(null).status, COMPARABLE_QUANTITY_STATUS.ABSENT);
});

test('KNOWN LIMIT (C-5): resolved is not correct — HONOR 5G projects as 5 g', () => {
  // Pinned deliberately. parseSize reads the model designator "5G" as a
  // measure, so M2 passes on a confidently wrong size. If someone later fixes
  // the parser this test SHOULD fail and be updated — it documents a measured
  // ceiling, not a desired behaviour.
  const cq = resolveComparableQuantity({ name: 'HONOR 5G' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.RESOLVED);
  assert.equal(cq.quantity, 5);
  assert.equal(cq.unit, 'g');
});

console.log(`Comparable Quantity: ${tests} tests passed`);
