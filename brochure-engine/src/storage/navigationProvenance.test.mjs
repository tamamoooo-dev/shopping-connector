import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createD1OfferStore } from './offerStore.js';
import { createSqliteD1 } from './testSqliteD1.mjs';

const { db, raw, close } = createSqliteD1(['schema.sql']);
const store = createD1OfferStore(db);
const base = {
  id: 'shop:central:d4d:A',
  store: 'shop',
  region: 'central',
  source: 'd4d',
  offer_id: 'A',
  flyer_ref: '111',
  page_ref: 'page-a',
  brochure_id: 'shop:central:2026-W31',
  page_index: 0,
  navigation_provenance: 'dual',
  edition: '2026-W31',
  name: 'Test',
  name_ar: null,
  price: 10,
  old_price: null,
  currency: 'SAR',
  category_id: null,
  category: null,
  image_url: null,
  source_url: null,
  valid_from: '2026-07-29',
  valid_to: '2026-08-05',
  detected_at: '2026-07-29T00:00:00.000Z',
  search_text: 'test',
  identity: null,
  brand_slug: null,
};

await store.upsertMany([base]);
let [row] = await store.byFlyer('shop', 'central', '111');
assert.equal(row.navigation_provenance, 'dual');

await store.updateNavigation([{
  id: base.id,
  brochureId: base.brochure_id,
  pageIndex: 1,
  navigationProvenance: 'hotspot_unique',
  edition: base.edition,
}]);
[row] = await store.byFlyer('shop', 'central', '111');
assert.equal(row.page_index, 1);
assert.equal(row.navigation_provenance, 'hotspot_unique');

assert.deepEqual(await store.navigationMetrics('2026-07-29'), {
  current: 1,
  unlinked: 0,
  dual: 0,
  hotspotUnique: 1,
  missingProvenance: 0,
});

assert.throws(
  () => raw.prepare(
    `UPDATE offers SET navigation_provenance = 'untrusted' WHERE id = ?`,
  ).run(base.id),
  /CHECK constraint failed/,
);

close();

// Upgrade-path proof: the additive migration applies to the exact legacy
// navigation shape and truthfully labels every pre-Policy-B link as dual.
const legacy = new DatabaseSync(':memory:');
legacy.exec(`
  CREATE TABLE offers (
    id TEXT PRIMARY KEY,
    brochure_id TEXT,
    page_index INTEGER,
    valid_to TEXT
  );
  INSERT INTO offers VALUES ('linked', 'brochure', 0, '2026-08-05');
  INSERT INTO offers VALUES ('unlinked', NULL, NULL, '2026-08-05');
`);
legacy.exec(readFileSync('migrate-2026-07-29-navigation-provenance.sql', 'utf8'));
assert.deepEqual(
  legacy.prepare(
    'SELECT id, navigation_provenance FROM offers ORDER BY id',
  ).all().map((row) => ({ ...row })),
  [
    { id: 'linked', navigation_provenance: 'dual' },
    { id: 'unlinked', navigation_provenance: null },
  ],
);
legacy.close();

console.log('navigationProvenance.test: D1 provenance persistence and metrics passed');
