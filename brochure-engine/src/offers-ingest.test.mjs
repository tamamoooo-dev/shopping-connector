// offers-ingest.test.mjs — Phase 1 of the offers-shortfall fix.
//
// Phase 1 = (a) brochure and offers ingest run in SEPARATE invocations, and
// (b) a failing offers batch is no longer swallowed — it fails the ingest.
// This test pins those two guarantees AND MEASURES the open question the user
// asked: with the invocations separated but a plain (non-atomic) multi-batch
// upsert, can a partial visible offers table still occur if a batch fails
// mid-write? The answer decides whether Phase 2 (staging/atomic promote) is
// warranted. Run: node src/offers-ingest.test.mjs

import { ingestOffersForTarget } from './offers/ingest.js';
import { createMemoryOfferStore } from './storage/local.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const FLYER = '742356';
const provider = { id: 'teststore', regions: { central: { store: 'teststore-212', city: 'riyadh' } } };

function mkRaws(n) {
  return Array.from({ length: n }, (_, i) => ({
    offerId: 90000000 + i, flyerRef: FLYER, pageRef: String(1 + (i % 30)),
    price: 5, wasPrice: 0, description: 'test milk 1l', categoryId: 40,
    imageUrl: null, sourceUrl: `https://x/o/${i}`,
    validFrom: '2026-07-07', validTo: '2026-07-14', storeWords: [],
  }));
}
const fakeSource = (raws) => ({ name: 'd4d', async listOffers() { return raws; } });

const N = 722; // > 700, spans 19 batches of 40

// --- 1. happy path: the whole company's offers land -----------------------------
{
  const store = createMemoryOfferStore();
  const line = await ingestOffersForTarget({ offersSource: fakeSource(mkRaws(N)), offerStore: store }, provider, 'central');
  const visible = await store.byFlyer('teststore', 'central', FLYER);
  check('happy: ok, no errors', line.ok === true && line.errors.length === 0, JSON.stringify(line.errors));
  check('happy: stored == fetched == all visible', line.stored === N && visible.length === N, `${line.stored}/${visible.length}`);
}

// --- 2. a failing batch is NOT swallowed -> the ingest FAILS (Phase 1 guarantee) -
// A store whose upsertMany commits 2 batches (80 rows) then rejects, exactly like
// a subrequest/CPU/time limit hitting the 3rd D1 batch.
function truncatingStore(base, { commitBatches = 2, batchSize = 40 } = {}) {
  return {
    ...base,
    async upsertMany(rows) {
      await base.upsertMany(rows.slice(0, commitBatches * batchSize)); // batches commit
      throw new Error('SIMULATED subrequest limit exceeded on batch ' + (commitBatches + 1));
    },
  };
}
{
  const base = createMemoryOfferStore();
  const store = truncatingStore(base, { commitBatches: 2 });
  const line = await ingestOffersForTarget({ offersSource: fakeSource(mkRaws(N)), offerStore: store }, provider, 'central');
  const visible = await base.byFlyer('teststore', 'central', FLYER);
  check('failure: surfaced, not swallowed', line.ok === false && line.errors.length === 1, JSON.stringify(line));

  // MEASUREMENT (the open question): does Phase 1 alone still allow a partial
  // visible table? With a plain non-atomic multi-batch upsert, the batches that
  // committed before the failure REMAIN visible. Record it.
  console.log(`  ->  after a mid-write batch failure, visible offers = ${visible.length} of ${N}`);
  check('MEASURED: Phase 1 leaves a PARTIAL visible table on batch failure',
    visible.length > 0 && visible.length < N,
    `visible ${visible.length}`);
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Phase-1 offers-ingest tests passed.');
console.log('FINDING: separating invocations fixes the OBSERVED cause (the write now completes),');
console.log('but a plain multi-batch upsert can STILL leave a partial visible table if any batch');
console.log('fails mid-write — so the "never partial" guarantee needs Phase 2 (staging/atomic promote).');
