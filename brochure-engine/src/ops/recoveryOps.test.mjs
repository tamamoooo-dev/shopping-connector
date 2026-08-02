// ops/recoveryOps.test.mjs — S5.7: the Recovery Queue's operator surface.
//
// WHAT THESE TESTS DEFEND, in priority order:
//
//  1. NOTHING SPENDS WITHOUT AN OPERATOR (C-8). Every mutating route is
//     confirm-gated, dismissal needs a TYPED confirmation because it is
//     terminal, and an unarmed Auto drain makes no provider call. These are the
//     assertions that stand between a stray request and a bill.
//  2. THE CONSOLE STAYS PROCESSOR-AGNOSTIC (C-9). The panel payload is built
//     from the registry, so a processor invented in this file shows up in the
//     console, is dispatchable, and appears in the effectiveness report —
//     without the console knowing it exists.
//  3. MANUAL DOES NOT CONSULT THE POLICY. An operator choosing a processor IS
//     the authorisation; refusing that because Auto is off would be the tool
//     overriding the person.
//  4. A MISSING MIGRATION RENDERS AS ITSELF, not as an empty queue.

import assert from 'node:assert/strict';
import { handleOps, OPS_PATH } from './console.js';
import { recoverySnapshot } from './status.js';
import { createD1EnrichStore } from '../storage/enrichStore.js';
import { createRecoveryQueue, RECOVERY_STATUS } from '../storage/recoveryQueue.js';
import { createSqliteD1, insertOffers } from '../storage/testSqliteD1.mjs';
import { createMemoryOpsStore } from '../storage/local.js';
import { buildStructuredProduct } from '../lexicon/structuredProduct.js';
import { evaluateBusinessAcceptance } from '../offers/businessAcceptance.js';
import { recoveryAdmission } from '../offers/enrich.js';
import { createRecoveryRegistry, defineProcessor } from '../recovery/registry.js';
// The REAL human processor: these tests are about the routes that drive it, so
// substituting a stub would test the harness instead of the surface.
import human from '../recovery/processors/human.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('S5.7 Recovery Queue operations surface:');

const FULL = [
  'schema.sql',
  'migrate-2026-07-vision-first-queue.sql',
  'migrate-2026-07-26-acceptance-verdicts.sql',
  'migrate-2026-07-27-recovery-queue.sql',
];
const AT = '2026-07-20T01:00:00.000Z';
const OFFER = 'a:r:d4d:1';
const B = 'https://engine.test' + OPS_PATH;
const auth = { Authorization: 'Bearer test-ops-token' };

const sizeless = buildStructuredProduct({ name_en: 'Arwa Bottled Water', brand: 'Arwa' });
const complete = buildStructuredProduct({ name_en: 'Arwa Bottled Water 330 ml', brand: 'Arwa', size: '330 ml' });

function memoryObjectStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes) { objects.set(key, { bytes }); },
    async get(key) { return objects.get(key) || null; },
    async delete(key) { objects.delete(key); },
  };
}

// A processor that exists ONLY in this test file — the C-9 console assertion.
let ranWith = [];
const invented = defineProcessor({
  id: 'invented-processor',
  label: 'Invented',
  description: 'Exists only in this test.',
  addresses: ['comparable_quantity'],
  costHint: { per: 'offer', requests: 2 },
  credential: 'ocr',
  run: async (item, pctx) => {
    ranWith.push(pctx);
    return {
      canonicalRow: {
        id: item.offerId, name: 'Arwa Bottled Water', size: '330 ml',
        corroboration: 1, enriched_at: AT, structured_product: complete,
      },
      attempt: {
        offerId: item.offerId, source: 'invented-processor', output: {},
        validation: { acceptedFields: ['name_en', 'size'] }, confidence: null,
        model: 'invented', cropUrl: null, accepted: 1, attemptedAt: AT,
      },
      cost: { requests: 2 },
    };
  },
});

async function buildCtx({ without = [], processors = [invented] } = {}) {
  const { db, raw, close } = createSqliteD1(FULL, { without });
  // valid_to must outlive the WALL CLOCK, not the fixture date. Every route
  // under test reaches the queue through the ops HTTP surface, which resolves
  // `currentOn` from todayISO() internally and has no injection point, and the
  // queue selection filters `o.valid_to >= currentOn`. With offerRow's default
  // (2026-07-31) these tests passed until that date and then reported
  // 'scanned: 0' forever — a time bomb, not a regression.
  insertOffers(raw, [{ id: OFFER, valid_to: '2099-01-01' }]);
  const enrichStore = createD1EnrichStore(db);
  const recoveryQueue = createRecoveryQueue(db);
  const verdict = evaluateBusinessAcceptance({
    offer: { price: 5.99, currency: 'SAR' },
    acceptedFields: ['name_en'],
    structured: sizeless,
  });
  const canonicalRow = {
    id: OFFER, name: 'Arwa Bottled Water', corroboration: 1,
    enriched_at: AT, structured_product: sizeless,
  };
  await enrichStore.saveVisionOutcome({
    attempt: {
      offerId: OFFER, source: 'vision', output: {},
      validation: { acceptedFields: ['name_en'], fields: { name_en: { status: 'Accepted', value: 'Arwa Bottled Water' } } },
      confidence: null, model: 'primary', cropUrl: 'https://cdn.example/c.jpg',
      accepted: 1, attemptedAt: AT,
    },
    canonicalRow,
    acceptance: verdict,
    recovery: recoveryAdmission({ canonicalRow, acceptance: verdict }),
  });
  return {
    close,
    ctx: {
      registry: {},
      enrichStore,
      recoveryQueue,
      recoveryRegistry: createRecoveryRegistry(processors),
      objectStore: memoryObjectStore(),
      opsStore: createMemoryOpsStore(),
      opsToken: 'test-ops-token',
      mistralOcrKey: 'ocr-key',
      mistralKey: 'vision-key',
    },
  };
}

const get = (ctx, path) => handleOps(new Request(B + path, { headers: auth }), ctx);
const post = (ctx, path, body) => handleOps(new Request(B + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify(body),
}), ctx);

// --- 1. nothing spends without an operator (C-8) ---------------------------

await test('every mutating recovery route refuses without confirmation', async () => {
  const { ctx, close } = await buildCtx();
  for (const path of ['/api/recovery/dispatch', '/api/recovery/drain', '/api/recovery/policy', '/api/recovery/reopen']) {
    const r = await post(ctx, path, { processor: 'invented-processor', offerIds: [OFFER] });
    assert.equal(r.status, 428, `${path} must demand confirmation`);
  }
  close();
});

await test('dismissal demands a TYPED confirmation because it is terminal', async () => {
  const { ctx, close } = await buildCtx();
  const bare = await post(ctx, '/api/recovery/dismiss', { confirm: true, offerIds: [OFFER] });
  assert.equal(bare.status, 428, 'confirm:true is not enough for a terminal act');
  const typed = await post(ctx, '/api/recovery/dismiss', { confirm: 'DISMISS', offerIds: [OFFER] });
  assert.equal(typed.status, 200);
  assert.equal((await ctx.recoveryQueue.get(OFFER)).status, 'dismissed');
  close();
});

await test('an unarmed Auto drain makes NO processor call', async () => {
  ranWith = [];
  const { ctx, close } = await buildCtx();
  const r = await post(ctx, '/api/recovery/drain', { confirm: true });
  const body = await r.json();
  assert.equal(body.report.skipped, true);
  assert.equal(body.report.reason, 'not_armed');
  assert.equal(ranWith.length, 0, 'a disarmed policy must not be able to spend');
  assert.equal((await ctx.recoveryQueue.get(OFFER)).status, 'queued');
  close();
});

await test('arming Auto is a policy write, and the drain then runs', async () => {
  const { ctx, close } = await buildCtx();
  const armed = await post(ctx, '/api/recovery/policy', {
    confirm: true, mode: 'auto', processors: ['invented-processor'],
  });
  assert.equal((await armed.json()).policy.armed, true);
  const drained = await post(ctx, '/api/recovery/drain', { confirm: true });
  const body = await drained.json();
  assert.equal(body.report.runs[0].recovered, 1);
  assert.equal((await ctx.recoveryQueue.get(OFFER)).status, 'resolved');
  close();
});

await test('arming a processor that does not exist fails loudly, not silently', async () => {
  const { ctx, close } = await buildCtx();
  const r = await post(ctx, '/api/recovery/policy', {
    confirm: true, mode: 'auto', processors: ['typo-processor'],
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Unknown recovery processor/);
  close();
});

// --- 2. the console stays processor-agnostic (C-9) -------------------------

await test('C-9: a processor invented in this test appears in the console payload', async () => {
  const { ctx, close } = await buildCtx();
  const body = await (await get(ctx, '/api/recovery')).json();
  assert.equal(body.available, true);
  const [p] = body.processors;
  assert.equal(p.id, 'invented-processor');
  assert.equal(p.label, 'Invented');
  assert.deepEqual(p.addresses, ['comparable_quantity']);
  assert.equal('run' in p, false, 'run() must not cross to the browser');
  assert.equal(body.depth.byStatus.queued, 1);
  assert.equal(body.depth.byMissingCondition.comparable_quantity, 1);
  close();
});

await test('C-9: it is dispatchable and lands in the effectiveness report', async () => {
  const { ctx, close } = await buildCtx();
  const r = await post(ctx, '/api/recovery/dispatch', {
    confirm: true, processor: 'invented-processor', limit: 5,
  });
  assert.equal((await r.json()).report.recovered, 1);
  const body = await (await get(ctx, '/api/recovery')).json();
  assert.equal(body.effectiveness['invented-processor'].recovered, 1);
  close();
});

await test('the declared credential is resolved and handed to the processor', async () => {
  ranWith = [];
  const { ctx, close } = await buildCtx();
  await post(ctx, '/api/recovery/dispatch', { confirm: true, processor: 'invented-processor' });
  assert.equal(ranWith.length, 1);
  assert.ok(ranWith[0].keyChain, 'a processor declaring credential:ocr gets a key chain');
  assert.equal(ranWith[0].keyChain.hasKeys(), true);
  close();
});

await test('a processor declaring NO credential is handed none', async () => {
  ranWith = [];
  const human = defineProcessor({
    id: 'human-rung', kind: 'human', run: async (item, pctx) => { ranWith.push(pctx); return {}; },
  });
  const { ctx, close } = await buildCtx({ processors: [human] });
  await post(ctx, '/api/recovery/dispatch', { confirm: true, processor: 'human-rung' });
  assert.equal(ranWith[0].keyChain, null, 'the human rung needs no provider');
  close();
});

await test('dispatching an unknown processor 404s with the available ids', async () => {
  const { ctx, close } = await buildCtx();
  const r = await post(ctx, '/api/recovery/dispatch', { confirm: true, processor: 'nope' });
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /invented-processor/);
  close();
});

// --- 3. Manual does not consult the policy ---------------------------------

await test('MANUAL dispatch works while Auto is disarmed — the choice IS the authorisation', async () => {
  const { ctx, close } = await buildCtx();
  const policy = await (await get(ctx, '/api/recovery')).json();
  assert.equal(policy.policy.armed, false, 'precondition: Auto is off');
  const r = await post(ctx, '/api/recovery/dispatch', { confirm: true, processor: 'invented-processor' });
  assert.equal((await r.json()).report.recovered, 1);
  close();
});

await test('an EXPLICIT empty selection is refused, not widened to the whole queue', async () => {
  // `offerIds: []` and an absent `offerIds` differ by one character in the body
  // and by an unbounded amount of paid model work in effect. The narrow one
  // must not become the wide one.
  const { ctx, close } = await buildCtx();
  const r = await post(ctx, '/api/recovery/dispatch', {
    confirm: true, processor: 'invented-processor', offerIds: [],
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /No offers selected/);
  const item = await (await get(ctx, `/api/recovery/history?id=${encodeURIComponent(OFFER)}`)).json();
  assert.equal(item.item.status, RECOVERY_STATUS.QUEUED, 'nothing was processed');
  close();
});

await test('dispatch is capped so one invocation cannot outrun its subrequest budget', async () => {
  const { ctx, close } = await buildCtx();
  const r = await post(ctx, '/api/recovery/dispatch', {
    confirm: true, processor: 'invented-processor', limit: 9999,
  });
  assert.equal(r.status, 200);
  const body = await (await get(ctx, '/api/recovery')).json();
  assert.equal(body.maxDispatch, 10, 'the cap is published so the console can forecast cost');
  close();
});

// --- 4. degraded states render as themselves -------------------------------

await test('a missing migration renders as itself, not as an empty queue', async () => {
  const { ctx, close } = await buildCtx({
    without: ['offer_recovery_queue', 'offer_recovery_attempts'],
  });
  const snapshot = await recoverySnapshot(ctx);
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.reason, 'migration_missing');
  assert.match(snapshot.message, /migration has not been applied/);
  close();
});

await test('a console with no recovery bound reports unavailable rather than throwing', async () => {
  const snapshot = await recoverySnapshot({});
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.reason, 'recovery_queue_unavailable');
});

await test('recovery routes require auth like every other console route', async () => {
  const { ctx, close } = await buildCtx();
  const r = await handleOps(new Request(B + '/api/recovery'), ctx);
  assert.equal(r.status, 401);
  close();
});

await test('the triage list carries the verdict and per-processor supportability', async () => {
  const { ctx, close } = await buildCtx();
  const body = await (await get(ctx, '/api/recovery/items?limit=10&processor=invented-processor')).json();
  const [item] = body.items;
  assert.equal(item.offerId, OFFER);
  assert.deepEqual(item.missing, ['comparable_quantity'], 'triageable without re-running the gate');
  assert.deepEqual(item.attemptedBy, ['vision']);
  assert.equal(item.supported, true);
  close();
});

// --- 5. S7 · the human review surface ---------------------------------------
//
// The routes, not the processor (humanReview.test.mjs owns that). What matters
// here is that REJECT and SEND BACK behave differently in the ways an operator
// would be hurt by if they did not: one is terminal, the other must cost the
// item nothing.

await test('the review payload carries the crop, the reasons and ONLY the blockers', async () => {
  const { ctx, close } = await buildCtx({ processors: [invented, human] });
  const body = await (await get(ctx, '/api/recovery/review?id=' + OFFER + '&processor=human')).json();
  assert.equal(body.processor, 'human');
  // The OFFER's crop, not the attempt's stored cropUrl: the reviewer judges the
  // product image, not whatever derived crop a model happened to be handed.
  assert.equal(body.plan.imageUrl, 'https://cdn.example/crop.jpg', 'the evidence is in the payload');
  assert.deepEqual(body.plan.blocking, ['comparable_quantity']);
  assert.deepEqual(body.plan.fields.map((f) => f.field), ['size', 'pack_count']);
  assert.ok(body.plan.advanced.some((f) => f.field === 'brand'), 'the rest is Advanced');
  close();
});

await test('a processor with no review surface is refused a review payload', async () => {
  const { ctx, close } = await buildCtx({ processors: [invented, human] });
  const r = await get(ctx, '/api/recovery/review?id=' + OFFER + '&processor=invented-processor');
  assert.equal(r.status, 400, 'the console asks for a capability, never assumes one');
  close();
});

await test('review is confirm-gated like every other mutation', async () => {
  const { ctx, close } = await buildCtx({ processors: [invented, human] });
  const r = await post(ctx, '/api/recovery/review', { offerId: OFFER, decision: 'approve' });
  assert.equal(r.status, 428);
  close();
});

await test('APPROVE through the route resolves the item and reports it honestly', async () => {
  const { ctx, close } = await buildCtx({ processors: [invented, human] });
  const body = await (await post(ctx, '/api/recovery/review', {
    confirm: true, offerId: OFFER, processor: 'human',
    decision: 'approve', fields: { size: '330 ml' }, actor: 'dev@example',
  })).json();
  assert.equal(body.resolved, true);
  assert.equal(body.status, RECOVERY_STATUS.RESOLVED);
  assert.deepEqual(body.stillMissing, []);
  close();
});

await test('REJECT closes the item as dismissed, WITH an auditable trail', async () => {
  const { ctx, close } = await buildCtx({ processors: [invented, human] });
  const body = await (await post(ctx, '/api/recovery/review', {
    confirm: true, offerId: OFFER, processor: 'human',
    decision: 'reject', actor: 'dev@example', note: 'not a real product',
  })).json();
  assert.equal(body.status, RECOVERY_STATUS.DISMISSED);
  const item = await ctx.recoveryQueue.get(OFFER);
  assert.equal(item.status, RECOVERY_STATUS.DISMISSED);
  // A dismissal with no history would be unauditable — who rejected it, and
  // against which conditions, has to survive.
  const [attempt] = await ctx.recoveryQueue.history(OFFER);
  assert.equal(attempt.processor, 'human');
  assert.equal(attempt.actor, 'dev@example');
  assert.match(attempt.error, /not a real product/);
  close();
});

await test('SEND BACK requeues and costs the item NOTHING', async () => {
  const { ctx, close } = await buildCtx({ processors: [invented, human] });
  const body = await (await post(ctx, '/api/recovery/review', {
    confirm: true, offerId: OFFER, processor: 'human',
    decision: 'sendback', actor: 'dev@example',
  })).json();
  assert.equal(body.status, RECOVERY_STATUS.QUEUED);
  const item = await ctx.recoveryQueue.get(OFFER);
  assert.equal(item.status, RECOVERY_STATUS.QUEUED, 'available to any processor again');
  // THE POINT: `declined` consumes no attempt. If send-back spent one, a
  // reviewer triaging a queue would walk items into `exhausted` just by looking
  // at them and deciding they were not the right person to fix them.
  assert.equal(item.attempts, 0);
  const [attempt] = await ctx.recoveryQueue.history(OFFER);
  assert.equal(attempt.outcome, 'declined');
  close();
});

await test('an unknown decision is refused rather than guessed', async () => {
  const { ctx, close } = await buildCtx({ processors: [invented, human] });
  const r = await post(ctx, '/api/recovery/review', {
    confirm: true, offerId: OFFER, processor: 'human', decision: 'maybe',
  });
  assert.equal(r.status, 400);
  close();
});

console.log(`\nS5.7 Recovery Queue operations surface: ${tests} tests OK`);
