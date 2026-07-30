// testSqliteD1.mjs — a D1-shaped adapter over node:sqlite. TEST SUPPORT ONLY.
//
// NOT part of the deployed Worker: nothing under src/index.js imports it, so it
// is never bundled. It exists so the D1 store implementations can be tested
// against a REAL SQL engine running the REAL schema.sql, instead of against a
// hand-written mock.
//
// WHY THIS IS WORTH HAVING. Every previous test of these stores mocked `db`,
// which means the assertions only ever proved that JS called JS. A mock cannot
// catch the failures that actually reach production from this layer: a SQL
// syntax error, a column that does not exist, a JOIN that silently multiplies
// rows, or SQLite disagreeing with JavaScript about types. Those are exactly the
// defects that make a Worker throw on its first real request after deploy.
//
// It implements only the D1 surface these stores use — prepare/bind/all/first/
// run and batch — and deliberately no more.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

function d1Statement(db, sql, bound = []) {
  const run = () => {
    const statement = db.prepare(sql);
    return { statement, args: bound };
  };
  return {
    bind: (...args) => d1Statement(db, sql, args),
    async all() {
      const { statement, args } = run();
      return { results: statement.all(...args), success: true };
    },
    async first(column = null) {
      const { statement, args } = run();
      const row = statement.get(...args) ?? null;
      if (row && column) return row[column] ?? null;
      return row;
    },
    async run() {
      const { statement, args } = run();
      const info = statement.run(...args);
      return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
    },
    // Batch executes through the same path; D1 wraps a batch in one implicit
    // transaction, and so does this, so an atomic-commit test means something.
    _exec() {
      const { statement, args } = run();
      return statement.run(...args);
    },
  };
}

/**
 * @param {string[]} sqlFiles paths to schema/migration files, applied in order.
 * @param {{without?: string[]}} [options] tables to DROP after applying, to
 *   simulate a database whose migration has not been run yet. schema.sql is the
 *   full current schema — it necessarily contains every table, which is the
 *   point of it — so "this migration is missing" can no longer be expressed by
 *   leaving a file out of the list. Dropping is the honest equivalent, and it
 *   keeps the migration-tolerance tests testing the store rather than testing
 *   which files a test happened to load.
 * @returns {{db: object, raw: DatabaseSync, close: () => void}} `db` is the D1-shaped handle.
 */
export function createSqliteD1(sqlFiles = [], { without = [] } = {}) {
  const raw = new DatabaseSync(':memory:');
  for (const file of sqlFiles) raw.exec(readFileSync(file, 'utf8'));
  for (const table of without) raw.exec(`DROP TABLE IF EXISTS ${table}`);
  const db = {
    prepare: (sql) => d1Statement(raw, sql),
    async batch(statements) {
      raw.exec('BEGIN');
      try {
        const out = statements.map((s) => s._exec());
        raw.exec('COMMIT');
        return out.map((info) => ({ success: true, meta: { changes: info.changes } }));
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    async exec(sql) {
      raw.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
  return { db, raw, close: () => raw.close() };
}

// Minimal valid `offers` row. Callers override only the field under test, so a
// test reads as the one thing it is about.
//
// store/region/source/offer_id are DERIVED from `id` rather than defaulted,
// because `offers` carries a UNIQUE constraint over those four columns and the
// S0 invariant is that `id` = `store:region:source:offerId`. Defaulting them
// would make every seeded row collide on the second insert.
export function offerRow(overrides = {}) {
  const id = overrides.id ?? 'store:region:d4d:1';
  const [store, region, source, offerId] = String(id).split(':');
  return {
    id,
    store,
    region,
    source,
    offer_id: offerId,
    price: 5.99,
    currency: 'SAR',
    category: 'rice',
    image_url: 'https://cdn.example/crop.jpg',
    valid_from: '2026-07-01',
    valid_to: '2026-07-31',
    detected_at: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

export function insertOffers(raw, offers) {
  const columns = [
    'id', 'store', 'region', 'source', 'offer_id', 'name', 'name_ar', 'price',
    'currency', 'image_url', 'valid_from', 'valid_to', 'detected_at', 'category',
  ];
  const statement = raw.prepare(
    `INSERT INTO offers (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
  );
  for (const offer of offers) {
    const row = offerRow(offer);
    statement.run(...columns.map((c) => (row[c] === undefined ? null : row[c])));
  }
}
