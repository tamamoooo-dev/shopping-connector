// watchIndex.test.mjs — Value Watch end to end (buildWatch → index → rounds →
// alerts) against the in-memory stores, a scripted store search and a scripted
// judge. The cases are the production failures this design replaces:
//   • the 80 g / 185 g Tendrina watches (size per item is identity),
//   • "12 cans at 50 beats one can at 5" (value per item, any pack),
//   • one store blocking the Worker (Lulu 403) starving or pinning a watch,
//   • the same deal alerted on every round.
import assert from 'node:assert/strict';
import { handleRequest } from './engine.js';
import { buildWatch, checkWatch } from './monitor.js';
import { createMemoryWatchStore } from './storage/local.js';
import { createMemoryWatchListingStore } from './storage/watchListingStore.js';
import { checkValueWatch, indexDueWatches, valueWatchSummary, watchListingsView } from './watchIndex.js';
import { normalizeText } from './matching.js';
import { readObservation } from './watchObserve.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); passed += 1; };

// A scripted market: catalog[store] = listings, or an Error the store throws.
function market(catalog) {
  const calls = [];
  return {
    calls,
    catalog,
    client: {
      async search(store, query) {
        calls.push({ store, query });
        const entry = catalog[store];
        if (entry instanceof Error) throw entry;
        return (entry || []).map((l) => ({ ...l }));
      },
      async lookupExact(store, id) {
        calls.push({ store, lookup: id });
        const entry = catalog[`${store}:exact`];
        return entry && String(entry.id) === String(id) ? { ...entry } : null;
      },
    },
  };
}

// The judge reads titles the way the prompt asks: same line + variant.
function scriptedJudge(rule, log = []) {
  return async (reference, candidates) => {
    log.push(candidates.length);
    return { reference: null, results: candidates.map((c) => rule(c.listing, c.store)) };
  };
}

async function setup(body, catalog, judgeRule) {
  const { watch, error } = buildWatch({ profileId: 'profile-value-1', kind: 'product', ...body });
  assert.equal(error, undefined, error);
  const watchStore = createMemoryWatchStore();
  await watchStore.create(watch);
  const m = market(catalog);
  const judgeCalls = [];
  const ctx = {
    watchStore,
    watchListingStore: createMemoryWatchListingStore(),
    searchClient: m.client,
    watchJudge: judgeRule ? scriptedJudge(judgeRule, judgeCalls) : null,
  };
  return { ctx, watch, m, judgeCalls, get: () => watchStore.get(watch.id) };
}

const t0 = new Date('2026-11-03T04:00:00Z');
const at = (hours) => new Date(t0.getTime() + hours * 3600 * 1000);

// --- 1. The 80 g Tendrina watch finds Panda's 3.66 ---------------------------------

const tendrinaCatalog = () => ({
  danube: [
    { id: '2674', name: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', price: 5.99 },
    { id: '2669', name: 'تندرينا تونه ناعمه', size: '185 غرام', price: 9.5 },
  ],
  panda: [
    { id: '21028', name: 'تندرينا تونة قطع خفيفة في زيت دوار الشمس 80 جم', price: 3.66 },
    { id: '21029', name: 'تندرينا تونة ناعمة 185 جم', price: 10.5 },
    { id: '30001', name: 'قودي تونة قطع خفيفة 80 جم × 4', price: 12 },
  ],
  lulu: Object.assign(new Error('search lulu -> HTTP 403'), {}),
});
const sameLine = (listing) => {
  const name = listing.name;
  if (/تندرينا/.test(name) && /قطع خفيفة/.test(name)) return { same: 'yes', items: 1, why: 'same line' };
  if (/تندرينا/.test(name) && /ناعم/.test(name)) return { same: 'yes', items: 1, why: 'same line' };
  return { same: 'no', why: 'different line' };
};

{
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', targetPrice: 6,
  }, tendrinaCatalog(), sameLine);
  eq(s.watch.watchTrack, 'indexed_value', 'a picked product is a Value Watch by default');
  eq(s.watch.targetUnitPrice, 6, 'one tin picked: the target per item is the target');

  const indexed = await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 });
  const line = indexed.lines[0];
  ok(line.alerted && line.alertType === 'target', 'the index pass alerts at once when a deal is live');
  eq(line.price, 3.66, 'the best per-item value is Panda 3.66');
  const alerts = await s.ctx.watchStore.listAlerts({ profileId: 'profile-value-1' });
  eq(alerts.length, 1, 'one alert');
  eq([alerts[0].store, alerts[0].purchasePrice, alerts[0].unitLabel], ['panda', 3.66, 'per-item'],
    'the alert names the store, the price paid and the per-item basis');

  const view = await watchListingsView(s.ctx, await s.get());
  const verdict = (store, id) => view.listings.find((l) => l.store === store && l.listingId === id)?.verdict;
  eq(verdict('danube', '2674'), 'match', 'the anchor listing is tracked');
  eq(verdict('panda', '21028'), 'match', 'the reworded Panda title is verified by the judge');
  eq(verdict('danube', '2669'), 'reject', 'the 185 g tin is rejected for the 80 g watch');
  eq(verdict('panda', '21029'), 'reject', 'Panda 185 g too');
  eq(verdict('panda', '30001'), 'reject', 'a different brand line is rejected by the judge');
  const watched = await s.get();
  eq(watched.indexState, 'ready', 'the index is ready');
  ok(Date.parse(watched.indexDueAt) - t0.getTime() >= 6 * 24 * 3600 * 1000, 'and due again in a week');
  eq(JSON.parse(watched.indexJson).stores.lulu, 'failed', 'Lulu is recorded as not answering …');
  ok(watched.isBelow, '… and did not block the watch: it holds no verified listing');

  // The next round: same market. Known listings are not re-judged.
  const before = s.judgeCalls.length;
  const r2 = await checkWatch(s.ctx, await s.get(), { roundKey: 'slot-am', alertKey: 'run-1' });
  eq(r2.alerted, false, 'the same deal next round is not alerted again');
  eq(s.judgeCalls.length, before, 'verdicts are remembered: nothing re-judged');

  // Panda (which holds the best listing) down: the round retries instead of
  // concluding anything …
  s.m.catalog.panda = new Error('search panda -> HTTP 502');
  const r3 = await checkWatch(s.ctx, await s.get(), { roundKey: 'slot-pm', alertKey: 'run-2' });
  eq(r3.resolution, 'provider-error', 'a store holding a verified listing failing → retry');
  ok((await s.get()).isBelow, 'and the state is untouched');
  // … the retry inside the same round re-asks only the stores that failed.
  s.m.catalog.panda = tendrinaCatalog().panda;
  s.m.calls.length = 0;
  const r4 = await checkWatch(s.ctx, await s.get(), { roundKey: 'slot-pm', alertKey: 'run-2' });
  ok(r4.resolution === 'ok' && !r4.alerted, 'the retry completes the round without a duplicate alert');
  ok(!s.m.calls.some((c) => c.store === 'danube'), 'stores that already answered this round are not asked again');

  // Prices go up: the deal ends; coming back down is a new event.
  s.m.catalog.panda = [{ id: '21028', name: 'تندرينا تونة قطع خفيفة في زيت دوار الشمس 80 جم', price: 6.25 }];
  s.m.catalog.danube = [{ id: '2674', name: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', price: 6.5 }];
  const r5 = await checkValueWatch(s.ctx, await s.get(), { roundKey: 'r5', now: at(24) });
  ok(r5.status === 'above-target' && !r5.alerted, 'above target: no alert');
  ok(!(await s.get()).isBelow, 'the watch re-arms (the deal listing was SEEN above target)');
  s.m.catalog.panda = [{ id: '21028', name: 'تندرينا تونة قطع خفيفة في زيت دوار الشمس 80 جم', price: 3.66 }];
  const r6 = await checkValueWatch(s.ctx, await s.get(), { roundKey: 'r6', now: at(36) });
  ok(r6.alerted && r6.alertType === 'target', 'the price back down alerts again');
  eq((await s.ctx.watchStore.listAlerts({ profileId: 'profile-value-1' })).length, 2, 'two alerts for two episodes');
}

// --- 2. The 185 g watches never take the 80 g price -------------------------------

{
  const s = await setup({
    provider: 'danube', productId: '2669', query: 'تندرينا تونه ناعمه',
    label: 'تندرينا تونه ناعمه', sizeText: '185 غرام', targetPrice: 6, customSearchQuery: 'تندرينا 185',
    listing: { id: '2669', provider: 'danube', name: 'تندرينا تونه ناعمه', size: '185 غرام' },
  }, tendrinaCatalog(), sameLine);
  const line = (await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 })).lines[0];
  ok(!line.alerted, 'no alert: no 185 g tin is under 6.00');
  eq(line.price, 9.5, 'the best 185 g value is 9.50, never the 3.66 80 g tin');
  eq(line.status, 'above-target', 'reported above target');
  const view = await watchListingsView(s.ctx, await s.get());
  ok(view.listings.filter((l) => /80/.test(l.name)).every((l) => l.verdict === 'reject'),
    'every 80 g listing is rejected for the 185 g watch');
  ok(s.m.calls.some((c) => c.query === 'تندرينا 185'), 'the advanced search phrase is one of the queries');
}

// --- 3. Value: "12 cans at 50 is better than one can at 5" ------------------------

{
  const fullFat = (listing) => /كامل الدسم|full fat/i.test(listing.name)
    ? { same: 'yes', why: 'same milk' } : { same: 'no', why: 'different fat level' };
  const s = await setup({
    provider: 'danube', productId: 'nadec-12', query: 'حليب نادك',
    label: 'نادك حليب طويل الأجل كامل الدسم 12 × 1 لتر', targetPrice: 50,
  }, {
    danube: [{ id: 'nadec-12', name: 'نادك حليب طويل الأجل كامل الدسم 12 × 1 لتر', price: 56 }],
    panda: [
      { id: 'p1', name: 'حليب نادك طويل الأجل كامل الدسم 1 لتر', price: 5 },
      { id: 'p2', name: 'حليب نادك طويل الأجل خالي الدسم 12 × 1 لتر', price: 40 },
    ],
    tamimi: [{ id: 't1', name: 'Nadec Long Life Milk Full Fat 1L x 12', price: 48 }],
  }, fullFat);
  eq(s.watch.targetUnitPrice, 4.1667, '50 SAR for 12 → 4.17 per carton');
  const line = (await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 })).lines[0];
  ok(line.alerted, 'the 12-pack at 48 (4.00 per carton) is under the 4.17 target');
  eq(line.price, 4, 'value per item, not the pack price');
  const alert = (await s.ctx.watchStore.listAlerts({ profileId: 'profile-value-1' }))[0];
  eq([alert.store, alert.purchasePrice], ['tamimi', 48], 'the deal is Tamimi 48 for 12, not Panda 5 for one');
  const view = await watchListingsView(s.ctx, await s.get());
  eq(view.listings.find((l) => l.listingId === 'p2').verdict, 'reject', 'skimmed is a different product');
  eq(view.listings.find((l) => l.listingId === 'p1').value, 5, 'the single carton is tracked at 5.00 per item');
}

// --- 4. The judge unsure, or unavailable: never an alert ----------------------------

{
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', targetPrice: 3,
  }, {
    danube: [{ id: '2674', name: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', price: 5.99 }],
    panda: [{ id: '21028', name: 'تندرينا تونة قطع خفيفة في زيت دوار الشمس 80 جم', price: 2.5 }],
  }, () => ({ same: 'unsure', why: 'cannot tell the oil' }));
  const line = (await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 })).lines[0];
  ok(!line.alerted, 'an unsure listing never alerts, however cheap');
  eq(line.price, 5.99, 'only verified listings are priced');
  const view = await watchListingsView(s.ctx, await s.get());
  eq(view.listings.find((l) => l.listingId === '21028').verdict, 'pending', 'it waits as pending');
  const asked = s.judgeCalls.length;
  await checkValueWatch(s.ctx, await s.get(), { roundKey: 'unsure-again', now: at(0.5) });
  eq(s.judgeCalls.length, asked, 'an "unsure" is an answer: the next round does not ask again (no second chance at a yes)');

  // The owner answers "yes, that is my product": the user's verdict wins.
  await s.ctx.watchListingStore.setVerdict(s.watch.id, 'panda', '21028', { verdict: 'match', by: 'user' });
  const after = await checkValueWatch(s.ctx, await s.get(), { roundKey: 'after-user', now: at(1) });
  ok(after.alerted && after.price === 2.5, 'after the owner confirms it, the deal alerts');
}

// --- 5. The checker not configured, every store down, concurrent rounds -------------

{
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', targetPrice: 6,
  }, Object.fromEntries(['panda', 'tamimi', 'danube', 'lulu', 'ninja', 'amazon', 'noon']
    .map((store) => [store, new Error(`search ${store} -> HTTP 500`)])), null);
  const line = await checkValueWatch(s.ctx, await s.get(), { roundKey: 'down', now: t0 });
  eq(line.resolution, 'provider-error', 'every store down is a retry, never "not found"');
  ok(!(await s.get()).isBelow, 'and changes nothing');
}

{
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', targetPrice: 6,
  }, tendrinaCatalog(), sameLine);
  const watch = await s.get();
  // Two children racing on the same initial state (a re-dispatched round).
  const [a, b] = await Promise.all([
    checkValueWatch(s.ctx, watch, { roundKey: 'race', now: t0 }),
    checkValueWatch(s.ctx, watch, { roundKey: 'race', now: t0 }),
  ]);
  ok(a.alertType === 'target' && b.alertType === 'target', 'both racers decide the same alert …');
  eq((await s.ctx.watchStore.listAlerts({ profileId: 'profile-value-1' })).length, 1,
    '… and the deterministic alert id records it once');
}

// --- 6. An Amazon pick: tracked by exact lookup, compared across stores -------------

{
  const asin = 'B098RGBBHM';
  const s = await setup({
    provider: 'amazon', productId: asin, query: 'nadec skimmed milk',
    label: 'Nadec Skimmed Milk Long Life 1 Liter (Pack of 12)', targetPrice: 50,
  }, {
    amazon: [],
    'amazon:exact': { id: asin, name: 'Nadec Skimmed Milk Long Life 1 Liter (Pack of 12)', price: 52 },
    danube: [{ id: 'd-skim', name: 'Nadec Long Life Skimmed Milk 12 x 1 L', price: 47 }],
  }, (listing) => /skim/i.test(listing.name) ? { same: 'yes' } : { same: 'no' });
  eq(s.watch.watchTrack, 'indexed_value', 'an Amazon pick is a Value Watch too');
  const line = (await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 })).lines[0];
  ok(s.m.calls.some((c) => c.lookup === asin), 'the picked ASIN is looked up by id when search misses it');
  ok(line.alerted && line.price === 3.9167, 'the same 12-pack cheaper at Danube alerts (47 / 12 = 3.92)');
  const view = await watchListingsView(s.ctx, await s.get());
  eq(view.listings.find((l) => l.listingId === asin)?.verdict, 'match', 'the ASIN itself stays tracked');
}

// --- 7. The HTTP surface: create → index → listings → the owner's answers ---------

{
  const BASE = 'https://engine.test';
  const P = 'profile-value-http';
  const call = (ctx, method, path, body, headers = {}) => handleRequest(new Request(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  }), ctx);
  const m = market(tendrinaCatalog());
  const ctx = {
    watchStore: createMemoryWatchStore(),
    watchListingStore: createMemoryWatchListingStore(),
    searchClient: m.client,
    watchJudge: scriptedJudge(sameLine),
    ingestSecret: 'secret-1',
  };
  const created = await call(ctx, 'POST', '/watches', {
    profileId: P, kind: 'product', provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'تونة تندرينا في زيت دوار الشمس', targetPrice: 6,
    listing: {
      id: 2674, provider: 'danube', name: 'تونة تندرينا في زيت دوار الشمس', size: '80 غرام',
      fullName: 'قودي تونة تندرينا في زيت دوار الشمس 80غرام', fullNameEn: 'Goody Tenderina Tuna in Sunflower Oil 80g',
      brand: 'قودي', brandEn: 'Goody',
    },
  });
  eq(created.status, 201, 'POST /watches creates a Value Watch');
  const id = (await created.json()).watch.id;
  const list = await (await call(ctx, 'GET', `/watches?profile=${P}`)).json();
  const row = list.watches.find((w) => w.id === id);
  eq([row.watchTrack, row.indexState, row.value.itemLabel, row.value.targetValue], ['indexed_value', 'pending', '80 g', 6],
    'the list carries the value contract and a pending index');
  eq((await call(ctx, 'POST', `/watches/index?ids=${id}`)).status, 403, 'the index route is guarded');
  const indexed = await (await call(ctx, 'POST', `/watches/index?ids=${id}`, null, { 'X-Ingest-Secret': 'secret-1' })).json();
  ok(indexed.lines[0].alerted, 'the guarded index pass runs and alerts');
  const view = await (await call(ctx, 'GET', `/watches/listings?profile=${P}&id=${id}`)).json();
  ok(view.listings.length >= 4 && view.reference.item.value === 80, 'GET /watches/listings shows the index');
  eq((await call(ctx, 'GET', `/watches/listings?profile=other&id=${id}`)).status, 404, 'another profile sees nothing');
  const rejected = await (await call(ctx, 'PATCH', `/watches/listings?profile=${P}&id=${id}`,
    { store: 'panda', listingId: '21028', verdict: 'reject' })).json();
  eq(rejected.listings.find((l) => l.listingId === '21028').verdictBy, 'user', 'the owner rejects a listing');
  eq((await ctx.watchStore.get(id)).indexState, 'pending', 'and the index runs again');
  await call(ctx, 'POST', `/watches/index?ids=${id}`, null, { 'X-Ingest-Secret': 'secret-1' });
  const again = await (await call(ctx, 'GET', `/watches/listings?profile=${P}&id=${id}`)).json();
  eq(again.listings.find((l) => l.listingId === '21028').verdict, 'reject', 'the checker never overrides the owner');
  eq((await call(ctx, 'POST', `/watches/refresh?profile=${P}&id=${id}`)).status, 409,
    'Refresh right after an index pass is refused (10-minute floor)');
  eq((await call(ctx, 'PATCH', `/watches/listings?profile=${P}&id=${id}`, { item: { value: -1, unit: 'g' } })).status, 400,
    'a nonsense size choice is refused');
}

// --- 7. Barcodes, pack sizes, stock and blank pages -------------------------------

{
  const TIN80 = '628101480047';
  const FOUR = '628101480099';
  // The judge says yes only to the 4-packs; everything else it would reject,
  // so a match elsewhere is the barcode rule's doing.
  const fourPacks = (listing) => /4/.test(listing.name) && /تندرينا/.test(listing.name)
    ? { same: 'yes', items: null, why: 'same tin' } : { same: 'no', why: 'different' };
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'قودي تونة تندرينا في زيت دوار الشمس 80غرام', targetPrice: 6,
    listing: { id: '2674', provider: 'danube', name: 'قودي تونة تندرينا في زيت دوار الشمس 80غرام', barcodes: [TIN80] },
  }, {
    danube: [
      { id: '2674', name: 'قودي تونة تندرينا في زيت دوار الشمس 80غرام', price: 5.99, barcodes: [TIN80] },
      { id: '9001', name: 'قودي تونة تندرينا 4 حبات 80 جرام', price: 16, barcodes: [FOUR] },
    ],
    // Tamimi files the 80 g tin as a pack size of its 185 g product.
    tamimi: [{
      id: '14', name: 'تونة تندرينا ناعمة', size: '185 غرام', price: 9.5, barcodes: ['628101462021'],
      variants: [
        { id: 27, size: '185 غرام', price: 9.5, barcodes: ['628101462021'], inStock: true },
        { id: 28, size: '80 غرام', price: 4.25, barcodes: [TIN80], inStock: true },
      ],
    }],
    panda: [{ id: '21028', name: 'تونة مختلفة الاسم 80 جم', price: 3.66, barcodes: [TIN80], inStock: false }],
    ninja: [{ id: '1-9', name: 'قودي تونة تندرينا 80 جرام عبوة من 4', price: 17.2, barcodes: [FOUR] }],
  }, fourPacks);
  const line = (await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 })).lines[0];
  const view = await watchListingsView(s.ctx, await s.get());
  const find = (store, id) => view.listings.find((l) => l.store === store && l.listingId === id);
  eq([find('tamimi', '14~v28')?.verdict, find('tamimi', '14~v28')?.verdictBy], ['match', 'barcode'],
    'the Tamimi 80 g pack size matches by its barcode, not its 185 g title');
  eq(find('tamimi', '14')?.verdict, 'reject', 'the 185 g pack size of the same product is rejected');
  eq([find('panda', '21028')?.verdict, find('panda', '21028')?.inStock], ['match', false],
    'a barcode twin under another title matches, and its stock is kept');
  eq(find('danube', '9001')?.pack, 4, '"4 حبات" is believed when a same-barcode twin states "عبوة من 4"');
  eq(line.price, 4, 'the best value is the Danube 4-pack at 4.00 a tin — never the out-of-stock 3.66');
  ok(line.alerted, 'and it alerts');

  // Tamimi answers with a blank page: asked again, still blank, it proves
  // nothing — its listing is not counted missing.
  s.m.catalog.tamimi = [];
  s.m.calls.length = 0;
  await checkValueWatch(s.ctx, await s.get(), { roundKey: 'blank-1', now: at(12) });
  const after = await watchListingsView(s.ctx, await s.get());
  eq(s.m.calls.filter((c) => c.store === 'tamimi').length, after.reference.queries.length + 1,
    'every query empty is asked once more');
  eq(after.listings.find((l) => l.listingId === '14~v28')?.missingRounds, 0, 'a blank answer is not a missing round');
  eq(JSON.parse((await s.get()).indexJson).stores.tamimi, 'partial', 'the store is recorded as not fully answering');
}

// --- 8. What the text proves, the judge cannot overrule ------------------------------

{
  const LONG = '628100703226';
  const yesToAll = () => ({ same: 'yes', items: 1, why: 'looks the same' });
  const s = await setup({
    provider: 'danube', productId: '1180', query: 'حليب المراعي',
    label: 'المراعي حليب طازج كامل الدسم 1لتر', targetPrice: 8,
    listing: { id: '1180', provider: 'danube', name: 'المراعي حليب طازج كامل الدسم 1لتر', brand: 'المراعي', size: '1 لتر' },
  }, {
    danube: [
      { id: '1180', name: 'المراعي حليب طازج كامل الدسم 1لتر', brand: 'المراعي', size: '1 لتر', price: 7 },
      { id: '13230', name: 'المراعي حليب طويل الاجل كامل الدسم غني و كريمي 1لتر', brand: 'المراعي', size: '1 لتر', price: 6, barcodes: [LONG] },
    ],
    panda: [
      { id: '22785', name: 'المراعي حليب كامل الدسم 1 لتر', brand: 'المراعي', size: '1 لتر', price: 6.5, barcodes: [LONG] },
      { id: '16445', name: 'المراعي لبن كامل الدسم 1 لتر', brand: 'المراعي', size: '1 لتر', price: 6.25 },
      { id: '16447', name: 'المراعي حليب طازج كامل الدسم 1 لتر', brand: 'المراعي', size: '1 لتر', price: 6.95 },
    ],
    ninja: [{ id: '1-19305907', name: 'الصافي حليب طازج كامل الدسم 1 لتر', brand: 'ALSAFI', price: 5.5 }],
  }, yesToAll);
  const line = (await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 })).lines[0];
  const view = await watchListingsView(s.ctx, await s.get());
  const find = (store, id) => view.listings.find((l) => l.store === store && l.listingId === id);
  eq([find('danube', '13230')?.verdict, find('danube', '13230')?.verdictBy], ['reject', 'conflict'], 'long-life is not fresh');
  eq(find('panda', '22785')?.verdict, 'reject', 'nor is its same-barcode twin whose title does not say long-life');
  ok(/same barcode/.test(find('panda', '22785')?.reason || ''), '… and the reason says why');
  eq(find('panda', '16445')?.verdict, 'reject', 'laban is not milk');
  eq(find('ninja', '1-19305907')?.verdict, 'reject', 'Al Safi is not Almarai, whatever the judge says');
  eq(find('panda', '16447')?.verdict, 'match', 'the same fresh milk at Panda matches');
  eq(line.price, 6.95, 'the deal is Panda 6.95 — never the long-life 6.00 or the Al Safi 5.50');
}

// --- 9. One judgement per product, every pack size priced -------------------------

{
  const variant = (id, size, price) => ({ id, size, price, inStock: true, barcodes: [] });
  const s = await setup({
    provider: 'panda', productId: '43460', query: 'بيبسي',
    label: 'بيبسي علب 18*330مل', targetPrice: 52,
    listing: { id: '43460', provider: 'panda', name: 'بيبسي علب 18*330مل', brand: 'بيبسي', size: '330 مل' },
  }, {
    panda: [{ id: '43460', name: 'بيبسي علب 18*330مل', brand: 'بيبسي', size: '330 مل', price: 55.5 }],
    // Tamimi's regular can: titled just "علبة", sized "330-355 مل".
    tamimi: [{
      id: 152693, name: 'علبة', brand: 'بيبسي', size: '24 x 330-355 مل', price: 72,
      variants: [
        variant(237035, '24 x 330-355 مل', 72), variant(237039, '18 x 330-355 مل', 50.4),
        variant(237036, '12 x 330-355 مل', 36), variant(237037, '330-355 مل', 3),
      ],
    }],
  }, () => ({ same: 'yes', items: null, why: 'regular can' }));
  const line = (await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 })).lines[0];
  const view = await watchListingsView(s.ctx, await s.get());
  const tamimi = view.listings.filter((l) => l.store === 'tamimi');
  eq(s.judgeCalls, [1, 1], 'the four Tamimi pack sizes are one product, asked twice (two votes)');
  ok(tamimi.length === 4 && tamimi.every((l) => l.verdict === 'match'), 'and every pack size is matched');
  eq(tamimi.find((l) => l.listingId === '152693~v237039')?.pack, 18, '"18 x 330-355 مل" is eighteen cans');
  eq(line.price, 2.8, 'the deal is Tamimi 50.40 for 18 — 2.80 a can, under the 2.89 target');
}

// --- 10. Two votes: a match needs both ---------------------------------------------

{
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', targetPrice: 5,
  }, {
    danube: [{ id: '2674', name: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', price: 5.99 }],
    panda: [
      { id: '21028', name: 'تندرينا تونة قطع خفيفة في زيت دوار الشمس 80 جم', price: 3.66 },
      { id: '28017', name: 'قودي تونة تندرينا بالليمون والفلفل الأسود، 80غ', price: 3.2 },
    ],
  }, null);
  let call = 0;
  s.ctx.watchJudge = async (reference, candidates) => {
    call += 1;
    return { reference: null, results: candidates.map(() => (call === 1 ? { same: 'yes', why: 'same tuna' } : { same: 'unsure', why: 'no line named' })) };
  };
  const line = (await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 })).lines[0];
  const view = await watchListingsView(s.ctx, await s.get());
  const row = view.listings.find((l) => l.listingId === '21028');
  eq(call, 2, 'the product is asked twice');
  eq([row.verdict, row.verdictBy], ['pending', 'ai'], 'a yes and an unsure make an unsure, kept as the answer');
  ok(/disagree/.test(row.reason || ''), '… saying the checks disagree');
  eq(view.listings.find((l) => l.listingId === '28017')?.verdictBy, 'conflict', 'the lemon-pepper tin never reaches the judge');
  ok(!line.alerted, 'nothing alerts on one yes');
  await checkValueWatch(s.ctx, await s.get(), { roundKey: 'two-votes-r2', now: at(12) });
  eq(call, 2, 'and the unsure is not asked again');
}

// --- 11. An assortment price is unsure, even after a "yes" ---------------------------

{
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', targetPrice: 5,
  }, {
    danube: [{ id: '2674', name: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', price: 5.99 }],
    tamimi: [{ id: 'g1', name: 'تونة قودي، أصناف متنوعة، 80 - 95 غرام', price: 8.5 }],
  }, () => ({ same: 'yes', why: 'Goody tuna' }));
  // The listing as an earlier engine left it: judged a match.
  await s.ctx.watchListingStore.upsertMany(s.watch.id, [{
    store: 'tamimi', listingId: 'g1', source: 'online', name: 'تونة قودي، أصناف متنوعة، 80 - 95 غرام',
    nameKey: normalizeText('تونة قودي، أصناف متنوعة، 80 - 95 غرام'), verdict: 'match', verdictBy: 'ai', item: { value: 80, unit: 'g' },
    pack: 2, sizeVerified: true, firstSeenAt: t0.toISOString(), lastSeenAt: t0.toISOString(), missingRounds: 0,
  }]);
  const line = (await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 })).lines[0];
  const row = (await watchListingsView(s.ctx, await s.get())).listings.find((l) => l.listingId === 'g1');
  eq([row.verdict, row.verdictBy], ['pending', 'assortment'], 'an assortment is unsure, overriding the earlier "yes"');
  eq(s.judgeCalls.length, 0, 'and never reaches the judge');
  ok(!line.alerted, 'so its 4.25 a tin never alerts');
}

// --- 12. A store that refuses the connector (Lulu, 2026-11-03) ----------------------
// Lulu's firewall answers every Worker request with 403. That is "blocked", not
// "did not answer": asked once per round (it comes back by itself), never
// retried inside the round, never holding a round back.

{
  const catalog = tendrinaCatalog();
  catalog.lulu = Object.assign(new Error('search lulu -> blocked by the store (HTTP 403)'), { blocked: true });
  catalog.ninja = new Error('search ninja -> HTTP 502');
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', targetPrice: 6,
  }, catalog, sameLine);
  const line = await checkValueWatch(s.ctx, await s.get(), { roundKey: 'blocked-am', now: t0 });
  ok(line.alerted, 'a blocked store does not hold the round back');
  eq(s.m.calls.filter((c) => c.store === 'lulu').length, 1, 'the blocked store is asked once, not once per search phrase');
  const index = JSON.parse((await s.get()).indexJson);
  eq([index.stores.lulu, index.stores.ninja], ['blocked', 'failed'], 'blocked and failed are told apart');
  const summary = valueWatchSummary(await s.get());
  eq([summary.storesBlocked, summary.storesFailed], [['lulu'], ['ninja']], 'the watch list says which is which');
  const matched = index.counts.matched;
  ok(matched >= 2, 'the index holds the verified listings');

  // Ninja comes back: the retry inside the round asks only Ninja, and the
  // counts still describe the whole index, not the retry.
  s.m.catalog.ninja = [];
  s.m.calls.length = 0;
  await checkValueWatch(s.ctx, await s.get(), { roundKey: 'blocked-am', now: t0 });
  const retried = new Set(s.m.calls.map((c) => c.store));
  ok(retried.has('ninja') && !retried.has('lulu'), 'the retry re-asks the failed store, never the blocked one');
  ok(!retried.has('danube') && !retried.has('panda'), 'nor the stores that answered');
  eq(JSON.parse((await s.get()).indexJson).counts.matched, matched, 'a retry keeps the counts of the whole index');

  // The next round asks Lulu again, so it returns the day Lulu lets us in.
  s.m.catalog.lulu = [{ id: 'l1', name: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', price: 5.5 }];
  await checkValueWatch(s.ctx, await s.get(), { roundKey: 'blocked-pm', now: at(12) });
  eq(JSON.parse((await s.get()).indexJson).stores.lulu, 'ok', 'a store that lets us back in is tracked again');
}

// --- 13. "Check with my browser": Lulu and Carrefour read in the owner's Chrome ---------
// The owner's browser reads a store the connector cannot (Lulu's firewall;
// Carrefour has no connector) and posts the listings. They are untrusted: the
// same rules and judge decide identity, a price stands for 12 hours, and the
// alert follows the same one-deal-one-alert machine.

{
  const catalog = tendrinaCatalog();
  catalog.lulu = Object.assign(new Error('search lulu -> blocked by the store (HTTP 403)'), { blocked: true });
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', targetPrice: 3.5,
  }, catalog, sameLine);
  const first = (await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 })).lines[0];
  ok(!first.alerted && first.price === 3.66, 'online the best is Panda 3.66, above the 3.50 target');

  const TIN = 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام';
  const luluTin = (price) => ({
    id: '807168', name: TIN, nameEn: 'Goody Tenderina Tuna Light Chunks in Sunflower Oil 80 g', size: '80 g',
    price: String(price), barcodes: ['6281014800471', 'nonsense'], inStock: true,
    link: 'https://gcc.luluhypermarket.com/ar-sa/goody-tenderina-80-g/p/807168/', image: 'https://cdn.example/1.jpg',
  });
  const run = async (listings, when, { store = 'lulu', complete = true } = {}) => {
    const supplied = readObservation({ store, complete, listings });
    assert.equal(supplied.error, undefined, supplied.error);
    return checkValueWatch(s.ctx, await s.get(), { mode: 'observe', supplied, acceptPartialSweep: true, now: when });
  };

  // The checked listings: the tin at 3.25, the 185 g tin far cheaper (a size
  // the watch is not), and rows the reader must drop.
  const supplied = readObservation({
    store: 'lulu',
    complete: true,
    listings: [
      luluTin(3.25),
      { id: '807170', name: 'تندرينا تونة ناعمة 185 جم', price: 2, link: 'https://evil.example/p' },
      { id: 'bad id', name: TIN, price: 1 },
      { id: 'p3', name: TIN, price: -4 },
      { id: 'p4', name: TIN, price: 3, currency: 'USD' },
      luluTin(3.25),
    ],
  });
  eq([supplied.listings.length, supplied.dropped], [2, 4], 'malformed, foreign-currency and duplicate rows are dropped');
  eq(supplied.listings[0].barcodes, ['628101480047'], 'barcodes are keyed like the connector (12-digit body), nonsense dropped');
  eq(supplied.listings[1].link, null, 'a link to another host is dropped');
  ok(readObservation({ store: 'amazon', listings: [] }).error.includes('lulu'), 'only Lulu and Carrefour are accepted');

  const line = await checkValueWatch(s.ctx, await s.get(), { mode: 'observe', supplied, acceptPartialSweep: true, now: at(1) });
  ok(line.alerted && line.alertType === 'target', 'the browser finding Lulu at 3.25 alerts');
  eq(line.price, 3.25, 'at the per-item value');
  eq([line.observed.store, line.observed.matched, line.observed.rejected], ['lulu', 1, 1], 'the check reports what it verified');
  eq(line.observed.matches[0].value, 3.25, '… cheapest first');
  const alerts = await s.ctx.watchStore.listAlerts({ profileId: 'profile-value-1' });
  eq([alerts[0].store, alerts[0].source], ['lulu', 'browser'], 'the alert says where the price came from');
  const view = await watchListingsView(s.ctx, await s.get());
  eq(view.listings.find((l) => l.listingId === '807170').verdict, 'reject',
    'the 185 g tin at 2.00 is rejected on size, whatever the checker says');
  const summary = valueWatchSummary(await s.get());
  eq(summary.storesBlocked, ['lulu'], 'the connector is still blocked: the browser check is reported apart');
  eq([summary.browser.lulu.matched, summary.browser.lulu.state], [1, 'ok'], 'the watch list carries the browser check');
  ok(!Object.keys(JSON.parse((await s.get()).indexJson).stores).some((k) => k.startsWith('browser')),
    'no browser key leaks into the store states');

  const again = await run([luluTin(3.25)], at(1.5));
  ok(!again.alerted, 'the same deal checked again is not alerted again');
  const judged = s.judgeCalls.length;
  await run([luluTin(3.25)], at(2));
  eq(s.judgeCalls.length, judged, 'verdicts are kept: a re-check judges nothing new');

  // A round 3 hours later: the browser's price still stands.
  const round = await checkValueWatch(s.ctx, await s.get(), { roundKey: 'browser-r1', now: at(4) });
  ok(!round.alerted && round.price === 3.25 && (await s.get()).isBelow, 'a round within 12 hours keeps the browser price');
  // 15 hours after the last check, nobody re-checked: the price is no longer known.
  const late = await checkValueWatch(s.ctx, await s.get(), { roundKey: 'browser-r2', now: at(17) });
  ok(!late.alerted && late.price === 3.66, 'after 12 hours the browser price no longer counts');
  ok(!(await s.get()).isBelow, '… and no longer holds the deal open');
  const back = await run([luluTin(3.25)], at(18));
  ok(!back.alerted && (await s.get()).isBelow, 'the same deal found again unchanged is not news');
  const lower = await run([luluTin(2.9)], at(19));
  eq([lower.alerted, lower.alertType], [true, 'lower'], 'a real drop on a re-check alerts as lower');

  // A complete check that no longer lists the tin: once is unknown, twice gone.
  const miss1 = await run([], at(20));
  ok(!miss1.alerted && (await s.get()).isBelow, 'one complete check without the tin cannot end the deal');
  eq(miss1.price, 3.66, '… but its price no longer counts');
  await run([], at(20.5), { complete: false });
  ok((await s.get()).isBelow, 'an incomplete check counts nothing missing');
  await run([], at(21));
  ok(!(await s.get()).isBelow, 'two complete checks without it end the deal');

  // Carrefour: a store with no connector at all.
  const carrefour = await run([{
    id: '126318', name: 'قودي تونا تندرينا 80 جرام', nameEn: 'goody Tenderina Tuna 80g', price: 3.4,
    inStock: true, link: 'https://www.carrefourksa.com/mafsau/ar/tuna/goody-tenderina-tuna-80g/p/126318',
  }], at(22), { store: 'carrefour' });
  eq(carrefour.observed.store, 'carrefour', 'Carrefour is checked the same way');
  const both = valueWatchSummary(await s.get()).browser;
  ok(both.lulu.at && both.carrefour.at, 'each store keeps its own last check');
}

// --- 14. The browser-check HTTP surface ------------------------------------------------

{
  const BASE = 'https://engine.test';
  const P = 'profile-value-1';
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة',
    label: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', targetPrice: 3.5,
  }, tendrinaCatalog(), sameLine);
  await indexDueWatches(s.ctx, { ids: [s.watch.id], now: new Date() });
  const call = (method, path, body) => handleRequest(new Request(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  }), s.ctx);
  const plan = await (await call('GET', `/watches/observe?profile=${P}`)).json();
  eq(plan.stores, ['lulu', 'carrefour'], 'GET /watches/observe names the stores a browser may check');
  const entry = plan.watches.find((w) => w.id === s.watch.id);
  ok(entry && entry.queries.length >= 1 && entry.item?.value === 80, '… and each watch with its search wording and size');
  eq((await call('GET', '/watches/observe')).status, 400, 'the plan needs a profile');
  const path = `/watches/observe?profile=${P}&id=${s.watch.id}`;
  eq((await call('POST', `/watches/observe?profile=other&id=${s.watch.id}`, { store: 'lulu', listings: [] })).status, 404,
    'another profile cannot post to the watch');
  eq((await call('POST', path, 'not json')).status, 400, 'a body that is not JSON is refused');
  eq((await call('POST', path, { store: 'othaim', listings: [] })).status, 400, 'an unknown store is refused');
  eq((await call('POST', path, { store: 'lulu', listings: new Array(301).fill({}) })).status, 400, 'at most 300 listings');
  const res = await call('POST', path, {
    store: 'lulu', complete: true,
    listings: [{ id: '807168', name: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام', price: 3.2, size: '80 g' }],
  });
  eq(res.status, 200, 'POST /watches/observe runs the check');
  const out = await res.json();
  eq([out.store, out.kept, out.alerted, out.price], ['lulu', 1, true, 3.2], '… and answers with the outcome');
  ok(out.value?.browser?.lulu?.matched === 1, '… with the watch summary');

  // The hand-off window a Lulu tab opens (Lulu's page policy blocks posting).
  const relay = await call('GET', '/watches/observe/relay');
  eq([relay.status, relay.headers.get('content-type')], [200, 'text/html; charset=utf-8'], 'the hand-off page is served');
  const html = await relay.text();
  ok(html.includes('https://gcc.luluhypermarket.com') && html.includes('lsa-relay-reply'),
    '… answering only the store tabs');
  ok(html.includes(String.raw`/^\/watches\/observe\?[\w=&%.~-]*$/`), '… and forwarding only the observe calls');
}

// --- 15. "N to confirm" is the owner's questions; the checker's backlog drains ---------
// 2026-11-03: the Uno watch read "137 to confirm" when 144 listings were only
// waiting for the checker (its first pass judged its 60, rounds judge 20).

{
  const TIN = 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام';
  const others = (from, n) => Array.from({ length: n }, (_, i) => ({
    id: `x${from + i}`, name: `تندرينا تونة قطع خفيفة رقم ${from + i} 80 جم`, price: 4 + i / 100,
  }));
  const s = await setup({
    provider: 'danube', productId: '2674', query: 'تندرينا تونة', label: TIN, targetPrice: 3,
  }, {
    danube: [{ id: '2674', name: TIN, price: 5.99 }],
    // A store answers at most 50 per query (VALUE_SEARCH_LIMIT): 70 over two.
    panda: others(0, 35),
    tamimi: others(35, 35),
  }, (listing) => (/رقم 7\b/.test(listing.name) ? { same: 'unsure', why: 'cannot tell' } : { same: 'no', why: 'another line' }));

  await indexDueWatches(s.ctx, { ids: [s.watch.id], now: t0 });
  let w = await s.get();
  let summary = valueWatchSummary(w);
  eq([summary.unsure, summary.waiting], [1, 10], 'the first pass: 1 question for the owner, 10 not judged yet (budget 60)');
  eq(summary.pending, 11, 'pending still counts both, for older readers');
  eq(w.indexDueAt, new Date(t0.getTime() + 5 * 60 * 1000).toISOString(), 'a backlog brings the next pass in 5 minutes, not a week');

  await indexDueWatches(s.ctx, { ids: [s.watch.id], now: at(0.1) });
  w = await s.get();
  summary = valueWatchSummary(w);
  eq([summary.unsure, summary.waiting], [1, 0], 'the second pass judges the rest');
  eq(w.indexDueAt, new Date(at(0.1).getTime() + 7 * 24 * 3600 * 1000).toISOString(), 'no backlog: the weekly refresh again');
  eq(JSON.parse(w.indexJson).backlogPasses, 0, 'and the pass counter resets');

  // A round that meets more new listings than its 20 pulls the index pass forward.
  s.m.catalog.panda = [...others(0, 35), ...others(100, 15)];
  s.m.catalog.tamimi = [...others(35, 35), ...others(115, 15)];
  await checkValueWatch(s.ctx, await s.get(), { roundKey: 'backlog-r1', now: at(1) });
  w = await s.get();
  eq(w.indexDueAt, new Date(at(1).getTime() + 5 * 60 * 1000).toISOString(), 'a round with a backlog brings the index pass forward');
  eq(valueWatchSummary(w).waiting, 10, '… 20 of the 30 new judged in the round, 10 left');

  // Never a loop: the pass counter stops at 8 in a row …
  await s.ctx.watchStore.updateValueState(s.watch.id, { indexJson: JSON.stringify({ ...JSON.parse(w.indexJson), backlogPasses: 7 }) });
  s.m.catalog.panda = others(200, 50);
  s.m.catalog.tamimi = others(250, 50);
  await indexDueWatches(s.ctx, { ids: [s.watch.id], now: at(2) });
  w = await s.get();
  eq(JSON.parse(w.indexJson).backlogPasses, 8, 'the eighth pass in a row …');
  eq(w.indexDueAt, new Date(at(2).getTime() + 7 * 24 * 3600 * 1000).toISOString(), '… is the last: back to weekly');

  // … and a checker that fails makes no backlog pass at all.
  s.ctx.watchJudge = async () => { throw new Error('checker down'); };
  s.m.catalog.panda = others(300, 50);
  await indexDueWatches(s.ctx, { ids: [s.watch.id], now: at(3) });
  w = await s.get();
  eq(w.indexDueAt, new Date(at(3).getTime() + 7 * 24 * 3600 * 1000).toISOString(), 'a failing checker does not bring passes forward');

  // A listing the search stopped returning is judged only if it comes back:
  // gone, it is not "waiting to be checked".
  await indexDueWatches(s.ctx, { ids: [s.watch.id], now: at(4) });
  const rows = await s.ctx.watchListingStore.list(s.watch.id);
  const unjudged = rows.filter((r) => r.verdict === 'pending' && !r.verdictBy);
  const gone = unjudged.filter((r) => r.missingRounds >= 2);
  ok(gone.length > 0, 'some unjudged listings are gone from the search');
  eq(valueWatchSummary(await s.get()).waiting, unjudged.length - gone.length, 'and only the ones still returned count as waiting');
}

console.log(`watchIndex.test: ${passed} passed, 0 failed`);
