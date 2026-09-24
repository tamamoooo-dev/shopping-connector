import assert from 'node:assert/strict';
import { enqueueBackground, consumeBackground } from './backgroundContinuation.js';
import { runEnrichDrain, runVisionVerificationDrain } from './scheduler.js';

const sent = [];
const queue = { async send(body, options) { sent.push({ body, options }); } };
const store = (status, last_error = null) => ({ async get() { return { status, last_error }; } });
for (const stage of ['vision', 'verification']) {
  await enqueueBackground(queue, store('running'), stage);
  assert.deepEqual(sent.at(-1), { body: { stage }, options: { delaySeconds: 0 } });
}
const before = sent.length;
for (const state of ['stopped', 'done', 'error']) await enqueueBackground(queue, store(state), 'vision');
assert.equal(sent.length, before, 'terminal/stopped jobs do not restart');
await enqueueBackground(queue, store('running', 'provider unavailable'), 'vision');
assert.equal(sent.at(-1).options.delaySeconds, 60, 'only failed work backs off');
let acked = false, finished = false, retry = null;
const message = { body: { stage: 'verification' }, ack() { assert.ok(finished); acked = true; }, retry(opts) { retry = opts; } };
await consumeBackground({ messages: [message] }, {}, async (event, env, ctx) => {
  assert.equal(event.backgroundStage, 'verification');
  ctx.waitUntil(Promise.resolve().then(() => { finished = true; }));
});
assert.ok(acked, 'message is acknowledged only after durable work finishes');
acked = false;
await consumeBackground({ messages: [message] }, {}, async () => { throw Error('test failure'); });
assert.equal(acked, false);
assert.deepEqual(retry, { delaySeconds: 60 });
for (const drain of [runEnrichDrain, runVisionVerificationDrain]) {
  let calls = 0;
  await drain(async () => { calls++; return { failed: 0 }; }, {
    pending: 28, batchSize: 1, maxBatches: 28,
    shouldContinue: async () => calls < 1,
  });
  assert.equal(calls, 1, 'operator stop prevents dispatch of the next product');
}
console.log('background continuation: immediate handoff, terminal stop, awaited completion and retry passed');
