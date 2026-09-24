// unpricedItems.test.mjs — price-less source records become flyer items, never
// offers, and the flyer viewer's hotspots join serves them.
//
// REGRESSION PIN (2026-09-24). From 2026-09-22 D4D published new flyers'
// per-product records with price/was_price "0.000". buildOffer dropped every one
// (a price is required), so no current flyer had a single structured row, the
// /brochures/hotspots join returned `offers: {}`, and the viewer — which only
// draws a tap box for a spot whose offer it has — fell back to bare pages with
// no per-product crops. Verified live: 568 spots / 0 offers on aljazera W39,
// 707 / 0 on carrefour W39, while the D4D records themselves were all there.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildFlyerItem,
  buildOffer,
  flyerItemRowToOffer,
  flyerItemToRow,
  isUnpriced,
  rowToOffer,
} from './contract.js';
import { ingestOffers } from './ingest.js';
import { getHotspotsDoc } from '../hotspots.js';
import { createMemoryMetadataStore, createMemoryOfferStore } from '../storage/local.js';
import { createD1OfferStore } from '../storage/offerStore.js';
import { createSqliteD1 } from '../storage/testSqliteD1.mjs';

const today = new Date().toISOString().slice(0, 10);
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const ctxBuild = { store: 'shop', region: 'central', source: 'd4d', detectedAt: '2026-09-24T06:00:00.000Z' };

// A raw record shaped exactly like d4dOffers.toRaw() output for the live
// zero-price item observed on 2026-09-24 (Lulu flyer 777519).
const unpricedRaw = {
  offerId: '97868097',
  flyerRef: '777519',
  pageRef: '9937716',
  price: '0.000',
  wasPrice: '0.000',
  description: 'kasih liquid jameed 1kg\nlulu hypermarket\nلولو هايبرماركت\n',
  categoryId: '100',
  category: null,
  imageUrl: 'https://cdn.d4donline.com/u/a/26/09/24/63900c152ff1fec271560b3b35b0cb64.jpg',
  sourceUrl: 'https://d4donline.com/en/saudi-arabia/riyadh/offers/lulu-hypermarket-63/777519/x?page=9937716',
  validFrom: '2026-09-23 21:00:00',
  validTo: '2026-10-07 20:59:00',
  storeWords: ['LULU Hypermarket', 'لولو هايبرماركت'],
};

// --- contract ------------------------------------------------------------------
{
  assert.equal(isUnpriced(unpricedRaw), true);
  assert.equal(isUnpriced({ price: 9.95 }), false);
  assert.equal(isUnpriced({ price: null }), true);
  assert.equal(isUnpriced({}), true);

  assert.equal(buildOffer(unpricedRaw, ctxBuild), null, 'a zero price is still never an offer');

  const item = buildFlyerItem(unpricedRaw, ctxBuild);
  assert.equal(item.id, 'shop:central:d4d:97868097', 'same id an offer would get');
  assert.equal(item.flyerRef, '777519');
  assert.equal(item.imageUrl, unpricedRaw.imageUrl);
  assert.equal(item.validFrom, '2026-09-23');
  assert.equal(item.validTo, '2026-10-07');
  assert.equal(Object.hasOwn(item, 'price'), false, 'an item carries no price field at all');

  assert.equal(buildFlyerItem({ ...unpricedRaw, flyerRef: null }, ctxBuild), null, 'unjoinable without a flyer');
  assert.equal(buildFlyerItem({ ...unpricedRaw, offerId: '' }, ctxBuild), null, 'unjoinable without an id');

  const served = flyerItemRowToOffer(flyerItemToRow(item));
  assert.equal(served.price, null);
  assert.equal(served.oldPrice, null);
  assert.equal(served.unpriced, true);
  assert.equal(served.offerId, '97868097');
  assert.equal(served.imageUrl, unpricedRaw.imageUrl);
  assert.equal(served.sourceUrl, null, 'D4D URL stays provenance-only, as in rowToOffer');
  // Same keys as a real offer (plus the flag), so clients need no second shape.
  for (const key of Object.keys(rowToOffer({}))) {
    assert.ok(Object.hasOwn(served, key), `served item carries offer key ${key}`);
  }
}

// --- ingest: priced -> offers, unpriced -> flyer items, junk -> dropped --------
async function runIngest(offerStore) {
  const offersSource = {
    name: 'd4d',
    async listOffers() {
      const common = { flyerRef: '111', description: 'Test product', validFrom: today, validTo: nextWeek };
      return [
        { ...common, offerId: 'A', price: 10 },
        { ...common, offerId: 'B', price: '0.000', wasPrice: '0.000', imageUrl: 'https://cdn/b.jpg' },
        { ...common, offerId: 'C', price: '0.000', flyerRef: null },
        { ...common, offerId: '', price: 5 },
      ];
    },
  };
  return ingestOffers({
    registry: { shop: { id: 'shop', regions: { central: { store: 'shop-1', city: 'riyadh' } } } },
    metadataStore: createMemoryMetadataStore(),
    objectStore: { get: async () => null },
    offerStore,
    offersSource,
  }, { store: 'shop' });
}

{
  const offerStore = createMemoryOfferStore();
  const report = await runIngest(offerStore);
  const line = report.targets[0];
  assert.deepEqual(line.errors, []);
  assert.equal(line.fetched, 4);
  assert.equal(line.stored, 1, 'only the priced record is an offer');
  assert.equal(line.unpriced, 1);
  assert.equal(line.dropped, 2, 'unjoinable unpriced + id-less priced');
  assert.equal(report.totals.unpriced, 1);

  const offers = await offerStore.byFlyer('shop', 'central', '111');
  assert.deepEqual(offers.map((r) => r.offer_id), ['A'], 'offers never receives a price-less row');
  const items = await offerStore.flyerItemsByFlyer('shop', 'central', '111');
  assert.deepEqual(items.map((r) => r.offer_id), ['B']);
  assert.equal(items[0].image_url, 'https://cdn/b.jpg');
}

// A side-table failure (e.g. migration not applied) must not become a line
// error: engine.js treats offers-ingest errors as fatal for publication.
{
  const offerStore = createMemoryOfferStore();
  offerStore.upsertFlyerItems = async () => {
    throw new Error('D1_ERROR: no such table: flyer_items');
  };
  const report = await runIngest(offerStore);
  const line = report.targets[0];
  assert.deepEqual(line.errors, [], 'flyer-item failure is not an ingest error');
  assert.equal(report.totals.failed, 0);
  assert.equal(line.stored, 1, 'priced offers are still stored');
  assert.match(line.unpricedError, /no such table/);
}

// --- hotspots: unpriced items fill uncovered spots; priced offers win ---------
{
  const offerStore = createMemoryOfferStore();
  await runIngest(offerStore);
  // The source later prices B's sibling — model a spot covered by BOTH tables.
  await offerStore.upsertFlyerItems([flyerItemToRow(buildFlyerItem(
    { offerId: 'A', flyerRef: '111', price: 0, imageUrl: 'stale', validFrom: today, validTo: nextWeek },
    ctxBuild,
  ))]);

  const row = {
    id: 'shop:central:2026-W39',
    store: 'shop',
    region: 'central',
    source_type: 'images',
    source_url: 'https://d4donline.com/en/saudi-arabia/riyadh/offers/shop-1/111/weekly',
    storage_key: 'shop/central/2026-W39',
  };
  const snapshot = {
    pages: [{ index: 0, spots: [
      { offerId: 'A', x: 0, y: 0, w: 0.5, h: 0.5 },
      { offerId: 'B', x: 0.5, y: 0, w: 0.5, h: 0.5 },
    ] }],
  };
  const ctx = {
    metadataStore: { getById: async () => row },
    objectStore: { get: async () => ({ bytes: new TextEncoder().encode(JSON.stringify(snapshot)) }) },
    offerStore,
  };
  const { status, doc } = await getHotspotsDoc(ctx, row.id, { rowToOffer });
  assert.equal(status, 200);
  assert.equal(doc.offers.A.price, 10, 'a priced offer always wins over an item');
  assert.equal(doc.offers.A.unpriced, undefined);
  assert.equal(doc.offers.B.price, null, 'the unpriced spot is now joinable');
  assert.equal(doc.offers.B.unpriced, true);
  assert.equal(doc.offers.B.imageUrl, 'https://cdn/b.jpg');

  // A failing item read degrades to the priced-only doc, never an error.
  const broken = { ...ctx, offerStore: { ...offerStore, byFlyer: offerStore.byFlyer,
    flyerItemsByFlyer: async () => { throw new Error('no such table: flyer_items'); } } };
  const degraded = await getHotspotsDoc(broken, row.id, { rowToOffer });
  assert.equal(degraded.status, 200);
  assert.deepEqual(Object.keys(degraded.doc.offers), ['A']);
}

// --- real SQL: schema.sql and the migration, through the D1 store --------------
{
  const { db, close } = createSqliteD1(['schema.sql']);
  const store = createD1OfferStore(db);
  const item = flyerItemToRow(buildFlyerItem(unpricedRaw, ctxBuild));
  await store.upsertFlyerItems([item]);
  // Re-ingest: fields refresh, first-seen detected_at is kept.
  await store.upsertFlyerItems([{ ...item, name: 'renamed', detected_at: '2099-01-01T00:00:00.000Z' }]);
  const rows = await store.flyerItemsByFlyer('shop', 'central', 777519);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'renamed');
  assert.equal(rows[0].detected_at, ctxBuild.detectedAt);
  assert.equal(await store.pruneFlyerItemsBefore('2026-10-01'), 0, 'not expired yet');
  assert.equal(await store.pruneFlyerItemsBefore('2026-10-08'), 1);
  assert.equal((await store.flyerItemsByFlyer('shop', 'central', '777519')).length, 0);
  close();
}
{
  // Upgrade path: a database without the table gains it from the migration alone.
  const { db, raw, close } = createSqliteD1(['schema.sql'], { without: ['flyer_items'] });
  const store = createD1OfferStore(db);
  await assert.rejects(store.flyerItemsByFlyer('shop', 'central', '1'), /no such table/);
  raw.exec(readFileSync('migrate-2026-09-24-flyer-items.sql', 'utf8'));
  await store.upsertFlyerItems([flyerItemToRow(buildFlyerItem(unpricedRaw, ctxBuild))]);
  assert.equal((await store.flyerItemsByFlyer('shop', 'central', '777519')).length, 1);
  raw.exec(readFileSync('migrate-2026-09-24-flyer-items.sql', 'utf8')); // idempotent
  close();
}

console.log('unpricedItems.test: all passed');
