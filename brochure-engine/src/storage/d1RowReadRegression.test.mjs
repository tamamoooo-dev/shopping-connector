import assert from 'node:assert/strict';
import { createD1EnrichStore } from './enrichStore.js';
import { createD1VisionVerificationStore } from './visionVerificationStore.js';
import { createSqliteD1, insertOffers } from './testSqliteD1.mjs';

let tests = 0;
async function test(name, fn) {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
}

function details(raw, sql, ...args) {
  return raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => row.detail).join('\n');
}

function insertAllSidecars(raw, id) {
  const at = '2026-08-01T00:00:00.000Z';
  raw.prepare('INSERT INTO offer_enrichments (id,name,enriched_at,match_text) VALUES (?,?,?,?)')
    .run(id, 'Product', at, 'product');
  raw.prepare(`INSERT INTO offer_extraction_attempts
    (offer_id,source,validation,accepted,attempted_at) VALUES (?, 'vision', '{}', 1, ?)`).run(id, at);
  raw.prepare(`INSERT INTO offer_ocr_queue
    (offer_id,status,trigger_reasons,attempts,created_at,updated_at)
    VALUES (?, 'ocr_pending', '[]', 0, ?, ?)`).run(id, at, at);
  raw.prepare(`INSERT INTO offer_recovery_attempts
    (offer_id,processor,attempt_no,outcome,started_at) VALUES (?, 'ocr', 1, 'no_change', ?)`).run(id, at);
  raw.prepare(`INSERT INTO offer_recovery_queue
    (offer_id,status,reasons,created_at,updated_at) VALUES (?, 'queued', '[]', ?, ?)`).run(id, at, at);
  raw.prepare(`INSERT INTO offer_acceptance_verdicts
    (offer_id,version,accepted,missing,mandatory,decided_at) VALUES (?, 'v1', 1, '[]', '{}', ?)`).run(id, at);
  raw.prepare(`INSERT INTO offer_vision_verification_queue
    (offer_id,status,attempts,initial_outcome,matched_fingerprint,match_count,created_at,updated_at)
    VALUES (?, 'queued', 1, 'accepted', '[]', 0, ?, ?)`).run(id, at, at);
}

console.log('D1 row-read regressions:');

await test('missing match_text probe is backed by the selective partial index', async () => {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  insertOffers(raw, Array.from({ length: 100 }, (_, index) => ({
    id: `index:r:d4d:${index}`,
    valid_to: '2099-01-01',
  })));
  const insert = raw.prepare(
    'INSERT INTO offer_enrichments (id,name,enriched_at,match_text) VALUES (?,?,?,?)',
  );
  for (let index = 0; index < 100; index += 1) {
    insert.run(`index:r:d4d:${index}`, 'Product', '2026-08-01T00:00:00.000Z', 'product');
  }
  const plan = details(raw, `SELECT id,name,name_ar,brand FROM offer_enrichments
    WHERE match_text IS NULL AND (name IS NOT NULL OR name_ar IS NOT NULL)
    ORDER BY id LIMIT ?`, 200);
  assert.match(plan, /ix_offer_enrichments_match_text_missing/);
  assert.equal(await createD1EnrichStore(db).reindexMatchText(200), 0);
  close();
});

await test('current Arabic shadow repair probe uses an empty partial index', async () => {
  const { raw, close } = createSqliteD1(['schema.sql']);
  const current = JSON.stringify({
    _arabic_builder: {
      builder_score_version: 'builder-score-v1',
      commerce_score_version: 'commerce-score-v1',
    },
  });
  raw.prepare(`INSERT INTO offer_enrichments
    (id,enriched_at,extraction_json) VALUES ('current','2026-08-25T00:00:00.000Z',?)`)
    .run(current);
  const predicate = `CASE WHEN extraction_json IS NULL THEN 1
    WHEN json_valid(extraction_json) THEN (
      COALESCE(json_extract(extraction_json, '$._arabic_builder.builder_score_version'), '')
        != 'builder-score-v1' OR
      COALESCE(json_extract(extraction_json, '$._arabic_builder.commerce_score_version'), '')
        != 'commerce-score-v1')
    ELSE 0 END`;
  const plan = details(raw, `SELECT id FROM offer_enrichments
    WHERE ${predicate} ORDER BY enriched_at DESC LIMIT ?`, 200);
  assert.match(plan, /ix_offer_enrichments_arabic_shadow_missing/);
  assert.equal(raw.prepare(`SELECT COUNT(*) n FROM offer_enrichments WHERE ${predicate}`).get().n, 0);
  close();
});

await test('retention deletes one bounded offer set and every sidecar atomically', async () => {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  insertOffers(raw, [
    { id: 'old:r:d4d:1', valid_to: '2026-07-01' },
    { id: 'old:r:d4d:2', valid_to: '2026-07-02' },
    { id: 'recent:r:d4d:3', valid_to: '2026-08-20' },
    { id: 'current:r:d4d:4', valid_to: '2099-01-01' },
  ]);
  insertAllSidecars(raw, 'old:r:d4d:1');
  insertAllSidecars(raw, 'old:r:d4d:2');
  const store = createD1EnrichStore(db);
  raw.exec(`CREATE TRIGGER force_cleanup_rollback BEFORE DELETE ON offer_ocr_queue
    BEGIN SELECT RAISE(ABORT, 'forced cleanup rollback'); END`);
  await assert.rejects(
    store.pruneExpiredOffers('2026-08-11', { limit: 1 }),
    /forced cleanup rollback/,
  );
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offers WHERE id=?').get('old:r:d4d:1').n, 1);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offer_enrichments WHERE id=?').get('old:r:d4d:1').n, 1);
  raw.exec('DROP TRIGGER force_cleanup_rollback');
  const first = await store.pruneExpiredOffers('2026-08-11', { limit: 1 });
  assert.equal(first.offers, 1);
  assert.equal(first.sidecars, 7);
  assert.deepEqual(Object.values(first.byTable), Array(7).fill(1));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offers WHERE id=?').get('old:r:d4d:1').n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offers WHERE id=?').get('old:r:d4d:2').n, 1);
  for (const [table, column] of [
    ['offer_enrichments', 'id'], ['offer_extraction_attempts', 'offer_id'],
    ['offer_ocr_queue', 'offer_id'], ['offer_recovery_attempts', 'offer_id'],
    ['offer_recovery_queue', 'offer_id'], ['offer_acceptance_verdicts', 'offer_id'],
    ['offer_vision_verification_queue', 'offer_id'],
  ]) {
    assert.equal(raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`).get('old:r:d4d:1').n, 0);
    assert.equal(raw.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${column}=?`).get('old:r:d4d:2').n, 1);
  }
  const plan = details(raw, `DELETE FROM offer_enrichments WHERE id IN (
    SELECT id FROM offers WHERE valid_to IS NOT NULL AND valid_to < ?
    ORDER BY valid_to, id LIMIT ?)`, '2026-08-11', 1);
  assert.match(plan, /SEARCH offer_enrichments USING (?:COVERING )?INDEX/);
  assert.match(plan, /ix_offers_valid/);
  const second = await store.pruneExpiredOffers('2026-08-11', { limit: 1 });
  assert.equal(second.offers, 1);
  assert.equal(second.sidecars, 7);
  const done = await store.pruneExpiredOffers('2026-08-11', { limit: 1 });
  assert.equal(done.offers, 0);
  assert.equal(done.sidecars, 0);
  assert.deepEqual(
    raw.prepare('SELECT id FROM offers ORDER BY id').all().map((row) => row.id),
    ['current:r:d4d:4', 'recent:r:d4d:3'],
  );
  close();
});

await test('Stage 1 scheduler ids retain queue guards and use keyed lookups', async () => {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  insertOffers(raw, [
    { id: 'queue:r:d4d:ready', valid_to: '2099-01-01' },
    { id: 'queue:r:d4d:done', valid_to: '2099-01-01' },
    { id: 'queue:r:d4d:outside', valid_to: '2099-01-01' },
  ]);
  raw.prepare(`INSERT INTO offer_enrichments (id,name,enriched_at,match_text)
    VALUES ('queue:r:d4d:done','Done','2026-08-01T00:00:00.000Z','done')`).run();
  const rows = await createD1EnrichStore(db).listDebrisByIds({
    ids: ['queue:r:d4d:ready', 'queue:r:d4d:done'],
    currentOn: '2026-08-25',
  });
  assert.deepEqual(rows.map((row) => row.id), ['queue:r:d4d:ready']);
  const plan = details(raw, `SELECT o.id FROM offers o
    LEFT JOIN offer_enrichments e ON e.id=o.id
    LEFT JOIN offer_extraction_attempts v ON v.offer_id=o.id AND v.source='vision'
    WHERE o.id IN (?,?) AND e.id IS NULL AND v.offer_id IS NULL
      AND o.image_url IS NOT NULL AND o.valid_to>=?`,
  'queue:r:d4d:ready', 'queue:r:d4d:done', '2026-08-25');
  assert.match(plan, /sqlite_autoindex_offers_1/);
  close();
});

await test('Stage 2 scheduler ids retain lease/current guards and use queue keys', async () => {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  insertOffers(raw, [
    { id: 'verify:r:d4d:ready', valid_to: '2099-01-01' },
    { id: 'verify:r:d4d:done', valid_to: '2099-01-01' },
  ]);
  const at = '2026-08-01T00:00:00.000Z';
  const insert = raw.prepare(`INSERT INTO offer_vision_verification_queue
    (offer_id,status,attempts,initial_outcome,matched_fingerprint,match_count,created_at,updated_at)
    VALUES (?,?,1,'accepted','[]',0,?,?)`);
  insert.run('verify:r:d4d:ready', 'queued', at, at);
  insert.run('verify:r:d4d:done', 'verified', at, at);
  const store = createD1VisionVerificationStore(db);
  const rows = await store.listPendingByIds({
    ids: ['verify:r:d4d:ready', 'verify:r:d4d:done'],
    currentOn: '2026-08-25',
  });
  assert.deepEqual(rows.map((row) => row.offerId), ['verify:r:d4d:ready']);
  const plan = details(raw, `SELECT q.offer_id FROM offer_vision_verification_queue q
    JOIN offers o ON o.id=q.offer_id
    WHERE q.offer_id IN (?,?) AND q.status='queued' AND o.valid_to>=?`,
  'verify:r:d4d:ready', 'verify:r:d4d:done', '2026-08-25');
  assert.match(plan, /sqlite_autoindex_offer_vision_verification_queue_1/);
  close();
});

await test('Stage 2 coordinator is driven by the ready queue, not all current offers', async () => {
  const { raw, close } = createSqliteD1(['schema.sql']);
  const plan = details(raw, `SELECT q.offer_id, q.status, q.attempts, q.updated_at,
      o.image_url, e.name AS initial_name
    FROM offer_vision_verification_queue q INDEXED BY ix_vision_verification_ready
    CROSS JOIN offers o ON o.id=q.offer_id
    LEFT JOIN offer_enrichments e ON e.id=q.offer_id
    WHERE (q.status='queued' OR
      (q.status='claimed' AND (q.claim_until IS NULL OR q.claim_until<=?)))
      AND o.valid_to>=? AND o.image_url IS NOT NULL
    ORDER BY q.updated_at, q.offer_id LIMIT ?`,
  '2026-08-25T00:00:00.000Z', '2026-08-25', 28);
  assert.match(plan, /ix_vision_verification_ready/);
  assert.match(plan, /sqlite_autoindex_offers_1/);
  assert.doesNotMatch(plan, /ix_offers_valid/);
  close();
});

console.log(`\nD1 row-read regressions: ${tests} tests OK`);
