import assert from 'node:assert/strict';
import { createD1EnrichStore } from './enrichStore.js';
import { archiveDoc, archiveImportValues, createOfferArchive, sizeMatches } from './offerArchive.js';
import { createSqliteD1, insertOffers } from './testSqliteD1.mjs';

let tests = 0;
async function test(name, fn) {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
}

console.log('Offer price archive:');

await test('expiring offers are archived in the same batch that deletes them', async () => {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  insertOffers(raw, [
    { id: 'danube:central:d4d:1', store: 'danube', name: 'tuna tuna goody', name_ar: 'تونه', price: 14.99, valid_from: '2026-07-29', valid_to: '2026-08-04' },
    { id: 'danube:central:d4d:2', store: 'danube', name: 'goody tuna 80g', price: 8.99, valid_from: '2026-07-29', valid_to: '2026-08-04' },
    { id: 'danube:central:d4d:3', store: 'danube', name: 'current', price: 5, valid_to: '2099-01-01' },
  ]);
  raw.prepare(`INSERT INTO offer_enrichments (id, name, name_ar, size, corroboration, enriched_at, match_text)
    VALUES (?,?,?,?,?,?,?)`).run('danube:central:d4d:1', 'Goody Tenderina Tuna 185g', 'تندرينا تونة ١٨٥ جم', '185g', 1,
    '2026-08-01T00:00:00.000Z', 'goody tenderina tuna 185g تندرينا تونه 185 جم');
  // A non-servable reading (corroboration under the floor) never names the row.
  raw.prepare(`INSERT INTO offer_enrichments (id, name, corroboration, enriched_at, match_text)
    VALUES (?,?,?,?,?)`).run('danube:central:d4d:2', 'Wrong Guess', 0.1, '2026-08-01T00:00:00.000Z', 'wrong guess');
  const store = createD1EnrichStore(db);

  raw.exec(`CREATE TRIGGER force_rollback BEFORE DELETE ON offers
    BEGIN SELECT RAISE(ABORT, 'forced rollback'); END`);
  await assert.rejects(store.pruneExpiredOffers('2026-08-11', { limit: 10 }), /forced rollback/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offer_archive').get().n, 0, 'archive rolls back with the delete');
  raw.exec('DROP TRIGGER force_rollback');

  const report = await store.pruneExpiredOffers('2026-08-11', { limit: 10 });
  assert.equal(report.offers, 2);
  assert.equal(report.archived, 2);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM offers').get().n, 1);
  const rows = raw.prepare('SELECT * FROM offer_archive ORDER BY id').all();
  assert.equal(rows[0].name, 'Goody Tenderina Tuna 185g');
  assert.equal(rows[0].size, '185g');
  assert.equal(rows[0].price, 14.99);
  assert.equal(rows[0].valid_from, '2026-07-29');
  assert.equal(rows[0].origin, 'retention');
  assert.match(rows[0].match_text, /tenderina/);
  assert.equal(rows[1].name, 'goody tuna 80g', 'non-servable Vision falls back to the flyer text');
  assert.equal(rows[1].size, null);

  const archive = createOfferArchive(db);
  const found = await archive.search({ q: 'تندرينا تونا 185' });
  assert.deepEqual(found.rows.map((r) => r.id), ['danube:central:d4d:1']);
  close();
});

await test('backfill import validates rows, computes match_text and is idempotent', async () => {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  const archive = createOfferArchive(db);
  const rows = [
    { id: 'othaim:central:d4d:95000001', price: 14.99, validFrom: '2026-08-04', validTo: '2026-08-10', name: 'Goody Tenderina Tuna', nameAr: 'تونة قودي خفيف', size: '185g', flyerText: 'tuna tenderina goody 185g each', origin: 'vision-evidence' },
    { id: 'tamimi:central:d4d:95000002', price: 12.99, oldPrice: 15, validFrom: '2026-08-04', name: 'GOODY LITE MEAT OR TENDERINA TUNA', size: '185 - 195 GRAMS', origin: 'dump-2026-08-26' },
    { id: 'tamimi:central:d4d:95000003', price: 9.99, validFrom: '2026-08-18', name: 'Tenderina Tuna 1850 ml', origin: 'x' },
    { id: 'bad id', price: 1, validFrom: '2026-08-01', name: 'x' },
    { id: 'lulu:central:d4d:1', price: 0, validFrom: '2026-08-01', name: 'free' },
    { id: 'lulu:central:d4d:2', price: 3, name: 'no date' },
    { id: 'lulu:central:d4d:3', price: 3, validFrom: '2026-08-01', name: 'cheap', oldPrice: 2 },
  ];
  const first = await archive.importRows(rows);
  assert.deepEqual(first, { received: 7, valid: 4, invalid: 3, inserted: 4 });
  const again = await archive.importRows(rows);
  assert.equal(again.inserted, 0, 'existing ids are never overwritten');
  const row = raw.prepare('SELECT * FROM offer_archive WHERE id=?').get('tamimi:central:d4d:95000002');
  assert.equal(row.store, 'tamimi');
  assert.equal(row.region, 'central');
  assert.equal(row.old_price, 15);
  assert.equal(row.origin, 'backfill:dump-2026-08-26');
  assert.equal(raw.prepare('SELECT old_price FROM offer_archive WHERE id=?').get('lulu:central:d4d:3').old_price, null);

  const english = await archive.search({ q: 'Tenderina tuna 185g' });
  assert.deepEqual(english.rows.map((r) => r.id).sort(), ['othaim:central:d4d:95000001', 'tamimi:central:d4d:95000002']);
  const arabic = await archive.search({ q: 'تونة تندرينا ١٨٥ جم' });
  assert.deepEqual(arabic.rows.map((r) => r.id).sort(), ['othaim:central:d4d:95000001', 'tamimi:central:d4d:95000002']);
  const all = await archive.search({ q: 'tenderina' });
  assert.equal(all.rows.length, 3);
  assert.equal(all.rows[0].valid_from, '2026-08-18', 'newest first');

  const doc = archiveDoc('tenderina', all);
  assert.equal(doc.offers, 3);
  assert.equal(doc.first, '2026-08-04');
  assert.equal(doc.last, '2026-08-18');
  assert.deepEqual(doc.stores.map((s) => [s.store, s.offers, s.lowest, s.highest]), [['tamimi', 2, 9.99, 12.99], ['othaim', 1, 14.99, 14.99]]);
  const stats = await archive.stats();
  assert.equal(stats.rows, 4);
  close();
});

await test('a missing archive table reads as empty, never as an error', async () => {
  const { db, close } = createSqliteD1([]);
  const archive = createOfferArchive(db);
  assert.deepEqual((await archive.search({ q: 'milk' })).rows, []);
  assert.equal((await archive.stats()).rows, 0);
  close();
});

await test('size filter matches whole numbers only', async () => {
  const size = { unit: 'g', each: 185, total: 185, pack: 1 };
  assert.equal(sizeMatches({ match_text: 'tuna 185g' }, size), true);
  assert.equal(sizeMatches({ match_text: 'tuna 185 - 195 grams' }, size), true);
  assert.equal(sizeMatches({ match_text: 'tuna 1850 ml' }, size), false);
  assert.equal(sizeMatches({ match_text: 'tuna 2185g' }, size), false);
  assert.equal(sizeMatches({ match_text: 'anything' }, null), true);
  const litre = { unit: 'ml', each: 1000, total: 1000, pack: 1 };
  assert.equal(sizeMatches({ name: 'Almarai Fresh Milk', size: '1L', match_text: 'almarai fresh milk' }, litre), true, 'parsed size field');
  assert.equal(sizeMatches({ match_text: 'حليب مراعي 1 لتر' }, litre), true, 'litres as printed');
  assert.equal(sizeMatches({ match_text: 'almarai milk 1l' }, litre), true);
  assert.equal(sizeMatches({ match_text: 'almarai milk 1000ml' }, litre), true);
  assert.equal(sizeMatches({ match_text: 'buy 1 get 1 almarai milk 2l' }, litre), false, 'a bare 1 is not a litre');
  assert.equal(sizeMatches({ name: 'Almarai Milk', size: '2L', match_text: 'almarai milk 2l' }, litre), false);
  assert.equal(archiveImportValues({ id: 'a:b:c:1', price: 2, validFrom: '2026-01-01' }, 'now'), null, 'no text, no row');
});

console.log(`${tests} offer archive tests passed`);
