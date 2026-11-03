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
import { checkValueWatch, indexDueWatches, watchListingsView } from './watchIndex.js';
import { normalizeText } from './matching.js';

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

console.log(`watchIndex.test: ${passed} passed, 0 failed`);
