// ocr.test.mjs — S5.5: OCR as a queue processor (C-6, C-9).
//
// WHAT THIS DEFENDS. The port must not change what OCR DOES, only who tells it
// to. So the assertions are about the seam, not the extraction:
//   • the preconditions the old `listPendingOcr` WHERE clause encoded in SQL now
//     live in `supports()`, and still hold
//   • a missing credential DECLINES rather than throwing, so it cannot burn an
//     item's attempt budget over a configuration state
//   • the merge replays the PERSISTED Vision attempt rather than re-reading the
//     model (§6 S6)
//   • the processor returns a proposal and closes nothing

import assert from 'node:assert/strict';
import ocr, { OCR_PROCESSOR_ID } from './ocr.js';
import { createKeyChain } from '../../offers/mistralKeys.js';
import { recoveryRegistry, RECOVERY_PROCESSORS } from './index.js';
import { RECOVERY_KIND } from '../registry.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('S5.5 OCR recovery processor:');

const item = (overrides = {}) => ({
  offerId: 'a:r:d4d:1',
  offer: { id: 'a:r:d4d:1', image_url: 'https://cdn.example/crop.jpg', price: 5.99, currency: 'SAR' },
  attemptsBySource: {
    vision: {
      source: 'vision',
      output: { name_en: 'Arwa Bottled Water' },
      validation: { acceptedFields: ['name_en'], fields: {} },
      model: 'mistral-medium-latest',
    },
  },
  ...overrides,
});

await test('it registers as a machine processor under a stable opaque id', async () => {
  assert.equal(ocr.id, OCR_PROCESSOR_ID);
  assert.equal(ocr.kind, RECOVERY_KIND.MACHINE, 'C-7 binds it');
  assert.equal(recoveryRegistry.get('ocr'), ocr);
  // The registry line is the whole cost of adding one. This used to assert
  // `length === 1`, which pinned "ocr is the only processor" rather than the
  // property — and S7 adding the human rung is the property being COLLECTED,
  // not violated. What must stay true is that membership is an array entry and
  // nothing else: no ordering dependency, no per-processor branch, no schema.
  assert.ok(RECOVERY_PROCESSORS.includes(ocr), 'membership is the array entry');
  assert.deepEqual(
    RECOVERY_PROCESSORS.map((p) => p.id),
    recoveryRegistry.ids(),
    'the registry is exactly the array, in order — nothing else decides who exists',
  );
});

await test('supports() carries the old listPendingOcr preconditions', async () => {
  assert.equal(ocr.supports(item()), true);
  assert.equal(ocr.supports(item({ offer: { image_url: null } })), false, 'needs a crop');
  assert.equal(ocr.supports(item({ attemptsBySource: {} })), false, 'needs a prior read to merge');
});

await test('no credential DECLINES rather than throwing', async () => {
  // Throwing would back the item off for hours over something no retry fixes.
  for (const keyChain of [null, createKeyChain([])]) {
    // The second case is the one the legacy `!mistralOcrKey && !keyChain` guard
    // missed: a real chain built from absent env vars, holding nothing.
    const out = await ocr.run(item(), { keyChain });
    assert.equal(out.declined, true);
    assert.match(out.error, /no OCR credential/);
  }
});

await test('it replays the PERSISTED vision attempt and never re-reads that model', async () => {
  const models = [];
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('cdn.example')) {
      return { ok: true, headers: new Map([['content-type', 'image/jpeg']]), arrayBuffer: async () => new ArrayBuffer(8) };
    }
    // Capture the model on every provider call the processor makes.
    try {
      models.push(JSON.parse(init.body || '{}').model);
    } catch { /* non-JSON body is not a model call */ }
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({ pages: [{ markdown: 'Arwa Bottled Water 330 ml' }] }),
      text: async () => JSON.stringify({ pages: [{ markdown: 'Arwa Bottled Water 330 ml' }] }),
    };
  };
  const out = await ocr.run(item(), {
    keyChain: createKeyChain(['test-key']),
    fetchImpl,
  }).catch((err) => ({ threw: err.message }));
  assert.ok(models.length > 0, 'the processor did make a provider call (else this proves nothing)');
  assert.equal(
    models.some((m) => String(m).includes('medium')), false,
    'the primary model must not be called again — the persisted attempt is replayed',
  );
  // Whatever the OCR call produced, the processor returns a PROPOSAL: it never
  // reports success and never touches queue state.
  if (!out.threw) {
    assert.equal('outcome' in out, false, 'a processor does not report an outcome');
    assert.equal(out.attempt?.source, OCR_PROCESSOR_ID);
  }
});

console.log(`\nS5.5 OCR recovery processor: ${tests} tests OK`);
