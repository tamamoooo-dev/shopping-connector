// visionMedium.test.mjs — the Vision Medium recovery processor.
//
// WHAT THIS DEFENDS, and why each one is a real risk rather than a ceremony:
//
//   • IT PINS ITS OWN MODEL. `processorContext` forwards the ARMED Vision
//     selection as `ctx.model`, and in production that selection is
//     `mistral-small-2603`. A rung whose entire identity is the model must not
//     let the selector redefine it, or "run Medium recovery" silently means "run
//     Small again" while the report claims otherwise. This is the single most
//     important assertion in the file.
//
//   • IT CANNOT VIOLATE C-7, structurally. A fresh Medium read disagrees with
//     Small on names routinely. If the processor proposed Medium's name over an
//     accepted prior one, the runner's commit boundary would refuse the write and
//     the rung would spend Medium money to record `failed`. The merge order is
//     what prevents that, so it is asserted through the runner's own checker
//     rather than by inspection.
//
//   • IT STILL FILLS THE GAP. The flip side: preserving accepted fields must not
//     degrade into preserving everything. A size the prior read did not have
//     accepted must land.
//
//   • ONE PROVIDER CALL, on the chat endpoint only. VISION_ONLY exists so a
//     failed validation cannot trigger an OCR call this rung never asked for and
//     whose cost it would not report.
//
//   • THE JOURNAL TELLS THE TRUTH about which model ran, since the merge slot it
//     reuses is named `ocr*` internally (see the module header).

import assert from 'node:assert/strict';
import visionMedium, { VISION_MEDIUM_PROCESSOR_ID, RECOVERY_VISION_MODEL } from './visionMedium.js';
import { createKeyChain } from '../../offers/mistralKeys.js';
import { recoveryRegistry, RECOVERY_PROCESSORS } from './index.js';
import { RECOVERY_KIND } from '../registry.js';
import { acceptedFieldViolations } from '../runner.js';
import { validateVisionOutput } from '../../offers/smartExtraction.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Vision Medium recovery processor:');

const PRIOR_NAME = 'Arwa Bottled Water';
const SMALL_MODEL = 'mistral-small-2603';

// The prior attempt as the JOURNAL holds it: name accepted, size never resolved.
// Built through the real validator so the fixture cannot drift from the shape
// `mergeValidatedExtractions` actually reads.
const priorValidation = validateVisionOutput({
  name_en: PRIOR_NAME, name_ar: 'أروى مياه', brand: 'Arwa', package_size: null, quantity: null,
});

const item = (overrides = {}) => ({
  offerId: 'a:r:d4d:1',
  offer: { id: 'a:r:d4d:1', image_url: 'https://cdn.example/crop.jpg', price: 5.99, currency: 'SAR' },
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

// A fake provider. `reply` is what the model returns as JSON content; every
// request is recorded so the test can assert WHICH endpoint and WHICH model.
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
    let body = {};
    try { body = JSON.parse(init.body || '{}'); } catch { /* not a model call */ }
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

await test('it registers as a machine rung on the existing vision credential', async () => {
  assert.equal(visionMedium.id, VISION_MEDIUM_PROCESSOR_ID);
  assert.equal(visionMedium.kind, RECOVERY_KIND.MACHINE, 'C-7 binds it');
  assert.equal(recoveryRegistry.get('vision-medium'), visionMedium);
  assert.ok(RECOVERY_PROCESSORS.includes(visionMedium), 'membership is the array entry');
  // Reusing an EXISTING credential name is what makes this cost zero console
  // code — `credentialChains()` already resolves 'vision' to the medium pool.
  assert.equal(visionMedium.credential, 'vision');
  assert.equal(visionMedium.reviewPlan, null, 'unattended: no review surface');
  assert.deepEqual(
    RECOVERY_PROCESSORS.map((p) => p.id),
    recoveryRegistry.ids(),
    'the registry is exactly the array, in order — nothing else decides who exists',
  );
});

await test('supports(): needs a crop, needs a prior read, refuses a second Medium pass', async () => {
  assert.equal(visionMedium.supports(item()), true);
  assert.equal(visionMedium.supports(item({ offer: { image_url: null } })), false, 'needs a crop');
  assert.equal(visionMedium.supports(item({ attemptsBySource: {} })), false, 'needs a prior read to merge');
  // Paying Medium twice for one crop cannot produce new evidence. The
  // Medium-extracted items already in the queue belong to the human rung.
  const already = item();
  already.attemptsBySource.vision.model = 'mistral-medium-latest';
  assert.equal(visionMedium.supports(already), false, 'never re-pays Medium for the same crop');
});

await test('no credential DECLINES rather than throwing', async () => {
  // Throwing would burn the item's attempt budget over a configuration state.
  for (const keyChain of [null, createKeyChain([])]) {
    const out = await visionMedium.run(item(), { keyChain });
    assert.equal(out.declined, true);
    assert.match(out.error, /no Vision credential/);
  }
});

await test('IT PINS MEDIUM AND IGNORES THE ARMED SELECTOR (ctx.model)', async () => {
  const { calls, fetchImpl } = fakeProvider({ name_en: PRIOR_NAME, package_size: '330 ml' });
  await visionMedium.run(item(), {
    keyChain: createKeyChain(['test-key']),
    fetchImpl,
    // Exactly what production hands it: the ARMED selection, which is Small.
    model: SMALL_MODEL,
  });
  assert.equal(calls.length, 1, 'exactly one provider call');
  assert.equal(
    calls[0].model, RECOVERY_VISION_MODEL,
    'the armed Small selection must NOT be able to redefine what this rung is',
  );
  assert.ok(calls[0].url.includes('chat/completions'), 'the chat endpoint, not the OCR one');
});

await test('recoveryModel is the ONE supported override', async () => {
  const { calls, fetchImpl } = fakeProvider({ name_en: PRIOR_NAME, package_size: '330 ml' });
  await visionMedium.run(item(), {
    keyChain: createKeyChain(['test-key']),
    fetchImpl,
    model: SMALL_MODEL,
    recoveryModel: 'mistral-large-future',
  });
  assert.equal(calls[0].model, 'mistral-large-future', 'the rung can be moved deliberately');
});

await test('C-7: a disagreeing Medium name CANNOT overwrite the accepted prior one', async () => {
  // The realistic failure mode — Medium reads the same crop and words the name
  // differently. A full re-read would propose it and the runner would refuse the
  // whole write.
  const { fetchImpl } = fakeProvider({
    name_en: 'Arwa Drinking Water Bottle',
    brand: 'ARWA',
    package_size: '330 ml',
  });
  const out = await visionMedium.run(item(), {
    keyChain: createKeyChain(['test-key']),
    fetchImpl,
  });
  assert.equal(out.canonicalRow.name, PRIOR_NAME, 'the accepted prior name survives verbatim');
  // Asserted through the RUNNER'S OWN checker, not by inspection: this is the
  // exact predicate the commit boundary will evaluate.
  assert.deepEqual(
    acceptedFieldViolations(item(), out.canonicalRow), [],
    'the commit boundary has nothing to refuse',
  );
});

await test('it still FILLS the gap the prior read left — the point of the rung', async () => {
  const { fetchImpl } = fakeProvider({ name_en: PRIOR_NAME, package_size: '330 ml' });
  const out = await visionMedium.run(item(), {
    keyChain: createKeyChain(['test-key']),
    fetchImpl,
  });
  assert.equal(out.canonicalRow.size, '330 ml', 'preserving accepted fields must not preserve gaps too');
});

await test('the journal records WHICH model ran, despite the reused merge slot', async () => {
  const { fetchImpl } = fakeProvider({ name_en: PRIOR_NAME, package_size: '330 ml' });
  const out = await visionMedium.run(item(), {
    keyChain: createKeyChain(['test-key']),
    fetchImpl,
  });
  assert.equal(out.attempt.source, VISION_MEDIUM_PROCESSOR_ID, 'the processor id IS the source');
  assert.equal(out.attempt.model, RECOVERY_VISION_MODEL);
  // The same `<prior>+<recovery>` shape that makes the OCR rung calibratable in
  // SQL today, so "did Medium recover this" stays a query and not a guess.
  assert.equal(out.canonicalRow.model, `${SMALL_MODEL}+${RECOVERY_VISION_MODEL}`);
  assert.equal(out.cost.tier, 'vision-medium');
  assert.equal(out.cost.requests, 1, 'the REPLAYED prior read is not billed again');
  // A processor proposes; it never reports success and never touches the queue.
  assert.equal('outcome' in out, false);
  assert.equal('resolved' in out, false);
});

await test('an unavailable crop THROWS — a failure, not a decline', async () => {
  // A decline consumes no attempt, so a genuinely broken crop must not decline
  // or it would be retried on every pass forever.
  const noCrop = item({ offer: { id: 'a:r:d4d:1', image_url: null } });
  await assert.rejects(
    () => visionMedium.run(noCrop, { keyChain: createKeyChain(['test-key']), fetchImpl: async () => { throw new Error('unreachable'); } }),
    /crop was unavailable/,
  );
});

console.log(`\nVision Medium recovery processor: ${tests} tests OK`);
