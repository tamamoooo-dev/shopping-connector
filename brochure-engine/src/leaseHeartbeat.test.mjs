// Vision lease heartbeat (2026-11-19). On 2026-11-18, 8 of 18 Background
// Vision hops died without recording anything and each then held the
// 15-minute lease, so the drain sat idle 15-48 minutes at a time. A hop now
// holds a short lease that a timer renews while the hop is alive.
import assert from 'node:assert/strict';
import {
  HEARTBEAT_LEASE_MS,
  LEASE_HEARTBEAT_EVERY_MS,
  runDrainLanes,
  runEnrichDrain,
  startLeaseHeartbeat,
} from './scheduler.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; console.log(`  ok  ${message}`); };

console.log('Vision lease heartbeat:');

// A manual clock: the test fires the interval callback itself.
function manualTimer() {
  const state = { callback: null, everyMs: null, cleared: false };
  return {
    state,
    setIntervalImpl(callback, everyMs) { state.callback = callback; state.everyMs = everyMs; return 1; },
    clearIntervalImpl() { state.cleared = true; },
  };
}

ok(HEARTBEAT_LEASE_MS >= 3 * LEASE_HEARTBEAT_EVERY_MS,
  'the lease outlives two missed beats (a D1 hiccup is not a lost lease)');
ok(HEARTBEAT_LEASE_MS <= 5 * 60 * 1000,
  'a dead hop frees the drain within five minutes, not fifteen');

// 1. Every beat renews the lease for the full lease length.
{
  const calls = [];
  const store = { async renewLease(args) { calls.push(args); return true; } };
  const timer = manualTimer();
  let t = 1_000;
  const hb = startLeaseHeartbeat(store, { now: () => t, ...timer });
  ok(timer.state.everyMs === LEASE_HEARTBEAT_EVERY_MS, 'beats once a minute');
  await timer.state.callback();
  t = 61_000;
  await timer.state.callback();
  ok(calls.length === 2 && calls[1].nowMs === 61_000 && calls[1].leaseMs === HEARTBEAT_LEASE_MS,
    'each beat extends the lease from now');
  ok(hb.lost === false, 'a renewed lease is not lost');
  await hb.stop();
  ok(timer.state.cleared, 'stop() clears the timer');
  await hb.beat();
  ok(calls.length === 2, 'no beat after stop()');
}

// 2. A failed D1 write is skipped; a refused renewal marks the lease lost.
{
  const answers = [new Error('D1 DB is overloaded'), false];
  const store = { async renewLease() { const a = answers.shift(); if (a instanceof Error) throw a; return a; } };
  const timer = manualTimer();
  const hb = startLeaseHeartbeat(store, timer);
  await timer.state.callback();
  ok(hb.lost === false, 'a D1 error does not give the lease up');
  await timer.state.callback();
  ok(hb.lost === true, 'a renewal the store refuses means another hop owns the drain');
  await hb.stop();
}

// 3. Beats never overlap: a slow renewal is not stacked.
{
  let calls = 0;
  let release;
  const store = { renewLease() { calls += 1; return new Promise((r) => { release = r; }); } };
  const timer = manualTimer();
  const hb = startLeaseHeartbeat(store, timer);
  const first = timer.state.callback();
  timer.state.callback();
  await new Promise((r) => setTimeout(r, 0));
  ok(calls === 1, 'a beat waits for the previous renewal');
  release(true);
  await first;
  await hb.stop();
}

// 4. A store without renewLease (tests, older fakes) gets an inert heartbeat.
{
  const timer = manualTimer();
  const hb = startLeaseHeartbeat({}, timer);
  await timer.state.callback();
  ok(hb.lost === false, 'no renewLease → nothing renewed, nothing lost');
  await hb.stop();
}

// 5. A lost lease stops the lanes from dispatching more children.
{
  let lost = false;
  const dispatched = [];
  const report = await runDrainLanes(runEnrichDrain, async (ids) => {
    dispatched.push(ids);
    if (dispatched.length === 2) lost = true;
    return { enriched: ids.length };
  }, {
    lanes: 1,
    candidateIds: Array.from({ length: 20 }, (_, i) => `offer-${i}`),
    batchSize: 4,
    maxBatches: 28,
    shouldContinue: async () => !lost,
  });
  ok(dispatched.length === 2 && report.enriched === 8, 'the hop stops dispatching once its lease is lost');
}

console.log(`\nAll ${passed} lease heartbeat checks passed.`);
