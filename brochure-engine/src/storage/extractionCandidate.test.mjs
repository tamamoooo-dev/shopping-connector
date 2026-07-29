// extractionCandidate.test.mjs — R4: the S1 admission predicate has TWO
// bindings (SQL in storage/enrichStore.js, JS in offers/commerceScore.js) and
// they must agree exactly. This suite is the proof.
//
// WHY THIS SUITE EXISTS. `USABLE_PRICE_SQL` is a hand translation of
// `hasUsableCommercePrice`. Hand translations rot silently: nothing in the type
// system, and no test that mocks D1, can catch SQLite disagreeing with
// JavaScript about what a number is. So this runs the REAL SQL against a REAL
// SQLite engine (node:sqlite) over a table of adversarial rows and asserts
// row-for-row agreement with the JS predicate.
//
// Two divergences were found this way during implementation and are pinned
// below as named tests, because both would have shipped otherwise:
//   - `'SAR '` — JS String.trim() strips NBSP, SQLite's bare TRIM does not.
//     SQL would have been STRICTER than JS: the dangerous direction, silently
//     starving an extractable offer of its one model call.
//   - `Infinity`   — typeof(price) is 'real' but Number.isFinite is false.
//     SQL would have been more permissive, paying for a doomed extraction.
//
// If SQLite is unavailable the suite SKIPS rather than passes, so a missing
// engine can never be mistaken for agreement.

import assert from 'node:assert/strict';
import { hasUsableCommercePrice } from '../offers/commerceScore.js';
import { USABLE_PRICE_SQL } from './enrichStore.js';

let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  console.log('S1 admission predicate: SKIPPED (node:sqlite unavailable)');
  process.exit(0);
}

let tests = 0;
const test = (name, fn) => {
  fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('S1 admission predicate (R4) — SQL twin vs JS:');

// The adversarial corpus. Each row is [label, price, currency]. `price` is
// bound through a REAL-affinity column exactly as production does, so affinity
// conversion is part of what is under test.
const CASES = [
  ['plain', 5.99, 'SAR'],
  ['integer', 3, 'SAR'],
  ['zero', 0, 'SAR'],
  ['negative', -1, 'SAR'],
  ['non_numeric_text', '12abc', 'SAR'],
  ['numeric_text', '5.99', 'SAR'],
  ['lowercase_currency', 3, 'sar'],
  ['padded_currency', 3, ' SAR '],
  ['tab_currency', 3, 'SAR\t'],
  ['newline_currency', 3, '\nSAR'],
  ['nbsp_currency', 3, 'SAR '],
  ['bom_currency', 3, 'SAR﻿'],
  ['four_letter_currency', 3, 'SARX'],
  ['two_letter_currency', 3, 'SA'],
  ['digit_in_currency', 3, 'S4R'],
  ['empty_currency', 3, ''],
  ['null_currency', 3, null],
  ['null_price', null, 'SAR'],
  ['infinity', Infinity, 'SAR'],
  ['negative_infinity', -Infinity, 'SAR'],
  ['very_large', 1e307, 'SAR'],
];

const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE offers (id TEXT PRIMARY KEY, price REAL, currency TEXT)');
const insert = db.prepare('INSERT INTO offers VALUES (?, ?, ?)');
for (const [label, price, currency] of CASES) insert.run(label, price, currency);

// `o` is the alias USABLE_PRICE_SQL is written against, matching every query
// that embeds it.
const sqlVerdicts = new Map(
  db
    .prepare(`SELECT o.id, (${USABLE_PRICE_SQL}) AS admitted FROM offers o`)
    .all()
    .map((r) => [r.id, !!r.admitted]),
);
// Read the values BACK from SQLite rather than reusing the literals: what the
// JS predicate sees in production is a D1 row, post-affinity, not the input.
const storedRows = new Map(
  db.prepare('SELECT id, price, currency FROM offers').all().map((r) => [r.id, r]),
);

test('every row agrees between the SQL twin and the JS predicate', () => {
  const divergences = [];
  for (const [label] of CASES) {
    const row = storedRows.get(label);
    const sql = sqlVerdicts.get(label);
    const js = hasUsableCommercePrice(row);
    if (sql !== js) divergences.push(`${label}: SQL=${sql} JS=${js}`);
  }
  assert.deepEqual(divergences, [], `predicate divergence: ${divergences.join('; ')}`);
});

test('the corpus actually exercises both verdicts', () => {
  const admitted = [...sqlVerdicts.values()].filter(Boolean).length;
  assert.ok(admitted > 0, 'no row was admitted — the test would pass vacuously');
  assert.ok(admitted < CASES.length, 'every row was admitted — nothing is being filtered');
});

// --- the two divergences found during implementation, pinned individually ----

test('NBSP-padded currency is ADMITTED (SQL must not be stricter than JS)', () => {
  assert.equal(hasUsableCommercePrice(storedRows.get('nbsp_currency')), true);
  assert.equal(sqlVerdicts.get('nbsp_currency'), true);
});

test('Infinity is REJECTED (typeof is real, but it is not finite)', () => {
  assert.equal(hasUsableCommercePrice(storedRows.get('infinity')), false);
  assert.equal(sqlVerdicts.get('infinity'), false);
  assert.equal(sqlVerdicts.get('negative_infinity'), false);
});

test('a non-numeric string in a REAL column is REJECTED, not CAST to a number', () => {
  // The reason the fragment uses typeof() and not CAST(): CAST('12abc' AS REAL)
  // is 12.0, which would admit an offer JS considers priceless.
  assert.equal(sqlVerdicts.get('non_numeric_text'), false);
  assert.equal(hasUsableCommercePrice(storedRows.get('non_numeric_text')), false);
});

test('a numeric STRING is admitted, because REAL affinity converts it on write', () => {
  assert.equal(storedRows.get('numeric_text').price, 5.99);
  assert.equal(sqlVerdicts.get('numeric_text'), true);
});

test('zero and negative prices are rejected, as the ingest sanity gate intends', () => {
  assert.equal(sqlVerdicts.get('zero'), false);
  assert.equal(sqlVerdicts.get('negative'), false);
});

test('currency shape is enforced: exactly three ASCII letters, case-insensitively', () => {
  assert.equal(sqlVerdicts.get('lowercase_currency'), true);
  assert.equal(sqlVerdicts.get('padded_currency'), true);
  assert.equal(sqlVerdicts.get('four_letter_currency'), false);
  assert.equal(sqlVerdicts.get('two_letter_currency'), false);
  assert.equal(sqlVerdicts.get('digit_in_currency'), false);
  assert.equal(sqlVerdicts.get('empty_currency'), false);
  assert.equal(sqlVerdicts.get('null_currency'), false);
});

db.close();

console.log(`\nS1 admission predicate: ${tests} tests OK`);
