// priceFallback.test.mjs — the vision price fallback: rule, drain, ingest
// lifecycle and real SQL. No network: Mistral and the CDN are scripted.

import assert from 'node:assert/strict';
import {
  checkAgainstDescription,
  consecutiveAgreement,
  decidePrice,
  descriptionNumbers,
  drainPriceFallback,
  priceReading,
} from './priceFallback.js';
import { ingestOffers } from './ingest.js';
import { isUnpriced, pricePendingRow, rowToOffer } from './contract.js';
import { buildMistralPools, createKeyChain } from './mistralKeys.js';
import { MISTRAL_URL } from './enrich.js';
import { createMemoryMetadataStore, createMemoryOfferStore } from '../storage/local.js';
import { createD1OfferStore } from '../storage/offerStore.js';
import { createSqliteD1 } from '../storage/testSqliteD1.mjs';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const r = (current, old = null) => ({ current, old });
const today = new Date().toISOString().slice(0, 10);
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

// --- one reading ------------------------------------------------------------------
assert.deepEqual(priceReading({ current_price: 16, old_price: null }), r(16));
assert.deepEqual(priceReading({ current_price: '39.96', old_price: 43.95 }), r(39.96, 43.95));
assert.equal(priceReading({ current_price: 0 }), null, 'zero is not a price');
assert.equal(priceReading({ current_price: null }), null);
assert.equal(priceReading({ current_price: 'abc' }), null);
assert.equal(priceReading({ current_price: 21.95, old_price: 11.5 }), null, 'old must be higher');
assert.equal(priceReading(null), null);

// --- consecutive agreement: the approved examples ----------------------------------
assert.equal(consecutiveAgreement([r(16)]), null, 'a single reading is never enough');
assert.equal(consecutiveAgreement([r(16), r(16)]).current, 16);
assert.equal(consecutiveAgreement([r(16), r(18), r(18)]).current, 18);
assert.equal(consecutiveAgreement([r(16), r(18), r(15), r(18), r(18)]).current, 18);
assert.equal(consecutiveAgreement([r(16), r(18), r(16), r(18)]), null, 'no consecutive pair -> reject');
assert.equal(consecutiveAgreement([r(16), null, r(16)]), null, 'an invalid reading breaks the run');
assert.equal(consecutiveAgreement([r(16), r(16.005)]).current, 16.005, 'within 0.01 agrees');
assert.equal(consecutiveAgreement([r(16), r(16.02)]), null, 'beyond 0.01 does not');
assert.deepEqual(consecutiveAgreement([r(30, 44.99), r(30, 44.99)]), { current: 30, old: 44.99, at: 2 });
assert.equal(consecutiveAgreement([r(30, 44.99), r(30)]).old, null, 'old kept only if both agree');

// --- the D4D description check (shapes copied from live D4D descriptions) --------
const riceDesc = '43.95 39,96 ال noora indian mazza sella rice $ 39.96 أرز نورا مازا سيلا الهندي 10 كج noora indian mazza sella rce 10kg';
assert.deepEqual(descriptionNumbers('farm milk 1.8kg 25.96'), [25.96], 'sizes are not prices');
assert.deepEqual(descriptionNumbers('٣٣٫٩٥ ريال'), [33.95], 'Arabic-Indic digits');
assert.deepEqual(checkAgainstDescription(riceDesc, r(39.96, 43.95)), { ok: true, current: 39.96, old: 43.95 });
assert.deepEqual(checkAgainstDescription(riceDesc, r(39.96)), { ok: true, current: 39.96, old: null });
assert.equal(checkAgainstDescription(riceDesc, r(43.95)).reason, 'lower_price_in_description',
  'the crossed-out price agreed as current is caught');
assert.equal(checkAgainstDescription(riceDesc, r(41.5)).reason, 'current_not_in_description');
assert.deepEqual(checkAgainstDescription(riceDesc, r(39.96, 55)), { ok: true, current: 39.96, old: null },
  'an unsupported old price is dropped, never kept');

// The known historical failure: crop 8 read 44.99 (the WAS price) on 5/5 readings.
const diapersDesc = 'fine baby diaper 5 maxi jumbo 40\'s 11-18kg 44.99 30.00';
const stableSwap = decidePrice([r(44.99), r(44.99), r(44.99)], diapersDesc);
assert.equal(stableSwap.status, 'rejected', 'stable agreement on the crossed-out price is rejected');
assert.equal(stableSwap.reason, 'lower_price_in_description');
assert.deepEqual(decidePrice([r(30, 44.99), r(30, 44.99)], diapersDesc), { status: 'accepted', price: 30, oldPrice: 44.99 });
assert.equal(decidePrice([r(30), r(31), r(30), r(31)], diapersDesc).reason, 'no_agreement');

// --- the key pool: its own keys first, then the shared pool (2026-09-24) -----------
{
  const pools = buildMistralPools({ MISTRAL_API_KEY: 'legacy', MISTRAL_OCR_API_KEY: 'ocr', MISTRAL_SMALL_API_KEY: 'small' });
  assert.deepEqual(pools.ministral14.filter((s) => s.key).map((s) => s.key), ['small', 'legacy', 'ocr'],
    'with no Ministral secret set, every other configured key serves it (one shared pool)');
  assert.ok(pools.ministral14.every((s) => s.model === 'ministral-14b-2512'), 'the model is always Ministral 14B');
  const mine = buildMistralPools({ MINISTRAL_14B_API_KEY_1: 'mine', MISTRAL_SMALL_API_KEY: 'small' });
  assert.deepEqual(mine.ministral14.filter((s) => s.key).map((s) => s.key), ['mine', 'small'], 'its own key is tried first');
  const three = buildMistralPools({ MINISTRAL_14B_API_KEY_1: 'a', MINISTRAL_14B_API_KEY_2: 'b', MINISTRAL_14B_API_KEY_3: 'c' });
  assert.deepEqual(three.ministral14.map((s) => s.key), ['a', 'b', 'c']);
}

// --- the drain, end to end with a scripted CDN + Mistral --------------------------
const CROP = (id) => `https://cdn.test/${id}.jpg`;
function harness(script, { cropStatus = {} } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url.startsWith('https://cdn.test/')) {
      const id = url.slice('https://cdn.test/'.length, -4);
      const status = cropStatus[id] || 200;
      return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : 'gone', { status, headers: { 'content-type': 'image/jpeg' } });
    }
    assert.equal(url, MISTRAL_URL);
    const body = JSON.parse(init.body);
    calls.push({ model: body.model, temperature: body.temperature, auth: init.headers.authorization });
    const next = script.shift(); // one item per drain call: one reading queue
    if (next && next.status) return new Response(next.body || 'err', { status: next.status });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(next) } }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}
async function drainOne(offerStore, readings, extra = {}) {
  const { calls, fetchImpl } = harness([...readings], extra);
  const keyChain = createKeyChain(buildMistralPools({ MINISTRAL_14B_API_KEY_1: 'k1', MINISTRAL_14B_API_KEY_2: 'k2' }).ministral14, { log: () => {} });
  const report = await drainPriceFallback({ offerStore, keyChain }, {
    model: 'ministral-14b-2512', currentOn: today, limit: 1, maxReadings: 6, temperature: 0.3, fetchImpl,
    failover: { sleepImpl: async () => {} }, ...extra.opts,
  });
  return { report, calls };
}
const rawFor = (id, description) => ({
  offerId: id, flyerRef: '777', pageRef: 'p1', price: '0.000', wasPrice: '0.000', description,
  imageUrl: CROP(id), validFrom: today, validTo: nextWeek, storeWords: ['Test Store'],
});
async function queued(id, description) {
  const offerStore = createMemoryOfferStore();
  await offerStore.upsertPricePending([pricePendingRow(rawFor(id, description), { store: 'shop', region: 'central', source: 'd4d', detectedAt: '2026-09-24T06:00:00.000Z' })]);
  return offerStore;
}
const P = (current_price, old_price = null) => ({ name_en: 'x', current_price, old_price });

{
  // 16 -> 18 -> 15 -> 18 -> 18 : accept 18 (and it is printed in the description)
  const store = await queued('A', 'kasih liquid jameed 1kg 22.50 18.00');
  const { report, calls } = await drainOne(store, [P(16), P(18), P(15), P(18), P(18)]);
  assert.equal(report.accepted, 1);
  assert.equal(report.readings, 5);
  assert.ok(calls.every((c) => c.model === 'ministral-14b-2512' && c.temperature === 0.3), 'Ministral 14B only, at the set temperature');
  assert.ok(calls.every((c) => c.auth === 'Bearer k1' || c.auth === 'Bearer k2'), 'only the Ministral pool keys are used');
  const offer = rowToOffer(await store.getById('shop:central:d4d:A'));
  assert.equal(offer.price, 18);
  assert.equal(offer.priceSource, 'vision');
  const [p] = await store.pricePendingByIds(['shop:central:d4d:A']);
  assert.equal(p.status, 'accepted');
  assert.deepEqual(JSON.parse(p.audit_json).readings.map((x) => x[0]), [16, 18, 15, 18, 18]);
  assert.equal((await store.listPricePending({ currentOn: today })).length, 0, 'decided once, never re-read');
}
{
  // 16 -> 18 -> 16 -> 18 -> 16 -> 18 : bound reached without agreement -> rejected, no offer
  const store = await queued('B', 'x 16.00 18.00');
  const { report } = await drainOne(store, [P(16), P(18), P(16), P(18), P(16), P(18)]);
  assert.equal(report.rejected, 1);
  assert.equal(report.readings, 6, 'stops at the maximum');
  assert.equal(report.reasons.no_agreement, 1);
  assert.equal(await store.getById('shop:central:d4d:B'), null, 'no guessed price stored');
}
{
  // stable swap: agrees on the crossed-out price -> rejected by the description
  const store = await queued('C', 'fine baby diaper 44.99 30.00');
  const { report } = await drainOne(store, [P(44.99), P(44.99)]);
  assert.equal(report.rejected, 1);
  assert.equal(report.reasons.lower_price_in_description, 1);
  assert.equal(await store.getById('shop:central:d4d:C'), null);
}
{
  // a candidate the description does not print -> rejected
  const store = await queued('D', 'toblerone 6x100gm 32.96 39.95');
  const { report } = await drainOne(store, [P(33), P(33)]);
  assert.equal(report.reasons.current_not_in_description, 1);
}
{
  // transient provider error: deferred, counted, and rejected after the bound
  const store = await queued('E', 'x 9.95');
  for (let i = 1; i <= 3; i += 1) {
    const { report } = await drainOne(store, [{ status: 500 }]);
    const [p] = await store.pricePendingByIds(['shop:central:d4d:E']);
    assert.equal(p.attempts, i);
    if (i < 3) { assert.equal(report.deferred, 1); assert.equal(p.status, 'pending'); }
    else { assert.equal(report.reasons.transient_exhausted, 1); assert.equal(p.status, 'rejected'); }
  }
}
{
  // unknown model / bad request: the drain STOPS; the item stays pending untouched
  const store = await queued('F', 'x 9.95');
  const { report } = await drainOne(store, [{ status: 400, body: 'invalid model' }]);
  assert.equal(report.stopped, 'model_or_keys_unavailable');
  const [p] = await store.pricePendingByIds(['shop:central:d4d:F']);
  assert.equal(p.status, 'pending');
  assert.equal(p.attempts, 0);
}
{
  // the crop is gone for good -> rejected without any model call
  const store = await queued('G', 'x 9.95');
  const { report, calls } = await drainOne(store, [P(9.95), P(9.95)], { cropStatus: { G: 404 } });
  assert.equal(report.reasons.crop_missing, 1);
  assert.equal(calls.length, 0);
}
{
  // no model configured -> inert
  const store = await queued('H', 'x 9.95');
  const { report } = await drainOne(store, [P(9.95), P(9.95)], { opts: { model: '' } });
  assert.equal(report.skipped, 'no_model');
  assert.equal((await store.pricePendingByIds(['shop:central:d4d:H']))[0].status, 'pending');
}
{
  // the subrequest budget is never overrun: an item that cannot finish is not started
  const store = await queued('I', 'x 9.95');
  const { report } = await drainOne(store, [P(9.95), P(9.95)], { opts: { subrequestBudget: 5 } });
  assert.equal(report.readings, 0);
  assert.equal((await store.pricePendingByIds(['shop:central:d4d:I']))[0].status, 'pending');
}

// --- ingest lifecycle: priced path unchanged, queue, rebuild, D4D wins ---------------
{
  const offerStore = createMemoryOfferStore();
  let feed = [];
  const ctx = {
    registry: { shop: { id: 'shop', regions: { central: { store: 'shop-1', city: 'riyadh' } } } },
    metadataStore: createMemoryMetadataStore(),
    objectStore: { get: async () => null },
    offerStore,
    offersSource: { name: 'd4d', async listOffers() { return feed; } },
  };
  const priced = { ...rawFor('P1', 'priced product 10.00'), price: 10, wasPrice: 12 };
  const unpriced = rawFor('U1', 'jameed 1kg 22.50 18.00');
  feed = [priced, unpriced, { ...rawFor('U2', 'no crop'), imageUrl: null }];

  let report = await ingestOffers(ctx, { store: 'shop' });
  let line = report.targets[0];
  assert.deepEqual(line.errors, []);
  assert.equal(line.stored, 1, 'only the D4D-priced record is an offer');
  assert.equal(line.unpriced, 1);
  assert.equal(line.dropped, 1, 'an unpriced record with no crop cannot be read');
  assert.equal(rowToOffer(await offerStore.getById('shop:central:d4d:P1')).priceSource, null, 'D4D path unchanged');
  assert.equal((await offerStore.listPricePending({ currentOn: today })).length, 1);

  // the fallback accepts 18; the NEXT ingest rebuilds it as a normal offer
  await offerStore.resolvePricePending('shop:central:d4d:U1', { status: 'accepted', price: 18, oldPrice: 22.5, at: 'now' });
  report = await ingestOffers(ctx, { store: 'shop' });
  line = report.targets[0];
  assert.equal(line.visionPriced, 1);
  assert.equal(line.stored, 2);
  let u1 = rowToOffer(await offerStore.getById('shop:central:d4d:U1'));
  assert.deepEqual([u1.price, u1.oldPrice, u1.priceSource], [18, 22.5, 'vision']);
  assert.equal((await offerStore.pricePendingByIds(['shop:central:d4d:U1']))[0].status, 'accepted', 're-ingest keeps the decision');

  // D4D later publishes a price for it -> D4D wins, the row is D4D's again
  feed = [priced, { ...unpriced, price: 17.5, wasPrice: 22.5 }];
  await ingestOffers(ctx, { store: 'shop' });
  u1 = rowToOffer(await offerStore.getById('shop:central:d4d:U1'));
  assert.deepEqual([u1.price, u1.priceSource], [17.5, null]);

  // a pending item D4D has priced is no longer drained
  const pendingOnly = rawFor('U3', 'x 5.00');
  feed = [pendingOnly];
  await ingestOffers(ctx, { store: 'shop' });
  assert.equal((await offerStore.listPricePending({ currentOn: today })).length, 1);
  feed = [{ ...pendingOnly, price: 5 }];
  await ingestOffers(ctx, { store: 'shop' });
  assert.equal((await offerStore.listPricePending({ currentOn: today })).length, 0, 'D4D-priced items leave the queue');

  // a failing queue write never fails the ingest
  offerStore.upsertPricePending = async () => { throw new Error('no such table: price_pending'); };
  feed = [priced, rawFor('U4', 'x 3.00')];
  report = await ingestOffers(ctx, { store: 'shop' });
  assert.deepEqual(report.targets[0].errors, []);
  assert.equal(report.totals.failed, 0);
  assert.match(report.targets[0].priceFallbackError, /no such table/);
}
assert.equal(isUnpriced({ price: '0.000' }), true);
assert.equal(isUnpriced({ price: 9.95 }), false);

// --- real SQL: schema.sql + the D1 store --------------------------------------------
{
  const { db, close } = createSqliteD1(['schema.sql']);
  const store = createD1OfferStore(db);
  const built = { store: 'shop', region: 'central', source: 'd4d', detectedAt: '2026-09-24T06:00:00.000Z' };
  const row = pricePendingRow(rawFor('S1', 'x 9.95'), built);
  await store.upsertPricePending([row]);
  assert.equal((await store.listPricePending({ currentOn: today })).length, 1);
  await store.resolvePricePending(row.id, { status: 'accepted', price: 9.95, oldPrice: null, audit: { readings: [[9.95, null], [9.95, null]] }, at: 'now' });
  await store.upsertPricePending([{ ...row, raw_json: '{"refreshed":true}' }]);
  const [kept] = await store.pricePendingByIds([row.id]);
  assert.equal(kept.status, 'accepted', 'a re-ingest never resets a decision');
  assert.equal(kept.raw_json, '{"refreshed":true}');
  assert.equal((await store.listPricePending({ currentOn: today })).length, 0);

  // the offers upsert carries price_source both ways
  const base = {
    id: 'shop:central:d4d:S2', store: 'shop', region: 'central', source: 'd4d', offer_id: 'S2', flyer_ref: '1',
    page_ref: null, brochure_id: null, page_index: null, edition: null, name: 'n', name_ar: null, price: 5,
    old_price: null, currency: 'SAR', category_id: null, category: null, image_url: null, source_url: null,
    valid_from: today, valid_to: nextWeek, detected_at: 'now', search_text: 'n', identity: null, brand_slug: null,
  };
  await store.upsertMany([{ ...base, price_source: 'vision' }]);
  assert.equal((await store.getById(base.id)).price_source, 'vision');
  await store.upsertMany([base]);
  assert.equal((await store.getById(base.id)).price_source, null, 'a D4D upsert takes the row back');

  // attempts + bounded rejection
  const t = pricePendingRow(rawFor('S3', 'x'), built);
  await store.upsertPricePending([t]);
  await store.markPricePendingAttempt(t.id, { reason: 'transient', reject: false, at: 'now' });
  await store.markPricePendingAttempt(t.id, { reason: 'transient', reject: true, at: 'now' });
  const [tt] = await store.pricePendingByIds([t.id]);
  assert.deepEqual([tt.attempts, tt.status], [2, 'rejected']);
  assert.equal(await store.prunePricePendingBefore('2099-01-01'), 2); // S1 + S3 (S2 is an offer)
  close();
}
{
  // Upgrade path: the migration applies to a pre-fallback offers table.
  const legacy = new DatabaseSync(':memory:');
  legacy.exec(`CREATE TABLE offers (id TEXT PRIMARY KEY, price REAL NOT NULL, brand_slug TEXT);
               INSERT INTO offers VALUES ('old', 9.95, NULL);`);
  legacy.exec(readFileSync('migrate-2026-09-24-price-fallback.sql', 'utf8'));
  assert.equal(legacy.prepare(`SELECT price_source FROM offers WHERE id = 'old'`).get().price_source, null,
    'every existing row keeps meaning "source price"');
  legacy.prepare(`INSERT INTO price_pending (id, store, region, source, offer_id, image_url, raw_json, detected_at)
                  VALUES ('p', 's', 'r', 'd4d', '1', 'u', '{}', 'now')`).run();
  assert.throws(() => legacy.prepare(`UPDATE price_pending SET status = 'guessed' WHERE id = 'p'`).run(), /CHECK constraint failed/);
  legacy.close();
}

console.log('priceFallback.test: all passed');
