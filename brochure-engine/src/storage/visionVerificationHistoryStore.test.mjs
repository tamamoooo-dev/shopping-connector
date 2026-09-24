import assert from 'node:assert/strict';
import {
  createR2VisionVerificationHistoryStore,
  visionVerificationAttemptKey,
} from './visionVerificationHistoryStore.js';

const writes = [];
const bucket = {
  async put(key, value, options) {
    writes.push({ key, value, options });
    return { key };
  },
};

const store = createR2VisionVerificationHistoryStore(bucket);
assert.equal(store.available, true);
const saved = await store.recordAttempt({
  offerId: 'store:riyadh:d4d:42',
  initialOutcome: 'rejected',
  attemptNo: 3,
  fingerprint: '{"name":"water"}',
  fingerprintHash: 'abc123',
  candidateRow: { name: 'Water', size: '330 ml' },
  attempt: {
    output: { name_en: 'Water' },
    validation: { acceptedFields: ['name_en'] },
    confidence: 0.91,
    model: 'vision-model',
    cropUrl: 'https://cdn.example/crop.jpg',
    accepted: true,
    attemptedAt: '2026-08-11T10:20:30.000Z',
  },
  token: 'claim-token',
});

assert.equal(writes.length, 1);
assert.equal(saved.key, writes[0].key);
assert.match(saved.key, /^vision-verification\/attempts\/store%3Ariyadh%3Ad4d%3A42\//);
assert.equal(writes[0].options.httpMetadata.contentType, 'application/json; charset=utf-8');
const body = JSON.parse(new TextDecoder().decode(writes[0].value));
assert.equal(body.offer_id, 'store:riyadh:d4d:42');
assert.equal(body.attempt_no, 3);
assert.equal(body.fingerprint_hash, 'abc123');
assert.deepEqual(body.observation, { name_en: 'Water' });
assert.equal(body.crop_url, 'https://cdn.example/crop.jpg');

assert.equal(
  visionVerificationAttemptKey({
    offerId: 'a/b',
    attemptNo: 2,
    attemptedAt: '2026-08-11T00:00:00.000Z',
    token: 'x/y',
  }),
  'vision-verification/attempts/a%2Fb/20260811T000000000Z-00000002-x%2Fy.json',
);

console.log('Vision Verification R2 history: 1 test OK');
