// enrichStoreQueries.test.mjs — the R4 queries, executed for real.
//
// extractionCandidate.test.mjs proves the PREDICATE is a faithful translation.
// This suite proves the three QUERIES that embed it are valid SQL against the
// real schema.sql and that they still agree with each other afterwards.
//
// The distinction matters. A predicate can be perfect and still be pasted into
// a query with a broken alias or a missing AND, and no amount of mocked-`db`
// testing would notice — the Worker would simply throw on its first request
// after deploy. So these run through createD1EnrichStore against node:sqlite.
//
// THE INVARIANT THIS EXISTS TO DEFEND: `coverage().remaining` must equal
// `countDebris('all')`. enrichStore.js documents that identity, and R4 could
// easily have broken it by filtering the work queue but not the denominator —
// leaving priceless offers permanently uncovered and capping coverage% below
// 100 forever. It is asserted directly, twice, on mixed traffic.

import assert from 'node:assert/strict';
import { createD1EnrichStore } from './enrichStore.js';
import { createSqliteD1, insertOffers } from './testSqliteD1.mjs';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('enrichStore R4 queries (real SQLite, real schema):');

const SCHEMA = ['schema.sql', 'migrate-2026-07-vision-first-queue.sql'];
const CURRENT_ON = '2026-07-20';

function freshStore(offers) {
  const { db, raw, close } = createSqliteD1(SCHEMA);
  insertOffers(raw, offers);
  return { store: createD1EnrichStore(db), raw, close };
}

// Mixed traffic: three admissible offers and five that S1 must refuse for a
// different reason each.
const MIXED = [
  { id: 'a:r:d4d:ok1', price: 5.99, currency: 'SAR' },
  { id: 'a:r:d4d:ok2', price: 12, currency: 'SAR' },
  { id: 'a:r:d4d:ok3', price: 0.5, currency: 'sar' },
  { id: 'a:r:d4d:zero', price: 0, currency: 'SAR' },
  { id: 'a:r:d4d:negative', price: -3, currency: 'SAR' },
  { id: 'a:r:d4d:badcurrency', price: 4, currency: 'XX' },
  { id: 'a:r:d4d:nocrop', price: 4, currency: 'SAR', image_url: null },
  { id: 'a:r:d4d:expired', price: 4, currency: 'SAR', valid_to: '2026-07-01' },
];

await test('listDebris executes and admits only priced, cropped, current offers', async () => {
  const { store, close } = freshStore(MIXED);
  const debris = await store.listDebris({ currentOn: CURRENT_ON, limit: 50 });
  assert.deepEqual(
    debris.map((r) => r.id).sort(),
    ['a:r:d4d:ok1', 'a:r:d4d:ok2', 'a:r:d4d:ok3'],
  );
  close();
});

await test('countDebris returns exactly the number listDebris would hand out', async () => {
  const { store, close } = freshStore(MIXED);
  const [listed, counted] = await Promise.all([
    store.listDebris({ currentOn: CURRENT_ON, limit: 50 }),
    store.countDebris(CURRENT_ON),
  ]);
  assert.equal(counted, listed.length);
  assert.equal(counted, 3);
  close();
});

await test('coverage().remaining === countDebris("all") on untouched traffic', async () => {
  const { store, close } = freshStore(MIXED);
  const coverage = await store.coverage(CURRENT_ON);
  assert.equal(coverage.remaining, await store.countDebris(CURRENT_ON, 'all'));
  // The denominator is S1-admissible offers, NOT every offer holding a crop.
  assert.equal(coverage.withCrop, 3);
  assert.equal(coverage.attempted, 0);
  assert.equal(coverage.coverage, 0);
  close();
});

await test('the identity still holds once part of the queue is attempted', async () => {
  const { store, close } = freshStore(MIXED);
  await store.saveVisionOutcome({
    attempt: {
      offerId: 'a:r:d4d:ok1',
      source: 'vision',
      output: { name_en: 'Arwa Water 330 ml' },
      validation: { acceptedFields: ['name_en'] },
      confidence: null,
      model: 'mistral-medium-latest',
      cropUrl: 'https://cdn.example/crop.jpg',
      accepted: 1,
      attemptedAt: '2026-07-20T01:00:00.000Z',
    },
    canonicalRow: {
      id: 'a:r:d4d:ok1',
      name: 'Arwa Water 330 ml',
      corroboration: 1,
      enriched_at: '2026-07-20T01:00:00.000Z',
    },
    triggerReasons: [],
  });
  const coverage = await store.coverage(CURRENT_ON);
  assert.equal(coverage.attempted, 1);
  assert.equal(coverage.remaining, await store.countDebris(CURRENT_ON, 'all'));
  assert.equal(coverage.remaining, 2);
  // An attempted offer must leave the work queue — one crop, one model call.
  const debris = await store.listDebris({ currentOn: CURRENT_ON, limit: 50 });
  assert.ok(!debris.some((r) => r.id === 'a:r:d4d:ok1'));
  close();
});

await test('coverage can reach 100% — no priceless offer is stranded in it', async () => {
  // The regression R4 could have introduced: if the denominator kept priceless
  // offers, coverage would asymptote below 100 and the Ops number would lie.
  const { store, close } = freshStore([
    { id: 'a:r:d4d:priced', price: 5, currency: 'SAR' },
    { id: 'a:r:d4d:priceless', price: 0, currency: 'SAR' },
  ]);
  await store.saveVisionOutcome({
    attempt: {
      offerId: 'a:r:d4d:priced',
      source: 'vision',
      output: null,
      validation: { acceptedFields: [] },
      confidence: null,
      model: 'm',
      cropUrl: null,
      accepted: 0,
      attemptedAt: '2026-07-20T01:00:00.000Z',
    },
    canonicalRow: null,
    triggerReasons: ['size_not_visible'],
  });
  const coverage = await store.coverage(CURRENT_ON);
  assert.equal(coverage.withCrop, 1);
  assert.equal(coverage.coverage, 100);
  assert.equal(coverage.remaining, 0);
  assert.equal(await store.countDebris(CURRENT_ON), 0);
  close();
});

await test('the debris scope still narrows to rows deriveNames could not name', async () => {
  const { store, close } = freshStore([
    { id: 'a:r:d4d:named', price: 5, currency: 'SAR', name: 'Known Product' },
    { id: 'a:r:d4d:unnamed', price: 5, currency: 'SAR' },
    { id: 'a:r:d4d:unnamed_priceless', price: 0, currency: 'SAR' },
  ]);
  const debris = await store.listDebris({ currentOn: CURRENT_ON, limit: 50, scope: 'debris' });
  assert.deepEqual(debris.map((r) => r.id), ['a:r:d4d:unnamed']);
  assert.equal(await store.countDebris(CURRENT_ON, 'debris'), 1);
  // ...and the price filter composes with the scope rather than replacing it.
  assert.equal(await store.countDebris(CURRENT_ON, 'all'), 2);
  close();
});

await test('listDebris carries price and currency so S4 needs no second query', async () => {
  const { store, close } = freshStore([{ id: 'a:r:d4d:ok1', price: 7.25, currency: 'SAR' }]);
  const [row] = await store.listDebris({ currentOn: CURRENT_ON });
  assert.equal(row.price, 7.25);
  assert.equal(row.currency, 'SAR');
  assert.equal(row.image_url, 'https://cdn.example/crop.jpg');
  close();
});

console.log(`\nenrichStore R4 queries: ${tests} tests OK`);
