import assert from 'node:assert/strict';
import { createSqliteD1, insertOffers } from './storage/testSqliteD1.mjs';
import { createD1MetadataStore } from './storage/metadataStore.js';
import { pruneStoredBytes } from './retention.js';

const { db, raw, close } = createSqliteD1(['schema.sql']);
const objects = new Map(), deleted = [];
const encode = value => new TextEncoder().encode(JSON.stringify(value));
let corruptArchive = false, failDelete = false;
const objectStore = {
  async put(key, bytes) { objects.set(key, { bytes: corruptArchive ? encode({ damaged: true }) : bytes }); },
  async get(key) { return objects.get(key) || null; },
  async delete(key) {
    if (failDelete) throw new Error('temporary delete failure');
    deleted.push(key); objects.delete(key);
  },
};
const metadataStore = createD1MetadataStore(db);
const now = new Date('2026-10-19T03:00:00Z');
const run = options => pruneStoredBytes({ metadataStore, objectStore }, { now, ...options });
function seed(name, { current = 0, end = '2026-10-10', offer = true, verified = true } = {}) {
  const id = `${name}:central:2026-W40`, base = `brochures/${name}/central/2026-W40`;
  raw.prepare(`INSERT INTO brochures
    (id,store,region,edition,valid_to,detected_at,source_type,collector,source_url,checksum,storage_key,is_current)
    VALUES (?,?,'central','2026-W40',?,'2026-10-01','images','d4d',?,?,?,?)`)
    .run(id, name, end, 'https://d4d.example/123/flyer', name, `${name}/central/2026-W40`, current);
  objects.set(`${base}/meta.json`, { bytes: encode({ complete: true, advertisedPageCount: 1,
    pages: [{ index: 0, imageUrl: `${base}/page00.webp` }] }) });
  objects.set(`${base}/hotspots.json`, { bytes: encode({ pages: [{ index: 0, spots: [{ offerId: '1' }] }] }) });
  objects.set(`${base}/page00.webp`, { bytes: encode('image') });
  if (offer) {
    const oid = `${name}:central:d4d:1`;
    insertOffers(raw, [{ id: oid, valid_to: end }]);
    raw.prepare('UPDATE offers SET brochure_id=?,page_index=0,flyer_ref=? WHERE id=?').run(id, '123', oid);
    raw.prepare(`INSERT INTO offer_enrichments
      (id,name,corroboration,crop_url,mint_verdict,enriched_at)
      VALUES (?,'Milk',?,'https://cdn.example/crop.jpg','minted','2026-10-01')`).run(oid, verified ? 1 : null);
    raw.prepare(`INSERT INTO offer_acceptance_verdicts
      (offer_id,version,accepted,missing,mandatory,decided_at)
      VALUES (?,'v5',1,'[]','{}','2026-10-01')`).run(oid);
    raw.prepare(`INSERT INTO offer_vision_verification_queue
      (offer_id,status,initial_outcome,created_at,updated_at)
      VALUES (?,'queued','accepted','2026-10-01','2026-10-01')`).run(oid);
    raw.prepare(`INSERT INTO product_sightings
      (offer_id,product_id,match_band,store,region,week,price,algo_version,resolved_at)
      VALUES (?,'pr_milk','auto',?,'central','2026-10-01',5.99,1,'2026-10-01')`).run(oid, name);
  }
  return { id, base, oid: `${name}:central:d4d:1` };
}
const ready = seed('ready');
const protectedRows = [seed('current', { current: 1 }), seed('valid', { end: '2026-10-25' }),
  seed('grace', { end: '2026-10-12' }), seed('missing', { offer: false }),
  seed('failed', { verified: false })];
assert.deepEqual((await metadataStore.listPrunable('2026-10-12', 40)).map(r => r.id), [ready.id]);
corruptArchive = true;
let result = await run();
assert.match(result.errors[0], /archive verification failed/);
assert.equal(deleted.length, 0);
assert.equal(raw.prepare('SELECT pruned_at FROM brochures WHERE id=?').get(ready.id).pruned_at, null);
corruptArchive = false;
failDelete = true;
result = await run();
assert.match(result.errors[0], /temporary delete failure/);
assert.equal(raw.prepare('SELECT pruned_at FROM brochures WHERE id=?').get(ready.id).pruned_at, null);
failDelete = false;
result = await run();
assert.equal(result.pruned, 1);
assert.equal(result.deletes, 1);
assert.equal(objects.has(`${ready.base}/page00.webp`), false);
assert.equal(objects.has(`${ready.base}/meta.json`), true);
assert.ok(raw.prepare('SELECT pruned_at FROM brochures WHERE id=?').get(ready.id).pruned_at);
assert.equal(raw.prepare('SELECT price FROM offers WHERE id=?').get(ready.oid).price, 5.99);
for (const r of protectedRows) assert.equal(objects.has(`${r.base}/page00.webp`), true);
const archives = [...objects].filter(([key]) => key.startsWith('brochure-data/'));
assert.ok(archives.some(([, value]) => JSON.parse(new TextDecoder().decode(value.bytes)).offers?.[0]?.price === 5.99));
assert.equal((await run()).deletes, 0);

// Even a published subset is insufficient when a hotspot product is absent.
const partial = seed('partial');
objects.set(`${partial.base}/hotspots.json`, { bytes: encode({ pages: [{ index: 0, spots: [{ offerId: '1' }, { offerId: '2' }] }] }) });
result = await run();
assert.equal(result.pruned, 0);
assert.equal(result.skipped, 1);
// Pending fallback, changed crops, and claimed verification all retain images.
raw.prepare(`UPDATE offer_enrichments SET crop_url='changed' WHERE id=?`).run(partial.oid);
assert.equal((await metadataStore.listPrunable('2026-10-12')).length, 0);
raw.prepare(`UPDATE offer_enrichments SET crop_url='https://cdn.example/crop.jpg' WHERE id=?`).run(partial.oid);
raw.prepare(`UPDATE offer_vision_verification_queue SET status='claimed' WHERE offer_id=?`).run(partial.oid);
assert.equal((await metadataStore.listPrunable('2026-10-12')).length, 0);
raw.prepare(`UPDATE offer_vision_verification_queue SET status='queued' WHERE offer_id=?`).run(partial.oid);
objects.set(`${partial.base}/hotspots.json`, { bytes: encode({ pages: [{ index: 0, spots: [{ offerId: '1' }] }] }) });
raw.prepare(`INSERT INTO price_pending
  (id,store,region,source,offer_id,flyer_ref,image_url,raw_json,detected_at)
  VALUES ('pending','partial','central','d4d','2','123','crop','{}','2026-10-01')`).run();
assert.equal((await run()).pruned, 0);
assert.equal(objects.has(`${partial.base}/page00.webp`), true);
raw.prepare('DELETE FROM price_pending').run();
raw.prepare("UPDATE product_sightings SET match_band='review' WHERE offer_id=?").run(partial.oid);
assert.equal((await metadataStore.listPrunable('2026-10-12')).length, 0);
raw.prepare('DELETE FROM product_sightings WHERE offer_id=?').run(partial.oid);
assert.equal((await metadataStore.listPrunable('2026-10-12')).length, 0);
close();
console.log('brochure retention: verified seven-day grace, completion gates, archive integrity, retry and data preservation');
