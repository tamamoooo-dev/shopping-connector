// unpricedHotspots.test.mjs — a product D4D publishes WITHOUT a price is still a
// product on the flyer: its hotspot is tappable at once (price pending), the
// vision price fallback may later price it (the normal offer takes its place,
// same id), and a rejection leaves it tappable with price unavailable.
// No network: the D4D feed, the CDN and Mistral are scripted.

import assert from 'node:assert/strict';
import { ingestOffers } from './ingest.js';
import { drainPriceFallback } from './priceFallback.js';
import { rowToOffer, unpricedOffer } from './contract.js';
import { applyEnrichment, MISTRAL_URL } from './enrich.js';
import { buildMistralPools, createKeyChain } from './mistralKeys.js';
import { getHotspotsDoc } from '../hotspots.js';
import { createMemoryMetadataStore, createMemoryOfferStore } from '../storage/local.js';
import { createD1OfferStore } from '../storage/offerStore.js';
import { createSqliteD1 } from '../storage/testSqliteD1.mjs';

const today = new Date().toISOString().slice(0, 10);
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const FLYER = '751686';
const raw = (id, description, extra = {}) => ({
  offerId: id, flyerRef: FLYER, pageRef: 'p1', price: '0.000', wasPrice: '0.000', description,
  imageUrl: `https://cdn.test/${id}.jpg`, validFrom: today, validTo: nextWeek,
  storeWords: ['Test Store'], ...extra,
});
const P1 = raw('P1', 'Almarai Milk 1L 6.50 7.25', { price: 6.5, wasPrice: 7.25 }); // D4D-priced
const U1 = raw('U1', 'Jameed 1kg 22.50 18.00'); // fallback agrees on 18, printed -> accepted
const U2 = raw('U2', 'Dates 1kg 30.00');         // model reads the crossed-out 44.99 -> rejected
const replies = {
  U1: { current_price: 18, old_price: 22.5 },
  U2: { current_price: 44.99, old_price: null },
};

const offerStore = createMemoryOfferStore();
const ctx = {
  registry: { shop: { id: 'shop', regions: { central: { store: 'shop-1', city: 'riyadh' } } } },
  metadataStore: createMemoryMetadataStore(),
  objectStore: { get: async () => null },
  offerStore,
  offersSource: { name: 'd4d', async listOffers() { return [P1, U1, U2]; } },
};

// The held brochure for that flyer, with one spot per product.
const brochure = {
  id: 'shop:central:2026-W39', store: 'shop', region: 'central', source_type: 'images',
  source_url: `https://d4donline.com/en/saudi-arabia/riyadh/offers/test-store/${FLYER}/weekly`,
  storage_key: 'shop/central/2026-W39',
};
const spots = ['P1', 'U1', 'U2'].map((offerId, i) => ({ offerId, x: 0.3 * i, y: 0, w: 0.3, h: 0.3 }));
const hotspotsCtx = {
  metadataStore: { getById: async () => brochure },
  objectStore: { get: async () => ({ bytes: new TextEncoder().encode(JSON.stringify({ pages: [{ index: 0, spots }] })) }) },
  offerStore,
};
const hotspots = async () => (await getHotspotsDoc(hotspotsCtx, brochure.id, { rowToOffer })).doc;
// The viewer's own rule (frontend viewer/hotspots.js): a spot is tappable iff
// the response carries an offer for it.
const tappable = (doc) => spots.filter((s) => doc.offers[s.offerId]).map((s) => s.offerId);
// What the priced join served BEFORE this change, for the unchanged-path check.
const pricedOnly = async (id) => {
  const row = await offerStore.getById(`shop:central:d4d:${id}`);
  const o = rowToOffer(row);
  applyEnrichment(o, row);
  return o;
};
// The route as it was before the queue join: the same getHotspotsDoc over a
// store with no pricePendingByFlyer. Priced entries must match it byte for byte.
const legacyDoc = async (c = hotspotsCtx, id = brochure.id) =>
  (await getHotspotsDoc({ ...c, offerStore: { byFlyer: c.offerStore.byFlyer } }, id, { rowToOffer })).doc;

// --- 1. ingest: priced -> offer (unchanged), unpriced -> queue ------------------------
let report = await ingestOffers(ctx, { store: 'shop' });
assert.deepEqual(report.targets[0].errors, []);
assert.equal(report.targets[0].stored, 1, 'only the D4D-priced record is an offer');
assert.equal(report.targets[0].unpriced, 2, 'both unpriced records are queued');
assert.equal(await offerStore.getById('shop:central:d4d:U1'), null, 'an unpriced product never enters offers');
assert.equal((await offerStore.listPricePending({ currentOn: today })).length, 2);

// --- 2. clickable immediately, price pending ---------------------------------------
let doc = await hotspots();
assert.deepEqual(tappable(doc), ['P1', 'U1', 'U2'], 'every product with a crop is tappable before any pricing');
assert.deepEqual(doc.offers.P1, await pricedOnly('P1'), 'the priced entry is exactly what the priced join served');
assert.equal(doc.offers.P1.priceStatus, undefined, 'a priced offer carries no priceStatus');
assert.equal(JSON.stringify(doc.offers.P1), JSON.stringify((await legacyDoc()).offers.P1),
  'the priced entry reaches the wire as the identical bytes');
assert.deepEqual(Object.keys((await getHotspotsDoc(hotspotsCtx, brochure.id, {})).doc.offers), ['P1'],
  'raw-row callers (no rowToOffer) get the priced join only, even while products are pending');
for (const id of ['U1', 'U2']) {
  const o = doc.offers[id];
  assert.equal(o.id, `shop:central:d4d:${id}`, 'same id the priced offer will have');
  assert.equal(o.offerId, id);
  assert.deepEqual([o.price, o.oldPrice, o.priceSource, o.priceStatus], [null, null, null, 'pending']);
  assert.equal(o.imageUrl, `https://cdn.test/${id}.jpg`, 'the crop is carried');
  assert.equal(o.flyerRef, FLYER);
  assert.equal(o.validTo, nextWeek);
  assert.equal(o.searchText, undefined, 'read-API shape: no raw OCR text');
}
assert.ok(doc.offers.U1.name || doc.offers.U1.nameAr, 'named from the D4D description, as a priced offer would be');

// --- 3. price enrichment: Ministral 14B, dedicated pool, the unchanged rules -------------
const seen = [];
const fetchImpl = async (url, init) => {
  if (url.startsWith('https://cdn.test/')) {
    return new Response(new TextEncoder().encode(url.slice('https://cdn.test/'.length, -4)), { headers: { 'content-type': 'image/jpeg' } });
  }
  assert.equal(url, MISTRAL_URL);
  const body = JSON.parse(init.body);
  const id = Buffer.from(body.messages[0].content[1].image_url.split(',')[1], 'base64').toString();
  seen.push({ id, model: body.model, temperature: body.temperature, auth: init.headers.authorization });
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies[id]) } }] }), { headers: { 'content-type': 'application/json' } });
};
const keyChain = createKeyChain(
  buildMistralPools({ MISTRAL_API_KEY: 'medium-key', MINISTRAL_14B_API_KEY_1: 'ministral-key' }).ministral14,
  { log: () => {} },
);
const drain = await drainPriceFallback({ offerStore, keyChain }, { model: 'ministral-14b-2512', currentOn: today, limit: 10, fetchImpl });
assert.deepEqual([drain.accepted, drain.rejected], [1, 1]);
assert.deepEqual(drain.reasons, { current_not_in_description: 1 }, 'the description check rejects the agreed crossed-out price');
assert.ok(seen.every((s) => s.model === 'ministral-14b-2512' && s.temperature === 0.3 && s.auth === 'Bearer ministral-key'),
  'only Ministral 14B, at the default temperature, on its own key');
assert.deepEqual(seen.map((s) => s.id).sort(), ['U1', 'U1', 'U2', 'U2'], 'two consecutive agreeing readings each');

// --- 4. success: the normal priced offer replaces the pending entry (same id) -------------
// --- 5. rejection: still tappable, price unavailable ----------------------------------
doc = await hotspots();
assert.deepEqual(tappable(doc), ['P1', 'U1', 'U2'], 'nothing becomes untappable');
assert.deepEqual(doc.offers.U1, await pricedOnly('U1'), 'U1 is now served by the normal offers join');
assert.deepEqual([doc.offers.U1.price, doc.offers.U1.oldPrice, doc.offers.U1.priceSource, doc.offers.U1.priceStatus], [18, 22.5, 'vision', undefined]);
assert.deepEqual([doc.offers.U2.price, doc.offers.U2.priceStatus], [null, 'unavailable']);
assert.equal(await offerStore.getById('shop:central:d4d:U2'), null, 'a rejected product never enters offers');
assert.deepEqual(doc.offers.P1, await pricedOnly('P1'), 'the D4D-priced product is untouched');
{
  const legacy = await legacyDoc();
  assert.deepEqual(Object.keys(legacy.offers).sort(), ['P1', 'U1'], 'offers holds priced products only');
  for (const id of ['P1', 'U1']) {
    assert.equal(JSON.stringify(doc.offers[id]), JSON.stringify(legacy.offers[id]), `${id} is served exactly as a normal offer`);
  }
}

// --- 6. the next ingest keeps every state -------------------------------------------------
const p1Before = await offerStore.getById('shop:central:d4d:P1');
report = await ingestOffers(ctx, { store: 'shop' });
assert.equal(report.targets[0].visionPriced, 1, 'the accepted price is rebuilt through the normal path');
const { detected_at: _a, ...p1Now } = await offerStore.getById('shop:central:d4d:P1');
const { detected_at: _b, ...p1Was } = p1Before;
assert.deepEqual(p1Now, p1Was, 'the priced row is unchanged by the unpriced flow');
doc = await hotspots();
assert.deepEqual(tappable(doc), ['P1', 'U1', 'U2']);
assert.deepEqual([doc.offers.U1.price, doc.offers.U2.priceStatus], [18, 'unavailable']);

// --- 7. D4D later prices the rejected product: D4D's offer takes the spot -------------------
ctx.offersSource.listOffers = async () => [P1, U1, { ...U2, price: 29.5, wasPrice: 30 }];
await ingestOffers(ctx, { store: 'shop' });
doc = await hotspots();
assert.deepEqual([doc.offers.U2.price, doc.offers.U2.priceSource, doc.offers.U2.priceStatus], [29.5, null, undefined]);

// --- 8. the queue can never break the priced join ----------------------------------------
{
  const broken = { ...hotspotsCtx, offerStore: { ...offerStore, byFlyer: offerStore.byFlyer, pricePendingByFlyer: async () => { throw new Error('no such table: price_pending'); } } };
  const d = (await getHotspotsDoc(broken, brochure.id, { rowToOffer })).doc;
  assert.deepEqual(Object.keys(d.offers).sort(), ['P1', 'U1', 'U2'], 'priced spots still served (U2 is D4D-priced by now)');
  const raw = (await getHotspotsDoc(hotspotsCtx, brochure.id, {})).doc;
  assert.ok(Object.values(raw.offers).every((o) => o.priceStatus === undefined), 'raw-row callers never get the read-API shape mixed in');
}

// --- 9. unpricedOffer on its own ------------------------------------------------------------
{
  const row = { id: 'shop:central:d4d:X', store: 'shop', region: 'central', source: 'd4d', offer_id: 'X', flyer_ref: FLYER, detected_at: 'now', raw_json: JSON.stringify(raw('X', 'thing 5.00')) };
  assert.equal(unpricedOffer({ ...row, status: 'pending' }).priceStatus, 'pending');
  assert.equal(unpricedOffer({ ...row, status: 'rejected' }).priceStatus, 'unavailable');
  assert.equal(unpricedOffer({ ...row, raw_json: '{broken' }), null, 'a corrupt record is skipped, not guessed');
  assert.equal(unpricedOffer({ ...row, raw_json: JSON.stringify({ ...raw('X', 'x'), offerId: '' }) }), null, 'no id, no product');
}

// --- 10. real SQL: the D1 query, the index, and offers.price still NOT NULL --------------------
{
  const { db, close } = createSqliteD1(['schema.sql']);
  const store = createD1OfferStore(db);
  const rows = ['A', 'B'].map((id) => ({ id: `shop:central:d4d:${id}`, store: 'shop', region: 'central', source: 'd4d', offer_id: id, flyer_ref: FLYER, image_url: `https://cdn.test/${id}.jpg`, valid_to: nextWeek, raw_json: JSON.stringify(raw(id, 'x 1.00')), detected_at: 'now' }));
  await store.upsertPricePending([...rows, { ...rows[0], id: 'other:central:d4d:A', store: 'other' }]);
  await store.resolvePricePending(rows[1].id, { status: 'rejected', reason: 'no_agreement', at: 'now' });
  const got = await store.pricePendingByFlyer('shop', 'central', FLYER);
  assert.deepEqual(got.map((r) => [r.offer_id, r.status]).sort(), [['A', 'pending'], ['B', 'rejected']], 'by flyer, any decision, this store only');
  const plan = (await db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM price_pending WHERE store = ? AND region = ? AND flyer_ref = ?`).bind('shop', 'central', FLYER).all()).results;
  assert.ok(plan.some((p) => /ix_price_pending_flyer/.test(p.detail)), `the flyer index is used: ${JSON.stringify(plan)}`);
  await assert.rejects(
    db.prepare(`INSERT INTO offers (id, store, region, source, offer_id, price, detected_at) VALUES ('n','s','r','d4d','1',NULL,'now')`).run(),
    /NOT NULL/, 'offers.price is still NOT NULL',
  );
  close();
}

// --- 11. a fully priced flyer: the whole document is byte-identical ------------------------
{
  const FLYER2 = '751700';
  const store2 = createMemoryOfferStore();
  const priced = ['Q1', 'Q2'].map((id, i) =>
    raw(id, `Rice 5kg ${20 + i}.00 25.00`, { flyerRef: FLYER2, price: 20 + i, wasPrice: 25 }));
  await ingestOffers({ ...ctx, offerStore: store2, offersSource: { name: 'd4d', async listOffers() { return priced; } } }, { store: 'shop' });
  const b2 = { ...brochure, id: 'shop:central:2026-W40', source_url: brochure.source_url.replace(FLYER, FLYER2) };
  const qSpots = ['Q1', 'Q2'].map((offerId, i) => ({ offerId, x: 0.4 * i, y: 0, w: 0.3, h: 0.3 }));
  const c2 = {
    metadataStore: { getById: async () => b2 },
    objectStore: { get: async () => ({ bytes: new TextEncoder().encode(JSON.stringify({ pages: [{ index: 0, spots: qSpots }] })) }) },
    offerStore: store2,
  };
  const now = (await getHotspotsDoc(c2, b2.id, { rowToOffer })).doc;
  assert.deepEqual(Object.keys(now.offers).sort(), ['Q1', 'Q2']);
  assert.equal(JSON.stringify(now), JSON.stringify(await legacyDoc(c2, b2.id)), 'no queued products -> the identical document');
}

console.log('unpricedHotspots.test: all passed');
