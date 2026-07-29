// watchMint.test.mjs — what the one-time migration CREATES, and what it cannot.
//
// The migration is the only moment this subsystem mints registry products, and
// a mint survives an engine rollback. These are the properties an operator has
// to be able to rely on before running it.
import assert from 'node:assert/strict';
import { anchorWatch, resolveLegacyWatches } from './monitor.js';
import { productFromListing } from './identity/listingCandidate.js';
import { createMemRegistryStore } from './registry/memstore.js';
import { createMemoryWatchStore } from './storage/local.js';
import { decodeProfile, profileTokens } from './registry/model.js';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };
const DATE = '2026-07-29';

const legacy = (id, over = {}) => ({
  id, profileId: 'p-mint-0001', kind: 'grocery', scope: 'market',
  query: 'Sadia Chicken Breast', label: 'Sadia Chicken Breast 900 g',
  targetPrice: 20, currency: 'SAR', active: true,
  registryProductId: null, spec: null,
  matchBrand: true, matchSize: true, matchVariant: true,
  identityFamily: 'chicken', identityType: 'breast', brandId: 'sadia',
  sizeUnit: 'g', sizeTotal: 900, variantKey: '',
  lastResolution: 'pending-migration', createdAt: DATE,
  ...over,
});

const seeded = async (withProduct = true) => {
  const registryStore = createMemRegistryStore();
  if (withProduct) {
    const p = productFromListing(
      { id: '1', name: 'Sadia Chicken Breast 900 g', brand: 'Sadia', size: '900 g' },
      { date: DATE, week: DATE, store: 'panda' },
    );
    await registryStore.createProduct(p, profileTokens(decodeProfile(p.token_profile)));
  }
  return { registryStore, watchStore: createMemoryWatchStore() };
};

// --- a mint happens ONLY when nothing in the registry is close enough --------
{
  // The product IS already in the registry -> attach, no mint.
  const ctx = await seeded(true);
  await ctx.watchStore.create(legacy('w1'));
  const r = await resolveLegacyWatches(ctx);
  ok(r.anchored === 1, 'anchored');
  ok(r.minted.length === 0, 'an existing product is ATTACHED, never re-minted');
}
{
  // Empty registry -> nothing to attach to -> mint.
  const ctx = await seeded(false);
  await ctx.watchStore.create(legacy('w1'));
  const r = await resolveLegacyWatches(ctx);
  ok(r.minted.length === 1, 'an absent product IS minted');
  ok(r.anchored === 1, 'and the watch is anchored to it');
}

// --- DRY RUN writes nothing --------------------------------------------------
{
  const ctx = await seeded(false);
  await ctx.watchStore.create(legacy('w1'));
  await ctx.watchStore.create(legacy('w2', { label: 'Almarai Full Fat Yoghurt 400 g' }));

  const dry = await resolveLegacyWatches(ctx, { dryRun: true });
  ok(dry.dryRun === true, 'the report says it was a dry run');
  ok(dry.minted.length === 2, 'it reports every product it WOULD create');
  ok((await ctx.watchStore.get('w1')).registryProductId == null, 'no watch was anchored');
  ok((await ctx.watchStore.get('w1')).lastResolution === 'pending-migration', 'state untouched');
  ok((await ctx.registryStore.productCount()) === 0, 'and NOTHING was written to the registry');

  // The mint line is reviewable without opening the registry.
  const m = dry.minted[0];
  for (const k of ['productId', 'displayName', 'fromWatch', 'fromLabel', 'brand', 'family', 'size', 'tokens']) {
    ok(k in m, `mint line carries ${k}`);
  }
  ok(m.fromWatch === 'w1', 'it names the watch that caused it');
  ok(Array.isArray(m.tokens) && m.tokens.length > 0, 'and the identity evidence it was minted from');

  // The real run then produces the same counts.
  const real = await resolveLegacyWatches(ctx);
  ok(real.minted.length === dry.minted.length, 'the real run mints what the dry run predicted');
  ok((await ctx.registryStore.productCount()) === 2, 'now the registry has them');
}

// --- TWO watches on the SAME product mint ONE product ------------------------
// The second watch resolves against a registry that already contains the first
// watch's mint, so it attaches. This is what stops the migration fanning out
// duplicates across watches of the same item.
{
  const ctx = await seeded(false);
  await ctx.watchStore.create(legacy('w1'));
  await ctx.watchStore.create(legacy('w2', { id: 'w2' })); // same label/brand/size
  const r = await resolveLegacyWatches(ctx);
  ok(r.anchored === 2, 'both watches anchored');
  ok(r.minted.length === 1, 'but only ONE product was minted');
  ok((await ctx.registryStore.productCount()) === 1, 'the registry holds one product');
  const a = await ctx.watchStore.get('w1');
  const b = await ctx.watchStore.get('w2');
  ok(a.registryProductId === b.registryProductId, 'and both watches point at it');
}

// --- IDEMPOTENCY: a second run mints nothing ---------------------------------
{
  const ctx = await seeded(false);
  await ctx.watchStore.create(legacy('w1'));
  await ctx.watchStore.create(legacy('w2', { label: 'Pepsi 1 L', identityFamily: null, identityType: null, brandId: 'pepsi', sizeUnit: 'ml', sizeTotal: 1000 }));
  await ctx.watchStore.create(legacy('w3', { matchBrand: false, matchSize: false, matchVariant: false }));

  const first = await resolveLegacyWatches(ctx);
  const countAfterFirst = await ctx.registryStore.productCount();
  const second = await resolveLegacyWatches(ctx);

  ok(second.scanned === first.needsConfirmation + first.unresolvable,
    'a second run only revisits watches that never got an anchor');
  ok(second.minted.length === 0, 'and mints NOTHING');
  ok((await ctx.registryStore.productCount()) === countAfterFirst,
    'the registry product count is unchanged by a re-run');

  const third = await resolveLegacyWatches(ctx);
  ok((await ctx.registryStore.productCount()) === countAfterFirst, 'still unchanged on a third run');
  ok(third.minted.length === 0, 'still mints nothing');
}

// --- an ambiguous watch is never minted into existence -----------------------
{
  const ctx = await seeded(true);
  // A label too thin to establish identity: one dimension only.
  await ctx.watchStore.create(legacy('w1', {
    label: 'Pepsi 1 L', query: 'Pepsi', identityFamily: null, identityType: null,
    brandId: 'pepsi', sizeUnit: 'ml', sizeTotal: 1000,
  }));
  const r = await resolveLegacyWatches(ctx);
  ok(r.minted.length === 0, 'a thin identity is NOT minted');
  ok(r.needsConfirmation + r.unresolvable === 1, 'it asks instead');
  ok((await ctx.registryStore.productCount()) === 1, 'the registry gained nothing');
}

// --- the stored brand/size are used, not discarded ---------------------------
// A legacy row carries the brand and size the v2 build derived. Ignoring them
// would resolve worse than the data allows, turning avoidable mints into
// questions for the user.
{
  const ctx = await seeded(false);
  const anchored = await anchorWatch(ctx, legacy('w1'), null, { dryRun: true });
  ok(anchored.wouldCreate?.brand_text === 'sadia', 'the stored brand reaches the mint');
  ok(anchored.wouldCreate?.size_total === 900, 'and so does the stored size');
  ok(anchored.wouldCreate?.size_unit === 'g', 'in canonical units');
}

console.log(`watchMint.test: ${passed} passed, 0 failed`);
