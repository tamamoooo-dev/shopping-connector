// Nothing in a drain may wait forever (2026-10-09): a hung SELF child or a
// provider connection used to hold its lane, the coordinator and the Vision
// lease until the cron invocation was killed with no audit row.
import assert from 'node:assert/strict';
import {
  createEnrichDispatcher,
  createVisionVerificationDispatcher,
  fetchSelfChild,
  runDrainLanes,
  runEnrichDrain,
  runVisionVerificationDrain,
} from './scheduler.js';
import { fetchWithTimeout, MISTRAL_URL, postMistral } from './offers/enrich.js';
import { classifyMistralError } from './offers/mistralKeys.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };

// A fetch that never answers unless aborted, recording the abort.
function hangingFetch(log) {
  return (url, init = {}) => new Promise((_, reject) => {
    init.signal?.addEventListener('abort', () => {
      log.push(url);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    });
  });
}

// 1. A child that never answers is abandoned after its timeout, and aborted.
{
  const aborted = [];
  const t0 = Date.now();
  await assert.rejects(
    fetchSelfChild({ fetch: hangingFetch(aborted) }, 'https://x/enrich', { method: 'POST' }, { timeoutMs: 30, label: 'enrich drain' }),
    (err) => err.timeout === true && /enrich drain -> no answer after/.test(err.message),
  );
  ok(Date.now() - t0 < 1000, 'the coordinator stops waiting at the timeout');
  ok(aborted.length === 1, 'the abandoned child request is aborted');
}

// 2. An answering child is unaffected.
{
  const self = { fetch: async () => new Response(JSON.stringify({ enriched: 2, failed: 0 })) };
  const { res, body } = await fetchSelfChild(self, 'https://x/enrich', {}, { timeoutMs: 1000 });
  ok(res.ok && body.enriched === 2, 'a normal child answers through');
}

// 3. Lanes over hung children stop and report, so the coordinator can record
//    its run and release the lease.
{
  const aborted = [];
  const self = { fetch: hangingFetch(aborted) };
  const ids = Array.from({ length: 12 }, (_, i) => `o${i}`);
  const t0 = Date.now();
  const stageOne = await runDrainLanes(runEnrichDrain, createEnrichDispatcher({ self, ingestSecret: 's', childTimeoutMs: 30 }), {
    lanes: 3, candidateIds: ids, batchSize: 2, maxBatches: 6,
  });
  ok(Date.now() - t0 < 1500, 'three hung lanes end at roughly one child timeout');
  ok(stageOne.failed === 3 && stageOne.ok === 0 && stageOne.batches === 3,
    'each lane stops at its first hung child (stop-on-failed-child kept)');
  ok(/no answer after/.test(stageOne.lines[0].error), 'the reason is reported');

  const stageTwo = await runDrainLanes(runVisionVerificationDrain, createVisionVerificationDispatcher({ self, ingestSecret: 's', childTimeoutMs: 30 }), {
    lanes: 2, candidateIds: ids, batchSize: 3, maxBatches: 4,
  });
  ok(stageTwo.failed === 2 && stageTwo.ok === 0, 'Stage 2 lanes stop the same way');
}

// 4. Provider calls are time-boxed; a timeout fails over like a 5xx.
// (Node unrefs AbortSignal.timeout timers; keep the loop alive meanwhile.)
{
  const keepAlive = setInterval(() => {}, 1000);
  const aborted = [];
  await assert.rejects(
    postMistral(MISTRAL_URL, { model: 'ministral-14b-2512' }, { apiKey: 'k', fetchImpl: hangingFetch(aborted), stage: 'mistral', timeoutMs: 30 }),
    (err) => {
      ok(err.timeout === true && err.stage === 'mistral' && err.model === 'ministral-14b-2512', 'the timeout carries its stage and model');
      ok(classifyMistralError(err) === 'transient', 'a timeout is transient: the next key is tried');
      return true;
    },
  );
  ok(aborted.length === 1, 'the hung provider request is aborted');
  const passthrough = await fetchWithTimeout(async (url, init) => ({ url, signalled: !!init.signal }), 'https://cdn/x.jpg', {}, { timeoutMs: 1000 });
  ok(passthrough.signalled, 'a normal fetch carries the signal and answers through');
  clearInterval(keepAlive);
}

console.log(`drainTimeouts.test: ${passed} passed, 0 failed`);
