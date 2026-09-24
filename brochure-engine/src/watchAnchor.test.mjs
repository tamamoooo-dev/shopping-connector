// watchAnchor.test.mjs — the product-anchored Watch subsystem (Stage 4).
//
// What must hold:
//   1. a resolved watch reads a price through the shared resolver, never text;
//   2. EVERY check writes an outcome — silence is impossible;
//   3. an unanchored watch monitors nothing and is reported, not skipped;
//   4. a registry merge re-points the anchor;
//   5. a Flexible Watch still works, on a declared class.
import assert from 'node:assert/strict';
import {
  RESOLUTION,
  anchorWatch,
  buildWatch,
  checkWatch,
  checkWatches,
  evaluateWatch,
  isMonitorable,
  watchAnchor,
  watchProviders,
  watchTarget,
} from './monitor.js';
import { productFromListing } from './identity/listingCandidate.js';
import { createMemRegistryStore } from './registry/memstore.js';
import { createMemoryWatchStore } from './storage/local.js';
import { decodeProfile, profileTokens } from './registry/model.js';

const PROFILE = 'profile-watch-anchor-1';
const DATE = '2026-07-29';
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };

const listing = (over = {}) => ({
  id: '12345', name: 'Sadia Chicken Breast 900 g', price: 25.0, currency: 'SAR',
  link: 'https://panda.sa/en/p/12345.sadia-chicken-breast', size: '900 g', brand: 'Sadia',
  ...over,
});

function searchClientOf(results) {
  return { async search(provider) {
    if (results[provider] instanceof Error) throw results[provider];
    return results[provider] || [];
  } };
}

async function seededRegistry() {
  const store = createMemRegistryStore();
  const product = productFromListing(listing(), { date: DATE, week: DATE, store: 'panda' });
  await store.createProduct(product, profileTokens(decodeProfile(product.token_profile)));
  return { store, product };
}

const baseWatch = (over = {}) => {
  const { watch, error } = buildWatch({
    profileId: PROFILE, kind: 'product', provider: 'panda', productId: '12345',
    query: 'Sadia Chicken Breast', label: 'Sadia Chicken Breast 900 g', targetPrice: 20,
    ...over,
  });
  assert.equal(error, undefined, error);
  // This suite exercises the pre-v3 Registry/source resolver. The new v3
  // all-source contract is covered independently by watchTracks.test.mjs.
  return {
    ...watch,
    watchTrack: null,
    scope: 'store',
    spec: null,
    registryProductId: null,
    anchorState: 'resolving',
  };
};

// --- 1. a resolved watch reads a price through the resolver -------------------
{
  const { store, product } = await seededRegistry();
  const watchStore = createMemoryWatchStore();
  const watch = { ...baseWatch(), registryProductId: product.id };
  await watchStore.create(watch);

  const ctx = {
    watchStore, registryStore: store,
    searchClient: searchClientOf({ panda: [listing({ price: 18.5 })] }),
  };
  const line = await checkWatch(ctx, watch);
  ok(line.resolution === RESOLUTION.OK, `resolved (${line.resolution}: ${line.notes})`);
  ok(line.price === 18.5, 'the price came from the verified listing');
  ok(line.alerted === true, 'crossing below target alerts');

  const saved = await watchStore.get(watch.id);
  ok(saved.lastResolution === RESOLUTION.OK, 'outcome persisted');
  ok(saved.resolvedAt != null, 'resolvedAt records that the check SUCCEEDED');
  ok(saved.lastPrice === 18.5, 'price persisted');
}

// A retailer rename + catalog-id rotation must NOT break the watch: identity
// re-finds it. This is the exact case that used to go silent forever.
{
  const { store, product } = await seededRegistry();
  const watchStore = createMemoryWatchStore();
  const watch = { ...baseWatch(), registryProductId: product.id };
  await watchStore.create(watch);
  const renamed = listing({
    id: '99999', name: 'Chicken Breast Sadia 900g', price: 19,
    link: 'https://panda.sa/en/p/99999.chicken-breast-sadia',
  });
  const line = await checkWatch(
    { watchStore, registryStore: store, searchClient: searchClientOf({ panda: [renamed] }) },
    watch,
  );
  ok(line.resolution === RESOLUTION.OK, 'a renamed, re-ided listing still resolves');
  ok(line.price === 19, 'and its price is read');
}

// --- 2. every check writes an outcome, with a reason --------------------------
{
  const { store, product } = await seededRegistry();
  const watchStore = createMemoryWatchStore();
  const watch = { ...baseWatch(), registryProductId: product.id };
  await watchStore.create(watch);

  // A wrong product in the results: not found, and it says WHY.
  const line = await checkWatch(
    {
      watchStore, registryStore: store,
      searchClient: searchClientOf({ panda: [listing({ name: 'Sadia Chicken Nuggets 900 g' })] }),
    },
    watch,
  );
  ok(line.resolution === RESOLUTION.NOT_FOUND, `not-found (${line.resolution})`);
  const saved = await watchStore.get(watch.id);
  ok(saved.lastResolution === RESOLUTION.NOT_FOUND, 'the failure is PERSISTED');
  ok(/excluded|matched/.test(saved.lastResolutionReason || ''), `reason names the cause: ${saved.lastResolutionReason}`);
  ok(saved.resolvedAt == null, 'a failed check never stamps resolvedAt');
  ok(saved.checkedAt != null, 'but it does record that a check ran');
}

// A total store outage is distinguished from "not on offer" — the arming state
// must not move because a retailer was down.
{
  const { store, product } = await seededRegistry();
  const watchStore = createMemoryWatchStore();
  const watch = { ...baseWatch(), registryProductId: product.id };
  await watchStore.create(watch);
  const line = await checkWatch(
    {
      watchStore, registryStore: store,
      searchClient: searchClientOf({ panda: new Error('HTTP 503') }),
    },
    watch,
  );
  ok(line.resolution === RESOLUTION.PROVIDER_ERROR, `provider-error (${line.resolution})`);
  ok(line.alerted === false, 'an outage never alerts');
}

// --- 3. an unanchored watch monitors nothing, and is REPORTED -----------------
{
  const watchStore = createMemoryWatchStore();
  const watch = baseWatch(); // no anchor
  await watchStore.create(watch);
  ok(isMonitorable(watch) === false, 'no anchor -> not monitorable');
  ok(watchAnchor(watch) === null, 'and no anchor is reported');

  const report = await checkWatches({ watchStore, searchClient: searchClientOf({}) });
  ok(report.skipped === 1, 'skipped, not silently omitted');
  ok(report.checked === 0, 'and it consumed no check budget');
  ok(report.lines[0].status === 'unanchored', 'the line names the state');
  ok(report.lines[0].resolution === RESOLUTION.PENDING_MIGRATION, 'with an explicit resolution');
}

// --- 4. a registry merge re-points the anchor ---------------------------------
{
  const { store, product } = await seededRegistry();
  const survivor = productFromListing(
    listing({ name: 'Sadia Chicken Breast Frozen 900 g' }), { date: DATE, week: DATE, store: 'panda' },
  );
  await store.createProduct(survivor, profileTokens(decodeProfile(survivor.token_profile)));
  await store.tombstoneProduct(product.id, survivor.id);

  const watchStore = createMemoryWatchStore();
  const watch = { ...baseWatch(), registryProductId: product.id };
  await watchStore.create(watch);
  const line = await checkWatch(
    { watchStore, registryStore: store, searchClient: searchClientOf({ panda: [listing()] }) },
    watch,
  );
  ok(line.rebound === survivor.id, 'the merge relocated the anchor');
  ok((await watchStore.get(watch.id)).registryProductId === survivor.id, 'and it was persisted');
}

// --- 5. the Flexible Watch: a declared class, not an instance -----------------
{
  const watchStore = createMemoryWatchStore();
  const { watch, error } = buildWatch({
    profileId: PROFILE, kind: 'grocery', query: 'chicken breast',
    label: 'Any chicken breast', targetPrice: 30,
    // A typed category watch has no reference pack — the target IS per kg.
    targetUnitPrice: 30, unitLabel: 'SAR/kg',
    spec: { family: 'chicken', cut: 'breast' },
  });
  assert.equal(error, undefined, error);
  await watchStore.create(watch);

  const anchor = watchAnchor(watch);
  ok(anchor?.kind === 'spec', 'a spec IS an anchor');
  ok(isMonitorable(watch) === true, 'so a flexible watch monitors immediately');
  ok(watchProviders(watch).length === 7, 'market scope sweeps every provider');

  // Size is unpinned -> the target must be compared per unit, automatically.
  ok(watchTarget(watch, anchor)?.unitLabel != null || watchTarget(watch, anchor) === null,
    'an unpinned size forces a unit-price basis');

  const ctx = {
    watchStore,
    searchClient: searchClientOf({
      panda: [listing({ name: 'Americana Chicken Breast 1 kg', brand: 'Americana', size: '1 kg', price: 22 })],
      tamimi: [listing({ name: 'Sadia Chicken Nuggets 400 g', brand: 'Sadia', size: '400 g', price: 9 })],
    }),
  };
  const best = await evaluateWatch(ctx, watch, []);
  ok(best.resolution === RESOLUTION.OK, `flexible watch resolved (${best.resolution}: ${best.reason})`);
  ok(best.name === 'Americana Chicken Breast 1 kg', 'any brand matched the class');
  ok(best.unitLabel === 'SAR/kg', `compared per kg (${best.unitLabel})`);
  ok(best.exclusions.cut === 1, 'the nuggets were excluded ON CUT, and counted');
}

// A malformed spec is refused at the API, never silently dropped.
{
  const bad = buildWatch({
    profileId: PROFILE, kind: 'grocery', query: 'anything', targetPrice: 10,
    spec: { colour: 'red' },
  });
  ok(/not a product identity dimension/.test(bad.error || ''), `refused: ${bad.error}`);
}

// --- anchoring at creation ----------------------------------------------------
{
  const { store, product } = await seededRegistry();
  const created = await anchorWatch({ registryStore: store }, baseWatch(), listing());
  ok(created.watch.registryProductId === product.id, 'an existing product is attached');

  // A product nothing has ever seen stays system-owned. Watches never mint or
  // teach shared Registry identity merely to clear an identity workflow.
  const fresh = await anchorWatch(
    { registryStore: store }, baseWatch(),
    listing({ name: 'Almarai Full Fat Yoghurt 400 g', brand: 'Almarai', size: '400 g' }),
  );
  ok(fresh.watch.registryProductId == null, 'an unseen product does not mint Registry identity');
  ok(fresh.watch.anchorState === 'resolving', 'and remains retryable without asking an empty question');

  // A LEXICON GAP ("zabadi" is not in the family vocabulary) must produce a
  // system-owned resolution, never a guess or an empty user question.
  const gap = await anchorWatch(
    { registryStore: store }, baseWatch(),
    listing({ name: 'Almarai Zabadi Full Fat 400 g', brand: 'Almarai', size: '400 g' }),
  );
  ok(gap.watch.anchorState === 'resolving', 'an unreadable family remains system-owned');
  ok(gap.watch.registryProductId == null, 'and anchors nothing');

  // A listing too thin to identify cannot produce an actionable ambiguity set.
  const thin = await anchorWatch({ registryStore: store }, baseWatch(), { name: 'Pepsi 1 L', brand: 'Pepsi' });
  ok(thin.needsConfirmation !== true, 'no candidate means no confirmation request');
  ok(thin.watch.anchorState === 'resolving', 'and holds an explicit retryable state');
  ok(thin.watch.registryProductId == null, 'with no anchor guessed');
}

// --- 6. the post-ingest flyer pass may only IMPROVE --------------------------
// Flyer prices change only at ingest, so that is when a flyer deal becomes
// knowable. The pass costs zero subrequests — and must never overwrite the
// daily check's recorded outcome with a misleading one.
{
  const { store, product } = await seededRegistry();
  const watchStore = createMemoryWatchStore();
  const watch = { ...baseWatch(), registryProductId: product.id, scope: 'market' };
  await watchStore.create(watch);

  // The daily check ran and recorded a genuine miss.
  await watchStore.updateState(watch.id, {
    checkedAt: '2026-07-29T05:45:00.000Z',
    lastResolution: RESOLUTION.NOT_FOUND,
    lastResolutionReason: '31 candidate(s) seen, none matched.',
  });

  // Now ingest fires. No search client is used at all, and the registry has no
  // current sighting for this product.
  const ctx = {
    watchStore,
    registryStore: { ...store, async bestCurrentForProduct() { return null; } },
    searchClient: searchClientOf({ panda: new Error('must not be called') }),
  };
  const line = await checkWatch(ctx, watch, { flyerOnly: true });
  ok(line.resolution == null, 'nothing on the flyers is "no change", not a failure');
  ok(line.status === 'no-change', 'and the line says so');

  const after = await watchStore.get(watch.id);
  ok(after.lastResolution === RESOLUTION.NOT_FOUND, 'the daily outcome is UNTOUCHED');
  ok(after.lastResolutionReason === '31 candidate(s) seen, none matched.', 'reason intact');
  ok(after.checkedAt === '2026-07-29T05:45:00.000Z', 'and checked_at did not move');
}

// But a flyer deal DOES alert, at zero subrequest cost.
{
  const { store, product } = await seededRegistry();
  const watchStore = createMemoryWatchStore();
  const watch = { ...baseWatch(), registryProductId: product.id, scope: 'market' };
  await watchStore.create(watch);
  const ctx = {
    watchStore,
    registryStore: {
      ...store,
      async bestCurrentForProduct() {
        return { price: 15, currency: 'SAR', store: 'lulu', link: 'https://f/1' };
      },
    },
    searchClient: searchClientOf({ panda: new Error('must not be called') }),
  };
  const line = await checkWatch(ctx, watch, { flyerOnly: true });
  ok(line.resolution === RESOLUTION.OK, `a flyer deal resolves (${line.resolution})`);
  ok(line.price === 15, 'at the sighting price');
  ok(line.alerted === true, 'and alerts without touching a single store');
  ok((await watchStore.get(watch.id)).lastSource === 'flyer', 'recorded as a flyer price');
}

console.log(`watchAnchor.test: ${passed} passed, 0 failed`);
