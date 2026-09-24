import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createD1EnrichStore } from './enrichStore.js';
import {
  createD1VisionVerificationStore,
  visionVerificationFingerprint,
  visionVerificationFingerprintHash,
} from './visionVerificationStore.js';
import { createSqliteD1, insertOffers } from './testSqliteD1.mjs';

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
// at once and STILL queued, so Stage 2 re-checks it later instead of gating it.
await test('accepted Stage 1 results are published after one read and still queued for the re-check', async () => {
  const f = fresh();
  const out = await seed(f, 's:r:d4d:1', candidate('s:r:d4d:1', 'Arwa Water 330 ml'), true);
  assert.equal(out.verificationQueued, true);
  assert.equal(out.published, true);
  assert.equal(await f.verificationStore.countPending(TODAY), 1, 'Stage 2 re-check still queued');
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

await test('rejected Stage 1 results enter the exact same queue', async () => {
  const f = fresh();
  const out = await seed(f, 's:r:d4d:1', candidate('s:r:d4d:1', 'Arwa Water 330 ml'), false);
  assert.equal(out.verificationQueued, true);
  const row = f.raw.prepare('SELECT initial_outcome FROM offer_vision_verification_queue').get();
  assert.equal(row.initial_outcome, 'rejected');
  assert.equal(out.published, false);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM offer_enrichments').get().n, 0, 'a rejected read is never published');
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

await test('a matching second read writes the canonical enrichment and closes Stage 2', async () => {
  const f = fresh();
  const row = candidate('s:r:d4d:1', 'Arwa Water 330 ml');
  await seed(f, 's:r:d4d:1', row, true);
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

// --- RE-CHECK fills what the first read missed (user directive 2026-09-24) -------
await test('re-check: a re-read that finds the brand the first read missed confirms it and fills it', async () => {
  const f = fresh();
  const id = 's:r:d4d:1';
  const noBrand = candidate(id, 'Arwa Water 330 ml', { brand: null, identity_candidate: { name: 'Arwa Water 330 ml', brand: null } });
  assert.equal((await seed(f, id, noBrand, true)).published, true, 'published by one reading');
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
  const out = await verifyOnce(f, id, candidate(id, 'Arwa Water 330 ml', { size: null, name_ar: null }));
  assert.equal(out.verified, true);
  const e = f.raw.prepare('SELECT size, name_ar FROM offer_enrichments').get();
  assert.deepEqual([e.size, e.name_ar], ['330 ml', 'مياه أروى 330 مل'], 'size and Arabic kept from the published read');
  f.close();
});

await test('re-check: a different product or a conflicting brand leaves the published read', async () => {
  for (const other of [{ name: 'Nova Water 330 ml' }, { brand: 'Nova' }]) {
    const f = fresh();
    const id = 's:r:d4d:1';
    await seed(f, id, candidate(id, 'Arwa Water 330 ml'), true);
    const out = await verifyOnce(f, id, candidate(id, other.name || 'Arwa Water 330 ml', other.brand ? { brand: other.brand } : {}));
    assert.equal(out.verified, false, `not the same product: ${JSON.stringify(other)}`);
    const e = f.raw.prepare('SELECT name, brand FROM offer_enrichments').get();
    assert.deepEqual([e.name, e.brand], ['Arwa Water 330 ml', 'Arwa'], 'the published read stays');
    assert.equal(await f.verificationStore.countPending(TODAY), 1, 'still queued for another re-check');
    f.close();
  }
});

await test('a mismatch remains queued; a third read matching either prior read verifies it', async () => {
  const f = fresh();
  const first = candidate('s:r:d4d:1', 'Arwa Water 330 ml');
  const different = candidate('s:r:d4d:1', 'Arwa Sparkling Water 330 ml');
  await seed(f, 's:r:d4d:1', first, true);
  const second = await verifyOnce(f, 's:r:d4d:1', different);
  assert.equal(second.verified, false);
  assert.equal(await f.verificationStore.countPending(TODAY), 1);
  const third = await verifyOnce(f, 's:r:d4d:1', first);
  assert.equal(third.verified, true);
  assert.equal(f.raw.prepare('SELECT attempts FROM offer_vision_verification_queue').get().attempts, 3);
  f.close();
});

await test('a first-read reject can enter Enrichment after two later matching valid reads', async () => {
  const f = fresh();
  await seed(f, 's:r:d4d:1', null, false);
  const later = candidate('s:r:d4d:1', 'Arwa Water 330 ml');
  assert.equal((await verifyOnce(f, 's:r:d4d:1', later)).verified, false);
  assert.equal((await verifyOnce(f, 's:r:d4d:1', later)).verified, true);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM offer_enrichments').get().n, 1);
  f.close();
});

await test('there is no exhaustion at the fourth attempt or any fixed maximum', async () => {
  const f = fresh();
  await seed(f, 's:r:d4d:1', candidate('s:r:d4d:1', 'Identity A'), true);
  await verifyOnce(f, 's:r:d4d:1', candidate('s:r:d4d:1', 'Identity B'));
  await verifyOnce(f, 's:r:d4d:1', candidate('s:r:d4d:1', 'Identity C'));
  await verifyOnce(f, 's:r:d4d:1', candidate('s:r:d4d:1', 'Identity D'));
  const state = f.raw.prepare('SELECT status, attempts FROM offer_vision_verification_queue').get();
  assert.equal(state.status, 'queued');
  assert.equal(state.attempts, 4);
  assert.equal(await f.verificationStore.countPending(TODAY), 1);
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
