// The re-judge sweep's cron home (2026-10-09), driven through the REAL Worker
// scheduled() handler on the */2 trigger: it stands aside for a watch round,
// publishes stored reads with zero model calls, audits every page, releases
// its lease, and goes quiet once the rule version is done.
import assert from 'node:assert/strict';
import worker from './index.js';
import { createD1EnrichStore } from './storage/enrichStore.js';
import { createR2VisionVerificationHistoryStore } from './storage/visionVerificationHistoryStore.js';
import { createSqliteD1, insertOffers } from './storage/testSqliteD1.mjs';

let tests = 0;
async function test(name, fn) {
  await fn();
  tests += 1;
  console.log('  ok ', name);
}

// An R2-shaped bucket: both the object store (arrayBuffer) and the
// verification history (text, list) read it.
function memoryR2() {
  const objects = new Map();
  const toBytes = (value) => (typeof value === 'string'
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array ? value : new Uint8Array(value));
  const body = (key) => {
    const bytes = objects.get(key);
    return {
      key,
      httpMetadata: {},
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); },
      async text() { return new TextDecoder().decode(bytes); },
    };
  };
  return {
    objects,
    async put(key, value) { objects.set(key, toBytes(value)); return { key }; },
    async get(key) { return objects.has(key) ? body(key) : null; },
    async head(key) { return objects.has(key) ? { key } : null; },
    async list({ prefix = '' } = {}) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

const crop = (id) => `https://cdn.example/${encodeURIComponent(id)}.jpg`;
const AT = '2026-08-11T00:00:01.000Z';

async function seedRejected(enrichStore, history, id) {
  const candidate = {
    id, name: null, name_ar: 'تونة قودي بزيت الزيتون', brand: null, size: '185 g',
    confidence: 0.9, corroboration: null, model: 'ministral-14b-2512', crop_url: crop(id),
    enriched_at: AT, extraction_json: { name_en: null, name_ar: 'تونة قودي بزيت الزيتون', package_size: '185 g' },
    identity_candidate: null, identity_candidate_version: null,
  };
  const attempt = {
    offerId: id, source: 'vision', output: candidate.extraction_json,
    validation: { acceptedFields: ['name_ar', 'size'] }, confidence: 0.9, model: 'ministral-14b-2512',
    cropUrl: crop(id), accepted: false, attemptedAt: AT,
  };
  await history.recordAttempt({ offerId: id, initialOutcome: 'rejected', attemptNo: 1, candidateRow: candidate, attempt });
  await enrichStore.saveVisionOutcome({
    attempt, canonicalRow: null, verificationCandidate: candidate, verificationEvidenceStored: true,
    acceptance: { accepted: false, version: 'business-acceptance-v4', mandatory: { price: true, english_name: false }, missing: ['english_name'] },
  });
}

async function fire(env, iso) {
  const pending = [];
  await worker.scheduled({ cron: '*/2 * * * *', scheduledTime: Date.parse(iso) }, env, {
    waitUntil: (p) => pending.push(p),
  });
  await Promise.all(pending);
}

const ids = ['s:r:d4d:1', 's:r:d4d:2', 's:r:d4d:3'];
const { db, raw, close } = createSqliteD1(['schema.sql']);
insertOffers(raw, ids.map((id) => ({ id, image_url: crop(id), price: 7.5, currency: 'SAR', valid_to: '2099-01-01' })));
const bucket = memoryR2();
const enrichStore = createD1EnrichStore(db);
const history = createR2VisionVerificationHistoryStore(bucket);
for (const id of ids) await seedRejected(enrichStore, history, id);
const env = { DB: db, BROCHURES: bucket };
const sweepRows = () => raw.prepare("SELECT ok, offers, detail FROM ops_runs WHERE action = 'cron:vision-rejudge' ORDER BY id").all();
const verified = () => raw.prepare("SELECT COUNT(*) n FROM offer_vision_verification_queue WHERE status = 'verified'").get().n;

console.log('Re-judge sweep on the */2 trigger:');

await test('it stands aside for the first half-hour of a watch round (16:00 UTC = 19:00 Riyadh)', async () => {
  await fire(env, '2026-10-09T16:10:00Z');
  assert.equal(verified(), 0);
  assert.equal(sweepRows().length, 0);
});

await test('outside the round it publishes stored reads, audits the page and releases its lease', async () => {
  await fire(env, '2026-10-09T17:00:00Z');
  assert.equal(verified(), 3);
  const rows = sweepRows();
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].ok, rows[0].offers], [1, 3]);
  const detail = JSON.parse(rows[0].detail);
  assert.deepEqual([detail.scanned, detail.published, detail.state.done], [3, 3, true]);
  const lease = raw.prepare("SELECT lease_until FROM vision_jobs WHERE id = 'rejudge-sweep'").get();
  assert.equal(lease?.lease_until ?? null, null, 'lease released');
});

await test('once the rule version is done, later fires record nothing', async () => {
  await fire(env, '2026-10-09T17:02:00Z');
  await fire(env, '2026-10-09T17:04:00Z');
  assert.equal(sweepRows().length, 1);
});

close();
console.log(`\nRe-judge sweep tick: ${tests} tests OK`);
