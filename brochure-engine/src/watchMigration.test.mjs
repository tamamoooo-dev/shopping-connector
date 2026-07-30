// watchMigration.test.mjs — DEPLOYMENT REHEARSAL against real SQLite.
//
// Everything else in the watch suite runs on the in-memory twin. This one runs
// the ACTUAL migration file over the ACTUAL pre-migration schema, with rows
// shaped like production, and asserts the properties the deploy depends on:
//
//   1. the migration applies to a live-shaped DB and is purely additive;
//   2. it leaves NO row meaning "unknown" (the no-ambiguity invariant);
//   3. rows written before it survive it unchanged;
//   4. the post-migration store reads and writes every new column;
//   5. rolling the CODE back still reads those rows (columns are additive).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSqliteD1 } from './storage/testSqliteD1.mjs';
import { createD1WatchStore } from './storage/watchStore.js';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; };

// The live schema BEFORE this migration: everything up to price-watch-v2.
const PRE = [
  'migrate-2026-07-watches.sql',
  'migrate-2026-07-profiles.sql',
  'migrate-2026-07-27-price-watch-v2.sql',
];
const MIGRATIONS = [
  'migrate-2026-07-29-watch-product-anchor.sql',
  'migrate-2026-07-30-watch-identity-state.sql',
];

const fixture = createSqliteD1(PRE);
try {
  const { db, raw } = fixture;

  // Production-shaped rows, written by the PREVIOUS deployment's INSERT.
  const insert = (id, over = {}) => {
    const r = {
      id, profile_id: 'profile-live-1', kind: 'grocery', label: 'Sadia Chicken Breast 900 g',
      query: 'Sadia Chicken Breast', provider: null, product_id: null,
      target_price: 20, currency: 'SAR', active: 1, is_below: 0, is_close: 0,
      created_at: '2026-07-20T00:00:00Z',
      identity_family: 'chicken', identity_type: 'breast', brand_id: 'sadia',
      variant_key: '', size_unit: 'g', size_total: 900,
      match_brand: 1, match_size: 1, match_variant: 1,
      last_price: 23.5, last_store: 'panda',
      ...over,
    };
    const cols = Object.keys(r);
    raw.prepare(
      `INSERT INTO watches (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    ).run(...cols.map((c) => r[c]));
  };

  insert('w_strict');
  insert('w_relaxed', { match_brand: 0, match_size: 0, match_variant: 0 });
  insert('w_registry', { kind: 'registry', product_id: 'pr_livechicken1' });
  insert('w_product', { kind: 'product', provider: 'panda', product_id: '12142' });

  const before = raw.prepare('SELECT COUNT(*) AS n FROM watches').get().n;
  ok(before === 4, 'four live-shaped rows exist pre-migration');

  // --- 1. the migration applies ------------------------------------------------
  for (const migration of MIGRATIONS) raw.exec(readFileSync(migration, 'utf8'));
  ok(true, 'the migration applies cleanly to a live-shaped database');

  const cols = raw.prepare('PRAGMA table_info(watches)').all().map((r) => r.name);
  for (const c of ['registry_product_id', 'spec', 'scope',
    'last_resolution', 'last_resolution_reason', 'resolved_at', 'anchor_state',
    'source_snapshot', 'anchor_provenance', 'candidate_snapshot',
    'monitoring_health', 'monitoring_health_reason']) {
    ok(cols.includes(c), `added column ${c}`);
  }
  // Additive: nothing the previous deployment wrote was removed.
  for (const c of ['identity_family', 'identity_type', 'brand_id', 'variant_key',
    'match_brand', 'match_size', 'match_variant', 'last_price']) {
    ok(cols.includes(c), `pre-existing column ${c} survives`);
  }

  // --- 2. THE NO-AMBIGUITY INVARIANT -------------------------------------------
  const ambiguous = raw.prepare(
    `SELECT COUNT(*) AS n FROM watches
      WHERE registry_product_id IS NULL AND spec IS NULL AND last_resolution IS NULL`,
  ).get().n;
  ok(ambiguous === 0, 'no row is left meaning "unknown"');

  // --- 3. rows survive, and the registry watch is anchored by the SQL ----------
  ok(raw.prepare('SELECT COUNT(*) AS n FROM watches').get().n === before, 'no row lost');
  const reg = raw.prepare("SELECT * FROM watches WHERE id = 'w_registry'").get();
  ok(reg.registry_product_id === 'pr_livechicken1', 'a registry watch is anchored by the migration');
  ok(reg.anchor_state === 'anchored_registry', 'and receives the explicit Registry identity state');
  ok(reg.last_resolution === null, 'and is NOT stamped as waiting');

  const strict = raw.prepare("SELECT * FROM watches WHERE id = 'w_strict'").get();
  ok(strict.last_resolution === 'pending-migration', 'an unanchored watch IS stamped');
  ok(strict.anchor_state === 'resolving', 'and re-enters system-owned resolution');
  ok(strict.last_price === 23.5, 'and its existing state is untouched');
  ok(strict.identity_family === 'chicken', 'including the v2 identity columns');

  ok(raw.prepare("SELECT scope FROM watches WHERE id = 'w_product'").get().scope === 'store',
    'scope is derived from the old kind');
  ok(raw.prepare("SELECT scope FROM watches WHERE id = 'w_strict'").get().scope === 'market',
    'grocery becomes market scope');

  // --- 4. the post-migration store round-trips the new columns -----------------
  const store = createD1WatchStore(db);
  await store.setAnchor('w_strict', {
    registryProductId: 'pr_boundnow001', spec: null,
    provider: null, productId: null, anchorState: 'anchored_registry',
    anchorPolicyVersion: 'watch-identity-v3-2026-07-30',
    anchorConfidence: 1, anchorMargin: 1,
    anchorProvenance: '{"kind":"test"}',
    monitoringHealth: 'unchecked',
    lastResolution: null, lastResolutionReason: null,
  });
  const bound = await store.get('w_strict');
  ok(bound.registryProductId === 'pr_boundnow001', 'setAnchor persists through D1');
  ok(bound.lastResolution === null, 'and clears the waiting state');

  await store.updateState('w_product', {
    checkedAt: '2026-07-30T05:45:00Z',
    lastResolution: 'not-found',
    lastResolutionReason: 'excluded: cut ×4',
  });
  const missed = await store.get('w_product');
  ok(missed.lastResolution === 'not-found', 'updateState writes the outcome');
  ok(missed.resolvedAt == null, 'a failed check leaves resolved_at null');

  // The COMPUTE cap counts only anchored rows; storage counts every row.
  ok((await store.count('profile-live-1')) === 2, 'monitored = the two anchored rows');
  ok((await store.countRows('profile-live-1')) === 4, 'rows = all four');
  ok((await store.countUnanchored('profile-live-1')) === 2, 'two still await an anchor');

  // A new row goes in through the real INSERT — the shape the deploy uses.
  await store.create({
    id: 'w_new', profileId: 'profile-live-1', kind: 'grocery', scope: 'market',
    query: 'milk', label: 'Almarai Milk 1 L', targetPrice: 5, currency: 'SAR',
    registryProductId: 'pr_milk00000001', spec: null, active: true,
    anchorState: 'anchored_registry', monitoringHealth: 'unchecked',
    anchorPolicyVersion: 'watch-identity-v3-2026-07-30',
    createdAt: '2026-07-29T00:00:00Z',
  });
  ok((await store.get('w_new')).registryProductId === 'pr_milk00000001', 'create() round-trips');

  // --- 5. CODE ROLLBACK: the previous deployment's SELECT still works ----------
  // Its create() referenced only pre-migration columns, and its reads are
  // SELECT * — extra columns are inert. Simulate its read path.
  const legacyRead = raw.prepare('SELECT * FROM watches WHERE id = ?').get('w_new');
  ok(legacyRead.target_price === 5, 'a rolled-back build still reads new rows');
  ok(legacyRead.match_brand === 1, 'and their NOT NULL columns are populated');
  ok(legacyRead.kind === 'grocery', 'kind is still written, as rollback requires');
} finally {
  fixture.close();
}

console.log(`watchMigration.test: ${passed} passed, 0 failed`);
