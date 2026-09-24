// acceptanceVerdicts.test.mjs — R5/R6: S4 verdict persistence, against the real
// migration and a real SQL engine.
//
// WHAT THESE TESTS DEFEND, in priority order:
//
//  1. REJECTS ARE PERSISTED (R5). The whole value of the table is the reject
//     rows: they are the only signal that can calibrate the mandatory set. An
//     `if (verdict.accepted)` creeping into the write path would leave the
//     feature looking healthy — accepted rows still stored, queue depth still
//     moving — while destroying the thing it was built for. Asserted directly.
//  2. REASONS STAY PER-CONDITION (R6). `missing` must name the failed
//     conditions, and the per-condition counts must stay OVERLAPPING rather
//     than being collapsed into a reject total.
//  3. THE WRITE IS MIGRATION-TOLERANT. Before the migration the drain must run
//     untouched, because the verdict rides inside the atomic batch — a hard
//     dependency there would turn a missing table into lost extraction work.
//  4. THE WRITE IS ATOMIC WITH THE EXTRACTION. No verdict describing a rolled
//     back attempt, and no attempt without its verdict.

import assert from 'node:assert/strict';
import { createD1EnrichStore } from './enrichStore.js';
import { createSqliteD1, insertOffers } from './testSqliteD1.mjs';
import { buildStructuredProduct } from '../lexicon/structuredProduct.js';
import {
  BUSINESS_ACCEPTANCE_VERSION,
  MANDATORY_CONDITIONS,
  evaluateBusinessAcceptance,
} from '../offers/businessAcceptance.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('S4 verdict persistence (R5, R6):');

// schema.sql carries the verdict table (a clean deployment must have it), so
// "before the migration" is expressed by dropping it rather than by leaving the
// migration file out of the list.
const SCHEMA = [
  'schema.sql',
  'migrate-2026-07-vision-first-queue.sql',
  'migrate-2026-07-26-acceptance-verdicts.sql',
];
const NO_VERDICTS = ['offer_acceptance_verdicts'];
const AT = '2026-07-20T01:00:00.000Z';

function freshStore(offers = [], without = []) {
  const { db, raw, close } = createSqliteD1(SCHEMA, { without });
  insertOffers(raw, offers);
  return { store: createD1EnrichStore(db), raw, close };
}

const attempt = (offerId, accepted = true) => ({
  offerId,
  source: 'vision',
  output: { name_en: 'Arwa Water 330 ml' },
  validation: { acceptedFields: accepted ? ['name_en'] : [] },
  confidence: null,
  model: 'mistral-medium-latest',
  cropUrl: 'https://cdn.example/crop.jpg',
  accepted: accepted ? 1 : 0,
  attemptedAt: AT,
});

const complete = buildStructuredProduct({
  name_en: 'Arwa Bottled Water 330 ml', name_ar: 'مياه أروى', brand: 'Arwa', size: '330 ml',
});
const acceptedVerdict = evaluateBusinessAcceptance({
  offer: { price: 5.99, currency: 'SAR' },
  acceptedFields: ['name_en'],
  structured: complete,
});

await test('an ACCEPTED verdict round-trips with its mandatory set intact', async () => {
  const { store, close } = freshStore([{ id: 'a:r:d4d:1' }]);
  const out = await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:1'),
    canonicalRow: { id: 'a:r:d4d:1', name: 'Arwa Water 330 ml', corroboration: 1, enriched_at: AT },
    acceptance: acceptedVerdict,
  });
  assert.equal(out.verdictStored, true);
  const stored = await store.getAcceptanceVerdict('a:r:d4d:1');
  assert.equal(stored.accepted, true);
  assert.equal(stored.version, BUSINESS_ACCEPTANCE_VERSION);
  assert.deepEqual(stored.missing, []);
  assert.deepEqual(stored.mandatory, { price: true, english_name: true });
  assert.equal(stored.decidedAt, AT);
  close();
});

await test('a REJECTED verdict is persisted too — the point of R5', async () => {
  const { store, close } = freshStore([{ id: 'a:r:d4d:2', price: 0 }]);
  const rejected = evaluateBusinessAcceptance({
    offer: { price: null, currency: 'SAR' },
    acceptedFields: [],
    observation: {},
  });
  assert.equal(rejected.accepted, false);
  const out = await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:2', false),
    canonicalRow: null,
    triggerReasons: ['size_not_visible'],
    acceptance: rejected,
  });
  assert.equal(out.verdictStored, true);
  const stored = await store.getAcceptanceVerdict('a:r:d4d:2');
  assert.equal(stored.accepted, false);
  // Every failed condition names itself (R6).
  assert.deepEqual([...stored.missing].sort(), [...MANDATORY_CONDITIONS].sort());
  close();
});

await test('a single failed condition is recorded ALONE, not as a bare rejection', async () => {
  const { store, close } = freshStore([{ id: 'a:r:d4d:3' }]);
  // Price is present; only the English name is unresolved.
  const noEnglishName = evaluateBusinessAcceptance({
    offer: { price: 5.99, currency: 'SAR' },
    acceptedFields: [],
    structured: buildStructuredProduct({ name_en: 'Mystery Product', brand: 'Arwa' }),
  });
  assert.deepEqual([...noEnglishName.missing], ['english_name']);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:3', true), canonicalRow: null, acceptance: noEnglishName,
  });
  const stored = await store.getAcceptanceVerdict('a:r:d4d:3');
  assert.deepEqual(stored.missing, ['english_name']);
  assert.equal(stored.mandatory.price, true);
  assert.equal(stored.mandatory.english_name, false);
  close();
});

await test('the verdict is committed ATOMICALLY with the attempt', async () => {
  const { store, raw, close } = freshStore([{ id: 'a:r:d4d:4' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:4'),
    canonicalRow: { id: 'a:r:d4d:4', name: 'Arwa Water 330 ml', corroboration: 1, enriched_at: AT },
    acceptance: acceptedVerdict,
  });
  const attempts = raw.prepare('SELECT COUNT(*) n FROM offer_extraction_attempts').get();
  const stored = raw.prepare('SELECT COUNT(*) n FROM offer_acceptance_verdicts').get();
  assert.equal(attempts.n, 1);
  assert.equal(stored.n, 1);
  close();
});

await test('a re-judgement UPSERTS, so the ladder never accumulates stale verdicts', async () => {
  const { store, raw, close } = freshStore([{ id: 'a:r:d4d:5' }]);
  const rejected = evaluateBusinessAcceptance({
    offer: { price: 5.99, currency: 'SAR' }, acceptedFields: [], observation: {},
  });
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:5', false), canonicalRow: null, acceptance: rejected,
  });
  // A later rung resolves the missing fields; S4 is asked again.
  await store.saveVisionOutcome({
    attempt: { ...attempt('a:r:d4d:5'), attemptedAt: '2026-07-20T02:00:00.000Z' },
    canonicalRow: { id: 'a:r:d4d:5', name: 'Arwa Water 330 ml', corroboration: 1, enriched_at: AT },
    acceptance: acceptedVerdict,
  });
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offer_acceptance_verdicts').get().n, 1);
  const stored = await store.getAcceptanceVerdict('a:r:d4d:5');
  assert.equal(stored.accepted, true);
  assert.equal(stored.decidedAt, '2026-07-20T02:00:00.000Z');
  close();
});

// --- migration tolerance ------------------------------------------------------

await test('BEFORE the migration the extraction still commits, verdict skipped', async () => {
  const { store, close } = freshStore([{ id: 'a:r:d4d:6' }], NO_VERDICTS);
  const out = await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:6'),
    canonicalRow: { id: 'a:r:d4d:6', name: 'Arwa Water 330 ml', corroboration: 1, enriched_at: AT },
    acceptance: acceptedVerdict,
  });
  // The extraction is what must survive; the verdict is a calibration record.
  assert.equal(out.stored, 1);
  assert.equal(out.verdictStored, false);
  assert.equal(await store.getAcceptanceVerdict('a:r:d4d:6'), null);
  assert.equal(await store.acceptanceSummary(), null);
  close();
});

await test('a store given no verdict at all behaves exactly as before', async () => {
  const { store, close } = freshStore([{ id: 'a:r:d4d:7' }]);
  const out = await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:7'),
    canonicalRow: { id: 'a:r:d4d:7', name: 'Arwa Water 330 ml', corroboration: 1, enriched_at: AT },
  });
  assert.equal(out.stored, 1);
  assert.equal(out.verdictStored, false);
  close();
});

// --- the calibration read (R6) ------------------------------------------------

await test('acceptanceSummary counts conditions separately, and they OVERLAP', async () => {
  const { store, close } = freshStore([
    { id: 'a:r:d4d:s1' }, { id: 'a:r:d4d:s2' }, { id: 'a:r:d4d:s3' }, { id: 'a:r:d4d:s4' },
  ]);
  const save = (id, acceptance) => store.saveVisionOutcome({
    attempt: attempt(id), canonicalRow: null, acceptance,
  });
  // s1 accepted; s2 missing price only; s3 missing English only;
  // s4 missing price AND English.
  await save('a:r:d4d:s1', acceptedVerdict);
  await save('a:r:d4d:s2', evaluateBusinessAcceptance({
    offer: { price: 0, currency: 'SAR' },
    acceptedFields: ['name_en'],
    structured: buildStructuredProduct({ name_en: 'No Size Product' }),
  }));
  await save('a:r:d4d:s3', evaluateBusinessAcceptance({
    offer: { price: 1, currency: 'SAR' }, acceptedFields: [], structured: complete,
  }));
  await save('a:r:d4d:s4', evaluateBusinessAcceptance({
    offer: { price: 0, currency: 'SAR' },
    acceptedFields: [],
    structured: buildStructuredProduct({ name_en: 'No Size Product' }),
  }));

  const summary = await store.acceptanceSummary();
  assert.equal(summary.judged, 4);
  assert.equal(summary.accepted, 1);
  assert.equal(summary.rejected, 3);
  assert.equal(summary.acceptanceRate, 25);
  // Overlapping counts: s4 appears in BOTH buckets. Summing these would
  // exceed the reject count, which is exactly why they are not summed.
  assert.equal(summary.missingByCondition.english_name, 2);
  assert.equal(summary.missingByCondition.price, 2);
  // The disjoint view: offers a SINGLE condition is keeping out.
  assert.equal(summary.onlyCondition.english_name, 1);
  assert.equal(summary.onlyCondition.price, 1);
  close();
});

await test('the summary is version-scoped, so one gate version is never averaged with another', async () => {
  // The "other" version must be one that CANNOT become real, or this test
  // quietly stops testing anything the day it ships. It was originally spelled
  // `business-acceptance-v2`, which collided with the real v2 on 2026-07-30 —
  // both fixtures landed in the same bucket and the scoping assertion failed
  // for the right reason. A far-future sentinel keeps the property honest.
  const OTHER_VERSION = 'business-acceptance-v999';
  assert.notEqual(BUSINESS_ACCEPTANCE_VERSION, OTHER_VERSION, 'the sentinel must never be the live version');
  const { store, close } = freshStore([{ id: 'a:r:d4d:cur' }, { id: 'a:r:d4d:other' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:cur'), canonicalRow: null, acceptance: acceptedVerdict,
  });
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:other'),
    canonicalRow: null,
    acceptance: { ...acceptedVerdict, version: OTHER_VERSION, accepted: false, missing: ['price'] },
  });
  const all = await store.acceptanceSummary();
  assert.equal(all.judged, 2);
  const current = await store.acceptanceSummary({ version: BUSINESS_ACCEPTANCE_VERSION });
  assert.equal(current.judged, 1);
  assert.equal(current.accepted, 1);
  const other = await store.acceptanceSummary({ version: OTHER_VERSION });
  assert.equal(other.judged, 1);
  assert.equal(other.rejected, 1);
  close();
});

await test('summary condition keys are generated FROM the gate, not restated', async () => {
  const { store, close } = freshStore([{ id: 'a:r:d4d:k' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:k'), canonicalRow: null, acceptance: acceptedVerdict,
  });
  const summary = await store.acceptanceSummary();
  assert.deepEqual(Object.keys(summary.missingByCondition), [...MANDATORY_CONDITIONS]);
  assert.deepEqual(Object.keys(summary.onlyCondition), [...MANDATORY_CONDITIONS]);
  close();
});

await test('the Comparable Quantity evidence is retained for calibration (R8)', async () => {
  const { store, close } = freshStore([{ id: 'a:r:d4d:q' }]);
  await store.saveVisionOutcome({
    attempt: attempt('a:r:d4d:q'), canonicalRow: null, acceptance: acceptedVerdict,
  });
  const stored = await store.getAcceptanceVerdict('a:r:d4d:q');
  assert.equal(stored.comparableQuantity.status, acceptedVerdict.comparableQuantity.status);
  assert.equal(stored.comparableQuantity.evidence, acceptedVerdict.comparableQuantity.evidence ?? null);
  close();
});

console.log(`\nS4 verdict persistence: ${tests} tests OK`);
