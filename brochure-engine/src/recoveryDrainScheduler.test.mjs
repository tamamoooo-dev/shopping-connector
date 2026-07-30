import assert from 'node:assert/strict';
import {
  createRecoveryDrainDispatcher,
  runRecoveryDrainFanOut,
} from './scheduler.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Recovery background drain scheduler:');

await test('runs sequential fresh-invocation batches and aggregates progress', async () => {
  let calls = 0;
  const report = await runRecoveryDrainFanOut(async () => {
    calls += 1;
    return {
      reconciledAsIs: { resolved: calls === 1 ? 500 : 0 },
      runs: [{ scanned: 15, attempted: 15, recovered: 12, failed: 0 }],
    };
  }, { maxBatches: 4 });
  assert.equal(calls, 4);
  assert.equal(report.batches, 4);
  assert.equal(report.scanned, 60);
  assert.equal(report.attempted, 60);
  assert.equal(report.recovered, 48);
  assert.equal(report.reconciledAsIs, 500);
});

await test('stops as soon as a child sees an empty queue', async () => {
  let calls = 0;
  const report = await runRecoveryDrainFanOut(async () => {
    calls += 1;
    return { runs: [{ scanned: calls === 1 ? 10 : 0, attempted: 10, failed: 0 }] };
  }, { maxBatches: 4 });
  assert.equal(calls, 2);
  assert.equal(report.batches, 2);
});

await test('stops after a provider failure instead of multiplying it', async () => {
  let calls = 0;
  const report = await runRecoveryDrainFanOut(async () => {
    calls += 1;
    return { runs: [{ scanned: 15, attempted: 0, failed: 1, providerLimit: { status: 429 } }] };
  }, { maxBatches: 4 });
  assert.equal(calls, 1);
  assert.equal(report.failed, 1);
});

await test('dispatcher calls the guarded internal recovery route', async () => {
  let request = null;
  const dispatch = createRecoveryDrainDispatcher({
    self: {
      async fetch(url, init) {
        request = { url, init };
        return new Response(JSON.stringify({ runs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
    ingestSecret: 'secret',
  });
  await dispatch();
  assert.equal(request.url, 'https://brochure-engine.internal/recovery-drain');
  assert.equal(request.init.method, 'POST');
  assert.equal(request.init.headers['X-Ingest-Secret'], 'secret');
});

console.log(`\nRecovery background drain scheduler: ${tests} tests OK`);
