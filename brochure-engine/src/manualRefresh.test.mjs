import assert from 'node:assert/strict';
import { handleRequest } from './engine.js';
import {
  MANUAL_REFRESH_STALE_MS,
  MONITOR_PROVIDERS,
  buildWatch,
  manualRefreshReason,
} from './monitor.js';
import { createMemoryWatchStore } from './storage/local.js';

const BASE = 'https://engine.test';
const PROFILE = 'profile-refresh-1111';
const OTHER = 'profile-refresh-2222';
const ASIN = 'B012345678';

const post = (ctx, path) =>
  handleRequest(new Request(`${BASE}${path}`, { method: 'POST' }), ctx);

const { watch, error } = buildWatch({
  profileId: PROFILE,
  kind: 'product',
  provider: 'amazon',
  productId: ASIN,
  query: 'Echo Dot',
  label: 'Echo Dot Smart Speaker',
  targetPrice: 100,
  listing: {
    id: ASIN,
    provider: 'amazon',
    name: 'Echo Dot Smart Speaker',
    brand: 'Amazon',
    link: `https://www.amazon.sa/dp/${ASIN}`,
  },
});
assert.equal(error, undefined);
assert.equal(watch.anchorState, 'anchored_source', 'trusted Amazon identity starts anchored');

const store = createMemoryWatchStore();
await store.create({
  ...watch,
  monitoringHealth: 'provider_error',
  monitoringHealthReason: 'amazon: HTTP 502',
  checkedAt: '2026-07-30T00:00:00.000Z',
  lastPrice: 110,
  lastPurchasePrice: 110,
  lastStore: 'amazon',
  lastSource: 'online',
  lastName: 'Echo Dot Smart Speaker',
  isBelow: false,
  isClose: false,
});

let providerUp = false;
const ctx = {
  watchStore: store,
  searchClient: {
    async search(provider) {
      assert.equal(provider, 'amazon', 'manual refresh evaluates only the anchored provider');
      if (!providerUp) throw new Error('HTTP 502');
      return [{
        id: ASIN,
        provider: 'amazon',
        name: 'Echo Dot Smart Speaker',
        brand: 'Amazon',
        price: 90,
        currency: 'SAR',
        link: `https://www.amazon.sa/dp/${ASIN}`,
      }];
    },
  },
};

assert.equal(MONITOR_PROVIDERS.includes('amazon'), true);
assert.equal(manualRefreshReason(await store.get(watch.id)), 'provider_failure');

// A continued 502 is a completed refresh, not a route failure. It records the
// provider failure while preserving the last known price and identity.
const failed = await post(
  ctx,
  `/watches/refresh?id=${encodeURIComponent(watch.id)}&profile=${encodeURIComponent(PROFILE)}`,
);
assert.equal(failed.status, 200);
const failedBody = await failed.json();
assert.equal(failedBody.result.resolution, 'provider-error');
assert.equal(failedBody.watch.monitoringHealth, 'provider_error');
assert.equal(failedBody.watch.lastPrice, 110);
assert.equal(failedBody.watch.productId, ASIN);
assert.equal((await store.listAlerts({ limit: 10, profileId: PROFILE })).length, 0);

// Provider recovery evaluates immediately, updates price, and uses the normal
// crossing logic exactly once.
providerUp = true;
const recovered = await post(
  ctx,
  `/watches/refresh?id=${encodeURIComponent(watch.id)}&profile=${encodeURIComponent(PROFILE)}`,
);
assert.equal(recovered.status, 200);
const recoveredBody = await recovered.json();
assert.equal(recoveredBody.result.resolution, 'ok');
assert.equal(recoveredBody.watch.monitoringHealth, 'ok');
assert.equal(recoveredBody.watch.lastPrice, 90);
assert.equal(recoveredBody.watch.productId, ASIN, 'monitoring refresh does not modify identity');
assert.equal((await store.listAlerts({ limit: 10, profileId: PROFILE })).length, 1);

// Success removes eligibility, so an immediate repeat cannot duplicate the
// crossing alert.
const repeat = await post(
  ctx,
  `/watches/refresh?id=${encodeURIComponent(watch.id)}&profile=${encodeURIComponent(PROFILE)}`,
);
assert.equal(repeat.status, 409);
assert.equal((await store.listAlerts({ limit: 10, profileId: PROFILE })).length, 1);

// Ownership and stale eligibility are enforced independently of the UI.
assert.equal(
  (await post(ctx, `/watches/refresh?id=${encodeURIComponent(watch.id)}&profile=${OTHER}`)).status,
  404,
);
const staleNow = Date.parse(recoveredBody.watch.checkedAt) + MANUAL_REFRESH_STALE_MS;
assert.equal(manualRefreshReason(recoveredBody.watch, staleNow), 'stale');

console.log('manualRefresh.test: 22 passed, 0 failed');
