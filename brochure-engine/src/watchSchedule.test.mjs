import assert from 'node:assert/strict';
import { buildWatch } from './monitor.js';
import { createMemoryWatchStore } from './storage/local.js';
import { createMemoryWatchRunStore } from './storage/watchRunStore.js';
import { claimScheduledWatchRuns, processWatchRuns } from './watchSchedule.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };

const ASIN = 'B012345678';
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
const built = buildWatch({
  profileId: 'profile-schedule-1',
  kind: 'product',
  provider: 'amazon',
  productId: ASIN,
  query: listing.name,
  label: listing.name,
  targetPrice: 1800,
  listing,
});
assert.equal(built.error, undefined, built.error);
const watch = { ...built.watch, createdAt: '2026-08-25T03:59:00.000Z' };
const watchStore = createMemoryWatchStore();
const watchRunStore = createMemoryWatchRunStore();
await watchStore.create(watch);

let reachable = false;
const ctx = {
  watchStore,
  watchRunStore,
  searchClient: {
    async lookupExact(provider, id) {
      assert.equal(provider, 'amazon');
      assert.equal(id, ASIN);
      if (!reachable) throw new Error('Amazon unavailable');
      return { ...listing };
    },
  },
};

const atSeven = Date.parse('2026-08-25T04:00:00.000Z'); // 07:00 Riyadh
const first = await claimScheduledWatchRuns(ctx, { nowMs: atSeven });
ok(first.slot.key === '2026-08-25-AM', '07:00 Riyadh creates the AM slot');
ok(first.created === 1 && first.runs.length === 1, 'one durable round is claimed');
let report = await processWatchRuns(ctx, { ids: first.runs.map((run) => run.id), nowMs: atSeven });
ok(report.retrying === 1 && report.completed === 0, 'unreachable exact ASIN retries');

const early = await claimScheduledWatchRuns(ctx, { nowMs: atSeven + 30_000 });
ok(early.runs.length === 0, 'it does not retry before one minute');

reachable = true;
const afterMinute = await claimScheduledWatchRuns(ctx, { nowMs: atSeven + 60_000 });
ok(afterMinute.runs.length === 1 && afterMinute.runs[0].attempts === 2,
  'the same round is claimed again after one minute');
report = await processWatchRuns(ctx, {
  ids: afterMinute.runs.map((run) => run.id),
  nowMs: atSeven + 60_000,
});
ok(report.completed === 1 && report.retrying === 0, 'successful exact lookup completes the round');

const frozen = await claimScheduledWatchRuns(ctx, { nowMs: atSeven + 2 * 60_000 });
ok(frozen.created === 0 && frozen.runs.length === 0, 'success stays frozen within the slot');

const atNineteen = Date.parse('2026-08-25T16:00:00.000Z'); // 19:00 Riyadh
const evening = await claimScheduledWatchRuns(ctx, { nowMs: atNineteen });
ok(evening.slot.key === '2026-08-25-PM' && evening.created === 1 && evening.runs.length === 1,
  '19:00 Riyadh creates the next independent round');

console.log(`watchSchedule.test: ${passed} passed, 0 failed`);
