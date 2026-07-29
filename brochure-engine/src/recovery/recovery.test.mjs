// recovery.test.mjs — S5.4/S5.6: the processor plug-in contract, the runner's
// commit boundary, and the execution policy.
//
// WHAT THESE TESTS DEFEND, in priority order:
//
//  1. THE PLATFORM PROPERTY, END TO END (C-9). A processor that exists ONLY in
//     this file — no module, no registry entry, no schema, no migration — is
//     claimed, run, committed, judged and closed by the production runner. If
//     that ever stops working, "adding a processor is one module plus one
//     registry line" has stopped being true, which is the whole decision.
//  2. THE GUARANTEES THE PROCESSOR IS NOT TRUSTED WITH. C-7 immutability is
//     enforced at the boundary against a processor that violates it, and a
//     processor cannot close its own item — only S4 can.
//  3. THE SPEND FAIL-SAFE (C-8). Every unreadable-policy path resolves to
//     Manual, and a disarmed policy makes NO processor call at all.

import assert from 'node:assert/strict';
import { createD1EnrichStore } from '../storage/enrichStore.js';
import { createRecoveryQueue, RECOVERY_STATUS } from '../storage/recoveryQueue.js';
import { createSqliteD1, insertOffers } from '../storage/testSqliteD1.mjs';
import { buildStructuredProduct } from '../lexicon/structuredProduct.js';
import { evaluateBusinessAcceptance } from '../offers/businessAcceptance.js';
import { recoveryAdmission } from '../offers/enrich.js';
import { createRecoveryRegistry, defineProcessor, RECOVERY_KIND } from './registry.js';
import { acceptedFieldViolations, drainRecovery, runRecovery } from './runner.js';
import {
  RECOVERY_MODES,
  RECOVERY_POLICY_KEY,
  readRecoveryPolicy,
  writeRecoveryPolicy,
} from './policy.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('S5 recovery processors, runner and policy (C-7, C-8, C-9):');

const SCHEMA = [
  'schema.sql',
  'migrate-2026-07-vision-first-queue.sql',
  'migrate-2026-07-26-acceptance-verdicts.sql',
  'migrate-2026-07-27-recovery-queue.sql',
];
const AT = '2026-07-20T01:00:00.000Z';
const TODAY = '2026-07-20';
const OFFER = 'a:r:d4d:1';

const sizeless = buildStructuredProduct({
  name_en: 'Arwa Bottled Water', name_ar: 'مياه أروى', brand: 'Arwa',
});
const complete = buildStructuredProduct({
  name_en: 'Arwa Bottled Water 330 ml', name_ar: 'مياه أروى', brand: 'Arwa', size: '330 ml',
});

// A primary Vision attempt that ACCEPTED name_en — the field C-7 protects.
const priorValidation = {
  acceptedFields: ['name_en'],
  fields: {
    name_en: { status: 'Accepted', value: 'Arwa Bottled Water' },
    size: { status: 'Missing', value: null },
  },
  triggerReasons: [],
};

// Seed one offer that is queued because comparable_quantity is missing.
async function seedQueued() {
  const { db, raw, close } = createSqliteD1(SCHEMA);
  insertOffers(raw, [{ id: OFFER }]);
  const store = createD1EnrichStore(db);
  const queue = createRecoveryQueue(db);
  const verdict = evaluateBusinessAcceptance({
    offer: { price: 5.99, currency: 'SAR' },
    acceptedFields: ['name_en'],
    structured: sizeless,
  });
  assert.deepEqual(verdict.missing, ['comparable_quantity'], 'seed precondition');
  const canonicalRow = {
    id: OFFER, name: 'Arwa Bottled Water', name_ar: 'مياه أروى',
    corroboration: 1, enriched_at: AT, structured_product: sizeless,
  };
  await store.saveVisionOutcome({
    attempt: {
      offerId: OFFER, source: 'vision', output: { name_en: 'Arwa Bottled Water' },
      validation: priorValidation, confidence: null, model: 'primary',
      cropUrl: 'https://cdn.example/crop.jpg', accepted: 1, attemptedAt: AT,
    },
    canonicalRow,
    acceptance: verdict,
    recovery: recoveryAdmission({ canonicalRow, acceptance: verdict }),
  });
  assert.equal((await queue.get(OFFER)).status, RECOVERY_STATUS.QUEUED, 'seed precondition');
  return { store, queue, raw, close };
}

// A processor that RESOLVES the item: it supplies the missing size.
const resolvingProcessor = (id = 'synthetic-processor', overrides = {}) => defineProcessor({
  id,
  label: 'Synthetic',
  kind: RECOVERY_KIND.MACHINE,
  provenance: 'Vision',
  addresses: ['comparable_quantity'],
  costHint: { per: 'offer' },
  run: async (item) => ({
    canonicalRow: {
      id: item.offerId,
      name: 'Arwa Bottled Water',
      name_ar: 'مياه أروى',
      size: '330 ml',
      corroboration: 1,
      enriched_at: AT,
      structured_product: complete,
    },
    attempt: {
      offerId: item.offerId, source: id, output: { size: '330 ml' },
      validation: { acceptedFields: ['name_en', 'size'] },
      confidence: null, model: id, cropUrl: item.offer.image_url,
      accepted: 1, attemptedAt: AT,
    },
    cost: { requests: 1 },
  }),
  ...overrides,
});

// --- 1. the platform property, end to end (C-9) ----------------------------

await test('C-9 PLATFORM: a processor invented in this file drains end to end', async () => {
  const { store, queue, close } = await seedQueued();
  // Defined here and nowhere else: no module, no registry entry in src/, no
  // schema change, no migration. This is "add Vision Large tomorrow".
  const processor = resolvingProcessor('processor-that-does-not-exist-yet');
  const report = await runRecovery(
    { queue, processor, enrichStore: store },
    { currentOn: TODAY },
  );
  assert.equal(report.recovered, 1);
  assert.equal(report.failed, 0);
  const item = await queue.get(OFFER);
  assert.equal(item.status, RECOVERY_STATUS.RESOLVED);
  assert.equal(item.verdict.accepted, true, 'the re-judged verdict is persisted');
  // History is keyed by the opaque id, and the effectiveness report gained a
  // row for a processor the codebase has never heard of.
  const [attempt] = await queue.history(OFFER);
  assert.equal(attempt.processor, 'processor-that-does-not-exist-yet');
  assert.deepEqual(attempt.missingBefore, ['comparable_quantity']);
  assert.deepEqual(attempt.missingAfter, []);
  const eff = await queue.effectiveness();
  assert.equal(eff['processor-that-does-not-exist-yet'].recovered, 1);
  close();
});

await test('the recovery attempt is journalled under the processor id (S5.0 CHECK removal)', async () => {
  const { store, queue, raw, close } = await seedQueued();
  await runRecovery(
    { queue, processor: resolvingProcessor('brand-new-engine'), enrichStore: store },
    { currentOn: TODAY },
  );
  const sources = raw.prepare('SELECT source FROM offer_extraction_attempts WHERE offer_id = ? ORDER BY source').all(OFFER);
  assert.deepEqual(sources.map((r) => r.source), ['brand-new-engine', 'vision'],
    'the primary read and the recovery read sit side by side, as S7 needs');
  close();
});

// --- 2. guarantees the processor is not trusted with ------------------------

await test('C-7: a MACHINE processor overwriting an accepted field is refused at the boundary', async () => {
  const { store, queue, close } = await seedQueued();
  const vandal = defineProcessor({
    id: 'overwriting-processor',
    kind: RECOVERY_KIND.MACHINE,
    run: async (item) => ({
      canonicalRow: {
        id: item.offerId,
        name: 'Something Completely Different',   // name_en was Accepted by the primary
        size: '330 ml',
        corroboration: 1,
        enriched_at: AT,
        structured_product: complete,
      },
      attempt: {
        offerId: item.offerId, source: 'overwriting-processor', output: {},
        validation: { acceptedFields: ['name_en'] }, confidence: null,
        model: 'x', cropUrl: null, accepted: 1, attemptedAt: AT,
      },
    }),
  });
  const report = await runRecovery({ queue, processor: vandal, enrichStore: store }, { currentOn: TODAY });
  assert.equal(report.blockedByImmutability, 1);
  assert.equal(report.recovered, 0);
  const item = await queue.get(OFFER);
  assert.equal(item.status, RECOVERY_STATUS.QUEUED, 'the item stays queued for another processor');
  assert.equal(item.enrichment.name, 'Arwa Bottled Water', 'the accepted value is untouched');
  const [attempt] = await queue.history(OFFER);
  assert.equal(attempt.outcome, 'failed');
  assert.match(attempt.error, /C-7 accepted-field overwrite refused/);
  close();
});

await test('C-7: the HUMAN rung may override the same field', async () => {
  const { store, queue, close } = await seedQueued();
  const reviewer = defineProcessor({
    id: 'human-review',
    kind: RECOVERY_KIND.HUMAN,
    provenance: 'Human',
    run: async (item) => ({
      canonicalRow: {
        id: item.offerId,
        name: 'Arwa Still Water 330 ml',           // corrects a confident misread
        size: '330 ml',
        corroboration: 1,
        enriched_at: AT,
        structured_product: complete,
      },
      attempt: {
        offerId: item.offerId, source: 'human-review', output: {},
        validation: { acceptedFields: ['name_en', 'size'] }, confidence: null,
        model: 'human', cropUrl: null, accepted: 1, attemptedAt: AT,
      },
      actor: 'majed',
    }),
  });
  const report = await runRecovery({ queue, processor: reviewer, enrichStore: store }, { currentOn: TODAY });
  assert.equal(report.blockedByImmutability, 0);
  assert.equal(report.recovered, 1);
  const item = await queue.get(OFFER);
  assert.equal(item.enrichment.name, 'Arwa Still Water 330 ml');
  assert.equal((await queue.history(OFFER))[0].actor, 'majed');
  close();
});

await test('a processor CANNOT close its own item — only S4 does', async () => {
  const { store, queue, close } = await seedQueued();
  // Reports success loudly and produces a row that still has no size.
  const liar = defineProcessor({
    id: 'optimistic-processor',
    run: async (item) => ({
      outcome: 'recovered', recovered: true, success: true,   // all ignored
      canonicalRow: {
        id: item.offerId, name: 'Arwa Bottled Water', corroboration: 1,
        enriched_at: AT, structured_product: sizeless,
      },
      attempt: {
        offerId: item.offerId, source: 'optimistic-processor', output: {},
        validation: { acceptedFields: ['name_en'] }, confidence: null,
        model: 'x', cropUrl: null, accepted: 1, attemptedAt: AT,
      },
    }),
  });
  const report = await runRecovery({ queue, processor: liar, enrichStore: store }, { currentOn: TODAY });
  assert.equal(report.recovered, 0, 'self-reported success must not close the item');
  assert.equal(report.noChange, 1);
  const item = await queue.get(OFFER);
  assert.equal(item.status, RECOVERY_STATUS.QUEUED);
  const [attempt] = await queue.history(OFFER);
  assert.deepEqual(attempt.missingAfter, ['comparable_quantity'],
    'the after-state is recorded even when nothing was recovered');
  close();
});

await test('acceptedFieldViolations compares against the persisted journal, not the merge', async () => {
  const item = {
    attemptsBySource: { vision: { source: 'vision', validation: priorValidation } },
  };
  assert.equal(acceptedFieldViolations(item, { name: 'Arwa Bottled Water' }).length, 0);
  assert.equal(acceptedFieldViolations(item, { name: null }).length, 0, 'clearing is not overwriting');
  assert.equal(acceptedFieldViolations(item, { name: 'Other' }).length, 1);
});

await test('a failing processor backs the item off and never loses it', async () => {
  const { store, queue, close } = await seedQueued();
  const broken = defineProcessor({
    id: 'broken-processor',
    run: async () => { throw new Error('provider exploded'); },
  });
  const report = await runRecovery({ queue, processor: broken, enrichStore: store }, { currentOn: TODAY });
  assert.equal(report.failed, 1);
  const item = await queue.get(OFFER);
  assert.equal(item.status, RECOVERY_STATUS.QUEUED);
  assert.ok(item.nextAttemptAt, 'backed off rather than retried immediately');
  assert.match(item.lastError, /provider exploded/);
  close();
});

await test('a declining processor records the refusal without consuming the item', async () => {
  const { store, queue, close } = await seedQueued();
  const unavailable = defineProcessor({
    id: 'no-credential-processor',
    run: async () => ({ declined: true, error: 'no credential bound' }),
  });
  const report = await runRecovery({ queue, processor: unavailable, enrichStore: store }, { currentOn: TODAY });
  assert.equal(report.declined, 1);
  assert.equal((await queue.get(OFFER)).status, RECOVERY_STATUS.QUEUED);
  assert.equal((await queue.history(OFFER))[0].outcome, 'declined');
  close();
});

await test('supports() keeps processor preconditions OUT of the queue', async () => {
  const { store, queue, close } = await seedQueued();
  let ran = false;
  const picky = defineProcessor({
    id: 'picky-processor',
    supports: (item) => item.offer.image_url == null,   // never true for the seed
    run: async () => { ran = true; return {}; },
  });
  const report = await runRecovery({ queue, processor: picky, enrichStore: store }, { currentOn: TODAY });
  assert.equal(report.unsupported, 1);
  assert.equal(ran, false);
  assert.equal((await queue.history(OFFER)).length, 0, 'an unsupported item is not history');
  close();
});

await test('an item is EXHAUSTED once its attempts are spent', async () => {
  const { store, queue, close } = await seedQueued();
  const noop = defineProcessor({
    id: 'noop-processor',
    run: async (item) => ({
      canonicalRow: {
        id: item.offerId, name: 'Arwa Bottled Water', corroboration: 1,
        enriched_at: AT, structured_product: sizeless,
      },
      attempt: {
        offerId: item.offerId, source: 'noop-processor', output: {},
        validation: { acceptedFields: ['name_en'] }, confidence: null,
        model: 'x', cropUrl: null, accepted: 1, attemptedAt: AT,
      },
    }),
  });
  const opts = { currentOn: TODAY, maxAttemptsPerItem: 1, offerIds: [OFFER] };
  await runRecovery({ queue, processor: noop, enrichStore: store }, opts);
  const second = await runRecovery({ queue, processor: noop, enrichStore: store }, opts);
  assert.equal(second.exhausted, 1);
  assert.equal((await queue.get(OFFER)).status, RECOVERY_STATUS.EXHAUSTED);
  close();
});

// --- 3. the registry contract ----------------------------------------------

await test('the registry rejects malformed descriptors at definition time', async () => {
  assert.throws(() => defineProcessor({ id: 'Bad Id', run: async () => {} }), /lower-kebab-case/);
  assert.throws(() => defineProcessor({ id: 'ok' }), /must supply run/);
  assert.throws(() => defineProcessor({ id: 'ok', kind: 'robot', run: async () => {} }), /unknown kind/);
  const registry = createRecoveryRegistry([resolvingProcessor('a'), resolvingProcessor('b')]);
  assert.deepEqual(registry.ids(), ['a', 'b']);
  assert.equal(registry.get('nope'), null, 'a stale id resolves to null, never a throw');
  assert.equal('run' in registry.describe()[0], false, 'describe() is UI-safe');
  assert.throws(
    () => createRecoveryRegistry([resolvingProcessor('a'), resolvingProcessor('a')]),
    /Duplicate/,
  );
});

// --- 4. the spend fail-safe (C-8) -------------------------------------------

const memoryStore = () => {
  const map = new Map();
  return {
    map,
    async get(key) { return map.has(key) ? { bytes: map.get(key) } : null; },
    async put(key, bytes) { map.set(key, bytes); },
  };
};
const registry = createRecoveryRegistry([resolvingProcessor('known-processor')]);

await test('EVERY unreadable-policy path resolves to Manual and disarmed', async () => {
  const enc = new TextEncoder();
  const cases = {
    'no object store bound': null,
    'key absent': memoryStore(),
    'corrupt JSON': (() => {
      const s = memoryStore();
      s.map.set(RECOVERY_POLICY_KEY, enc.encode('{not json'));
      return s;
    })(),
    'unknown mode': (() => {
      const s = memoryStore();
      s.map.set(RECOVERY_POLICY_KEY, enc.encode(JSON.stringify({ mode: 'turbo', processors: ['known-processor'] })));
      return s;
    })(),
    'auto with no processors': (() => {
      const s = memoryStore();
      s.map.set(RECOVERY_POLICY_KEY, enc.encode(JSON.stringify({ mode: 'auto', processors: [] })));
      return s;
    })(),
    'auto naming only processors that no longer exist': (() => {
      const s = memoryStore();
      s.map.set(RECOVERY_POLICY_KEY, enc.encode(JSON.stringify({ mode: 'auto', processors: ['retired-processor'] })));
      return s;
    })(),
    'auto whose window has expired': (() => {
      const s = memoryStore();
      s.map.set(RECOVERY_POLICY_KEY, enc.encode(JSON.stringify({
        mode: 'auto', processors: ['known-processor'], until: '2020-01-01T00:00:00.000Z',
      })));
      return s;
    })(),
  };
  for (const [label, store] of Object.entries(cases)) {
    const policy = await readRecoveryPolicy(store, { registry });
    assert.equal(policy.armed, false, `${label}: must not be armed`);
    if (label === 'no object store bound' || label === 'key absent' || label === 'corrupt JSON') {
      assert.equal(policy.mode, RECOVERY_MODES.MANUAL, `${label}: must fall back to Manual`);
    }
  }
  // A processor named by a stored policy but missing from the registry is
  // REPORTED, so an operator sees why their armed drain does nothing.
  const stale = await readRecoveryPolicy(cases['auto naming only processors that no longer exist'], { registry });
  assert.deepEqual(stale.unknownProcessors, ['retired-processor']);
});

await test('a disarmed policy makes NO processor call at all', async () => {
  const { store, queue, close } = await seedQueued();
  let called = false;
  const watched = createRecoveryRegistry([defineProcessor({
    id: 'known-processor',
    run: async () => { called = true; return {}; },
  })]);
  const policy = await readRecoveryPolicy(memoryStore(), { registry: watched });
  const report = await drainRecovery(
    { queue, registry: watched, enrichStore: store, policy },
    { currentOn: TODAY },
  );
  assert.equal(report.skipped, true);
  assert.equal(report.reason, 'not_armed');
  assert.equal(called, false, 'a disarmed policy must not be able to spend');
  assert.equal((await queue.get(OFFER)).status, RECOVERY_STATUS.QUEUED);
  close();
});

await test('an ARMED auto policy drains, and Manual/Auto share one runner', async () => {
  const { store, queue, close } = await seedQueued();
  const objectStore = memoryStore();
  const policy = await writeRecoveryPolicy(
    objectStore,
    { mode: RECOVERY_MODES.AUTO, processors: ['known-processor'], maxItemsPerRun: 5 },
    { registry, by: 'majed' },
  );
  assert.equal(policy.armed, true);
  const report = await drainRecovery(
    { queue, registry, enrichStore: store, policy },
    { currentOn: TODAY },
  );
  assert.equal(report.skipped, undefined);
  assert.equal(report.runs[0].recovered, 1);
  assert.equal((await queue.get(OFFER)).status, RECOVERY_STATUS.RESOLVED);
  close();
});

await test('multi-processor Auto builds the credential context PER PROCESSOR', async () => {
  // The coupling this pins: one context, built for the first armed processor
  // and reused, hands a second processor the first one's key chain — a silent
  // auth failure that presents as a provider outage.
  const { store, queue, close } = await seedQueued();
  const seen = [];
  const probe = (id, credential) => defineProcessor({
    id,
    credential,
    // Produces nothing, so the item stays queued and reaches the second
    // processor in the same drain.
    run: async (item, ctx) => {
      seen.push({ id, key: ctx?.keyChain ?? null });
      return {};
    },
  });
  const twoProcessors = createRecoveryRegistry([
    probe('first-processor', 'ocr'),
    probe('second-processor', 'vision'),
  ]);
  const objectStore = memoryStore();
  const policy = await writeRecoveryPolicy(
    objectStore,
    { mode: RECOVERY_MODES.AUTO, processors: ['first-processor', 'second-processor'] },
    { registry: twoProcessors, by: 'majed' },
  );
  await drainRecovery(
    {
      queue,
      registry: twoProcessors,
      enrichStore: store,
      policy,
      contextFor: (p) => ({ keyChain: `key:${p.credential}` }),
    },
    { currentOn: TODAY },
  );
  assert.deepEqual(seen, [
    { id: 'first-processor', key: 'key:ocr' },
    { id: 'second-processor', key: 'key:vision' },
  ]);
  close();
});

// --- 5. the runner's own failure handling ----------------------------------

await test('a FAILED run is retried, then EXHAUSTS — the ladder is not one-way', async () => {
  // With one processor configured, an exclusion that ignored outcome would end
  // this after the first failure with the item still sitting in `queued`.
  const { store, queue, close } = await seedQueued();
  let calls = 0;
  const flaky = defineProcessor({
    id: 'flaky-processor',
    run: async () => { calls += 1; throw new Error('HTTP 500'); },
  });
  const at = new Date('2026-07-20T02:00:00.000Z');
  const first = await runRecovery(
    { queue, processor: flaky, enrichStore: store },
    { currentOn: TODAY, maxAttemptsPerItem: 2, now: () => at },
  );
  assert.equal(first.failed, 1);
  assert.equal((await queue.get(OFFER)).attempts, 1);

  // Still selectable once the backoff elapses — the whole point.
  const later = new Date(at.getTime() + 6 * 60 * 60_000);
  const second = await runRecovery(
    { queue, processor: flaky, enrichStore: store },
    { currentOn: TODAY, maxAttemptsPerItem: 2, now: () => later },
  );
  assert.equal(second.scanned, 1, 'a transient failure must not retire the item');
  assert.equal(second.failed, 1);
  assert.equal(calls, 2);

  // Only NOW is the budget spent.
  const third = await runRecovery(
    { queue, processor: flaky, enrichStore: store },
    { currentOn: TODAY, maxAttemptsPerItem: 2, now: () => new Date(later.getTime() + 864e5) },
  );
  assert.equal(third.exhausted, 1);
  assert.equal(calls, 2, 'an exhausted item costs no further provider call');
  assert.equal((await queue.get(OFFER)).status, RECOVERY_STATUS.EXHAUSTED);
  close();
});

await test('an item stolen MID-RUN is not overwritten by the original holder', async () => {
  const { store, queue, raw, close } = await seedQueued();
  // The processor takes the item's lease away from under itself while running —
  // exactly what a Worker eviction plus a second drain looks like from the
  // database's point of view.
  const slow = defineProcessor({
    id: 'slow-processor',
    run: async (item) => {
      await queue.claim({
        offerId: item.offerId,
        processor: 'other-worker',
        now: new Date(Date.now() + 60 * 60_000),
      });
      return resolvingProcessor('slow-processor').run(item);
    },
  });
  const report = await runRecovery(
    { queue, processor: slow, enrichStore: store },
    { currentOn: TODAY },
  );
  assert.equal(report.staleClaims, 1, 'the fence fires and is reported as itself');
  assert.equal(report.recovered, 0);
  assert.equal(report.failed, 0, 'losing a race is not an error');
  assert.equal((await queue.get(OFFER)).status, RECOVERY_STATUS.CLAIMED,
    'the new holder keeps the item — the loser must not release it either');
  const size = raw.prepare('SELECT size FROM offer_enrichments WHERE id = ?').get(OFFER)?.size;
  assert.equal(size, null, 'and the stale result never reached the canonical row');
  close();
});

await test('an EXPLICIT empty selection processes nothing, rather than everything', async () => {
  const { store, queue, close } = await seedQueued();
  let called = false;
  const watched = defineProcessor({
    id: 'watched-processor',
    run: async () => { called = true; return {}; },
  });
  const report = await runRecovery(
    { queue, processor: watched, enrichStore: store },
    { currentOn: TODAY, offerIds: [] },
  );
  assert.equal(report.scanned, 0);
  assert.equal(called, false, '`[]` is the narrowest instruction, not the widest');
  assert.equal((await queue.get(OFFER)).status, RECOVERY_STATUS.QUEUED);
  // ...and omitting the field entirely still means "you pick".
  const bulk = await runRecovery(
    { queue, processor: watched, enrichStore: store },
    { currentOn: TODAY },
  );
  assert.equal(bulk.scanned, 1);
  close();
});

await test('arming Auto against an unknown processor fails loudly on WRITE', async () => {
  await assert.rejects(
    () => writeRecoveryPolicy(
      memoryStore(),
      { mode: RECOVERY_MODES.AUTO, processors: ['typo-processor'] },
      { registry },
    ),
    /Unknown recovery processor/,
  );
});

console.log(`\nS5 recovery processors, runner and policy: ${tests} tests OK`);
