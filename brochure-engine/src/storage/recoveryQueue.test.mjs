// recoveryQueue.test.mjs — S5, the Recovery Queue platform, against the real
// migrations and a real SQL engine.
//
// WHAT THESE TESTS DEFEND, in priority order:
//
//  1. THE PLATFORM PROPERTY (C-9). The queue must not know what a processor IS.
//     This is the decision the whole design exists to buy, so it is asserted
//     mechanically — against the schema and the module source — rather than
//     left to review. If someone adds `ocr_attempts INTEGER` in two years, this
//     test is what stops it.
//  2. ONE ADMISSION RULE (C-9). Not a servable canonical product => queued,
//     whatever the cause. Including the two CROSSING populations that a
//     single-cause rule gets wrong: a Quality-Gate reject that PASSES S4, and
//     an S4 reject that PASSED the Quality Gate.
//  3. THE WRITE IS MIGRATION-TOLERANT AND ATOMIC. It rides inside the
//     extraction batch, so a missing table must degrade to pre-S5 behaviour
//     rather than cost extraction work.
//  4. TERMINAL OPERATOR DECISIONS SURVIVE (C-8/S7). `dismissed` is never undone
//     by an automatic path.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createD1EnrichStore } from './enrichStore.js';
import {
  createRecoveryQueue,
  isStaleClaimError,
  RECOVERY_OUTCOME,
  RECOVERY_STATUS,
} from './recoveryQueue.js';
import { createSqliteD1, insertOffers } from './testSqliteD1.mjs';
import { buildStructuredProduct } from '../lexicon/structuredProduct.js';
import { evaluateLegacyBusinessAcceptance as evaluateBusinessAcceptance } from '../offers/businessAcceptance.js';
import { recoveryAdmission } from '../offers/enrich.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('S5 Recovery Queue platform (C-8, C-9):');

// schema.sql is the FULL current schema and contains every table below — that
// is what makes a clean deployment work, and it is asserted at the bottom of
// this file. "The migration has not been applied yet" is therefore expressed by
// DROPPING the tables it would create, not by omitting a file.
const FULL = [
  'schema.sql',
  'migrate-2026-07-vision-first-queue.sql',
  'migrate-2026-07-26-acceptance-verdicts.sql',
  'migrate-2026-07-27-recovery-queue.sql',
];
const NO_RECOVERY = ['offer_recovery_queue', 'offer_recovery_attempts'];
const NO_VERDICTS = ['offer_acceptance_verdicts'];
const AT = '2026-07-20T01:00:00.000Z';
const TODAY = '2026-07-20';

function fresh(offers = [{ id: 'a:r:d4d:1' }], without = []) {
  const { db, raw, close } = createSqliteD1(FULL, { without });
  insertOffers(raw, offers);
  return { store: createD1EnrichStore(db), queue: createRecoveryQueue(db), db, raw, close };
}

const attempt = (offerId, { accepted = true, at = AT } = {}) => ({
  offerId,
  source: 'vision',
  output: { name_en: 'Arwa Water 330 ml' },
  validation: { acceptedFields: accepted ? ['name_en'] : [] },
  confidence: null,
  model: 'mistral-medium-latest',
  cropUrl: 'https://cdn.example/crop.jpg',
  accepted: accepted ? 1 : 0,
  attemptedAt: at,
});

const servableRow = (id) => ({
  id, name: 'Arwa Water 330 ml', name_ar: 'مياه أروى', corroboration: 1, enriched_at: AT,
});

const completeProduct = buildStructuredProduct({
  name_en: 'Arwa Bottled Water 330 ml', name_ar: 'مياه أروى', brand: 'Arwa', size: '330 ml',
});
const sizelessProduct = buildStructuredProduct({
  name_en: 'Arwa Bottled Water', name_ar: 'مياه أروى', brand: 'Arwa',
});

const acceptVerdict = evaluateBusinessAcceptance({
  offer: { price: 5.99, currency: 'SAR' },
  acceptedFields: ['name_en'],
  structured: completeProduct,
});
const rejectVerdict = evaluateBusinessAcceptance({
  offer: { price: 5.99, currency: 'SAR' },
  acceptedFields: ['name_en'],
  structured: sizelessProduct,
});

// --- 1. the platform property (C-9) ----------------------------------------

// Processor names that must never appear in structure. Comments discuss them
// freely — on purpose, since explaining what the schema does NOT encode is half
// of why C-9 survives — so both checks strip comments FULLY, trailing ones
// included. An incomplete stripper makes this test fire on prose, which is how
// a mechanical guard gets deleted for being noisy.
const PROCESSOR_NAMES = ['ocr', 'vision', 'medium', 'small', 'human', 'mistral'];

await test('C-9: the queue SCHEMA names no processor', async () => {
  const sql = readFileSync('migrate-2026-07-27-recovery-queue.sql', 'utf8');
  // Structure only: the one-time fold-in at the end reads the LEGACY table by
  // its real name, which is data migration rather than schema, so the check
  // stops where the DDL does.
  const ddl = sql
    .replace(/--[^\n]*/g, '')
    .split(/INSERT INTO offer_recovery_queue/)[0];
  for (const name of PROCESSOR_NAMES) {
    assert.equal(
      new RegExp(name, 'i').test(ddl), false,
      `processor name '${name}' leaked into the recovery queue DDL`,
    );
  }
  assert.match(ddl, /CREATE TABLE IF NOT EXISTS offer_recovery_queue/, 'DDL was located');
});

await test('C-9: the queue MODULE names no processor', async () => {
  const src = readFileSync('src/storage/recoveryQueue.js', 'utf8');
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  for (const name of PROCESSOR_NAMES) {
    assert.equal(
      new RegExp(name, 'i').test(code), false,
      `processor name '${name}' leaked into recoveryQueue.js`,
    );
  }
  assert.match(code, /export function createRecoveryQueue/, 'source was located');
});

await test('C-9: an unknown processor id is storable with no schema change', async () => {
  // A processor nobody has written yet must round-trip through queue and
  // reports untouched. This is "add Vision Large tomorrow" as an assertion.
  const f = fresh([{ id: 'a:r:d4d:9' }]);
  await f.store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:9', { accepted: false }),
    canonicalRow: null,
    acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  await f.queue.recordAttempt({
    offerId: 'a:r:d4d:9',
    processor: 'vision-large-2027',      // does not exist anywhere in the codebase
    outcome: RECOVERY_OUTCOME.NO_CHANGE,
    startedAt: AT,
    finishedAt: AT,
  });
  const eff = await f.queue.effectiveness();
  assert.equal(eff['vision-large-2027'].attempts, 1);
  assert.equal(eff['vision-large-2027'][RECOVERY_OUTCOME.NO_CHANGE], 1);
  f.close();
});

// --- 2. one admission rule (C-9) -------------------------------------------

await test('a servable, S4-ACCEPTED offer is NOT queued', async () => {
  const { store, queue, close } = fresh();
  const recovery = recoveryAdmission({
    canonicalRow: servableRow('a:r:d4d:1'), acceptance: acceptVerdict,
  });
  assert.equal(recovery.complete, true);
  const out = await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:1'),
    canonicalRow: servableRow('a:r:d4d:1'),
    acceptance: acceptVerdict,
    recovery,
  });
  assert.equal(out.recoveryQueued, false);
  assert.equal(await queue.get('a:r:d4d:1'), null, 'a complete offer must not create a queue row');
  close();
});

await test('CROSSING POPULATION A: passed the Quality Gate, FAILED S4 => queued', async () => {
  // The canonical row is written and servable, so the legacy ocr_queue rule
  // would never have seen this offer. C-9 admits it because a missing
  // comparable quantity means it is not a servable CANONICAL PRODUCT.
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:2' }]);
  const row = servableRow('a:r:d4d:2');
  const recovery = recoveryAdmission({ canonicalRow: row, acceptance: rejectVerdict });
  assert.equal(recovery.complete, false);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:2'), canonicalRow: row, acceptance: rejectVerdict, recovery,
  });
  const item = await queue.get('a:r:d4d:2');
  assert.equal(item.status, RECOVERY_STATUS.QUEUED);
  assert.deepEqual(item.reasons.acceptance.missing, ['comparable_quantity']);
  assert.equal(item.reasons.servable, true, 'servable is recorded as metadata, not as admission');
  // and the verdict is JOINED, not copied
  assert.deepEqual(item.verdict.missing, ['comparable_quantity']);
  close();
});

await test('CROSSING POPULATION B: failed the Quality Gate, PASSED S4 => queued', async () => {
  // No canonical row, so nothing is servable — admitted even though every
  // mandatory business condition holds. A pure "S4 reject" rule would strand it.
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:3' }]);
  const recovery = recoveryAdmission({
    canonicalRow: null,
    acceptance: acceptVerdict,
    triggerReasons: ['brand_missing_or_invalid'],
  });
  assert.equal(recovery.complete, false);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:3', { accepted: false }),
    canonicalRow: null,
    triggerReasons: ['brand_missing_or_invalid'],
    acceptance: acceptVerdict,
    recovery,
  });
  const item = await queue.get('a:r:d4d:3');
  assert.equal(item.status, RECOVERY_STATUS.QUEUED);
  assert.equal(item.reasons.servable, false);
  assert.deepEqual(item.reasons.qualityGate, ['brand_missing_or_invalid']);
  assert.deepEqual(item.reasons.acceptance.missing, [], 'S4 passed; the cause was the gate');
  close();
});

await test('a mandatory rule that did not run cannot fail (no verdict => servable decides)', async () => {
  const withRow = recoveryAdmission({ canonicalRow: servableRow('x'), acceptance: null });
  assert.equal(withRow.complete, true);
  assert.equal(withRow.reasons.acceptance, undefined);
  const without = recoveryAdmission({ canonicalRow: null, acceptance: null });
  assert.equal(without.complete, false);
});

await test('an unservable canonical row (low corroboration) is admitted', async () => {
  const weak = { ...servableRow('a:r:d4d:4'), corroboration: 0.1 };
  const recovery = recoveryAdmission({ canonicalRow: weak, acceptance: acceptVerdict });
  assert.equal(recovery.complete, false);
  assert.equal(recovery.reasons.servable, false);
});

// --- 3. migration tolerance and atomicity ----------------------------------

await test('without the migration the extraction is untouched and the LEGACY queue still fills', async () => {
  const { store, queue, raw, close } = fresh([{ id: 'a:r:d4d:5' }], NO_RECOVERY);
  const out = await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:5', { accepted: false }),
    canonicalRow: null,
    triggerReasons: ['brand_missing_or_invalid'],
    acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  assert.equal(out.stored, 1, 'the extraction must still commit');
  assert.equal(out.recoveryQueued, false);
  assert.equal(await queue.ready(), false);
  const legacy = raw.prepare('SELECT status FROM offer_ocr_queue WHERE offer_id = ?').get('a:r:d4d:5');
  assert.equal(legacy.status, 'ocr_pending', 'pre-S5 behaviour must be exactly preserved');
  close();
});

await test('the queue reports not-ready when the VERDICT table is absent', async () => {
  // Every triage read joins it; half-working would throw on the first drain.
  const { db, close } = createSqliteD1(FULL, { without: NO_VERDICTS });
  assert.equal(await createRecoveryQueue(db).ready(), false);
  close();
});

await test('the queue row is committed atomically with the attempt', async () => {
  const { store, queue, raw, close } = fresh([{ id: 'a:r:d4d:6' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:6', { accepted: false }),
    canonicalRow: null,
    acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  const attempts = raw.prepare('SELECT COUNT(*) n FROM offer_extraction_attempts').get().n;
  const queued = raw.prepare('SELECT COUNT(*) n FROM offer_recovery_queue').get().n;
  assert.equal(attempts, 1);
  assert.equal(queued, 1);
  assert.ok(await queue.get('a:r:d4d:6'));
  close();
});

// --- 4. lifecycle ----------------------------------------------------------

await test('a DISMISSED item is never resurrected by a re-extraction', async () => {
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:7' }]);
  const reject = recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict });
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:7', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict, recovery: reject,
  });
  await queue.close('a:r:d4d:7', RECOVERY_STATUS.DISMISSED);
  // re-extract: same offer, fails again
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:7', { accepted: false, at: '2026-07-21T01:00:00.000Z' }),
    canonicalRow: null, acceptance: rejectVerdict, recovery: reject,
  });
  assert.equal((await queue.get('a:r:d4d:7')).status, RECOVERY_STATUS.DISMISSED);
  // ...and only an explicit operator act brings it back
  await queue.reopen(['a:r:d4d:7']);
  assert.equal((await queue.get('a:r:d4d:7')).status, RECOVERY_STATUS.QUEUED);
  close();
});

await test('a later servable+accepted outcome RESOLVES an existing item, and never creates one', async () => {
  const { store, queue, raw, close } = fresh([{ id: 'a:r:d4d:8' }, { id: 'a:r:d4d:80' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:8', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:8', { at: '2026-07-21T01:00:00.000Z' }),
    canonicalRow: servableRow('a:r:d4d:8'), acceptance: acceptVerdict,
    recovery: recoveryAdmission({ canonicalRow: servableRow('a:r:d4d:8'), acceptance: acceptVerdict }),
  });
  assert.equal((await queue.get('a:r:d4d:8')).status, RECOVERY_STATUS.RESOLVED);
  // An offer that was never queued must not gain a `resolved` row — otherwise
  // the queue becomes a copy of the offers table.
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:80'),
    canonicalRow: servableRow('a:r:d4d:80'), acceptance: acceptVerdict,
    recovery: recoveryAdmission({ canonicalRow: servableRow('a:r:d4d:80'), acceptance: acceptVerdict }),
  });
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offer_recovery_queue').get().n, 1);
  close();
});

await test('exactly one racing claim wins, and an expired lease is reclaimable', async () => {
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:c' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:c', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  const now = new Date('2026-07-20T02:00:00.000Z');
  const first = await queue.claim({ offerId: 'a:r:d4d:c', processor: 'p-one', now });
  assert.ok(first, 'the first claim wins');
  assert.equal(await queue.claim({ offerId: 'a:r:d4d:c', processor: 'p-two', now }), null);
  const later = new Date(now.getTime() + 10 * 60_000);
  const second = await queue.claim({ offerId: 'a:r:d4d:c', processor: 'p-two', now: later });
  assert.ok(second, 'an evicted Worker must not hold an item forever');
  assert.notEqual(second, first, 'a re-claim mints a NEW token, invalidating the old holder');
  close();
});

await test('attempt history is append-only, numbered, and counted against the item', async () => {
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:h' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:h', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  await queue.recordAttempt({
    offerId: 'a:r:d4d:h', processor: 'p-one', outcome: RECOVERY_OUTCOME.NO_CHANGE,
    missingBefore: ['comparable_quantity'], missingAfter: ['comparable_quantity'],
    cost: { requests: 1 }, startedAt: AT, finishedAt: AT,
  });
  await queue.recordAttempt({
    offerId: 'a:r:d4d:h', processor: 'p-two', outcome: RECOVERY_OUTCOME.RECOVERED,
    missingBefore: ['comparable_quantity'], missingAfter: [],
    startedAt: AT, finishedAt: AT,
  });
  const history = await queue.history('a:r:d4d:h');
  assert.deepEqual(history.map((h) => h.attemptNo), [1, 2]);
  assert.deepEqual(history.map((h) => h.processor), ['p-one', 'p-two']);
  assert.deepEqual(history[0].cost, { requests: 1 });
  assert.deepEqual(history[1].missingAfter, [], 'the before/after pair is the payoff metric');
  assert.equal((await queue.get('a:r:d4d:h')).attempts, 2);
  close();
});

await test('list() excludes offers a processor already SETTLED', async () => {
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:l1' }, { id: 'a:r:d4d:l2' }]);
  for (const id of ['a:r:d4d:l1', 'a:r:d4d:l2']) {
    await store.saveVisionOutcome({
      attempt: attempt(id, { accepted: false }),
      canonicalRow: null, acceptance: rejectVerdict,
      recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
    });
  }
  await queue.recordAttempt({
    offerId: 'a:r:d4d:l1', processor: 'p-one', outcome: RECOVERY_OUTCOME.NO_CHANGE, startedAt: AT,
  });
  const forOne = await queue.list({ currentOn: TODAY, excludeProcessor: 'p-one' });
  assert.deepEqual(forOne.map((i) => i.offerId), ['a:r:d4d:l2']);
  const forTwo = await queue.list({ currentOn: TODAY, excludeProcessor: 'p-two' });
  assert.equal(forTwo.length, 2, 'a different processor still sees both');
  close();
});

// --- 5. retries actually retry ---------------------------------------------
// The failure this defends against is silent and terminal: with one processor
// configured, an exclusion that ignored OUTCOME would let a single transient
// provider error retire an offer permanently while leaving it sitting in
// `queued` forever — depth non-zero, drains doing nothing, no error anywhere.

await test('a FAILED attempt leaves the item selectable by the same processor', async () => {
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:r1' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:r1', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  await queue.recordAttempt({
    offerId: 'a:r:d4d:r1', processor: 'p-one', outcome: RECOVERY_OUTCOME.FAILED,
    error: 'HTTP 500', startedAt: AT, finishedAt: AT,
  });
  const ready = await queue.list({ currentOn: TODAY, excludeProcessor: 'p-one' });
  assert.deepEqual(ready.map((i) => i.offerId), ['a:r:d4d:r1']);
  assert.equal(ready[0].attempts, 1, 'a failure spends an attempt — that is what bounds the retry');
  close();
});

await test('a DECLINED attempt is selectable again and spends NO attempt', async () => {
  // Otherwise an unbound credential walks the whole queue into `exhausted`
  // without a single model call.
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:r2' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:r2', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  await queue.recordAttempt({
    offerId: 'a:r:d4d:r2', processor: 'p-one', outcome: RECOVERY_OUTCOME.DECLINED,
    error: 'no credential', startedAt: AT, finishedAt: AT,
  });
  const item = await queue.get('a:r:d4d:r2');
  assert.equal(item.attempts, 0);
  const ready = await queue.list({ currentOn: TODAY, excludeProcessor: 'p-one' });
  assert.equal(ready.length, 1);
  close();
});

await test('a re-extraction resets the GENERATION, so a settled processor looks again', async () => {
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:r3' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:r3', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  await queue.recordAttempt({
    offerId: 'a:r:d4d:r3', processor: 'p-one', outcome: RECOVERY_OUTCOME.NO_CHANGE,
    startedAt: AT, finishedAt: AT,
  });
  assert.equal((await queue.list({ currentOn: TODAY, excludeProcessor: 'p-one' })).length, 0);

  // A fresh primary extraction: new evidence, still not servable.
  const at2 = '2026-07-21T01:00:00.000Z';
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:r3', { accepted: false, at: at2 }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  const ready = await queue.list({ currentOn: TODAY, excludeProcessor: 'p-one' });
  assert.deepEqual(ready.map((i) => i.offerId), ['a:r:d4d:r3'],
    'a processor that settled against the OLD crop has said nothing about the new one');
  assert.equal(ready[0].attempts, 0, 'the counter and the history reset together, or neither works');
  assert.equal(ready[0].queuedAt, at2);
  close();
});

await test('reopen() resets the generation too — an operator asking again means again', async () => {
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:r4' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:r4', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  await queue.recordAttempt({
    offerId: 'a:r:d4d:r4', processor: 'p-one', outcome: RECOVERY_OUTCOME.NO_CHANGE, startedAt: AT,
  });
  await queue.close('a:r:d4d:r4', RECOVERY_STATUS.EXHAUSTED);
  await queue.reopen(['a:r:d4d:r4'], { now: new Date('2026-07-22T00:00:00.000Z') });
  const ready = await queue.list({ currentOn: TODAY, excludeProcessor: 'p-one' });
  assert.deepEqual(ready.map((i) => i.offerId), ['a:r:d4d:r4']);
  close();
});

// --- 6. the lease FENCES, it does not merely expire -------------------------

await test('a stale holder cannot release, close, or spend the new holder\'s attempts', async () => {
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:f1' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:f1', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  const now = new Date('2026-07-20T02:00:00.000Z');
  const stale = await queue.claim({ offerId: 'a:r:d4d:f1', processor: 'p-one', now });
  const later = new Date(now.getTime() + 10 * 60_000);
  const live = await queue.claim({ offerId: 'a:r:d4d:f1', processor: 'p-one', now: later });
  assert.ok(live && live !== stale);

  assert.equal(await queue.release('a:r:d4d:f1', { token: stale }), false);
  assert.equal((await queue.get('a:r:d4d:f1')).status, RECOVERY_STATUS.CLAIMED,
    'the live holder keeps the item');
  assert.equal(await queue.close('a:r:d4d:f1', RECOVERY_STATUS.EXHAUSTED, { token: stale }), false);

  await queue.recordAttempt({
    offerId: 'a:r:d4d:f1', processor: 'p-one', outcome: RECOVERY_OUTCOME.NO_CHANGE,
    startedAt: AT, finishedAt: AT, token: stale,
  });
  const item = await queue.get('a:r:d4d:f1');
  assert.equal(item.attempts, 0, 'a stale run must not spend the live generation\'s budget');
  assert.equal((await queue.history('a:r:d4d:f1')).length, 1,
    'but the run still happened and its cost is still recorded');

  // The live holder is unaffected and can still finish.
  assert.equal(await queue.release('a:r:d4d:f1', { token: live }), true);
  close();
});

await test('a stale holder\'s canonical write is REFUSED, whole batch and all', async () => {
  const { store, queue, raw, close } = fresh([{ id: 'a:r:d4d:f2' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:f2', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  const now = new Date('2026-07-20T02:00:00.000Z');
  const stale = await queue.claim({ offerId: 'a:r:d4d:f2', processor: 'p-one', now });
  await queue.claim({
    offerId: 'a:r:d4d:f2', processor: 'p-two', now: new Date(now.getTime() + 10 * 60_000),
  });

  let thrown = null;
  try {
    await store.saveRecoveryOutcome({
      attempt: { ...attempt('a:r:d4d:f2'), source: 'p-one' },
      canonicalRow: servableRow('a:r:d4d:f2'),
      acceptance: acceptVerdict,
      resolve: true,
      fence: { offerId: 'a:r:d4d:f2', token: stale, at: AT },
      history: {
        offerId: 'a:r:d4d:f2', processor: 'p-one',
        outcome: RECOVERY_OUTCOME.RECOVERED, startedAt: AT, finishedAt: AT,
      },
    });
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'the fence must abort, not silently no-op');
  assert.equal(isStaleClaimError(thrown), true, 'and it must be distinguishable from a broken DB');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offer_enrichments').get().n, 0,
    'no canonical row — this is the overwrite the fence exists to prevent');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offer_recovery_attempts').get().n, 0,
    'and nothing else from the batch landed either');
  assert.equal((await queue.get('a:r:d4d:f2')).status, RECOVERY_STATUS.CLAIMED);
  close();
});

await test('a live holder\'s outcome commits as ONE transaction — row, verdict, queue, history', async () => {
  const { store, queue, raw, close } = fresh([{ id: 'a:r:d4d:f3' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:f3', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  const token = await queue.claim({ offerId: 'a:r:d4d:f3', processor: 'p-one' });
  await store.saveRecoveryOutcome({
    attempt: { ...attempt('a:r:d4d:f3'), source: 'p-one' },
    canonicalRow: servableRow('a:r:d4d:f3'),
    acceptance: acceptVerdict,
    resolve: true,
    fence: { offerId: 'a:r:d4d:f3', token, at: AT },
    history: {
      offerId: 'a:r:d4d:f3', processor: 'p-one',
      outcome: RECOVERY_OUTCOME.RECOVERED, missingAfter: [], startedAt: AT, finishedAt: AT,
    },
  });
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offer_enrichments').get().n, 1);
  assert.equal((await queue.get('a:r:d4d:f3')).status, RECOVERY_STATUS.RESOLVED);
  assert.equal((await queue.history('a:r:d4d:f3')).length, 1,
    'the cost record cannot be lost separately from the row it describes');
  close();
});

await test('the fence also refuses a write whose queue row has been deleted', async () => {
  const { store, queue, raw, close } = fresh([{ id: 'a:r:d4d:f4' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:f4', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  const token = await queue.claim({ offerId: 'a:r:d4d:f4', processor: 'p-one' });
  raw.exec("DELETE FROM offer_recovery_queue WHERE offer_id = 'a:r:d4d:f4'");
  await assert.rejects(() => store.saveRecoveryOutcome({
    attempt: { ...attempt('a:r:d4d:f4'), source: 'p-one' },
    canonicalRow: servableRow('a:r:d4d:f4'),
    acceptance: acceptVerdict,
    fence: { offerId: 'a:r:d4d:f4', token, at: AT },
  }));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offer_enrichments').get().n, 0);
  close();
});

// --- 7. a clean deployment has the tables ----------------------------------
// The defect this pins: both recovery tables and the verdict table lived only
// in migration files, so `wrangler deploy` against a fresh database produced a
// Worker whose Recovery Platform reported itself permanently unavailable.

await test('schema.sql alone builds a WORKING recovery platform', async () => {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  insertOffers(raw, [{ id: 'a:r:d4d:s1' }]);
  assert.equal(await createRecoveryQueue(db).ready(), true,
    'a fresh deployment must not need a migration to have recovery at all');
  close();
});

await test('migration DDL is identical to schema.sql (both must build the same tables)', () => {
  const ddl = (sql, tables) => sql
    .replace(/--[^\n]*/g, ' ')
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => /^CREATE (TABLE|INDEX)/i.test(s))
    .filter((s) => tables.some((t) => new RegExp(`\\b${t}\\b`).test(s)))
    .sort();
  const schema = readFileSync('schema.sql', 'utf8');
  const recovery = ['offer_recovery_queue', 'offer_recovery_attempts'];
  const a = ddl(schema, recovery);
  const b = ddl(readFileSync('migrate-2026-07-27-recovery-queue.sql', 'utf8'), recovery);
  assert.equal(a.length, 6, '2 tables + 4 indexes');
  assert.deepEqual(a, b);

  const verdicts = ['offer_acceptance_verdicts'];
  assert.deepEqual(
    ddl(schema, verdicts),
    ddl(readFileSync('migrate-2026-07-26-acceptance-verdicts.sql', 'utf8'), verdicts),
  );
});

await test('list() hands a processor the prior attempts keyed by opaque source', async () => {
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:j' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:j', { accepted: false }),
    canonicalRow: null, acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  const [item] = await queue.list({ currentOn: TODAY });
  assert.deepEqual(item.attemptsBySource.vision.output, { name_en: 'Arwa Water 330 ml' });
  assert.equal(item.offer.image_url, 'https://cdn.example/crop.jpg');
  close();
});

await test('depth() reports per-condition buckets that OVERLAP, never a reject total', async () => {
  const { store, queue, close } = fresh([{ id: 'a:r:d4d:d1' }, { id: 'a:r:d4d:d2' }]);
  const bothMissing = evaluateBusinessAcceptance({
    offer: { price: null, currency: null },
    acceptedFields: ['name_en'],
    structured: sizelessProduct,
  });
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:d1', { accepted: false }), canonicalRow: null,
    acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:d2', { accepted: false }), canonicalRow: null,
    acceptance: bothMissing,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: bothMissing }),
  });
  const depth = await queue.depth({ currentOn: TODAY });
  assert.equal(depth.byStatus.queued, 2);
  assert.equal(depth.byMissingCondition.comparable_quantity, 2);
  assert.equal(depth.byMissingCondition.price, 1);
  close();
});

await test('known grocery is selected first and triage scopes separate the bulk', async () => {
  const offers = [
    { id: 'a:r:d4d:ng', name: 'Samsung TV', category: 'tv' },
    { id: 'a:r:d4d:unknown', name: 'Mystery product', category: null },
    { id: 'a:r:d4d:grocery', name: 'Basmati Rice', category: 'rice' },
  ];
  const { store, queue, close } = fresh(offers);
  for (const offer of offers) {
    await store.saveVisionOutcome({
      attempt: attempt(offer.id, { accepted: false }),
      canonicalRow: null,
      acceptance: rejectVerdict,
      // Simulates stale v1 queue rows before as-is reconciliation.
      recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
    });
  }
  const all = await queue.list({ currentOn: TODAY, limit: 10 });
  assert.deepEqual(all.map((item) => item.offerId), [
    'a:r:d4d:grocery',
    'a:r:d4d:unknown',
    'a:r:d4d:ng',
  ]);
  assert.deepEqual(
    (await queue.list({ currentOn: TODAY, scope: 'grocery' })).map((item) => item.offerId),
    ['a:r:d4d:grocery'],
  );
  assert.deepEqual(
    (await queue.list({ currentOn: TODAY, scope: 'uncategorized' })).map((item) => item.offerId),
    ['a:r:d4d:unknown'],
  );
  assert.deepEqual(
    (await queue.list({ currentOn: TODAY, scope: 'non_grocery' })).map((item) => item.offerId),
    ['a:r:d4d:ng'],
  );
  const depth = await queue.depth({ currentOn: TODAY });
  assert.deepEqual(depth.byProductClass, { grocery: 1, uncategorized: 1, non_grocery: 1 });
  close();
});

await test('named/priced non-grocery is reconciled as-is without a recovery attempt', async () => {
  const offers = [
    { id: 'a:r:d4d:tv', name: 'Samsung 65 inch TV', category: 'tv' },
    { id: 'a:r:d4d:shoe', name: null, name_ar: null, category: 'footwear' },
    { id: 'a:r:d4d:rice', name: 'Basmati Rice', category: 'rice' },
  ];
  const { store, queue, close } = fresh(offers);
  for (const offer of offers) {
    await store.saveVisionOutcome({
      attempt: attempt(offer.id, { accepted: false }),
      canonicalRow: null,
      acceptance: rejectVerdict,
      recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
    });
  }
  const result = await store.reconcileNonGroceryAcceptance({ currentOn: TODAY });
  assert.equal(result.resolved, 1);
  assert.equal((await queue.get('a:r:d4d:tv')).status, RECOVERY_STATUS.RESOLVED);
  assert.equal((await queue.get('a:r:d4d:tv')).verdict.accepted, true);
  assert.equal((await queue.get('a:r:d4d:tv')).verdict.quantityBasis, 'unit');
  assert.equal((await queue.get('a:r:d4d:shoe')).status, RECOVERY_STATUS.QUEUED);
  assert.equal((await queue.get('a:r:d4d:rice')).status, RECOVERY_STATUS.QUEUED);
  assert.equal((await queue.history('a:r:d4d:tv')).length, 0, 'no paid recovery attempt');
  close();
});

await test('basis-priced stock is reconciled from data we already own, at zero cost', async () => {
  // The population this whole change exists for. Every row below was queued for
  // Recovery under gate v2 with `comparable_quantity` ABSENT; three of them
  // printed their denominator all along, in three different places.
  const offers = [
    { id: 'a:r:d4d:apple', name: null, name_ar: 'تفاح رويال جالا للكيلو', category: 'fresh-fruits' },
    { id: 'a:r:d4d:veal', name: 'FRESH VEAL - BONE IN', category: 'meat-fresh-chilled' },
    { id: 'a:r:d4d:lettuce', name: 'Iceberg Lettuce/pc', category: 'fresh-vegetables' },
    // No basis anywhere: must stay queued. A re-judge that retires this row is
    // retiring a product that still needs a real reading.
    { id: 'a:r:d4d:cushion', name: 'Novelty Cushion', category: 'home-furnishing-decor' },
  ];
  const rows = {
    // The basis in the SIZE field — the commonest production shape.
    'a:r:d4d:apple': { name: 'Apple Royal Gala Brazil', size: 'Per Kg', extraction_json: null },
    // The basis in the extractor's `unit` field ONLY.
    // extraction_json is stored as an OBJECT (the store serialises it), which is
    // what makes `json_extract(..., '$.unit')` able to read it back.
    'a:r:d4d:veal': { name: 'FRESH VEAL - BONE IN', size: null, extraction_json: { unit: 'KILO' } },
    // The basis in the NAME.
    'a:r:d4d:lettuce': { name: 'Iceberg Lettuce/pc', size: null, extraction_json: null },
    'a:r:d4d:cushion': { name: 'Novelty Cushion', size: null, extraction_json: null },
  };
  const { store, queue, close } = fresh(offers);
  for (const offer of offers) {
    await store.saveVisionOutcome({
      attempt: attempt(offer.id, { accepted: true }),
      canonicalRow: {
        id: offer.id, corroboration: 1, enriched_at: AT, ...rows[offer.id],
      },
      acceptance: rejectVerdict,
      recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
    });
  }
  const result = await store.reconcilePriceBasisAcceptance({ currentOn: TODAY });
  assert.equal(result.resolved, 3, 'three legible bases, three resolutions');
  for (const id of ['a:r:d4d:apple', 'a:r:d4d:veal', 'a:r:d4d:lettuce']) {
    const item = await queue.get(id);
    assert.equal(item.status, RECOVERY_STATUS.RESOLVED, id);
    assert.equal(item.verdict.accepted, true, id);
    assert.equal(item.verdict.quantityBasis, 'price_basis', id);
    assert.equal((await queue.history(id)).length, 0, `${id}: no paid recovery attempt`);
  }
  assert.equal(
    (await queue.get('a:r:d4d:cushion')).status, RECOVERY_STATUS.QUEUED,
    'a product with no basis must not be retired by this pass',
  );
  close();
});

await test('the basis re-judge survives a batch bigger than D1 allows in one query', async () => {
  // FOUND IN PRODUCTION, NOT IN TEST. D1 caps bound parameters per query at 100.
  // Every fixture above resolves 3-4 rows, so the batch builder shipped with a
  // single `IN (...)` list; the first live fire had 344 candidates, built a
  // statement with 351 binds, threw, and the caller's `.catch()` turned it into
  // a silent `resolved: 0` that looked exactly like "nothing to do".
  //
  // 150 rows is comfortably past the cap and past one 40-id chunk.
  const N = 150;
  const offers = Array.from({ length: N }, (_, i) => ({
    id: `a:r:d4d:bulk${i}`, name: 'Fresh Produce', category: 'fresh-fruits',
  }));
  const { store, queue, close } = fresh(offers);
  for (const offer of offers) {
    await store.saveVisionOutcome({
      attempt: attempt(offer.id, { accepted: true }),
      canonicalRow: {
        id: offer.id, name: 'Apple Royal Gala Brazil', size: 'Per Kg',
        corroboration: 1, enriched_at: AT,
      },
      acceptance: rejectVerdict,
      recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
    });
  }
  const result = await store.reconcilePriceBasisAcceptance({ currentOn: TODAY, limit: 500 });
  assert.equal(result.resolved, N, 'every candidate commits, not just the first chunk');
  // Spot-check the ends, so a chunking off-by-one cannot pass.
  for (const id of ['a:r:d4d:bulk0', `a:r:d4d:bulk${N - 1}`]) {
    const item = await queue.get(id);
    assert.equal(item.status, RECOVERY_STATUS.RESOLVED, id);
    assert.equal(item.verdict.quantityBasis, 'price_basis', id);
  }
  close();
});

await test('the basis re-judge never retires a row for some OTHER reason', async () => {
  // A televison passes the gate on the v2 UNIT basis, and the prefilter's
  // "%each%" test is loose enough to offer it up. Retiring it here would make
  // "why was this accepted" unanswerable from the verdict alone, so the pass
  // resolves ONLY rows whose comparable quantity is a price basis.
  const tv = { id: 'a:r:d4d:tv2', name: 'Samsung 65 inch TV Each', category: 'tv' };
  const { store, queue, close } = fresh([tv]);
  await store.saveVisionOutcome({
    attempt: attempt(tv.id, { accepted: true }),
    canonicalRow: { id: tv.id, name: 'Samsung 65 inch TV Each', corroboration: 1, enriched_at: AT },
    acceptance: rejectVerdict,
    recovery: recoveryAdmission({ canonicalRow: null, acceptance: rejectVerdict }),
  });
  const result = await store.reconcilePriceBasisAcceptance({ currentOn: TODAY });
  assert.equal(result.resolved, 0);
  assert.equal((await queue.get(tv.id)).status, RECOVERY_STATUS.QUEUED);
  close();
});

await test('new named/priced non-grocery never enters Recovery or legacy OCR', async () => {
  const tv = {
    id: 'a:r:d4d:new-tv',
    name: 'Samsung 65 inch TV',
    category: 'tv',
    price: 1999,
    currency: 'SAR',
  };
  const { store, queue, raw, close } = fresh([tv]);
  const acceptance = evaluateBusinessAcceptance({
    offer: tv,
    acceptedFields: [],
    observation: { name: null },
  });
  const recovery = recoveryAdmission({
    canonicalRow: null,
    acceptance,
    offer: tv,
  });
  assert.equal(recovery.complete, true);
  assert.equal(recovery.reasons.acceptedAsIs, true);
  await store.saveVisionOutcome({
    attempt: attempt(tv.id, { accepted: false }),
    canonicalRow: null,
    acceptance,
    recovery,
  });
  assert.equal(await queue.get(tv.id), null, 'no Recovery row is created');
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM offer_ocr_queue WHERE offer_id = ?').get(tv.id).n,
    0,
    'no legacy OCR row is created',
  );
  assert.equal((await store.getAcceptanceVerdict(tv.id)).accepted, true);
  close();
});

console.log(`\nS5 Recovery Queue platform: ${tests} tests OK`);
