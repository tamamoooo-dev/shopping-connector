import assert from 'node:assert/strict';
import { createSqliteD1, insertOffers } from './storage/testSqliteD1.mjs';
import { createD1MetadataStore } from './storage/metadataStore.js';
import { createD1EnrichStore } from './storage/enrichStore.js';
import { createOfferArchive } from './storage/offerArchive.js';
import { hotspotOfferIds, pruneStoredBytes } from './retention.js';

const { db, raw, close } = createSqliteD1(['schema.sql']);
const objects = new Map();
const encode = (value) => new TextEncoder().encode(JSON.stringify(value));
const objectStore = {
  async put(key, bytes) { objects.set(key, { bytes }); },
  async get(key) { return objects.get(key) || null; },
  async delete(key) { objects.delete(key); },
};
const metadataStore = createD1MetadataStore(db);
const offerArchive = createOfferArchive(db);
const enrichStore = createD1EnrichStore(db);
const ctx = { metadataStore, objectStore, offerArchive, enrichStore };
const now = new Date('2026-10-30T03:00:00Z'); // archive pass cutoff: valid_to < 2026-10-15

function seed(name, { end = '2026-10-01', current = 0, spots = ['1', '2'] } = {}) {
  const id = `${name}:central:2026-W39`;
  const base = `brochures/${name}/central/2026-W39`;
  raw.prepare(`INSERT INTO brochures
    (id,store,region,edition,valid_from,valid_to,detected_at,source_type,collector,source_url,checksum,storage_key,is_current)
    VALUES (?,?,'central','2026-W39','2026-09-24',?,'2026-09-24','images','d4d',?,?,?,?)`)
    .run(id, name, end, 'https://d4d.example/555/flyer', name, `${name}/central/2026-W39`, current);
  objects.set(`${base}/meta.json`, { bytes: encode({ pages: [{ index: 0, imageUrl: `${base}/page00.webp` }, { index: 1, imageUrl: `${base}/page01.webp` }] }) });
  objects.set(`${base}/hotspots.json`, { bytes: encode({ pages: [{ index: 0, spots: spots.map((offerId) => ({ offerId })) }] }) });
  objects.set(`${base}/page00.webp`, { bytes: encode('image') });
  objects.set(`${base}/page01.webp`, { bytes: encode('image') });
  return { id, base };
}
const archived = (store, offerId, price = 9.5) => ({
  id: `${store}:central:d4d:${offerId}`, price, validFrom: '2026-09-24', validTo: '2026-10-01', name: `${store} product ${offerId}`, origin: 'test',
});

console.log('Price-archive retention:');

assert.deepEqual(hotspotOfferIds({ pages: [{ spots: [{ offerId: 1 }, { offerId: '1' }, { offerId: null }] }, { spots: [{ offerId: '2' }] }] }), ['1', '2']);
assert.deepEqual(hotspotOfferIds(null), []);

// saved: one product archived, the other never priced by the flyer and rejected.
const saved = seed('saved');
await offerArchive.importRows([archived('saved', '1')]);
raw.prepare(`INSERT INTO price_pending (id,store,region,source,offer_id,flyer_ref,image_url,valid_to,raw_json,status,detected_at)
  VALUES ('saved:central:d4d:2','saved','central','d4d','2','555','https://cdn/x.jpg','2026-10-01','{}','rejected','2026-09-24')`).run();
// gap: a product with no saved price keeps the pages.
const gap = seed('gap');
await offerArchive.importRows([archived('gap', '1')]);
// live: its offers are still in D1 — the offers prune archives them first, in
// the same run, and then the pages can go.
const live = seed('live');
insertOffers(raw, [
  { id: 'live:central:d4d:1', store: 'live', name: 'live one', price: 3, valid_from: '2026-09-24', valid_to: '2026-10-01' },
  { id: 'live:central:d4d:2', store: 'live', name: 'live two', price: 4, valid_from: '2026-09-24', valid_to: '2026-10-01' },
]);
const empty = seed('empty', { spots: [] });
const recent = seed('recent', { end: '2026-10-20' });
await offerArchive.importRows([archived('recent', '1'), archived('recent', '2')]);
const current = seed('current', { current: 1 });
await offerArchive.importRows([archived('current', '1'), archived('current', '2')]);

const report = await pruneStoredBytes(ctx, { now });
assert.deepEqual(report.errors, []);
assert.equal(report.archivePass.pruned, 2);
assert.equal(report.archivePass.deletes, 4);
assert.equal(report.archivePass.incomplete, 1);
assert.equal(report.archivePass.noProducts, 1);
assert.equal(report.offersPruned, 2);

for (const gone of [saved, live]) {
  assert.equal(objects.has(`${gone.base}/page00.webp`), false);
  assert.equal(objects.has(`${gone.base}/page01.webp`), false);
  assert.equal(objects.has(`${gone.base}/meta.json`), true, 'manifests stay');
  assert.ok(raw.prepare('SELECT pruned_at FROM brochures WHERE id=?').get(gone.id).pruned_at);
}
for (const kept of [gap, empty, recent, current]) {
  assert.equal(objects.has(`${kept.base}/page00.webp`), true, `${kept.id} keeps its pages`);
  assert.equal(raw.prepare('SELECT pruned_at FROM brochures WHERE id=?').get(kept.id).pruned_at, null);
}
const snapshots = [...objects].filter(([key]) => key.startsWith('brochure-data/'))
  .map(([, value]) => JSON.parse(new TextDecoder().decode(value.bytes)));
const savedSnapshot = snapshots.find((s) => s.brochure.id === saved.id);
assert.equal(savedSnapshot.policy, 'price-archive-complete');
assert.deepEqual(savedSnapshot.archived_offer_ids, ['1']);
assert.deepEqual(savedSnapshot.unpriced_offer_ids, ['2']);
assert.equal(raw.prepare("SELECT COUNT(*) n FROM offer_archive WHERE store='live'").get().n, 2, 'live offers archived before their pages went');
const found = await offerArchive.search({ q: 'live two' });
assert.deepEqual(found.rows.map((r) => [r.store, r.price, r.valid_from]), [['live', 4, '2026-09-24']]);

// A second run finds nothing more to delete.
const again = await pruneStoredBytes(ctx, { now });
assert.equal(again.archivePass.pruned, 0);
assert.equal(again.deletes, 0);

// The delete budget is respected.
const tight = seed('tight');
await offerArchive.importRows([archived('tight', '1'), archived('tight', '2')]);
const limited = await pruneStoredBytes(ctx, { now, maxDeletes: 1 });
assert.equal(limited.archivePass.pruned, 0);
assert.equal(objects.has(`${tight.base}/page00.webp`), true);

close();
console.log('price-archive retention: archived products free their pages; gaps, empty, recent and current brochures keep theirs');
