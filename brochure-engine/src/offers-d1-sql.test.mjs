// offers-d1-sql.test.mjs — validates the REAL D1 offers SQL (createD1OfferStore)
// against a real SQLite engine (node:sqlite = the engine D1 runs), so the atomic
// stage->promote is proven on the shipped SQL, not only the in-memory mirror.
//
// Proves: the staging INSERT, the COUNT, and — the load-bearing one — the single
// `INSERT INTO offers SELECT … FROM offer_stage ON CONFLICT(id) DO UPDATE`
// promote (atomic, size-independent, detected_at preserved).
// Run: node --experimental-sqlite src/offers-d1-sql.test.mjs   (node 22.5+)

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.log('  skip  node:sqlite unavailable (needs node 22.5+); D1 SQL validated when it is');
  process.exit(0);
}
import { createD1OfferStore } from './storage/offerStore.js';
import { offerToRow, buildOffer } from './offers/contract.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Minimal D1-compatible adapter over node:sqlite: prepare().bind().run()/first()/all()
// and a transactional batch() (D1's batch is one implicit transaction).
function d1(db) {
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async run() { return { meta: { changes: db.prepare(sql).run(...params).changes } }; },
            async first() { return db.prepare(sql).get(...params) ?? null; },
            async all() { return { results: db.prepare(sql).all(...params) }; },
          };
        },
      };
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

const COLS = `id TEXT PRIMARY KEY, store TEXT, region TEXT, source TEXT, offer_id TEXT,
  flyer_ref TEXT, page_ref TEXT, edition TEXT, name TEXT, name_ar TEXT, price REAL,
  old_price REAL, currency TEXT, category_id TEXT, category TEXT, image_url TEXT,
  source_url TEXT, valid_from TEXT, valid_to TEXT, detected_at TEXT, search_text TEXT`;
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE offers (${COLS});`);
db.exec(`CREATE TABLE offer_stage (${COLS});`);
db.exec('CREATE INDEX ix ON offer_stage(store, region, source);');
const store = createD1OfferStore(d1(db));

const row = (i, price, { detectedAt = 'run1' } = {}) =>
  offerToRow(buildOffer(
    { offerId: 90000000 + i, flyerRef: '742356', pageRef: String(i % 30), price, wasPrice: 0,
      description: 'milk 1l', categoryId: 40, imageUrl: null, sourceUrl: `https://x/${i}`,
      validFrom: '2026-07-07', validTo: '2026-07-14', storeWords: [] },
    { store: 'teststore', region: 'central', source: 'd4d', detectedAt },
  ));

const N = 722;

// stage -> count -> promote (the full atomic path, 19 batches)
await store.clearStage('teststore', 'central', 'd4d');
await store.stageMany(Array.from({ length: N }, (_, i) => row(i, 5)));
check('D1 staged all rows', (await store.stagedCount('teststore', 'central', 'd4d')) === N);
const promoted = await store.promoteStaged('teststore', 'central', 'd4d');
check('D1 promote INSERT…SELECT ran (changes == N)', promoted === N, `changes ${promoted}`);
check('D1 offers now holds all', (await store.byFlyer('teststore', 'central', '742356')).length === N);

// upsert path: re-promote the SAME ids with a new price + new detected_at.
// price must update; detected_at must be PRESERVED (not in the DO UPDATE set).
await store.clearStage('teststore', 'central', 'd4d');
await store.stageMany(Array.from({ length: N }, (_, i) => row(i, 7, { detectedAt: 'run2' })));
await store.promoteStaged('teststore', 'central', 'd4d');
const after = await store.byFlyer('teststore', 'central', '742356');
check('D1 upsert did not duplicate rows', after.length === N, `rows ${after.length}`);
check('D1 upsert updated price', after.every((r) => r.price === 7));
check('D1 upsert PRESERVED detected_at (first-seen)', after.every((r) => r.detected_at === 'run1'));

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nAll D1 offers-SQL tests passed.');
