import assert from 'node:assert/strict';
import {
  CPU_SAFE_BACKGROUND_DRAIN,
  createResolutionDispatcher,
  isDailyEmptyResolutionTick,
  runDrainLanes,
  runEnrichDrain,
  runVisionVerificationDrain,
} from './scheduler.js';

console.log('CPU-safe background drains:');

assert.equal(isDailyEmptyResolutionTick(Date.UTC(2026, 7, 25, 0, 10)), true);
assert.equal(isDailyEmptyResolutionTick(Date.UTC(2026, 7, 25, 0, 30)), false);
assert.equal(isDailyEmptyResolutionTick(Date.UTC(2026, 7, 25, 1, 10)), false);
console.log('  ok  empty-queue Registry repair keeps one daily safety tick');

for (const [name, run] of [
  ['Stage 1', runEnrichDrain],
  ['Stage 2', runVisionVerificationDrain],
]) {
  const calls = [];
  const report = await run(async (limit) => {
    calls.push(limit);
    return name === 'Stage 1'
      ? { enriched: 1 }
      : { verified: 1, unmatched: 0 };
  }, { pending: 200, ...CPU_SAFE_BACKGROUND_DRAIN });
  // Workers Paid: four offers per child, still at most 28 SELF children.
  assert.equal(report.batches, 28);
  assert.deepEqual(calls, Array(28).fill(4));
  console.log(`  ok  ${name} batches four offers per child and stays below the SELF invocation ceiling`);
}

for (const [name, run] of [
  ['Stage 1', runEnrichDrain],
  ['Stage 2', runVisionVerificationDrain],
]) {
  let calls = 0;
  const providerLimit = {
    status: 429,
    category: 'request_allowance_zero',
    limitRequestsMinute: '0',
    remainingRequestsMinute: '0',
  };
  const report = await run(async () => {
    calls += 1;
    return { failed: 1, errors: ['mistral 429'], providerLimit, providerError: { category: providerLimit.category } };
  }, { pending: 100, ...CPU_SAFE_BACKGROUND_DRAIN });
  assert.equal(calls, 1);
  assert.equal(report.batches, 1);
  assert.equal(report.failed, 1);
  assert.equal(report.providerLimit.category, 'request_allowance_zero');
  console.log(`  ok  ${name} stops the 28-child fan-out on an HTTP-200 failure report`);
}

for (const [name, run] of [
  ['Stage 1', runEnrichDrain],
  ['Stage 2', runVisionVerificationDrain],
]) {
  const calls = [];
  const candidateIds = ['offer-1', 'offer-2', 'offer-3'];
  const report = await run(async (ids) => {
    calls.push(ids);
    return name === 'Stage 1' ? { enriched: ids.length } : { verified: ids.length };
  }, { pending: 100, batchSize: 1, maxBatches: 28, candidateIds });
  assert.deepEqual(calls, candidateIds.map((id) => [id]));
  assert.equal(report.batches, 3);
  assert.equal(report.enriched, 3);
  console.log(`  ok  ${name} dispatches coordinator-selected ids without child queue rescans`);
}

{
  let request;
  const dispatch = createResolutionDispatcher({
    ingestSecret: 'secret',
    tag: 'ops',
    self: {
      async fetch(url, init) {
        request = { url, init };
        return new Response(JSON.stringify({ scanned: 25, attached: 10 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
  const result = await dispatch(25);
  assert.equal(result.scanned, 25);
  assert.equal(request.url, 'https://brochure-engine.internal/resolve?limit=25');
  assert.equal(request.init.headers['X-Ingest-Secret'], 'secret');
  assert.equal(request.init.headers['X-Ops-Origin'], 'ops');
  console.log('  ok  registry resolution runs in a detached SELF child');
}

{
  // Lanes: one fire's 112 candidates run as concurrent sequential drains.
  const ids = Array.from({ length: 112 }, (_, i) => `offer-${String(i).padStart(3, '0')}`);
  const seen = [];
  let inFlight = 0;
  let peak = 0;
  const report = await runDrainLanes(runEnrichDrain, async (batch) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    seen.push(batch);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    return { enriched: batch.length };
  }, { lanes: 3, candidateIds: ids, ...CPU_SAFE_BACKGROUND_DRAIN });
  assert.equal(report.lanes, 3);
  assert.equal(report.batches, 28, 'the child count is unchanged by lanes');
  assert.equal(report.enriched, 112);
  assert.equal(peak, 3, 'three children run at once, never more');
  assert.deepEqual(seen.flat().sort(), ids, 'every candidate is dispatched exactly once');
  // Expiry-first survives: the three lanes open with the three soonest batches.
  assert.deepEqual(seen.slice(0, 3).map((batch) => batch[0]).sort(), ['offer-000', 'offer-004', 'offer-008']);
  console.log('  ok  lanes run one fire in parallel, same 28 children, expiry order kept');
}

{
  // A lane that meets a spent window stops alone; the others carry on.
  const providerLimit = { status: 429, category: 'rate_limit' };
  const report = await runDrainLanes(runEnrichDrain, async (batch) => (
    batch.includes('offer-1')
      ? { failed: 1, errors: ['mistral 429'], providerLimit }
      : { enriched: batch.length }
  ), {
    lanes: 2,
    candidateIds: ['offer-0', 'offer-1', 'offer-2', 'offer-3', 'offer-4', 'offer-5'],
    batchSize: 1,
    maxBatches: 28,
  });
  // Lane A: offer-0, offer-2, offer-4 (3 ok). Lane B: offer-1 fails, stops.
  assert.equal(report.enriched, 3);
  assert.equal(report.failed, 1);
  assert.equal(report.batches, 4);
  assert.equal(report.providerLimit.category, 'rate_limit');
  console.log('  ok  a rate-limited lane stops alone and leaves its offers for the next fire');
}

{
  // The dispatch window ends a fire before the next one is due.
  let clock = 0;
  let calls = 0;
  const report = await runDrainLanes(runVisionVerificationDrain, async (batch) => {
    calls += 1;
    clock += 60_000;
    return { verified: batch.length, unmatched: 0 };
  }, {
    lanes: 1,
    candidateIds: Array.from({ length: 40 }, (_, i) => `o${i}`),
    batchSize: 4,
    maxBatches: 28,
    deadlineMs: 180_000,
    now: () => clock,
  });
  assert.equal(calls, 3, 'no child is dispatched once the window has passed');
  assert.equal(report.verified, 12);
  console.log('  ok  the dispatch window stops new children');
}

{
  // Fewer batches than lanes: one lane per batch, no empty lanes.
  const report = await runDrainLanes(runVisionVerificationDrain, async (batch) => (
    { verified: 1, unmatched: batch.length - 1 }
  ), { lanes: 3, candidateIds: ['a', 'b', 'c', 'd', 'e'], batchSize: 4, maxBatches: 28 });
  assert.equal(report.lanes, 2);
  assert.equal(report.verified, 2);
  assert.equal(report.unmatched, 3);
  const empty = await runDrainLanes(runEnrichDrain, async () => { throw new Error('never'); }, { lanes: 3, candidateIds: [] });
  assert.equal(empty.batches, 0);
  console.log('  ok  lanes never exceed the batches and an empty fire dispatches nothing');
}

console.log('\nCPU-safe background drains: 10 tests OK');
