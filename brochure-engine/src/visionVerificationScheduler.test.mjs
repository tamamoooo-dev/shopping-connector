import assert from 'node:assert/strict';
import {
  createVisionVerificationDispatcher,
  runVisionVerificationDrain,
} from './scheduler.js';

console.log('Vision Verification live/background drain scheduler:');

{
  const calls = [];
  const report = await runVisionVerificationDrain(async (limit) => {
    calls.push(limit);
    return { verified: 2, unmatched: 1 };
  }, { pending: 31, batchSize: 15, maxBatches: 2 });
  assert.deepEqual(calls, [15, 15]);
  assert.equal(report.batches, 2);
  assert.equal(report.verified, 4);
  assert.equal(report.unmatched, 2);
  console.log('  ok  copied Stage 1 pacing and batch cap');
}

{
  let request;
  const dispatch = createVisionVerificationDispatcher({
    ingestSecret: 'secret',
    tag: 'ops',
    self: {
      async fetch(url, init) {
        request = { url, init };
        return new Response(JSON.stringify({ verified: 1, unmatched: 0 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
  const body = await dispatch(15);
  assert.equal(body.verified, 1);
  assert.equal(request.url, 'https://brochure-engine.internal/vision-verification?limit=15');
  assert.equal(request.init.headers['X-Ingest-Secret'], 'secret');
  assert.equal(request.init.headers['X-Ops-Origin'], 'ops');
  console.log('  ok  copied dispatcher uses the guarded Stage 2 child route');
}

{
  let request;
  const dispatch = createVisionVerificationDispatcher({
    ingestSecret: 'secret',
    self: {
      async fetch(url) {
        request = url;
        return new Response(JSON.stringify({ verified: 2 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  });
  await dispatch(['store:r:d4d:1', 'store:r:d4d:2']);
  assert.equal(
    request,
    'https://brochure-engine.internal/vision-verification?ids=store%3Ar%3Ad4d%3A1%2Cstore%3Ar%3Ad4d%3A2',
  );
  console.log('  ok  coordinator ids reach the guarded child route');
}

console.log('\nVision Verification scheduler: 3 tests OK');
