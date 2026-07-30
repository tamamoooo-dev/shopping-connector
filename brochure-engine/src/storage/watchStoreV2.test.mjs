import assert from 'node:assert/strict';
import { createD1WatchStore } from './watchStore.js';
import { createSqliteD1 } from './testSqliteD1.mjs';

const fixture = createSqliteD1(['schema.sql']);
try {
  const store = createD1WatchStore(fixture.db);
  const watch = {
    id: 'w_v2',
    profileId: 'profile-v2-test',
    kind: 'grocery',
    label: 'Sadia Chicken Breast 900 g',
    query: 'Sadia Chicken Breast 900 g',
    targetPrice: 20,
    currency: 'SAR',
    sizeUnit: 'g',
    sizeTotal: 900,
    sizeSource: 'measure',
    identityQuery: 'chicken breast',
    identityFamily: 'chicken',
    identityType: 'breast',
    brandId: 'sadia',
    variantKey: '',
    matchBrand: true,
    matchSize: false,
    matchVariant: true,
    targetUnitPrice: 22.2222,
    unitLabel: 'SAR/kg',
    closeThreshold: 10,
    active: true,
    isBelow: false,
    isClose: false,
    createdAt: '2026-07-27T00:00:00.000Z',
    registryProductId: 'pr_testchicken1',
    scope: 'market',
    spec: JSON.stringify({ family: 'chicken', cut: 'breast' }),
  };
  await store.create(watch);
  const read = await store.get(watch.id);
  assert.equal(read.matchBrand, true);
  assert.equal(read.matchSize, false);
  assert.equal(read.targetUnitPrice, 22.2222);
  // Identity is no longer stored as attributes; the anchor is a registry id.
  assert.equal(read.registryProductId, 'pr_testchicken1');
  assert.equal(read.scope, 'market');
  assert.equal(JSON.parse(read.spec).family, 'chicken');

  assert.equal(await store.updateSettings(watch.id, watch.profileId, {
    matchBrand: false,
    matchVariant: false,
    closeThreshold: 5,
  }), true);
  const updated = await store.get(watch.id);
  assert.equal(updated.matchBrand, false);
  assert.equal(updated.matchVariant, false);
  assert.equal(updated.closeThreshold, 5);

  await store.updateState(watch.id, {
    isClose: true,
    lastPrice: 23,
    lastPurchasePrice: 20.7,
    lastUnitLabel: 'SAR/kg',
  });
  assert.equal((await store.get(watch.id)).isClose, true);

  await store.insertAlert({
    id: 'a_v2',
    watchId: watch.id,
    price: 23,
    purchasePrice: 20.7,
    targetPrice: 22.2222,
    unitLabel: 'SAR/kg',
    alertType: 'close',
    currency: 'SAR',
    store: 'lulu',
    source: 'online',
    name: 'Americana Chicken Breast 900 g',
    observedAt: '2026-07-27T01:00:00.000Z',
  });
  const [alert] = await store.listAlerts({ profileId: watch.profileId });
  assert.equal(alert.alertType, 'close');
  assert.equal(alert.purchasePrice, 20.7);
  assert.equal(alert.unitLabel, 'SAR/kg');

  // --- the ANCHOR moves only when the registry relocates it ---------------------
  const product = {
    ...watch,
    id: 'w_anchor',
    kind: 'product',
    scope: 'store',
    provider: 'panda',
    productId: '12142',
    registryProductId: 'pr_twixice0001',
    spec: null,
    link: 'https://panda.sa/en/p/12142.twix-ice-cream-bar-40-g',
    image: 'https://images.example/337855.jpg',
  };
  await store.create(product);
  assert.equal((await store.get(product.id)).registryProductId, 'pr_twixice0001');

  // A registry MERGE relocated the identity: the watch re-points at the
  // survivor. Nothing else about the watch may move.
  assert.equal(await store.rebindProduct(product.id, 'pr_twixsurv001'), true);
  const rebound = await store.get(product.id);
  assert.equal(rebound.registryProductId, 'pr_twixsurv001');
  assert.equal(rebound.targetPrice, product.targetPrice);
  assert.equal(rebound.image, product.image);
  assert.equal(rebound.link, product.link);
  assert.equal(await store.rebindProduct(product.id, null), false);

  // Every check records an outcome — including the ones that find nothing.
  await store.updateState(product.id, {
    checkedAt: '2026-07-29T05:45:00.000Z',
    lastResolution: 'not-found',
    lastResolutionReason: '31 candidate(s) seen, none matched — excluded: cut ×4',
  });
  const missed = await store.get(product.id);
  assert.equal(missed.lastResolution, 'not-found');
  assert.match(missed.lastResolutionReason, /excluded/);
  assert.equal(missed.resolvedAt, null, 'a failed check never stamps resolvedAt');
} finally {
  fixture.close();
}

// The live migration must produce the same watches table schema.sql declares —
// a column that exists only in one of them is a production-only failure.
{
  const migrated = createSqliteD1([
    'migrate-2026-07-watches.sql',
    'migrate-2026-07-profiles.sql',
    'migrate-2026-07-27-price-watch-v2.sql',
    'migrate-2026-07-29-watch-product-anchor.sql',
    'migrate-2026-07-30-watch-identity-state.sql',
  ]);
  const canonical = createSqliteD1(['schema.sql']);
  try {
    const columns = async (fx) => {
      const { results } = await fx.db.prepare('PRAGMA table_info(watches)').all();
      return results.map((r) => r.name).sort().join(',');
    };
    assert.equal(await columns(migrated), await columns(canonical));
  } finally {
    migrated.close();
    canonical.close();
  }
}

console.log('watchStoreV2.test: all checks passed');
