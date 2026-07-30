// Regression fixtures for WATCH-CONFIRMATION-DESIGN.md.
import assert from 'node:assert/strict';
import {
  anchorWatch,
  buildWatch,
  checkWatch,
  confirmWatchSource,
  declineWatchCandidates,
  repairWatch,
  resolveLegacyWatches,
  watchCandidates,
} from './monitor.js';
import {
  MONITORING_HEALTH,
  WATCH_IDENTITY_STATE,
  rankSourceCandidates,
} from './watchIdentity.js';
import { createMemoryWatchStore } from './storage/local.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };
const PROFILE = 'profile-watch-v3';

const listing = (over = {}) => ({
  id: 'catalog-1',
  name: 'Snickers Ice Cream Bar 6 x 40 g',
  brand: 'Snickers',
  size: '6 x 40 g',
  image: 'https://catalog.test/snickers.jpg',
  price: 18,
  currency: 'SAR',
  link: 'https://catalog.test/p/1',
  ...over,
});

const watchFrom = (over = {}) => buildWatch({
  profileId: PROFILE,
  kind: 'grocery',
  provider: 'panda',
  productId: 'old-catalog-id',
  query: 'Snickers Ice Cream Bar',
  label: 'Snickers Ice Cream Bar 6 x 40 g',
  sizeText: '6 x 40 g',
  targetPrice: 20,
  image: 'https://catalog.test/snickers.jpg',
  listing: listing({ id: 'old-catalog-id' }),
  ...over,
}).watch;

function searchClient(results = {}, failures = new Set()) {
  return {
    async search(provider) {
      if (failures.has(provider)) throw new Error(`${provider} unavailable`);
      return results[provider] || [];
    },
  };
}

const completeSearch = (results = {}) => searchClient({
  panda: [], tamimi: [], danube: [], lulu: [], ninja: [], amazon: [], noon: [],
  ...results,
});

// Trusted Amazon identity anchors immediately and asks nothing.
{
  const amazon = buildWatch({
    profileId: PROFILE,
    kind: 'product',
    provider: 'amazon',
    productId: 'B012345678',
    query: 'Amazon exact product',
    targetPrice: 50,
    listing: { id: 'B012345678', provider: 'amazon', name: 'Amazon exact product' },
  });
  ok(!amazon.error, 'Amazon watch validates');
  ok(amazon.watch.anchorState === WATCH_IDENTITY_STATE.ANCHORED_SOURCE, 'Amazon ASIN source-anchors');
  const resolved = await anchorWatch({}, amazon.watch, null);
  ok(resolved.watch.anchorState === WATCH_IDENTITY_STATE.ANCHORED_SOURCE, 'Amazon never enters confirmation');
}

// Snickers: unchanged image + exact title/brand/pack safely follows ID rotation.
{
  const watch = watchFrom();
  const result = await anchorWatch(
    { searchClient: completeSearch({ panda: [listing({ id: 'new-catalog-id' })] }) },
    watch,
    listing({ id: 'old-catalog-id' }),
  );
  ok(result.watch.anchorState === WATCH_IDENTITY_STATE.ANCHORED_SOURCE, 'Snickers auto-anchors');
  ok(result.watch.productId === 'new-catalog-id', 'Snickers adopts the live catalog id');
  ok(result.watch.anchorConfidence >= 0.9, 'Snickers decision retains strong evidence');
}

// Sunbulah: exact repeated product beats the materially different spicy sibling.
{
  const exact = {
    id: 'sun-plain-new',
    name: 'Sunbulah Breaded Frozen Shrimp 400 g',
    brand: 'Sunbulah',
    size: '400 g',
    image: 'https://catalog.test/sunbulah-plain.jpg',
    price: 24,
  };
  const spicy = {
    id: 'sun-spicy',
    name: 'Sunbulah Spicy Breaded Frozen Shrimp 400 g',
    brand: 'Sunbulah',
    size: '400 g',
    image: 'https://catalog.test/sunbulah-spicy.jpg',
    price: 23,
  };
  const watch = watchFrom({
    productId: 'sun-plain-old',
    query: 'Sunbulah Breaded Frozen Shrimp',
    label: exact.name,
    sizeText: exact.size,
    image: exact.image,
    listing: { ...exact, id: 'sun-plain-old', provider: 'panda' },
  });
  const result = await anchorWatch(
    { searchClient: completeSearch({ panda: [spicy, exact] }) },
    watch,
    { ...exact, id: 'sun-plain-old', provider: 'panda' },
  );
  ok(result.watch.anchorState === WATCH_IDENTITY_STATE.ANCHORED_SOURCE, 'Sunbulah auto-anchors');
  ok(result.watch.productId === exact.id, 'Sunbulah selects the unchanged product, not spicy');
}

// Genuine ambiguity produces concrete choices and a stable version.
let ambiguousWatch;
{
  const reference = {
    id: 'latte-old',
    provider: 'panda',
    name: 'Nescafe Dolce Gusto Latte Macchiato Capsules',
    brand: 'Nescafe',
    image: 'https://catalog.test/latte-reference.jpg',
  };
  const caramel = {
    id: 'latte-caramel',
    name: 'Nescafe Dolce Gusto Latte Macchiato Caramel Capsules',
    brand: 'Nescafe',
    image: 'https://catalog.test/latte-caramel.jpg',
  };
  const vanilla = {
    id: 'latte-vanilla',
    name: 'Nescafe Dolce Gusto Latte Macchiato Vanilla Capsules',
    brand: 'Nescafe',
    image: 'https://catalog.test/latte-vanilla.jpg',
  };
  const watch = watchFrom({
    productId: reference.id,
    query: reference.name,
    label: reference.name,
    sizeText: null,
    image: reference.image,
    listing: reference,
  });
  const result = await anchorWatch(
    { searchClient: completeSearch({ panda: [caramel], tamimi: [vanilla] }) },
    watch,
    reference,
  );
  ambiguousWatch = result.watch;
  ok(result.watch.anchorState === WATCH_IDENTITY_STATE.CONFIRMATION_REQUIRED, 'real ambiguity asks');
  const snapshot = JSON.parse(result.watch.candidateSnapshot);
  ok(snapshot.candidates.length === 2 && Boolean(snapshot.version), 'the question has two versioned choices');
  ok(snapshot.candidates.every((candidate) => candidate.image && candidate.brand), 'choices carry human evidence');
}

// Ranking deduplicates sightings and requires a well-separated winner.
{
  const reference = listing({ id: 'old-catalog-id', provider: 'panda' });
  const ranked = rankSourceCandidates(reference, [
    { store: 'panda', listing: listing({ id: 'panda-new' }) },
    { store: 'tamimi', listing: listing({ id: 'tamimi-same' }) },
  ], { coverageComplete: true, attempted: 7, succeeded: 7 });
  ok(ranked.candidates.length === 1, 'duplicate retailer sightings become one choice');
  ok(ranked.autoCandidate != null && ranked.margin >= 0.16, 'unique high-confidence winner auto-qualifies');
}

// Confirmation transitions, including stale-snapshot safety and None of these.
{
  const store = createMemoryWatchStore();
  await store.create(ambiguousWatch);
  const ctx = { watchStore: store };
  const snapshot = await watchCandidates(ctx, ambiguousWatch);
  const first = snapshot.candidates[0];
  ok((await confirmWatchSource(ctx, ambiguousWatch, {
    provider: first.provider,
    productId: first.productId,
    candidateVersion: 'stale',
  })).error != null, 'stale confirmation is refused');
  const confirmed = await confirmWatchSource(ctx, ambiguousWatch, {
    provider: first.provider,
    productId: first.productId,
    candidateVersion: snapshot.version,
  });
  ok(Boolean(confirmed.productId), 'an offered source choice confirms');
  ok((await store.get(ambiguousWatch.id)).anchorState === WATCH_IDENTITY_STATE.ANCHORED_SOURCE,
    'confirmation transitions to anchored_source');

  const second = { ...ambiguousWatch, id: 'w-decline' };
  await store.create(second);
  await declineWatchCandidates(ctx, second, snapshot.version);
  ok((await store.get(second.id)).anchorState === WATCH_IDENTITY_STATE.RESOLVING,
    'None of these returns to resolving');
}

// Backfill source-anchors Amazon, rehydrates exact catalog evidence, and never
// disturbs an existing anchor.
{
  const store = createMemoryWatchStore();
  const amazon = {
    ...watchFrom(), id: 'w-amazon-backfill', kind: 'product', scope: 'store',
    provider: 'amazon', productId: 'B012345678', anchorState: 'resolving',
  };
  const snickers = { ...watchFrom(), id: 'w-snickers-backfill' };
  const anchored = {
    ...watchFrom(), id: 'w-existing', anchorState: 'anchored_registry',
    registryProductId: 'pr_existing123', productId: null,
  };
  await store.create(amazon);
  await store.create(snickers);
  await store.create(anchored);
  const ctx = {
    watchStore: store,
    searchClient: completeSearch({ panda: [listing({ id: 'new-catalog-id' })] }),
  };
  const report = await resolveLegacyWatches(ctx, { limit: 10 });
  ok(report.sourceAnchored === 2, 'backfill source-anchors Amazon and Snickers');
  ok((await store.get('w-existing')).registryProductId === 'pr_existing123',
    'existing anchored watch remains anchored');
}

// Repair may follow a verified source-key rotation but cannot erase the anchor.
{
  const store = createMemoryWatchStore();
  const watch = {
    ...watchFrom(),
    id: 'w-repair',
    kind: 'product',
    scope: 'store',
    anchorState: WATCH_IDENTITY_STATE.ANCHORED_SOURCE,
    sourceSnapshot: JSON.stringify({
      provider: 'panda',
      productId: 'old-catalog-id',
      ...listing({ id: undefined, provider: undefined }),
    }),
  };
  await store.create(watch);
  const result = await repairWatch({
    watchStore: store,
    searchClient: searchClient({ panda: [listing({ id: 'new-catalog-id' })] }),
  }, watch);
  ok(result.repaired === true, 'repair accepts verified source continuity');
  ok((await store.get(watch.id)).productId === 'new-catalog-id', 'repair persists the rotated id');
}

// Monitoring health changes independently; identity and alert safety remain.
{
  const store = createMemoryWatchStore();
  const watch = {
    ...watchFrom({ targetPrice: 20 }),
    id: 'w-health',
    kind: 'product',
    scope: 'store',
    anchorState: WATCH_IDENTITY_STATE.ANCHORED_SOURCE,
  };
  await store.create(watch);
  const healthy = await checkWatch({
    watchStore: store,
    searchClient: searchClient({ panda: [listing({ id: 'old-catalog-id', price: 18 })] }),
  }, watch);
  let saved = await store.get(watch.id);
  ok(healthy.alerted === true && saved.monitoringHealth === MONITORING_HEALTH.OK,
    'verified source observation still generates an alert');
  ok(saved.anchorState === WATCH_IDENTITY_STATE.ANCHORED_SOURCE, 'health success does not change identity');

  await checkWatch({
    watchStore: store,
    searchClient: searchClient({}, new Set(['panda'])),
  }, saved);
  saved = await store.get(watch.id);
  ok(saved.monitoringHealth === MONITORING_HEALTH.PROVIDER_ERROR, 'provider failure is monitoring health');
  ok(saved.anchorState === WATCH_IDENTITY_STATE.ANCHORED_SOURCE, 'provider failure never erases the anchor');
}

console.log(`watchIdentityV3.test: ${passed} passed, 0 failed`);
