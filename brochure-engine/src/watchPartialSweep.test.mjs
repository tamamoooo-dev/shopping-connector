// watchPartialSweep.test.mjs — a market-wide round must not starve on one store.
//
// 2026-09-21..10-08: five market watches retried every minute for the whole
// 6-hour slot (360 attempts) and never completed, because one store kept
// failing. After MARKET_PARTIAL_SWEEP_AFTER_ATTEMPTS the round completes with
// the stores that answered; a partial answer may alert but never re-arms.
import assert from 'node:assert/strict';
import { buildWatch, MONITOR_PROVIDERS, RESOLUTION } from './monitor.js';
import { createMemoryWatchStore } from './storage/local.js';
import { createMemoryWatchRunStore } from './storage/watchRunStore.js';
import {
  claimScheduledWatchRuns, MARKET_PARTIAL_SWEEP_AFTER_ATTEMPTS, processWatchRuns,
} from './watchSchedule.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };

const listing = {
  id: 'catalog-123', provider: 'panda', name: 'حليب نادك كامل الدسم 1 لتر',
  brand: 'نادك', size: '1 لتر', price: 6.5, currency: 'SAR',
  link: 'https://panda.example/p/catalog-123',
};

async function setup({ targetPrice = 7, failing = ['danube'], answering = { panda: [listing] }, state = {} } = {}) {
  const built = buildWatch({
    profileId: 'profile-partial-1',
    kind: 'grocery',
    provider: 'panda',
    productId: listing.id,
    query: listing.name,
    label: listing.name,
    brand: 'نادك',
    sizeText: '1 لتر',
    targetPrice,
    listing,
  });
  assert.equal(built.error, undefined, built.error);
  const watch = { ...built.watch, createdAt: '2026-10-08T03:00:00.000Z', ...state };
  const watchStore = createMemoryWatchStore();
  await watchStore.create(watch);
  const ctx = {
    watchStore,
    watchRunStore: createMemoryWatchRunStore(),
    searchClient: {
      async search(provider) {
        if (failing.includes(provider)) throw new Error(`search ${provider} -> HTTP 502`);
        return answering[provider] || [];
      },
    },
  };
  return { ctx, watch, watchStore };
}

// Drive one slot minute by minute until the round completes (or `max` tries).
async function runSlot(ctx, max) {
  const start = Date.parse('2026-10-08T04:00:00.000Z'); // 07:00 Riyadh
  const reports = [];
  for (let minute = 0; minute < max; minute += 1) {
    const claimed = await claimScheduledWatchRuns(ctx, { nowMs: start + minute * 60_000 });
    if (!claimed.runs.length) continue;
    const report = await processWatchRuns(ctx, {
      ids: claimed.runs.map((run) => run.id),
      nowMs: start + minute * 60_000,
    });
    reports.push({ attempts: claimed.runs[0].attempts, report });
    if (report.completed) break;
  }
  return reports;
}

// 1. One store down: retries first, then completes with the others.
{
  const { ctx, watch, watchStore } = await setup();
  const reports = await runSlot(ctx, 40);
  const first = reports[0];
  ok(first.report.retrying === 1 && first.report.lines[0].resolution === RESOLUTION.PROVIDER_ERROR,
    'a failing store makes the first attempt retry');
  const done = reports.at(-1);
  ok(done.report.completed === 1, 'the round completes instead of starving');
  ok(done.attempts === MARKET_PARTIAL_SWEEP_AFTER_ATTEMPTS,
    `it completes on attempt ${MARKET_PARTIAL_SWEEP_AFTER_ATTEMPTS} (${done.attempts})`);
  const line = done.report.lines[0];
  ok(line.resolution === RESOLUTION.OK, `partial sweep resolves (${line.resolution})`);
  ok(line.partialCoverage?.failed === 1 && line.partialCoverage.attempted === MONITOR_PROVIDERS.length,
    'the line records which share of stores answered');
  ok(line.notes.some((note) => /did not answer/.test(note)), 'the missing store is noted');
  ok(line.alerted && line.alertType === 'target', 'a hit seen on a partial sweep still alerts');
  const saved = await watchStore.get(watch.id);
  ok(saved.isBelow === true, 'the hit arms the watch');
}

// 2. Already below target; a partial sweep sees only a higher price: stay armed.
{
  const { ctx, watch, watchStore } = await setup({
    answering: { panda: [{ ...listing, price: 9.5 }] },
    state: { isBelow: true },
  });
  await runSlot(ctx, 40);
  const saved = await watchStore.get(watch.id);
  ok(saved.isBelow === true, 'a partial sweep never re-arms a below-target watch');
  ok(saved.lastResolution === RESOLUTION.OK, 'the round is still recorded as resolved');
}

// 3. Every store down: still a provider error, the round keeps retrying.
{
  const { ctx } = await setup({ failing: [...MONITOR_PROVIDERS] });
  const reports = await runSlot(ctx, MARKET_PARTIAL_SWEEP_AFTER_ATTEMPTS + 3);
  ok(reports.every((r) => r.report.retrying === 1), 'no answers at all never completes the round');
}

// 4. Every store answered (one with nothing): complete on the first attempt.
{
  const { ctx } = await setup({ failing: [] });
  const reports = await runSlot(ctx, 3);
  ok(reports.length === 1 && reports[0].report.completed === 1,
    'an empty answer is an answer: the round completes at once');
  ok(!reports[0].report.lines[0].partialCoverage, 'a full sweep is not marked partial');
}

console.log(`watchPartialSweep.test: ${passed} passed, 0 failed`);
