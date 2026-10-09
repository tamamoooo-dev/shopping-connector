// A scheduled round records an alert at most once per type (2026-10-09). A
// round re-runs when its lease expires mid-check or a child is retried; the
// watch snapshot it reads is then still un-armed, so without a deterministic id
// the same price drop was written (and pushed) twice.
import assert from 'node:assert/strict';
import { buildWatch, checkWatch } from './monitor.js';
import { createMemoryWatchStore } from './storage/local.js';
import { createMemoryWatchRunStore } from './storage/watchRunStore.js';
import { claimScheduledWatchRuns, processWatchRuns } from './watchSchedule.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };

const ASIN = 'B0ALERT001';
const listing = {
  id: ASIN,
  provider: 'amazon',
  name: 'Apple Watch Series 10 GPS 46mm Black Aluminium',
  brand: 'Apple',
  size: '46 mm',
  price: 1899,
  currency: 'SAR',
  link: `https://www.amazon.sa/dp/${ASIN}`,
};

function fixture({ price }) {
  const built = buildWatch({
    profileId: 'profile-alert-1',
    kind: 'product',
    provider: 'amazon',
    productId: ASIN,
    query: listing.name,
    label: listing.name,
    targetPrice: 1800,
    closeThreshold: 10,
    listing,
  });
  assert.equal(built.error, undefined, built.error);
  const watch = { ...built.watch, createdAt: '2026-08-25T03:59:00.000Z' };
  const watchStore = createMemoryWatchStore();
  const pushes = [];
  const state = { price };
  const ctx = {
    watchStore,
    watchRunStore: createMemoryWatchRunStore(),
    notifier: { async send(payload) { pushes.push(payload); } },
    searchClient: {
      async lookupExact() { return { ...listing, price: state.price }; },
    },
  };
  return { ctx, watch, watchStore, pushes, state };
}

// 1. The same round run twice from the same un-armed snapshot: one alert, one push.
{
  const { ctx, watch, watchStore, pushes } = fixture({ price: 1750 });
  await watchStore.create(watch);
  const first = await checkWatch(ctx, watch, { alertKey: 'wr_round1' });
  const again = await checkWatch(ctx, watch, { alertKey: 'wr_round1' });
  ok(first.alerted && first.alertType === 'target', 'the first pass alerts');
  ok(!again.alerted && again.alertType === 'target', 'the re-run is not a second alert');
  ok(again.notes.includes('alert already recorded for this round'), 'the re-run says why');
  ok((await watchStore.listAlerts({})).length === 1, 'exactly one alert row');
  ok(pushes.length === 1, 'exactly one push');
  ok((await watchStore.get(watch.id)).isBelow === true, 'the watch is still armed by the re-run');
}

// 2. A re-run that now finds a DIFFERENT alert type is a new fact, not a repeat.
{
  const { ctx, watch, watchStore, state } = fixture({ price: 1900 });
  await watchStore.create(watch);
  const close = await checkWatch(ctx, watch, { alertKey: 'wr_round2' });
  state.price = 1750;
  const target = await checkWatch(ctx, watch, { alertKey: 'wr_round2' });
  ok(close.alertType === 'close' && close.alerted, 'close alert recorded');
  ok(target.alertType === 'target' && target.alerted, 'the target alert in the same round still lands');
  ok((await watchStore.listAlerts({})).length === 2, 'two distinct alerts');
}

// 3. Different rounds are different alerts; manual checks keep random ids.
{
  const { ctx, watch, watchStore } = fixture({ price: 1750 });
  await watchStore.create(watch);
  await checkWatch(ctx, watch, { alertKey: 'wr_am' });
  await checkWatch(ctx, watch, { alertKey: 'wr_pm' });
  await checkWatch(ctx, watch);
  await checkWatch(ctx, watch);
  ok((await watchStore.listAlerts({})).length === 4, 'two rounds + two manual checks');
}

// 4. The scheduled path carries the run id end to end.
{
  const { ctx, watch, watchStore, pushes } = fixture({ price: 1750 });
  await watchStore.create(watch);
  const atSeven = Date.parse('2026-08-25T04:00:00.000Z');
  const claimed = await claimScheduledWatchRuns(ctx, { nowMs: atSeven });
  const report = await processWatchRuns(ctx, { ids: claimed.runs.map((run) => run.id), nowMs: atSeven });
  const [alert] = await watchStore.listAlerts({});
  ok(report.alerted === 1, 'the round alerts');
  ok(alert.id === `a_${claimed.runs[0].id}_target`, 'the alert id is the round id + type');
  ok(pushes.length === 1, 'one push for the round');
}

console.log(`watchAlertIdempotency.test: ${passed} passed, 0 failed`);
