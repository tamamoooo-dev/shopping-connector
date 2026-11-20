// packCountBeforeMeasure.test.mjs — a bare count word ("24's", "12 pcs") right
// BEFORE a measure names the pieces inside it; only AFTER the measure does it
// multiply (2026-11-20). "Kiri Portions Cheese 24's (400g)" was valued as
// 24 × 400 g = 9.6 kg, 2.08 SR/kg: a fake lowest price. Run with:
//   node src/packCountBeforeMeasure.test.mjs
import assert from 'node:assert/strict';
import { parseSize } from './matching.js';
import { resolveComparableQuantity } from './lexicon/comparableQuantity.js';
import { archiveLine } from './offers/valueLines.js';

const total = (name, size) => { const p = parseSize(name, size); return `${p.pack}×${p.each}${p.unit}`; };

// Count before the measure: the measure is the whole package.
assert.equal(total("Kiri Portions Cheese 24's (400g)", "24's (400g)"), '1×400g', 'size field repeats the count after the name');
assert.equal(total('Kiri Portions Cheese 24’s (400g)', '400g'), '1×400g');
assert.equal(total('Kiri Spreadable Cream Cheese 24 PCS, 400 G', '24 PCS, 400 G'), '1×400g');
assert.equal(total("Seara Chicken Burger 24's (1344g)", '1344g'), '1×1344g');
assert.equal(total('Fuchsia Sesme Burger Bun 6s', '400g'), '1×400g', 'count in the name, measure in the size field');
assert.equal(total("Sadia Chicken Burger 20'S Poly Bag 1Kg", '1Kg'), '1×1000g', 'a count before, not right after');
assert.equal(total('Toffifee Hazelnut Caramel 48PC 400G', '400G'), '1×400g');

// Count after the measure, or an explicit ×: a multipack, as before.
assert.equal(total("Nestle Pure Life Water 330ml 40's", '330ml'), '40×330ml', 'size field repeats the measure after the count');
assert.equal(total('Indomie Chicken Noodles 70g 10s', '70g'), '10×70g');
assert.equal(total('Coca-Cola Original Taste 2.21 L Plastic Bottle 2 PCS', '2.21 L'), '2×2210ml');
assert.equal(total('PRINGLES ORIGINAL 165Gm Asstt 3Pc', '165Gm'), '3×165g');
assert.equal(total('Kiri Cheese', '24 x 400g'), '24×400g', 'an explicit × is still read as printed');
assert.equal(total('Nadec Uht Milk', '12x1L'), '12×1000ml');
// "N pack" right before the measure is a multipack.
assert.equal(total('KINZA COLA DRINK 6 PACK 360ML -ASSORTED', '360ML'), '6×360ml');
assert.equal(total('SADO Soft Drinks 4 Pack 1280 ml', '4 Pack 1280 ml'), '4×1280ml');

// The read path and the saved-price lines use the same reading.
const q = resolveComparableQuantity({ size: "24's (400g)", name: "Kiri Portions Cheese 24's (400g)" });
assert.deepEqual(q.reference, { quantity: 0.4, unit: 'kg' });
const line = archiveLine({
  id: 'hyperpanda:central:d4d:95041032', store: 'hyperpanda', region: 'central', valid_from: '2026-08-12',
  valid_to: '2026-08-18', price: 20, old_price: null, currency: 'SAR', name: "Kiri Portions Cheese 24's (400g)",
  name_ar: null, size: "24's (400g)", category: null, image_url: null, source_url: null,
  match_text: "kiri portions cheese 24's (400g)",
});
assert.equal(line.unitPrice.unit, 'kg');
assert.ok(Math.abs(line.unitPrice.value - 50) < 1e-9, `Kiri 24's (400g) at 20 SR is 50 SR/kg, got ${line.unitPrice.value}`);

console.log('Pack count before a measure: pieces inside it, never a multiplier.');
