// Re-judging stored Vision evidence (2026-10-09): a rule change publishes reads
// already paid for, with zero model calls, and never revives a flagged read.
import assert from 'node:assert/strict';
import { createD1EnrichStore } from '../storage/enrichStore.js';
import { createD1VisionVerificationStore } from '../storage/visionVerificationStore.js';
import { createR2VisionVerificationHistoryStore } from '../storage/visionVerificationHistoryStore.js';
import { createSqliteD1, insertOffers } from '../storage/testSqliteD1.mjs';
import {
  drainVisionVerification,
  rejudgeStoredAttempt,
  rejudgeVerificationBacklog,
} from './visionVerification.js';
import { createKeyChain } from './mistralKeys.js';

const TODAY = '2026-08-11';
const AT = '2026-08-11T00:00:01.000Z';
let tests = 0;
async function test(name, fn) {
  await fn();
  tests += 1;
  console.log('  ok ', name);
}

function memoryBucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) { objects.set(key, new TextDecoder().decode(value)); return { key }; },
    async get(key) { return objects.has(key) ? { text: async () => objects.get(key) } : null; },
    async list({ prefix = '' } = {}) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
  };
}

const crop = (id) => `https://cdn.example/${encodeURIComponent(id)}.jpg`;

function arabicOnlyCandidate(id) {
  return {
    id, name: null, name_ar: 'تونة قودي بزيت الزيتون', brand: null, size: '185 g',
    confidence: 0.9, corroboration: null, model: 'ministral-14b-2512', crop_url: crop(id),
    enriched_at: AT, extraction_json: { name_en: null, name_ar: 'تونة قودي بزيت الزيتون', package_size: '185 g' },
    identity_candidate: null, identity_candidate_version: null,
  };
}

// A Stage 1 read rejected under v4 (no English name), with its full evidence
// in R2 exactly as the drain writes it.
async function seedRejected(f, id, { acceptedFields = ['name_ar', 'size'], candidate = arabicOnlyCandidate(id) } = {}) {
  const attempt = {
    offerId: id, source: 'vision', output: candidate.extraction_json,
    validation: { acceptedFields }, confidence: 0.9, model: 'ministral-14b-2512',
    cropUrl: crop(id), accepted: false, attemptedAt: AT,
  };
  await f.history.recordAttempt({
    offerId: id, initialOutcome: 'rejected', attemptNo: 1, candidateRow: candidate, attempt,
  });
  await f.enrichStore.saveVisionOutcome({
    attempt, canonicalRow: null, verificationCandidate: candidate, verificationEvidenceStored: true,
    acceptance: { accepted: false, version: 'business-acceptance-v4', mandatory: { price: true, english_name: false }, missing: ['english_name'] },
  });
}

function fresh(ids = ['s:r:d4d:1']) {
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  insertOffers(raw, ids.map((id) => ({ id, image_url: crop(id), price: 7.5, currency: 'SAR', valid_to: '2099-01-01' })));
  const bucket = memoryBucket();
  return {
    raw, close, bucket,
    enrichStore: createD1EnrichStore(db),
    verificationStore: createD1VisionVerificationStore(db),
    history: createR2VisionVerificationHistoryStore(bucket),
  };
}

const stores = (f) => ({
  verificationStore: f.verificationStore,
  verificationHistoryStore: f.history,
  enrichStore: f.enrichStore,
});

console.log('Re-judging stored Vision evidence:');

await test('a stored Arabic-only read passes the v5 rule; an unvalidated one does not', async () => {
  const item = { offerId: 'x', imageUrl: crop('x'), price: 7.5, currency: 'SAR' };
  const ok = rejudgeStoredAttempt({ candidate: arabicOnlyCandidate('x'), validation: { acceptedFields: ['name_ar'] }, crop_url: crop('x') }, item);
  assert.equal(ok.row.corroboration, 1);
  assert.equal(ok.acceptance.accepted, true);
  assert.equal(rejudgeStoredAttempt({ candidate: arabicOnlyCandidate('x'), validation: { acceptedFields: [] }, crop_url: crop('x') }, item), null);
  assert.equal(rejudgeStoredAttempt({ candidate: arabicOnlyCandidate('x'), validation: { acceptedFields: ['name_ar'] }, crop_url: 'https://other' }, item),
    null, 'evidence of another crop is stale');
  assert.equal(rejudgeStoredAttempt({ candidate: arabicOnlyCandidate('x'), validation: { acceptedFields: ['name_ar'] } }, { ...item, flagged: true }),
    null, 'a flagged read is the suspect');
});

await test('a dry run reports what would publish and writes nothing', async () => {
  const f = fresh(['s:r:d4d:1', 's:r:d4d:2']);
  await seedRejected(f, 's:r:d4d:1');
  await seedRejected(f, 's:r:d4d:2', { acceptedFields: ['size'] });
  const report = await rejudgeVerificationBacklog(stores(f), { currentOn: TODAY, dryRun: true });
  assert.deepEqual([report.scanned, report.passing, report.published, report.skipped], [2, 1, 0, 1]);
  assert.equal(report.samples[0].nameAr, 'تونة قودي بزيت الزيتون');
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM offer_enrichments').get().n, 0);
  f.close();
});

await test('the backlog pass publishes with zero model calls and settles the queue row', async () => {
  const f = fresh();
  await seedRejected(f, 's:r:d4d:1');
  const report = await rejudgeVerificationBacklog(stores(f), { currentOn: TODAY, dryRun: false });
  assert.equal(report.published, 1);
  const e = f.raw.prepare('SELECT name, name_ar, corroboration FROM offer_enrichments').get();
  assert.deepEqual([e.name, e.name_ar, e.corroboration], [null, 'تونة قودي بزيت الزيتون', 1]);
  const q = f.raw.prepare('SELECT status, attempts FROM offer_vision_verification_queue').get();
  assert.deepEqual([q.status, q.attempts], ['verified', 1], 'no read happened, so the count stays');
  const v = f.raw.prepare('SELECT version, accepted FROM offer_acceptance_verdicts').get();
  assert.deepEqual([v.version, v.accepted], ['business-acceptance-v5', 1]);
  assert.equal(await f.verificationStore.countPending(TODAY), 0);
  f.close();
});

await test('the Stage 2 drain re-judges first and never calls the model for a passing stored read', async () => {
  const f = fresh();
  await seedRejected(f, 's:r:d4d:1');
  let modelCalls = 0;
  const report = await drainVisionVerification({
    ...stores(f),
    keyChain: createKeyChain(['k'], { log: () => {} }),
  }, {
    currentOn: TODAY,
    fetchImpl: async () => { modelCalls += 1; throw new Error('no network in tests'); },
  });
  assert.equal(modelCalls, 0);
  assert.deepEqual([report.rejudged, report.verified, report.failed], [1, 1, 0]);
  f.close();
});

await test('rows past the read cap are still re-judged (it is free), paged by cursor', async () => {
  const ids = ['s:r:d4d:1', 's:r:d4d:2', 's:r:d4d:3'];
  const f = fresh(ids);
  for (const id of ids) await seedRejected(f, id);
  f.raw.prepare('UPDATE offer_vision_verification_queue SET attempts = 9').run();
  assert.equal(await f.verificationStore.countPending(TODAY), 0, 'not due for a paid read');
  const page1 = await rejudgeVerificationBacklog(stores(f), { currentOn: TODAY, dryRun: false, limit: 2 });
  assert.deepEqual([page1.scanned, page1.published, page1.nextCursor], [2, 2, 's:r:d4d:2']);
  const page2 = await rejudgeVerificationBacklog(stores(f), { currentOn: TODAY, dryRun: false, limit: 2, after: page1.nextCursor });
  assert.deepEqual([page2.scanned, page2.published, page2.nextCursor], [1, 1, null]);
  assert.equal(f.raw.prepare("SELECT COUNT(*) n FROM offer_vision_verification_queue WHERE status='verified'").get().n, 3);
  f.close();
});

await test('a flagged offer is read again, never re-judged back into service', async () => {
  const f = fresh();
  await seedRejected(f, 's:r:d4d:1');
  await rejudgeVerificationBacklog(stores(f), { currentOn: TODAY, dryRun: false });
  await f.verificationStore.flagForReverification(['s:r:d4d:1']);
  const report = await rejudgeVerificationBacklog(stores(f), { currentOn: TODAY, dryRun: true });
  assert.deepEqual([report.scanned, report.passing], [1, 0]);
  f.close();
});

console.log(`\nRe-judge: ${tests} tests OK`);
