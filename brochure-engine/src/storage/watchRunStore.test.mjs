import assert from 'node:assert/strict';
import { createD1WatchRunStore, createMemoryWatchRunStore } from './watchRunStore.js';
import { latestRiyadhSlot } from '../watchPlan.js';
import { createSqliteD1 } from './testSqliteD1.mjs';
import { createD1WatchStore } from './watchStore.js';

const store = createMemoryWatchRunStore();
const morningMs = Date.parse('2026-08-25T04:00:00Z');
const watch = { id: 'w1', active: true, createdAt: '2026-08-24T20:00:00Z' };
assert.equal(await store.ensureForSlot([watch], latestRiyadhSlot(morningMs), morningMs), 1);
assert.equal(await store.ensureForSlot([watch], latestRiyadhSlot(morningMs), morningMs), 0);
let [run] = await store.claimDue(morningMs, 3);
assert.equal(run.attempts, 1);
await store.finish(run.id, run.leaseToken, { resolution: 'provider-error', notes: ['blocked'] }, { retryable: true, nowMs: morningMs });
assert.equal((await store.get(run.id)).status, 'retrying');
assert.equal((await store.claimDue(morningMs + 59_000)).length, 0);
[run] = await store.claimDue(morningMs + 60_000);
assert.equal(run.attempts, 2);
await store.finish(run.id, run.leaseToken, { resolution: 'ok', price: 10 }, { nowMs: morningMs + 60_000 });
assert.equal((await store.get(run.id)).status, 'completed');
assert.equal((await store.claimDue(morningMs + 120_000)).length, 0);
const eveningMs = Date.parse('2026-08-25T16:00:00Z');
assert.equal(await store.ensureForSlot([watch], latestRiyadhSlot(eveningMs), eveningMs), 1);
assert.equal((await store.latestForWatchIds(['w1'])).get('w1').slotKey, '2026-08-25-PM');

// The production D1 implementation creates a whole slot with set-based SQL.
const fixture = createSqliteD1(['schema.sql']);
try {
  const watchStore = createD1WatchStore(fixture.db);
  await watchStore.create({
    id: 'w_d1', profileId: 'profile-d1-runs', kind: 'product', label: 'Exact item',
    query: 'Exact item', watchTrack: 'amazon_exact', provider: 'amazon',
    productId: 'B012345678', targetPrice: 10, currency: 'SAR', active: true,
    anchorState: 'anchored_source', createdAt: '2026-08-25T03:59:00.000Z',
  });
  const d1Runs = createD1WatchRunStore(fixture.db);
  assert.equal(await d1Runs.ensureForSlot([], latestRiyadhSlot(morningMs), morningMs), 1);
  assert.equal(await d1Runs.ensureForSlot([], latestRiyadhSlot(morningMs), morningMs), 0);
  assert.equal((await d1Runs.claimDue(morningMs, 3))[0].watchId, 'w_d1');
} finally {
  fixture.close();
}

// Retention (2026-11-12): settled rounds past the cutoff go, but never a
// watch's newest round, and never an open one. Both twins, same cases.
const pruneCases = [
  // [id, watch, scheduled_at, status]
  ['r_old_done', 'wa', '2026-09-01T04:00:00.000Z', 'completed'],
  ['r_old_inc', 'wa', '2026-09-02T04:00:00.000Z', 'incomplete'],
  ['r_new', 'wa', '2026-11-10T04:00:00.000Z', 'completed'],
  ['r_only', 'wb', '2026-08-01T04:00:00.000Z', 'completed'], // a paused watch's last result
  ['r_old_open', 'wc', '2026-09-01T04:00:00.000Z', 'retrying'],
  ['r_wc_new', 'wc', '2026-11-10T04:00:00.000Z', 'completed'],
];
const pruneCutoff = '2026-10-13T00:00:00.000Z';
const survivors = ['r_new', 'r_old_open', 'r_only', 'r_wc_new'];

const memPrune = createMemoryWatchRunStore();
for (const [id, watchId, scheduledAt, status] of pruneCases) {
  memPrune._runs.set(id, { id, watchId, scheduledAt, status, slotKey: scheduledAt.slice(0, 10) + '-AM' });
}
assert.equal(await memPrune.pruneBefore(pruneCutoff, { limit: 1 }), 1, 'the limit bounds one pass');
assert.equal(await memPrune.pruneBefore(pruneCutoff), 1);
assert.equal(await memPrune.pruneBefore(pruneCutoff), 0);
assert.deepEqual([...memPrune._runs.keys()].sort(), survivors);

const pruneFixture = createSqliteD1(['schema.sql']);
try {
  for (const [id, watchId, scheduledAt, status] of pruneCases) {
    await pruneFixture.db.prepare(
      `INSERT INTO watch_runs (id, watch_id, slot_key, slot_period, scheduled_at, status,
         next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, 'AM', ?, ?, ?, ?, ?)`,
    ).bind(id, watchId, scheduledAt.slice(0, 10) + '-AM', scheduledAt, status, scheduledAt, scheduledAt, scheduledAt).run();
  }
  const d1Prune = createD1WatchRunStore(pruneFixture.db);
  assert.equal(await d1Prune.pruneBefore(pruneCutoff, { limit: 1 }), 1, 'the limit bounds one pass');
  assert.equal(await d1Prune.pruneBefore(pruneCutoff), 1);
  assert.equal(await d1Prune.pruneBefore(pruneCutoff), 0);
  const { results } = await pruneFixture.db.prepare('SELECT id FROM watch_runs ORDER BY id').all();
  assert.deepEqual(results.map((row) => row.id), survivors);
} finally {
  pruneFixture.close();
}

console.log('watchRunStore.test: 21 passed, 0 failed');
