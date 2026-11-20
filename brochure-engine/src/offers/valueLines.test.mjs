// offers/valueLines.test.mjs — saved flyer prices priced per kg / L / piece by
// the read path (GET /prices/lines). Rows are from the live archive
// (2026-11-20). Run with:  node src/offers/valueLines.test.mjs

import assert from 'node:assert/strict';
import { archiveLine, offerLine, valueLinesDoc } from './valueLines.js';

const arch = (id, store, validFrom, price, name, size, nameAr = null) => ({
  id, store, region: 'riyadh', valid_from: validFrom, valid_to: validFrom, price, old_price: null,
  currency: 'SAR', name, name_ar: nameAr, size, category: null, image_url: `img/${id}`, source_url: null,
  match_text: `${name} ${nameAr || ''}`.toLowerCase(),
});

// A 12 × 1 L pack is priced per litre, and the brand is stamped from the name.
const milk = archiveLine(arch('othaim:riyadh:d4d:1', 'othaim', '2026-11-11', 50, 'Nadec Uht Milk', '12x1L'));
assert.equal(milk.brandSlug, 'nadec');
assert.equal(milk.unitPrice.unit, 'l');
assert.ok(Math.abs(milk.unitPrice.value - 50 / 12) < 1e-9);
assert.equal(milk.origin, 'archive');
assert.equal(milk.image, 'img/othaim:riyadh:d4d:1');

// 20 × 200 ml ("18+2") is 4 litres.
const bonus = archiveLine(arch('carrefour:riyadh:d4d:2', 'carrefour', '2026-11-11', 26.99,
  'NADEC Halib Full Cream Milk 18+2 200 ml', '200 ml'));
assert.ok(Math.abs(bonus.unitPrice.value - 26.99 / 4) < 1e-9);

// No size read and none in the name: no value — refused, not guessed.
const bare = archiveLine(arch('ramez:riyadh:d4d:3', 'ramez', '2026-11-11', 46.99, 'Nadec Long Life Full Fat Milk', null));
assert.equal(bare.unitPrice, null);

// An offers-table row keeps its own enrichment reading.
const live = offerLine({
  id: 'lulu:riyadh:d4d:9', store: 'lulu', region: 'riyadh', source: 'd4d', price: 4.5, old_price: 5,
  currency: 'SAR', name: 'NADEC MILK', name_ar: null, valid_from: '2026-11-18', valid_to: '2026-11-24',
  brand_slug: 'nadec', e_name: 'Nadec Long Life Milk Full Fat 1L', e_name_ar: null, e_corroboration: 0.9, e_size: '1L',
});
assert.equal(live.name, 'Nadec Long Life Milk Full Fat 1L');
assert.equal(live.unitPrice.value, 4.5);
assert.equal(live.origin, 'offers');

// Both sources, one line per id (the offers table wins), unpriced lines out,
// newest first.
const doc = await valueLinesDoc('nadec milk', {
  offerArchive: {
    search: async () => ({
      rows: [
        arch('othaim:riyadh:d4d:1', 'othaim', '2026-11-11', 50, 'Nadec Uht Milk', '12x1L'),
        arch('lulu:riyadh:d4d:9', 'lulu', '2026-11-18', 4.9, 'Nadec Milk', '1L'),
        arch('x:riyadh:d4d:0', 'x', '2026-11-01', 0, 'Nadec Milk', '1L'),
      ],
    }),
  },
  offerStore: {
    search: async ({ currentOn }) => {
      assert.equal(currentOn, null, 'ended offers not yet archived are included');
      return [{
        id: 'lulu:riyadh:d4d:9', store: 'lulu', region: 'riyadh', source: 'd4d', price: 4.5, currency: 'SAR',
        name: 'NADEC MILK', valid_from: '2026-11-18', valid_to: '2026-11-24', brand_slug: 'nadec',
        e_name: 'Nadec Long Life Milk Full Fat 1L', e_corroboration: 0.9, e_size: '1L',
      }];
    },
  },
});
assert.equal(doc.lines, 2);
assert.equal(doc.archived, 1);
assert.deepEqual(doc.offers.map((l) => [l.id, l.price]), [['lulu:riyadh:d4d:9', 4.5], ['othaim:riyadh:d4d:1', 50]]);
assert.equal(doc.first, '2026-11-11');
assert.equal(doc.last, '2026-11-18');

console.log('valueLines tests passed.');
