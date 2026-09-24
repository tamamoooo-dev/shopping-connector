import assert from 'node:assert/strict';
import {
  CPU_SAFE_BACKGROUND_DRAIN,
  createResolutionDispatcher,
  isDailyEmptyResolutionTick,
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
  }, { pending: 100, ...CPU_SAFE_BACKGROUND_DRAIN });
  assert.equal(report.batches, 28);
  assert.deepEqual(calls, Array(28).fill(1));
  console.log(`  ok  ${name} isolates every offer and stays below the SELF invocation ceiling`);
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

console.log('\nCPU-safe background drains: 6 tests OK');
