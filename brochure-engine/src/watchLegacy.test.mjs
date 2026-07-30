// watchLegacy.test.mjs — the ONE-TIME migration of pre-anchor watches, and the
// user's confirmation of an ambiguous one.
//
// The promise being guarded: after the backfill, EVERY existing watch sits in
// exactly one of three explicit states — anchored (to a product or a class),
// needs-confirmation, or unresolvable. No watch is left meaning "unknown".
import assert from 'node:assert/strict';
import {
  RESOLUTION,
  confirmWatchProduct,
  isMonitorable,
  resolveLegacyWatches,
  watchCandidates,
} from './monitor.js';
import { productFromListing } from './identity/listingCandidate.js';
import { createMemRegistryStore } from './registry/memstore.js';
import { createMemoryWatchStore } from './storage/local.js';
import { decodeProfile, profileTokens } from './registry/model.js';

const DATE = '2026-07-29';
const PROFILE = 'profile-legacy-1111';
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };

// A watch row exactly as the v2 schema left it: no anchor, no spec, stamped
// 'pending-migration' by the SQL migration.
const legacy = (over = {}) => ({
  id: `w_${Math.random().toString(36).slice(2, 10)}`,
  profileId: PROFILE, kind: 'grocery', scope: 'market',
  query: 'Sadia Chicken Breast', label: 'Sadia Chicken Breast 900 g',
  targetPrice: 20, currency: 'SAR', active: true,
  registryProductId: null, spec: null,
  matchBrand: true, matchSize: true, matchVariant: true,
  identityFamily: 'chicken', identityType: 'breast', brandId: 'sadia',
  sizeUnit: 'g', sizeTotal: 900, variantKey: '',
  lastResolution: 'pending-migration',
  lastResolutionReason: 'Awaiting the one-time product-anchor backfill.',
  createdAt: DATE, isBelow: false, isClose: false,
  ...over,
});

async function seeded() {
  const registryStore = createMemRegistryStore();
  const product = productFromListing(
    { id: '1', name: 'Sadia Chicken Breast 900 g', brand: 'Sadia', size: '900 g', price: 25 },
    { date: DATE, week: DATE, store: 'panda' },
  );
  await registryStore.createProduct(product, profileTokens(decodeProfile(product.token_profile)));
  return { registryStore, product, watchStore: createMemoryWatchStore() };
}

// --- a strict legacy watch resolves to the product it always meant -----------
{
  const ctx = await seeded();
  const w = legacy();
  await ctx.watchStore.create(w);
  const report = await resolveLegacyWatches(ctx);
  ok(report.anchored === 1, `anchored (${JSON.stringify(report.lines)})`);
  const saved = await ctx.watchStore.get(w.id);
  ok(saved.registryProductId === ctx.product.id, 'bound to the existing product');
  ok(saved.lastResolution === null, 'and its waiting state is cleared');
  ok(isMonitorable(saved) === true, 'so it monitors from the next check');
}

// --- a RELAXED legacy watch keeps its class: the Flexible Watch survives -----
// PRICE_WATCH_V2 §3.3's "all recognized Chicken Breast" must still mean that.
{
  const ctx = await seeded();
  const w = legacy({ matchBrand: false, matchSize: false, matchVariant: false });
  await ctx.watchStore.create(w);
  const report = await resolveLegacyWatches(ctx);
  ok(report.specced === 1, 'a relaxed watch becomes a spec, not a product');
  const saved = await ctx.watchStore.get(w.id);
  const spec = JSON.parse(saved.spec);
  ok(spec.family === 'chicken' && spec.cut === 'breast', 'the class it always meant');
  ok(spec.brand === undefined, 'brand stays FREE — that is what relaxing it meant');
  ok(spec.size === undefined, 'and so does size');
  ok(saved.registryProductId == null, 'a class watch is not bound to one product');
  ok(isMonitorable(saved) === true, 'and it monitors immediately');
}

// A partially relaxed watch pins only what was strict.
{
  const ctx = await seeded();
  const w = legacy({ matchBrand: false });
  await ctx.watchStore.create(w);
  await resolveLegacyWatches(ctx);
  const spec = JSON.parse((await ctx.watchStore.get(w.id)).spec);
  ok(spec.brand === undefined, 'the relaxed gate is free');
  ok(spec.size?.value === 900, 'the strict ones stay pinned');
}

// --- ambiguity asks, and NEVER guesses ---------------------------------------
{
  const ctx = await seeded();
  const w = legacy({ label: 'Pepsi 1 L', query: 'Pepsi', identityFamily: null, identityType: null });
  await ctx.watchStore.create(w);
  const report = await resolveLegacyWatches(ctx);
  ok(report.resolving + report.unresolvable === 1, 'it did not invent an actionable choice');
  const saved = await ctx.watchStore.get(w.id);
  ok(saved.registryProductId == null, 'and nothing was guessed');
  ok(['resolving', 'unresolvable'].includes(saved.anchorState), 'but an EXPLICIT state was written');
  ok(saved.lastResolutionReason != null, 'with a reason the UI can show');
  ok(isMonitorable(saved) === false, 'so it monitors nothing until answered');
}

// --- THE INVARIANT: no watch is left meaning "unknown" -----------------------
{
  const ctx = await seeded();
  for (const w of [
    legacy(),
    legacy({ matchBrand: false }),
    legacy({ label: 'Pepsi 1 L', identityFamily: null, identityType: null }),
    legacy({ label: '', query: 'xx', identityFamily: null, identityType: null }),
  ]) await ctx.watchStore.create(w);

  // An explicit limit: the DEFAULT is deliberately small (resolution is
  // CPU-heavy against a real registry and a big batch dies at the Worker CPU
  // limit), so the invariant is checked over one deliberate full pass.
  const report = await resolveLegacyWatches(ctx, { limit: 100 });
  ok(report.scanned === 4, 'every pending watch was visited');
  ok(report.stillPending >= 1, 'insufficient evidence remains explicitly retryable');

  for (const w of await ctx.watchStore.list({})) {
    ok(
      isMonitorable(w) || Boolean(w.anchorState),
      `${w.id} is either anchored or explicitly explained`,
    );
  }
}

// --- idempotent: a second run settles nothing again --------------------------
{
  const ctx = await seeded();
  await ctx.watchStore.create(legacy());
  await resolveLegacyWatches(ctx);
  const again = await resolveLegacyWatches(ctx);
  ok(again.scanned === 0, 'an already-settled watch is skipped');
}

// --- the user answers ---------------------------------------------------------
{
  const ctx = await seeded();
  const w = legacy({ label: 'Sadia Chicken Breast 900 g' });
  await ctx.watchStore.create(w);

  const candidateVersion = 'wc_legacy_test';
  const candidateSnapshot = JSON.stringify({
    version: candidateVersion,
    reason: 'two products remain plausible',
    candidates: [{ type: 'registry', productId: ctx.product.id }],
  });
  await ctx.watchStore.setAnchor(w.id, {
    ...w,
    anchorState: 'confirmation_required',
    candidateSnapshot,
    lastResolution: 'needs-confirmation',
  });
  const pending = await ctx.watchStore.get(w.id);
  const candidates = await watchCandidates(ctx, pending);
  ok(Array.isArray(candidates.candidates), 'candidates are offered as a versioned list');

  const confirmed = await confirmWatchProduct(ctx, pending, ctx.product.id, candidateVersion);
  ok(confirmed.productId === ctx.product.id, 'confirming binds the watch');
  const saved = await ctx.watchStore.get(w.id);
  ok(saved.registryProductId === ctx.product.id, 'the anchor is persisted');
  ok(saved.lastResolution === null, 'and the waiting state is cleared');
  ok(isMonitorable(saved) === true, 'monitoring resumes');

  ok((await confirmWatchProduct(ctx, pending, 'not-an-id', candidateVersion)).error != null, 'a bad id is refused');
  ok((await confirmWatchProduct(ctx, pending, 'pr_missing1', candidateVersion)).error != null, 'an unknown product is refused');
}

console.log(`watchLegacy.test: ${passed} passed, 0 failed`);
