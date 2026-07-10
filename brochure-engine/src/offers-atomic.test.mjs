// offers-atomic.test.mjs — Phase 2: the structured-offers write has ATOMIC
// VISIBILITY. The production `offers` table is only ever the complete previous
// dataset or the complete new dataset — never an intermediate state — under any
// failure (interrupted batch, failed validation, promote failure, restart).
//
// Cases (each asserts the VISIBLE table is never partial):
//   1. successful ingest                         -> whole set promoted
//   2. interrupted ingest after an arbitrary batch -> nothing promoted
//   3. failed validation (coverage too low)      -> nothing promoted, previous kept
//   4. promotion failure                          -> nothing promoted, previous kept
//   5. retry after failure                        -> next run promotes fully
// Run: node src/offers-atomic.test.mjs

import { ingestOffersForTarget } from './offers/ingest.js';
import { createMemoryOfferStore } from './storage/local.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

const FLYER = '742356';
const provider = { id: 'teststore', regions: { central: { store: 'teststore-212', city: 'riyadh' } } };

// N raw D4D-shaped records; the first `priced` carry a price (buildOffer keeps
// them), the rest are unpriced (dropped by the price gate).
function mkRaws(n, priced = n) {
  return Array.from({ length: n }, (_, i) => ({
    offerId: 90000000 + i, flyerRef: FLYER, pageRef: String(1 + (i % 30)),
    price: i < priced ? 5 : 0, wasPrice: 0, description: 'test milk 1l', categoryId: 40,
    imageUrl: null, sourceUrl: `https://x/o/${i}`, validFrom: '2026-07-07', validTo: '2026-07-14', storeWords: [],
  }));
}
const fakeSource = (raws) => ({ name: 'd4d', async listOffers() { return raws; } });
const visibleCount = (store) => store.byFlyer('teststore', 'central', FLYER).then((r) => r.length);

// Seed a COMPLETE previous healthy dataset (a prior week's promote) so "previous
// preserved" is observable. Marked with edition 'prev' / price 9.
async function seedPrevious(store, n) {
  await store.stageMany(mkRaws(n).map((r) => ({
    id: `teststore:central:d4d:${r.offerId}`, store: 'teststore', region: 'central', source: 'd4d',
    offer_id: String(r.offerId), flyer_ref: FLYER, page_ref: r.pageRef, edition: 'prev',
    name: 'prev', name_ar: null, price: 9, old_price: null, currency: 'SAR', category_id: '40',
    category: null, image_url: null, source_url: r.sourceUrl, valid_from: r.validFrom,
    valid_to: r.validTo, detected_at: 'prev-run', search_text: 'prev',
  })));
  await store.promoteStaged('teststore', 'central', 'd4d');
  await store.clearStage('teststore', 'central', 'd4d');
}
const isPreviousIntact = (visible, n) =>
  visible.length === n && visible.every((r) => r.price === 9 && r.detected_at === 'prev-run');

const N = 722; // > 700, spans 19 batches of 40

// Wrap a memory store to inject a failure at a chosen step.
function fragile(base, { throwStageAfterBatches = Infinity, throwOnPromote = false, batchSize = 40 } = {}) {
  return {
    ...base,
    async stageMany(rows) {
      for (let b = 0; b * batchSize < rows.length; b++) {
        await base.stageMany(rows.slice(b * batchSize, (b + 1) * batchSize), { batchSize });
        if (b + 1 >= throwStageAfterBatches) throw new Error(`SIMULATED failure on stage batch ${b + 2}`);
      }
      return { staged: rows.length };
    },
    async promoteStaged(store, region, src) {
      if (throwOnPromote) throw new Error('SIMULATED promote failure (atomic statement rejected)');
      return base.promoteStaged(store, region, src);
    },
  };
}

// --- 1. successful ingest -------------------------------------------------------
{
  const store = createMemoryOfferStore();
  const line = await ingestOffersForTarget({ offersSource: fakeSource(mkRaws(N)), offerStore: store }, provider, 'central');
  check('1 success: ok, no errors', line.ok && line.errors.length === 0, JSON.stringify(line.errors));
  check('1 success: whole set visible', (await visibleCount(store)) === N && line.stored === N, `${line.stored}`);
  check('1 success: staging cleared', (await store.stagedCount('teststore', 'central', 'd4d')) === 0);
}

// --- 2. interrupted after an arbitrary batch (here batch 5) ---------------------
{
  const base = createMemoryOfferStore();
  await seedPrevious(base, N);
  const store = fragile(base, { throwStageAfterBatches: 5 });
  const line = await ingestOffersForTarget({ offersSource: fakeSource(mkRaws(N)), offerStore: store }, provider, 'central');
  const visible = await base.byFlyer('teststore', 'central', FLYER);
  check('2 interrupted: failed + surfaced', line.ok === false && line.errors.length === 1, JSON.stringify(line));
  check('2 interrupted: previous dataset intact (no partial)', isPreviousIntact(visible, N), `visible ${visible.length}`);
  check('2 interrupted: staging discarded', (await base.stagedCount('teststore', 'central', 'd4d')) === 0);
}

// --- 3. failed validation (source mostly unpriced -> coverage too low) ----------
{
  const store = createMemoryOfferStore();
  await seedPrevious(store, N);
  // 722 fetched but only 80 priced -> built 80 << 50% -> validation refuses promote
  const line = await ingestOffersForTarget({ offersSource: fakeSource(mkRaws(N, 80)), offerStore: store }, provider, 'central');
  const visible = await store.byFlyer('teststore', 'central', FLYER);
  check('3 validation: failed + surfaced', line.ok === false && /coverage too low/.test(line.errors[0] || ''), JSON.stringify(line.errors));
  check('3 validation: previous dataset preserved', isPreviousIntact(visible, N), `visible ${visible.length}`);
}

// --- 4. promotion failure -------------------------------------------------------
{
  const base = createMemoryOfferStore();
  await seedPrevious(base, N);
  const store = fragile(base, { throwOnPromote: true });
  const line = await ingestOffersForTarget({ offersSource: fakeSource(mkRaws(N)), offerStore: store }, provider, 'central');
  const visible = await base.byFlyer('teststore', 'central', FLYER);
  check('4 promote-fail: failed + surfaced', line.ok === false && /promote failure/.test(line.errors[0] || ''), JSON.stringify(line.errors));
  check('4 promote-fail: previous dataset intact (atomic — no partial)', isPreviousIntact(visible, N), `visible ${visible.length}`);
}

// --- 5. retry after failure -----------------------------------------------------
{
  const base = createMemoryOfferStore();
  await seedPrevious(base, N);
  // first run fails mid-stage
  await ingestOffersForTarget({ offersSource: fakeSource(mkRaws(N)), offerStore: fragile(base, { throwStageAfterBatches: 3 }) }, provider, 'central');
  check('5 retry: previous intact after the failed run', isPreviousIntact(await base.byFlyer('teststore', 'central', FLYER), N));
  // retry on the healthy store promotes the full new dataset
  const line = await ingestOffersForTarget({ offersSource: fakeSource(mkRaws(N)), offerStore: base }, provider, 'central');
  const visible = await base.byFlyer('teststore', 'central', FLYER);
  check('5 retry: succeeds', line.ok && line.stored === N);
  check('5 retry: new complete dataset now visible', visible.length === N && visible.every((r) => r.price === 5));
}

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll Phase-2 offers-atomicity tests passed (visible table never partial).');
