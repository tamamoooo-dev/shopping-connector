import assert from 'node:assert/strict';
import visionSmallRetry, { VISION_SMALL_RETRY_PROCESSOR_ID } from './visionSmallRetry.js';
import visionMedium from './visionMedium.js';
import ocr from './ocr.js';
import { recoveryRegistry, RECOVERY_PROCESSORS } from './index.js';
import { createKeyChain } from '../../offers/mistralKeys.js';
import { acceptedFieldViolations } from '../runner.js';
import { validateVisionOutput } from '../../offers/smartExtraction.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Vision Small retry recovery processor:');

const SMALL_MODEL = 'mistral-small-2603';
const PRIOR_NAME = 'Arwa Bottled Water';
const priorValidation = validateVisionOutput({
  name_en: PRIOR_NAME,
  name_ar: null,
  brand: 'Arwa',
  package_size: null,
  quantity: null,
});

const item = (overrides = {}) => ({
  offerId: 'a:r:d4d:small-retry',
  offer: {
    id: 'a:r:d4d:small-retry',
    image_url: 'https://cdn.example/crop.jpg',
    price: 5.99,
    currency: 'SAR',
  },
  verdict: { missing: ['comparable_quantity'], accepted: false },
  attemptsBySource: {
    vision: {
      source: 'vision',
      output: { name_en: PRIOR_NAME, brand: 'Arwa' },
      validation: priorValidation,
      model: SMALL_MODEL,
    },
  },
  ...overrides,
});

const fakeProvider = (reply) => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('cdn.example')) {
      return {
        ok: true,
        headers: new Map([['content-type', 'image/jpeg']]),
        arrayBuffer: async () => new ArrayBuffer(8),
      };
    }
    const body = JSON.parse(init.body || '{}');
    calls.push({ url: String(url), model: body.model });
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ choices: [{ message: { content: JSON.stringify(reply) } }] }),
      text: async () => '',
    };
  };
  return { calls, fetchImpl };
};

await test('it is the first automatic recovery rung before Medium and OCR', async () => {
  assert.equal(recoveryRegistry.get(VISION_SMALL_RETRY_PROCESSOR_ID), visionSmallRetry);
  assert.deepEqual(RECOVERY_PROCESSORS.slice(0, 3), [visionSmallRetry, visionMedium, ocr]);
  assert.equal(visionSmallRetry.credential, 'vision-small');
});

await test('supports only a cropped product whose primary attempt used Small', async () => {
  assert.equal(visionSmallRetry.supports(item()), true);
  assert.equal(visionSmallRetry.supports(item({ offer: { image_url: null } })), false);
  assert.equal(visionSmallRetry.supports(item({ attemptsBySource: {} })), false);
  const medium = item();
  medium.attemptsBySource.vision.model = 'mistral-medium-latest';
  assert.equal(visionSmallRetry.supports(medium), false);
});

await test('it retries the exact same Small model once on the Vision endpoint', async () => {
  const { calls, fetchImpl } = fakeProvider({ name_en: PRIOR_NAME, package_size: '330 ml' });
  await visionSmallRetry.run(item(), {
    keyChain: createKeyChain(['small-key']),
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, SMALL_MODEL);
  assert.ok(calls[0].url.includes('chat/completions'));
});

await test('the retry preserves accepted fields while filling the first-read gap', async () => {
  const { fetchImpl } = fakeProvider({
    name_en: 'Arwa Drinking Water Bottle',
    brand: 'ARWA',
    package_size: '330 ml',
  });
  const out = await visionSmallRetry.run(item(), {
    keyChain: createKeyChain(['small-key']),
    fetchImpl,
  });
  assert.equal(out.canonicalRow.name, PRIOR_NAME);
  assert.equal(out.canonicalRow.size, '330 ml');
  assert.deepEqual(acceptedFieldViolations(item(), out.canonicalRow), []);
  assert.equal(out.attempt.source, VISION_SMALL_RETRY_PROCESSOR_ID);
  assert.equal(out.attempt.model, SMALL_MODEL);
  assert.equal(out.cost.tier, 'vision-small');
  assert.equal(out.cost.requests, 1);
});

await test('it also preserves fields accepted by an earlier OCR journal entry', async () => {
  const ocrName = 'FAIRY 5X POWER ACTION';
  const queued = item();
  queued.attemptsBySource.vision.validation = validateVisionOutput({
    name_en: null,
    name_ar: null,
    brand: null,
    package_size: null,
    quantity: null,
  });
  queued.attemptsBySource.ocr = {
    source: 'ocr',
    output: { name_en: ocrName, name_ar: 'فيري', brand: 'فيري' },
    validation: validateVisionOutput({
      name_en: ocrName,
      name_ar: 'فيري',
      brand: 'فيري',
      package_size: null,
      quantity: null,
    }),
    model: 'mistral-ocr-latest',
  };
  const { fetchImpl } = fakeProvider({
    name_en: 'Fairy Dishwasher Capsules',
    name_ar: 'كبسولات فيري',
    brand: 'FAIRY',
    package_size: '40 pcs',
  });

  const out = await visionSmallRetry.run(queued, {
    keyChain: createKeyChain(['small-key']),
    fetchImpl,
  });

  assert.equal(out.canonicalRow.name, ocrName);
  assert.equal(out.canonicalRow.name_ar, 'فيري');
  assert.equal(out.canonicalRow.brand, 'فيري');
  assert.equal(out.canonicalRow.size, '40 pcs');
  assert.deepEqual(acceptedFieldViolations(queued, out.canonicalRow), []);
});

await test('a missing Small credential declines without consuming an attempt', async () => {
  for (const keyChain of [null, createKeyChain([])]) {
    const out = await visionSmallRetry.run(item(), { keyChain });
    assert.equal(out.declined, true);
    assert.match(out.error, /Small Vision credential/);
  }
});

console.log(`\nVision Small retry recovery processor: ${tests} tests OK`);
