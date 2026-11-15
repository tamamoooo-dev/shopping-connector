// The Fresh and Frozen listings, executed against real SQLite and the real
// schema. Pins the production defect found 2026-11-15:
//
//   The frozen-mark SQL wrote the offer's whole name expression out once per
//   term (41 terms). A Fresh or Frozen listing carries the mark twice, so its
//   statement reached 163 KB; D1 accepts 100 KB. Every Fresh and Frozen page
//   answered 500 while every other department worked.
//
// Two things are checked: no Browse statement may come near D1's limit, and
// the SQL mark still agrees with its JS twin (mapping.isFrozenMarked) row by
// row, including rows whose names are NULL.

import assert from 'node:assert/strict';
import { getBrowseOffersDoc, getBrowseSummaryDoc } from '../browse/api.js';
import { isFrozenMarked } from '../browse/mapping.js';
import { DEPARTMENTS, AISLES } from '../browse/taxonomy.js';
import { createD1BrowseStore } from './browseStore.js';
import { createSqliteD1, insertOffers } from './testSqliteD1.mjs';

const TODAY = '2026-07-20';
// D1 refuses a statement over 100,000 bytes. Half of it is the ceiling here, so
// a later growth of the name expression fails this test long before production.
const STATEMENT_CEILING = 50_000;
const BOUND_CEILING = 40;

const { db, raw, close } = createSqliteD1(['schema.sql']);

// Every name shape the mark has to classify, all filed under a FRESH category.
const NAMES = [
  ['Fresh Chicken Whole 1kg', 'دجاج كامل طازج'],
  ['Frozen Chicken Whole 1kg', null],
  [null, 'دجاج مجمد 1 كجم'],
  ['Chicken Nuggets 400g', null],
  [null, 'برجر دجاج 24 حبة'],
  ['Chicken Burger', 'برجر دجاج بوتشر'], // a fresh-counter word outweighs a processed form
  ['Butcher Burger Frozen', null], // a literal frozen mark is never outweighed
  ['FROZEN chicken strips', null], // ASCII case
  ['Chicken Breast', 'صدور دجاج'],
  [null, null], // no name at all: reads as "no mark", never as NULL
];
insertOffers(raw, NAMES.map(([name, name_ar], i) => ({
  id: `lulu:central:d4d:${i + 1}`, name, name_ar, price: 10 + i, category: 'fresh-chicken-poultry',
})));
// Two rows no source maps: a category slug nobody knows, and no category.
// Names the classifier cannot place either, so they belong to More.
insertOffers(raw, [
  { id: 'lulu:central:d4d:901', name: 'Zzyx Qwv', price: 3, category: 'a-slug-nobody-maps' },
  { id: 'lulu:central:d4d:902', name: 'Zzyx Qwv Two', price: 4, category: null },
]);
raw.exec("UPDATE offers SET brochure_id = 'fixture-brochure', page_index = 0");

const expectFrozen = NAMES.filter(([n, a]) => isFrozenMarked(n, a)).length;
const expectFresh = NAMES.length - expectFrozen;
assert.ok(expectFrozen >= 5 && expectFresh >= 4, 'the fixture covers both sides of the mark');

let assertions = 0;
for (const builtArabicNamesEnabled of [false, true]) {
  const statements = [];
  const boundCounts = [];
  const recording = {
    ...db,
    prepare(sql) {
      statements.push(Buffer.byteLength(sql));
      const statement = db.prepare(sql);
      return {
        ...statement,
        bind(...args) {
          boundCounts.push(args.length);
          return statement.bind(...args);
        },
      };
    },
  };
  const store = createD1BrowseStore(recording, { builtArabicNamesEnabled });
  const ctx = { browseStore: store };

  // The tile counts split the fresh category by the mark exactly as JS does.
  const counts = await store.categoryCounts(TODAY);
  const marked = (flag) => counts
    .filter((r) => r.category === 'fresh-chicken-poultry' && Number(r.frozen_marked) === flag)
    .reduce((n, r) => n + Number(r.n), 0);
  assert.equal(marked(1), expectFrozen, 'tile counts: frozen-marked rows');
  assert.equal(marked(0), expectFresh, 'tile counts: unmarked rows (NULL names included)');

  // The listings place every row on the side JS places it, and nowhere else.
  const fresh = await getBrowseOffersDoc(ctx, { aisle: 'chicken-poultry' }, TODAY);
  const frozen = await getBrowseOffersDoc(ctx, { aisle: 'frozen-poultry' }, TODAY);
  assert.equal(fresh.count, expectFresh, 'fresh aisle: the unmarked rows');
  assert.equal(frozen.count, expectFrozen, 'frozen aisle: the marked rows');
  assert.ok(fresh.offers.every((o) => o.aisle === 'chicken-poultry'), 'fresh cards say fresh');
  assert.ok(frozen.offers.every((o) => o.aisle === 'frozen-poultry'), 'frozen cards say frozen');
  assert.equal((await getBrowseOffersDoc(ctx, { dept: 'fresh' }, TODAY)).count, expectFresh);
  assert.equal((await getBrowseOffersDoc(ctx, { dept: 'frozen' }, TODAY)).count, expectFrozen);

  // Every statement Browse can send: the summary, each department, each aisle,
  // a brand page.
  await getBrowseSummaryDoc(ctx, TODAY);
  for (const d of DEPARTMENTS) await getBrowseOffersDoc(ctx, { dept: d.id }, TODAY);
  for (const a of AISLES) await getBrowseOffersDoc(ctx, { aisle: a.id, sort: 'price' }, TODAY);
  await getBrowseOffersDoc(ctx, { dept: 'fresh', brand: 'almarai' }, TODAY);
  await getBrowseOffersDoc(ctx, { dept: 'more', store: 'lulu', brand: 'almarai' }, TODAY);
  const largest = Math.max(...statements);
  assert.ok(
    largest < STATEMENT_CEILING,
    `largest Browse statement is ${largest} bytes; D1 refuses 100,000 (ceiling here ${STATEMENT_CEILING})`,
  );
  // D1 refuses more than 100 bound parameters. The More department bound 175
  // (every mapped category of every source) and answered 500.
  const mostBound = Math.max(...boundCounts);
  assert.ok(
    mostBound <= BOUND_CEILING,
    `a Browse statement binds ${mostBound} parameters; D1 refuses over 100 (ceiling here ${BOUND_CEILING})`,
  );

  // The More department: only what no source maps, saved classification included.
  const more = await getBrowseOffersDoc(ctx, { dept: 'more' }, TODAY);
  assert.equal(more.count, 2, 'More: the unmapped-category row and the no-category row');
  assert.ok(more.offers.every((o) => o.aisle === 'other'), 'More cards say other');
  assertions += 12;
}

close();
console.log(`browseStore frozen mark: ${assertions} assertions passed`);
