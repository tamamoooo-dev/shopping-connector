import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createD1EnrichStore } from './enrichStore.js';
import {
  compatibleVisionIdentity,
  createD1VisionVerificationStore,
  STAGE_TWO_MAX_ATTEMPTS,
  visionVerificationFingerprint,
  visionVerificationFingerprintHash,
} from './visionVerificationStore.js';
import { createSqliteD1, insertOffers } from './testSqliteD1.mjs';
import { normalizeText } from '../matching.js';

const SCHEMA = ['schema.sql'];
const AT = '2026-08-11T00:00:00.000Z';
const TODAY = '2026-08-11';
let tests = 0;

async function test(name, fn) {
  await fn();
  tests += 1;
  console.log('  ok ', name);
}

function fresh(ids = ['s:r:d4d:1']) {
  const { db, raw, close } = createSqliteD1(SCHEMA);
  insertOffers(raw, ids.map((id) => ({
    id,
    image_url: `https://cdn.example/${encodeURIComponent(id)}.jpg`,
    price: 5.99,
    currency: 'SAR',
    valid_to: '2099-01-01',
  })));
  return {
    db,
    raw,
    close,
    enrichStore: createD1EnrichStore(db),
    verificationStore: createD1VisionVerificationStore(db),
  };
}

function candidate(id, name, overrides = {}) {
  return {
    id,
    name,
    name_ar: 'مياه أروى 330 مل',
    brand: 'Arwa',
    size: '330 ml',
    confidence: 0.98,
    corroboration: 1,
    model: 'mistral-medium-latest',
    crop_url: `https://cdn.example/${encodeURIComponent(id)}.jpg`,
    enriched_at: AT,
    extraction_json: { name_en: name, name_ar: 'مياه أروى 330 مل', brand: 'Arwa', package_size: '330 ml' },
    identity_candidate: { name, brand: 'Arwa', size: '330 ml' },
    structured_product: { size: { canonical: { pack: 1 } } },
    identity_candidate_version: 'identity-candidate-v1',
    ...overrides,
  };
}

function attempt(id, accepted, no = 1, output = {}) {
  return {
    offerId: id,
    source: no === 1 ? 'vision' : 'vision-verification',
    output,
    validation: { acceptedFields: accepted ? ['name_en', 'name_ar', 'brand', 'size'] : [] },
    confidence: 0.98,
    model: 'mistral-medium-latest',
    cropUrl: `https://cdn.example/${encodeURIComponent(id)}.jpg`,
    accepted,
    attemptedAt: new Date(Date.parse(AT) + no * 1000).toISOString(),
  };
}

async function seed(f, id, row, accepted = true) {
  return f.enrichStore.saveVisionOutcome({
    attempt: attempt(id, accepted, 1, { name_en: row?.name ?? null }),
    canonicalRow: accepted ? row : null,
    verificationCandidate: row,
    acceptance: null,
  });
}

async function verifyOnce(f, id, row) {
  const [item] = await f.verificationStore.listPending({ currentOn: TODAY, limit: 15 });
  assert.equal(item.offerId, id);
  const token = await f.verificationStore.claim({ offerId: id });
  assert.ok(token);
  return f.enrichStore.saveVisionVerificationOutcome({
    fence: { offerId: id, token, at: attempt(id, true, item.attempts + 1).attemptedAt },
    priorFingerprintHashes: item.fingerprintHashes,
    attempt: attempt(id, true, item.attempts + 1, { name_en: row.name }),
    candidateRow: row,
    fingerprint: visionVerificationFingerprint(row),
    fingerprintHash: await visionVerificationFingerprintHash(row),
    nextAttemptNo: item.attempts + 1,
    acceptance: null,
  });
}

console.log('Stage-two Vision verification:');

// ONE READING (user decision 2026-09-24): an accepted Stage-1 read is published
// at once. Since 2026-10-09 (never reprocess a validated product) it is then
// SETTLED: its queue row stays, but it is not due until flagged or changed.
await test('accepted Stage 1 results are published after one read and are not re-read', async () => {
  const f = fresh();
  const out = await seed(f, 's:r:d4d:1', candidate('s:r:d4d:1', 'Arwa Water 330 ml'), true);
  assert.equal(out.verificationQueued, true);
  assert.equal(out.published, true);
  assert.equal(await f.verificationStore.countPending(TODAY), 0, 'a published read is not due');
  assert.deepEqual(await f.verificationStore.listPending({ currentOn: TODAY, limit: 15 }), []);
  assert.deepEqual(await f.verificationStore.listPendingByIds({ ids: ['s:r:d4d:1'], currentOn: TODAY }), [],
    'not even when a caller names it');
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM offer_enrichments').get().n, 1, 'served after one read');
  assert.equal(f.raw.prepare('SELECT name FROM offer_enrichments').get().name, 'Arwa Water 330 ml');
  const queue = f.raw.prepare(
    'SELECT matched_fingerprint, match_count FROM offer_vision_verification_queue',
  ).get();
  assert.equal(JSON.parse(queue.matched_fingerprint).length, 1);
  assert.equal(queue.match_count, 1);
  assert.equal(f.raw.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='offer_vision_verification_attempts'",
  ).get().n, 0);
  f.close();
});

await test('rejected Stage 1 results enter the exact same queue and are due', async () => {
  const f = fresh();
  const out = await seed(f, 's:r:d4d:1', candidate('s:r:d4d:1', 'Arwa Water 330 ml'), false);
  assert.equal(out.verificationQueued, true);
  const row = f.raw.prepare('SELECT initial_outcome FROM offer_vision_verification_queue').get();
  assert.equal(row.initial_outcome, 'rejected');
  assert.equal(out.published, false);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM offer_enrichments').get().n, 0, 'a rejected read is never published');
  assert.equal(await f.verificationStore.countPending(TODAY), 1, 'a failed validation is re-read');
  f.close();
});

await test('one reading: a missing brand and size never block publication (name + price are the requirement)', async () => {
  const f = fresh();
  const bare = { ...candidate('s:r:d4d:2', 'Tilapia Fish Per Kg'), brand: null, size: null };
  const out = await seed(f, 's:r:d4d:2', bare, true);
  assert.equal(out.published, true);
  const e = f.raw.prepare('SELECT name, brand, size FROM offer_enrichments').get();
  assert.deepEqual([e.name, e.brand, e.size], ['Tilapia Fish Per Kg', null, null]);
  f.close();
});

await test('v5: an Arabic-only read is published by one reading and stays searchable', async () => {
  const f = fresh();
  const arabicOnly = candidate('s:r:d4d:1', null, { name_ar: 'تونة قودي بزيت الزيتون', brand: null });
  const out = await seed(f, 's:r:d4d:1', arabicOnly, true);
  assert.equal(out.published, true);
  const e = f.raw.prepare('SELECT name, name_ar, match_text FROM offer_enrichments').get();
  assert.equal(e.name, null);
  assert.equal(e.name_ar, 'تونة قودي بزيت الزيتون');
  assert.equal(e.match_text, normalizeText('تونة قودي بزيت الزيتون'), 'the Arabic name is the search haystack');
  assert.equal(await f.verificationStore.countPending(TODAY), 0);
  f.close();
});

await test('a failed first read is published by ONE later passing read', async () => {
  const f = fresh();
  await seed(f, 's:r:d4d:1', null, false);
  const later = candidate('s:r:d4d:1', 'Arwa Water 330 ml');
  const out = await verifyOnce(f, 's:r:d4d:1', later);
  assert.equal(out.verified, true, 'the same bar Stage 1 applies');
  assert.equal(f.raw.prepare('SELECT name FROM offer_enrichments').get().name, 'Arwa Water 330 ml');
  assert.equal(await f.verificationStore.countPending(TODAY), 0);
  f.close();
});

await test('failed reads stop at STAGE_TWO_MAX_ATTEMPTS reads in total', async () => {
  const f = fresh();
  await seed(f, 's:r:d4d:1', null, false);
  const unreadable = candidate('s:r:d4d:1', null, { name_ar: null, corroboration: null });
  for (let read = 2; read <= STAGE_TWO_MAX_ATTEMPTS; read += 1) {
    assert.equal(await f.verificationStore.countPending(TODAY), 1, `read ${read} is due`);
    assert.equal((await verifyOnce(f, 's:r:d4d:1', unreadable)).verified, false);
  }
  const state = f.raw.prepare('SELECT status, attempts FROM offer_vision_verification_queue').get();
  assert.deepEqual([state.status, state.attempts], ['queued', STAGE_TWO_MAX_ATTEMPTS]);
  assert.equal(await f.verificationStore.countPending(TODAY), 0, 'no further read of the same crop');
  f.close();
});

await test('a changed crop makes a published read due, and its passing read replaces the old one', async () => {
  const f = fresh();
  const id = 's:r:d4d:1';
  await seed(f, id, candidate(id, 'Arwa Water 330 ml'), true);
  assert.equal(await f.verificationStore.countPending(TODAY), 0);
  f.raw.prepare('UPDATE offers SET image_url=? WHERE id=?').run('https://cdn.example/rerendered.jpg', id);
  assert.equal(await f.verificationStore.countPending(TODAY), 1, 'a detected change is due');
  const reread = candidate(id, 'Arwa Water 1.5 L', { crop_url: 'https://cdn.example/rerendered.jpg' });
  assert.equal((await verifyOnce(f, id, reread)).verified, true);
  const e = f.raw.prepare('SELECT name, crop_url FROM offer_enrichments').get();
  assert.deepEqual([e.name, e.crop_url], ['Arwa Water 1.5 L', 'https://cdn.example/rerendered.jpg']);
  assert.equal(await f.verificationStore.countPending(TODAY), 0, 'settled again');
  f.close();
});

await test('a flag quarantines the published read and buys a full fresh cycle', async () => {
  const f = fresh(['s:r:d4d:1', 's:r:d4d:nocrop']);
  f.raw.prepare('UPDATE offers SET image_url=NULL WHERE id=?').run('s:r:d4d:nocrop');
  const id = 's:r:d4d:1';
  await seed(f, id, candidate(id, 'Arwa Water 330 ml'), true);
  const flagged = await f.verificationStore.flagForReverification([id, 's:r:d4d:nocrop', 'missing']);
  assert.deepEqual(flagged, [id], 'offers without a crop are skipped');
  const q = f.raw.prepare('SELECT status, attempts, last_error FROM offer_vision_verification_queue WHERE offer_id=?').get(id);
  assert.deepEqual([q.status, q.attempts, q.last_error], ['queued', 0, 'flagged for review']);
  assert.equal(f.raw.prepare('SELECT corroboration FROM offer_enrichments').get().corroboration, null,
    'a suspect name stops serving');
  assert.equal(await f.verificationStore.countPending(TODAY), 1);
  f.close();
});

await test('a matching re-read of a flagged offer restores it and closes Stage 2', async () => {
  const f = fresh();
  const row = candidate('s:r:d4d:1', 'Arwa Water 330 ml');
  await seed(f, 's:r:d4d:1', row, true);
  await f.verificationStore.flagForReverification(['s:r:d4d:1']);
  const out = await verifyOnce(f, 's:r:d4d:1', { ...row, name: '  ARWA   WATER 330 ML ' });
  assert.equal(out.verified, true, 'normalization makes casing/spacing equivalent');
  assert.equal(await f.verificationStore.countPending(TODAY), 0);
  const stored = f.raw.prepare('SELECT name, corroboration FROM offer_enrichments WHERE id=?').get('s:r:d4d:1');
  assert.equal(stored.name, '  ARWA   WATER 330 ML ');
  assert.equal(stored.corroboration, 1);
  assert.equal((await f.enrichStore.coverage(TODAY)).verified, 1);
  f.close();
});

await test('Arabic never vetoes a match, while brand and count remain identity fields', async () => {
  const id = 's:r:d4d:1';
  const base = candidate(id, 'Arwa Water 330 ml');
  assert.equal(
    visionVerificationFingerprint(base),
    visionVerificationFingerprint({ ...base, name_ar: 'مياه أروى الطبيعية' }),
    'Arabic is display-only for verification',
  );
  assert.notEqual(
    visionVerificationFingerprint(base),
    visionVerificationFingerprint({ ...base, brand: 'Other Brand' }),
  );
  assert.notEqual(
    visionVerificationFingerprint(base),
    visionVerificationFingerprint({
      ...base,
      structured_product: { size: { canonical: { pack: 6 } } },
    }),
  );
});

await test('v5: an Arabic-only read has a fingerprint, and English hashes keep their shape', async () => {
  const id = 's:r:d4d:1';
  const english = candidate(id, 'Arwa Water 330 ml');
  assert.equal(
    visionVerificationFingerprint(english),
    JSON.stringify({ name: 'arwa water 330 ml', brand: 'arwa', count: 1 }),
    'stored English hashes stay valid',
  );
  const arabic = candidate(id, null, { name_ar: 'مياه أروى' });
  assert.ok(visionVerificationFingerprint(arabic), 'before v5 this was null and could never match');
  assert.equal(visionVerificationFingerprint(arabic), visionVerificationFingerprint({ ...arabic }));
  assert.notEqual(visionVerificationFingerprint(arabic), visionVerificationFingerprint({ ...arabic, name_ar: 'مياه نوفا' }));
  assert.equal(compatibleVisionIdentity(arabic, { ...arabic, brand: null }), true);
  assert.equal(compatibleVisionIdentity(arabic, { ...arabic, name_ar: 'مياه نوفا' }), false);
  assert.equal(visionVerificationFingerprint(candidate(id, null, { name_ar: null })), null);
});

// --- RE-CHECK fills what the first read missed (user directive 2026-09-24) -------
// Since 2026-10-09 a published read is re-read only when flagged (or changed).
await test('re-check: a re-read that finds the brand the first read missed confirms it and fills it', async () => {
  const f = fresh();
  const id = 's:r:d4d:1';
  const noBrand = candidate(id, 'Arwa Water 330 ml', { brand: null, identity_candidate: { name: 'Arwa Water 330 ml', brand: null } });
  assert.equal((await seed(f, id, noBrand, true)).published, true, 'published by one reading');
  await f.verificationStore.flagForReverification([id]);
  const out = await verifyOnce(f, id, candidate(id, 'Arwa Water 330 ml'));
  assert.equal(out.verified, true, 'a missing brand is not a mismatch');
  assert.equal(f.raw.prepare('SELECT brand FROM offer_enrichments').get().brand, 'Arwa', 'the re-check filled it');
  assert.equal(await f.verificationStore.countPending(TODAY), 0);
  f.close();
});

await test('re-check: a field the re-read lacks is never taken away', async () => {
  const f = fresh();
  const id = 's:r:d4d:1';
  await seed(f, id, candidate(id, 'Arwa Water 330 ml'), true);
  await f.verificationStore.flagForReverification([id]);
  const out = await verifyOnce(f, id, candidate(id, 'Arwa Water 330 ml', { size: null, name_ar: null }));
  assert.equal(out.verified, true);
  const e = f.raw.prepare('SELECT size, name_ar FROM offer_enrichments').get();
  assert.deepEqual([e.size, e.name_ar], ['330 ml', 'مياه أروى 330 مل'], 'size and Arabic kept from the published read');
  f.close();
});

await test('re-check: a flagged read is replaced by a passing read of another identity', async () => {
  const f = fresh();
  const id = 's:r:d4d:1';
  await seed(f, id, candidate(id, 'Arwa Water 330 ml'), true);
  await f.verificationStore.flagForReverification([id]);
  const out = await verifyOnce(f, id, candidate(id, 'Nova Water 330 ml', { brand: 'Nova' }));
  assert.equal(out.verified, true, 'the flag said the published read was suspect');
  const e = f.raw.prepare('SELECT name, brand FROM offer_enrichments').get();
  assert.deepEqual([e.name, e.brand], ['Nova Water 330 ml', 'Nova']);
  f.close();
});

await test('the production migration backfills both old accepts and rejects and quarantines one-read rows', async () => {
  const f = fresh(['s:r:d4d:1', 's:r:d4d:2']);
  f.raw.prepare(
    `INSERT INTO offer_enrichments
       (id,name,brand,size,corroboration,model,crop_url,enriched_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(
    's:r:d4d:1', 'Arwa Water 330 ml', 'Arwa', '330 ml', 1,
    'mistral-medium-latest', 'https://cdn.example/1.jpg', AT,
  );
  const insertAttempt = f.raw.prepare(
    `INSERT INTO offer_extraction_attempts
       (offer_id,source,output,validation,confidence,model,crop_url,accepted,attempted_at)
     VALUES (?,'vision',?,?,?,?,?,?,?)`,
  );
  insertAttempt.run('s:r:d4d:1', '{}', '{}', 0.98, 'mistral-medium-latest', 'https://cdn.example/1.jpg', 1, AT);
  insertAttempt.run('s:r:d4d:2', '{}', '{}', 0.98, 'mistral-medium-latest', 'https://cdn.example/2.jpg', 0, AT);
  f.raw.exec(fs.readFileSync('migrate-2026-08-11-vision-verification.sql', 'utf8'));
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM offer_vision_verification_queue').get().n, 2);
  assert.equal(f.raw.prepare("SELECT COUNT(*) n FROM offer_vision_verification_queue WHERE initial_outcome='rejected'").get().n, 1);
  assert.equal(f.raw.prepare('SELECT corroboration FROM offer_enrichments WHERE id=?').get('s:r:d4d:1').corroboration, null);
  const pending = await f.verificationStore.listPending({ currentOn: TODAY, limit: 15 });
  assert.deepEqual(
    pending.find((item) => item.offerId === 's:r:d4d:1').initialCandidate,
    { name: 'Arwa Water 330 ml', brand: 'Arwa', size: '330 ml' },
    'the old Stage-1 row can be re-fingerprinted under the current contract',
  );
  f.close();
});

console.log(`\nStage-two Vision verification: ${tests} tests OK`);
