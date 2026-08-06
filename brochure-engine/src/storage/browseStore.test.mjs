// Brand Browse counts and pages, executed against real SQLite and the real
// schema. This pins the production defect where two flyer variants inflated a
// brand's badge and were removed only after LIMIT/OFFSET.

import assert from 'node:assert/strict';
import { createD1BrowseStore } from './browseStore.js';
import { createSqliteD1, insertOffers } from './testSqliteD1.mjs';

const CURRENT_ON = '2026-07-20';
const { db, raw, close } = createSqliteD1(['schema.sql']);

insertOffers(raw, [
  { id: 'lulu:central:d4d:one', name: 'Snickers Bar 50g', price: 3, category: 'chocolates' },
  { id: 'lulu:central:d4d:one-copy', name: 'Snickers Bar 50g', price: 3, category: 'chocolates' },
  { id: 'panda:central:d4d:two', name: 'Snickers Minis 200g', price: 12, category: 'chocolates' },
]);

raw.exec(`
  UPDATE offers
     SET brochure_id = 'fixture-brochure', page_index = 0, brand_slug = 'snickers';
  UPDATE offers
     SET identity = 'ph_snickers_bar'
   WHERE id IN ('lulu:central:d4d:one', 'lulu:central:d4d:one-copy');
  UPDATE offers SET identity = 'ph_snickers_minis'
   WHERE id = 'panda:central:d4d:two';
`);

const store = createD1BrowseStore(db);

const counts = await store.brandCounts(CURRENT_ON);
assert.deepEqual(
  counts.map((row) => ({ brand_slug: row.brand_slug, n: Number(row.n), stores: Number(row.stores) })),
  [{ brand_slug: 'snickers', n: 2, stores: 2 }],
  'the brand badge counts unique deals, not flyer variants',
);

const facets = await store.brandFacets('snickers', CURRENT_ON);
assert.equal(facets.reduce((sum, row) => sum + Number(row.n), 0), 2,
  'family counts add up to the same unique brand deals');

const firstPage = await store.list({
  brand: 'snickers', currentOn: CURRENT_ON, sort: 'price', limit: 1, offset: 0,
});
const secondPage = await store.list({
  brand: 'snickers', currentOn: CURRENT_ON, sort: 'price', limit: 1, offset: 1,
});
assert.equal(firstPage.length, 1);
assert.equal(secondPage.length, 1);
assert.notEqual(firstPage[0].identity, secondPage[0].identity,
  'pagination happens after dedupe and never skips the second real product');

close();
console.log('browseStore brand dedupe: 3 assertions passed');
