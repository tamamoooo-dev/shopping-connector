import assert from 'node:assert/strict';
import { getQueryPricesDoc } from '../priceHistory.js';
import { buildIdentitySearchQuery, createD1HistoryStore } from './historyStore.js';
import { createSqliteD1 } from './testSqliteD1.mjs';

let tests = 0;
async function test(name, fn) {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
}

const identity = (id, matchText, price = 10, overrides = {}) => ({
  id,
  store: 'test-store',
  region: 'riyadh',
  name: matchText,
  name_ar: null,
  match_text: matchText,
  size_unit: null,
  size_total: null,
  size_pack: null,
  category: null,
  image_url: null,
  source_url: null,
  currency: 'SAR',
  first_seen: '2026-08-01',
  last_seen: '2026-08-25',
  weeks_seen: 1,
  last_price: price,
  last_valid_to: '2026-08-31',
  ...overrides,
});

const planFor = (raw, query) => raw
  .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
  .all(...query.binds)
  .map((row) => row.detail)
  .join('\n');

console.log('Price identity indexed-search regressions:');

await test('real SQLite plan replaces the leading-wildcard corpus scan', async () => {
  const { raw, close } = createSqliteD1(['schema.sql']);
  const before = raw.prepare(`EXPLAIN QUERY PLAN
    SELECT * FROM price_identities WHERE match_text LIKE ?`).all('%notpresent%')
    .map((row) => row.detail).join('\n');
  assert.match(before, /SCAN price_identities/);

  const query = buildIdentitySearchQuery('notpresent', 300);
  const after = planFor(raw, query);
  assert.match(after, /price_identities_fts VIRTUAL TABLE INDEX \d+:M\d/);
  assert.match(after, /SEARCH p USING INTEGER PRIMARY KEY \(rowid=\?\)/);
  assert.doesNotMatch(after, /SCAN p(?:\s|$)/);
  close();
});

await test('bilingual long and keyed short variants preserve successful matches', async () => {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  const store = createD1HistoryStore(db);
  await store.upsertIdentities([
    identity('milk-en', 'fresh milk one litre', 8),
    identity('rice-ar', 'ارز بسمتي رز', 9),
    identity('corn-prefix', 'cornflakes family pack', 11),
    identity('short-exact', 'brand xy pack', 7),
    identity('short-noise', 'foxy candy', 1),
  ]);

  assert.deepEqual(
    (await store.searchIdentities({ q: 'milk', limit: 300 })).map((row) => row.id),
    ['milk-en'],
  );
  assert.deepEqual(
    (await store.searchIdentities({ q: 'rice', limit: 300 })).map((row) => row.id),
    ['rice-ar'],
  );
  assert.deepEqual(
    (await store.searchIdentities({ q: 'corn', limit: 300 })).map((row) => row.id),
    ['corn-prefix'],
  );
  // `foxy` satisfied the old broad %xy% prefilter, but can never pass the
  // unchanged short-token relevance gate. The short-word sentinel retains the
  // legitimate row without allowing that noise to consume the LIMIT window.
  assert.deepEqual(
    (await store.searchIdentities({ q: 'xy', limit: 300 })).map((row) => row.id),
    ['short-exact'],
  );
  assert.match(planFor(raw, buildIdentitySearchQuery('xy', 300)), /VIRTUAL TABLE INDEX \d+:M\d/);
  close();
});

await test('successful end-to-end history match and a genuine miss stay honest', async () => {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  const store = createD1HistoryStore(db);
  await store.upsertIdentities([identity('nova', 'nova water نوفا مياه', 5.5)]);
  await store.insertPoints([{
    identity: 'nova',
    week: '2026-08-20',
    price: 5.5,
    old_price: 7,
    observed_at: '2026-08-20T00:00:00.000Z',
  }]);

  const hit = await getQueryPricesDoc(store, 'NOVA WATER 1.5L', { today: '2026-08-25' });
  assert.equal(hit.lowest?.price, 5.5);
  assert.equal(hit.observations, 1);

  const miss = await getQueryPricesDoc(store, 'definitely not in this catalog', {
    today: '2026-08-25',
  });
  assert.equal(miss.lowest, null);
  assert.equal(miss.observations, 0);
  assert.deepEqual(miss.variants, []);

  const missPlan = planFor(raw, buildIdentitySearchQuery('definitely not in this catalog', 300));
  assert.match(missPlan, /VIRTUAL TABLE INDEX \d+:M\d/);
  assert.doesNotMatch(missPlan, /SCAN p(?:\s|$)/);
  close();
});

await test('insert, changed match_text, and stale delete maintain the search index', async () => {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  const store = createD1HistoryStore(db);
  await store.upsertIdentities([identity('mutable', 'brand xy milk', 10, {
    last_seen: '2025-01-01',
  })]);
  assert.equal((await store.searchIdentities({ q: 'milk' })).length, 1);
  assert.equal((await store.searchIdentities({ q: 'xy' })).length, 1);

  await store.upsertIdentities([identity('mutable', 'brand zz coffee', 9, {
    first_seen: '2025-01-01',
    last_seen: '2025-01-02',
  })]);
  assert.equal((await store.searchIdentities({ q: 'milk' })).length, 0);
  assert.equal((await store.searchIdentities({ q: 'coffee' })).length, 1);
  assert.equal((await store.searchIdentities({ q: 'xy' })).length, 0);
  assert.equal((await store.searchIdentities({ q: 'zz' })).length, 1);

  assert.deepEqual(await store.pruneStale('2026-01-01', { maxRows: 1 }), {
    identities: 1,
    points: 0,
  });
  assert.equal((await store.searchIdentities({ q: 'coffee' })).length, 0);
  raw.prepare(
    "INSERT INTO price_identities_fts(price_identities_fts) VALUES('integrity-check')",
  ).run();
  close();
});

console.log(`\nPrice identity indexed-search regressions: ${tests} tests OK`);
