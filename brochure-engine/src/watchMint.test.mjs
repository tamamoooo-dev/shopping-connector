// watchMint.test.mjs — watch resolution never teaches or mints Registry identity.
import assert from 'node:assert/strict';
import { resolveLegacyWatches } from './monitor.js';
import { productFromListing } from './identity/listingCandidate.js';
import { createMemRegistryStore } from './registry/memstore.js';
import { createMemoryWatchStore } from './storage/local.js';
import { decodeProfile, profileTokens } from './registry/model.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };
const DATE = '2026-07-29';

const legacy = (id, over = {}) => ({
  id, profileId: 'p-mint-0001', kind: 'grocery', scope: 'market',
  query: 'Sadia Chicken Breast', label: 'Sadia Chicken Breast 900 g',
  targetPrice: 20, currency: 'SAR', active: true,
  registryProductId: null, spec: null,
  matchBrand: true, matchSize: true, matchVariant: true,
  identityFamily: 'chicken', identityType: 'breast', brandId: 'sadia',
  sizeUnit: 'g', sizeTotal: 900, variantKey: '',
  anchorState: 'resolving',
  lastResolution: 'pending-migration', createdAt: DATE,
  ...over,
});

const seeded = async (withProduct = true) => {
  const registryStore = createMemRegistryStore();
  if (withProduct) {
    const product = productFromListing(
      { id: '1', name: 'Sadia Chicken Breast 900 g', brand: 'Sadia', size: '900 g' },
      { date: DATE, week: DATE, store: 'panda' },
    );
    await registryStore.createProduct(product, profileTokens(decodeProfile(product.token_profile)));
  }
  return { registryStore, watchStore: createMemoryWatchStore() };
};

{
  const ctx = await seeded(true);
  await ctx.watchStore.create(legacy('w1'));
  const before = await ctx.registryStore.productCount();
  const report = await resolveLegacyWatches(ctx);
  ok(report.anchored === 1, 'an existing Registry product is attached');
  ok(report.minted.length === 0, 'the watch resolver reports no mint');
  ok((await ctx.registryStore.productCount()) === before, 'Registry product count is unchanged');
}

{
  const ctx = await seeded(false);
  await ctx.watchStore.create(legacy('w1'));
  const report = await resolveLegacyWatches(ctx);
  const saved = await ctx.watchStore.get('w1');
  ok(report.minted.length === 0, 'an absent product is not minted');
  ok(saved.registryProductId == null, 'no Registry anchor is fabricated');
  ok(['resolving', 'unresolvable'].includes(saved.anchorState), 'insufficient evidence stays system-owned');
  ok((await ctx.registryStore.productCount()) === 0, 'the shared Registry remains empty');
}

{
  const ctx = await seeded(false);
  await ctx.watchStore.create(legacy('w1'));
  const dry = await resolveLegacyWatches(ctx, { dryRun: true });
  ok(dry.dryRun === true, 'dry-run is reported');
  ok((await ctx.watchStore.get('w1')).lastResolutionAttemptAt == null, 'dry-run writes no watch state');
  ok((await ctx.registryStore.productCount()) === 0, 'dry-run writes no Registry state');
}

{
  const ctx = await seeded(false);
  await ctx.watchStore.create(legacy('w1'));
  await ctx.watchStore.create(legacy('w2'));
  const first = await resolveLegacyWatches(ctx, { limit: 100 });
  const second = await resolveLegacyWatches(ctx, { limit: 100 });
  ok(first.scanned === 2, 'the first backfill visits both rows');
  ok(second.scanned === 0, 'the ordinary backfill is idempotent after one attempt');
  ok((await ctx.registryStore.productCount()) === 0, 'multiple watches still cannot mint');
}

console.log(`watchMint.test: ${passed} passed, 0 failed`);
