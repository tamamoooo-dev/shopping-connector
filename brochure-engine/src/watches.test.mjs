// watches.test.mjs — offline, dependency-free tests for PROFILE-SCOPED Price
// Monitoring (Local Profile milestone). Run with:
//   node brochure-engine/src/watches.test.mjs   (repo root)
//
// Guards the milestone's promises, end-to-end through handleRequest over the
// in-memory WatchStore twin (identical semantics to the D1 impl):
//  • every user-facing route requires a profile; validation rejects without it,
//  • different profiles NEVER see (or delete) each other's watches or alerts,
//  • the MAX_WATCHES cap applies per profile; MAX_WATCHES_TOTAL is the global
//    cron-budget backstop,
//  • pre-profile (NULL-profile) watches are claimed by the first profile to
//    list — once, idempotently,
//  • the cron's unscoped list({activeOnly}) still sees every profile's watches.

import { handleRequest } from './engine.js';
import { buildWatch, MAX_WATCHES, MAX_WATCHES_TOTAL } from './monitor.js';
import { createMemoryWatchStore } from './storage/local.js';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } };

const BASE = 'https://engine.test';
const A = 'profile-aaaa-1111';
const B = 'profile-bbbb-2222';

const get = (ctx, path) => handleRequest(new Request(`${BASE}${path}`), ctx);
const post = (ctx, path, body) =>
  handleRequest(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    ctx,
  );
const del = (ctx, path) => handleRequest(new Request(`${BASE}${path}`, { method: 'DELETE' }), ctx);
const watchBody = (profileId, query, targetPrice = 10) => ({ kind: 'grocery', query, targetPrice, profileId });

// --- buildWatch validation ---
ok('buildWatch rejects a missing profileId', !!buildWatch({ kind: 'grocery', query: 'milk', targetPrice: 5 }).error);
ok('buildWatch rejects a too-short profileId', !!buildWatch({ ...watchBody('short', 'milk') }).error);
{
  const { watch, error } = buildWatch(watchBody(A, 'milk'));
  ok('buildWatch accepts a valid profileId', !error && watch && watch.profileId === A);
}

// --- isolation: list / create / delete ---
{
  const ctx = { watchStore: createMemoryWatchStore() };

  ok('GET /watches without profile -> 400', (await get(ctx, '/watches')).status === 400);
  ok('POST /watches without profileId -> 400',
    (await post(ctx, '/watches', { kind: 'grocery', query: 'milk', targetPrice: 5 })).status === 400);
  ok('GET /alerts without profile -> 400', (await get(ctx, '/alerts')).status === 400);
  ok('POST /alerts/seen without profile -> 400', (await post(ctx, '/alerts/seen', {})).status === 400);
  ok('DELETE /watches without profile -> 400', (await del(ctx, '/watches?id=w_x')).status === 400);

  const a1 = await (await post(ctx, '/watches', watchBody(A, 'milk'))).json();
  const a2 = await (await post(ctx, '/watches', watchBody(A, 'eggs'))).json();
  const b1 = await (await post(ctx, '/watches', watchBody(B, 'water'))).json();
  ok('creates return the watch', a1.watch && a2.watch && b1.watch);

  const listA = await (await get(ctx, `/watches?profile=${A}`)).json();
  const listB = await (await get(ctx, `/watches?profile=${B}`)).json();
  ok('A sees exactly its 2 watches', listA.count === 2 && listA.watches.length === 2);
  ok('B sees exactly its 1 watch', listB.count === 1 && listB.watches[0].query === 'water');
  ok('no watch appears in both lists',
    !listA.watches.some((w) => listB.watches.some((v) => v.id === w.id)));

  // Cross-profile delete must be a 404 no-op.
  const cross = await del(ctx, `/watches?id=${b1.watch.id}&profile=${A}`);
  ok("A cannot delete B's watch (404)", cross.status === 404);
  ok("B's watch survives the attempt",
    (await (await get(ctx, `/watches?profile=${B}`)).json()).count === 1);
  const own = await del(ctx, `/watches?id=${b1.watch.id}&profile=${B}`);
  ok('B deletes its own watch', own.status === 200);
  ok("B's list is empty after", (await (await get(ctx, `/watches?profile=${B}`)).json()).count === 0);

  // The cron's view stays global (unscoped list).
  ok('cron list({activeOnly}) sees all profiles',
    (await ctx.watchStore.list({ activeOnly: true })).length === 2);
}

// --- alerts isolation ---
{
  const ctx = { watchStore: createMemoryWatchStore() };
  const wa = (await (await post(ctx, '/watches', watchBody(A, 'milk'))).json()).watch;
  const wb = (await (await post(ctx, '/watches', watchBody(B, 'water'))).json()).watch;
  await ctx.watchStore.insertAlert({ id: 'al_a', watchId: wa.id, price: 4, targetPrice: 5, observedAt: '2026-07-17T00:00:00Z' });
  await ctx.watchStore.insertAlert({ id: 'al_b', watchId: wb.id, price: 1, targetPrice: 2, observedAt: '2026-07-17T00:00:01Z' });

  const alertsA = await (await get(ctx, `/alerts?profile=${A}`)).json();
  const alertsB = await (await get(ctx, `/alerts?profile=${B}`)).json();
  ok('A sees only its alert', alertsA.count === 1 && alertsA.alerts[0].id === 'al_a');
  ok('B sees only its alert', alertsB.count === 1 && alertsB.alerts[0].id === 'al_b');
  ok('unseen counts are per profile', alertsA.unseen === 1 && alertsB.unseen === 1);
  ok('badge count on GET /watches is per profile',
    (await (await get(ctx, `/watches?profile=${A}`)).json()).unseenAlerts === 1);

  const marked = await (await post(ctx, `/alerts/seen?profile=${A}`, {})).json();
  ok('seen marks only the profile’s alerts', marked.marked === 1);
  ok('A has 0 unseen after', (await (await get(ctx, `/alerts?profile=${A}`)).json()).unseen === 0);
  ok("B's alert stays unseen", (await (await get(ctx, `/alerts?profile=${B}`)).json()).unseen === 1);
}

// --- caps: per profile, plus the global backstop ---
{
  const ctx = { watchStore: createMemoryWatchStore() };
  for (let i = 0; i < MAX_WATCHES; i++) {
    await post(ctx, '/watches', watchBody(A, `item ${i}`));
  }
  ok(`A is capped at MAX_WATCHES (${MAX_WATCHES})`,
    (await post(ctx, '/watches', watchBody(A, 'one too many'))).status === 409);
  ok('B still creates freely under its own cap',
    (await post(ctx, '/watches', watchBody(B, 'water'))).status === 201);

  // Fill to the global backstop with more profiles, then verify capacity 409.
  let created = MAX_WATCHES + 1;
  let p = 0;
  while (created < MAX_WATCHES_TOTAL) {
    const pid = `filler-profile-${String(p).padStart(4, '0')}`;
    for (let i = 0; i < MAX_WATCHES && created < MAX_WATCHES_TOTAL; i++, created++) {
      await post(ctx, '/watches', watchBody(pid, `bulk ${created}`));
    }
    p += 1;
  }
  ok('store sits at the global backstop', (await ctx.watchStore.countActiveTotal()) === MAX_WATCHES_TOTAL);
  const overflow = await post(ctx, '/watches', watchBody('fresh-profile-zzzz', 'anything'));
  ok('global backstop refuses with 409 capacity', overflow.status === 409);
}

// --- legacy adoption (pre-profile watches) ---
{
  const ctx = { watchStore: createMemoryWatchStore() };
  // Two rows as they exist in production today: no profile.
  await ctx.watchStore.create({ id: 'w_legacy1', kind: 'grocery', query: 'milk', targetPrice: 5, active: true, createdAt: '2026-07-01T00:00:00Z' });
  await ctx.watchStore.create({ id: 'w_legacy2', kind: 'grocery', query: 'eggs', targetPrice: 9, active: true, createdAt: '2026-07-02T00:00:00Z' });

  const firstList = await (await get(ctx, `/watches?profile=${A}`)).json();
  ok('first profile to list adopts the legacy watches', firstList.count === 2);
  ok('adopted watches carry the profile', firstList.watches.every((w) => w.profileId === A));
  ok('a later profile inherits nothing',
    (await (await get(ctx, `/watches?profile=${B}`)).json()).count === 0);
  ok('adoption is one-time (A keeps 2 on re-list)',
    (await (await get(ctx, `/watches?profile=${A}`)).json()).count === 2);
}

// --- registry product watches (REGISTRY-DESIGN §7) ---
{
  const { checkWatch } = await import('./monitor.js');
  const { createMemRegistryStore } = await import('./registry/memstore.js');

  ok('buildWatch rejects a registry watch without a pr_ id',
    !!buildWatch({ kind: 'registry', query: 'halah oil', targetPrice: 20, profileId: A }).error &&
    !!buildWatch({ kind: 'registry', query: 'halah oil', targetPrice: 20, profileId: A, productId: 'asin123' }).error);
  const { watch, error } = buildWatch({
    kind: 'registry', query: 'halah oil', label: 'Halah Sunflower Oil', targetPrice: 20,
    profileId: A, productId: 'pr_abc123',
  });
  ok('buildWatch accepts a registry watch (no provider needed)',
    !error && watch.kind === 'registry' && watch.productId === 'pr_abc123' && watch.provider === null);

  // Evaluation: sighting precision over CURRENT offers, tombstones followed.
  const registryStore = createMemRegistryStore({
    offers: [
      { id: 'o:cur', store: 'lulu', region: 'riyadh', price: 18.5, currency: 'SAR', valid_to: '2099-01-01', source_url: 'http://f/1' },
      { id: 'o:old', store: 'othaim', region: 'riyadh', price: 15.0, currency: 'SAR', valid_to: '2000-01-01', source_url: 'http://f/2' },
    ],
  });
  await registryStore.createProduct(
    { id: 'pr_live', status: 'active', merged_into: null, kind: 'product', display_name: 'Halah Sunflower Oil 1.5L', display_name_ar: null, token_profile: '{}', sightings: 2, stores_seen: '[]', first_seen: '2026-07-01', last_seen: '2026-07-15', review_flag: null, algo_version: 1 },
    [],
  );
  await registryStore.createProduct(
    { id: 'pr_abc123', status: 'merged', merged_into: 'pr_live', kind: 'product', token_profile: '{}', sightings: 0, stores_seen: '[]', first_seen: '2026-07-01', last_seen: '2026-07-01', review_flag: null, algo_version: 1 },
    [],
  );
  await registryStore.insertSighting({ offer_id: 'o:cur', product_id: 'pr_live', match_band: 'auto', store: 'lulu', region: 'riyadh', week: '2026-07-15', price: 18.5 });
  await registryStore.insertSighting({ offer_id: 'o:old', product_id: 'pr_live', match_band: 'auto', store: 'othaim', region: 'riyadh', week: '2026-06-01', price: 15.0 });

  const ctx = { watchStore: createMemoryWatchStore(), registryStore };
  await ctx.watchStore.create(watch);
  const line = await checkWatch(ctx, watch);
  ok('registry watch: expired offers never count; cheapest CURRENT sighting wins',
    line.price === 18.5 && line.status === 'below-target');
  ok('registry watch: tombstone followed, alert carries the display name + flyer source',
    line.alerted === true &&
    (await ctx.watchStore.listAlerts({ limit: 5 })).some(
      (a) => a.name === 'Halah Sunflower Oil 1.5L' && a.source === 'flyer' && a.store === 'lulu',
    ));

  // No current sighting -> silence (no-data), never a stale alert.
  const { watch: ghost } = buildWatch({
    kind: 'registry', query: 'gone thing', targetPrice: 99, profileId: A, productId: 'pr_ghost',
  });
  await ctx.watchStore.create(ghost);
  const gLine = await checkWatch(ctx, ghost);
  ok('registry watch on an unknown product stays silent', gLine.status === 'no-data' && !gLine.alerted);
}

// --- grocery watches see VISION names (vision-canonical, 2026-07-21) ---
// A debris offer OCR can't name (or match) alerts through its servable vision
// read — the same applyEnrichment gate Search serves with.
{
  const { checkWatch } = await import('./monitor.js');
  const { createMemoryOfferStore, createMemoryEnrichStore } = await import('./storage/local.js');
  let offerStoreRef;
  const enrichStore = createMemoryEnrichStore({ listOffers: async () => offerStoreRef.listAll() });
  offerStoreRef = createMemoryOfferStore({ enrichStore });
  await offerStoreRef.upsertMany([{
    id: 'lulu:riyadh:d4d:v1', store: 'lulu', region: 'riyadh', source: 'd4d',
    offer_id: 'v1', flyer_ref: null, page_ref: null, edition: null,
    name: null, name_ar: null, price: 8.5, old_price: null, currency: 'SAR',
    category_id: null, category: null, image_url: 'http://c/i.jpg',
    source_url: 'http://f/v1', valid_from: null, valid_to: '2099-01-01',
    detected_at: 'now', search_text: 'tanzanian mutton smear zz', identity: null, brand_slug: null,
  }]);
  await enrichStore.upsertMany([{
    id: 'lulu:riyadh:d4d:v1', name: 'Tanzanian Mutton', name_ar: null,
    brand: null, size: null, confidence: 0.9, corroboration: 0.8,
    model: 'test', crop_url: null, enriched_at: 'now',
  }]);
  const ctx = { watchStore: createMemoryWatchStore(), offerStore: offerStoreRef, searchClient: null };
  const { watch } = buildWatch(watchBody(A, 'tanzanian mutton', 10));
  await ctx.watchStore.create(watch);
  const line = await checkWatch(ctx, watch);
  ok('grocery watch matches via the vision read and alerts', line.alerted === true && line.price === 8.5);
  ok('alert carries the VISION name',
    (await ctx.watchStore.listAlerts({ limit: 5 })).some((a) => a.name === 'Tanzanian Mutton'));
}

console.log(`\nwatches.test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
