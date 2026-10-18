// Current user policy: Ministral 14B only, including failed/stale settings.
import assert from 'node:assert/strict';
import { VISION_MODEL_KEY, VISION_MODEL_OPTIONS, DEFAULT_VISION_TIER,
  normalizeVisionTier, visionModelFor, readVisionModelSetting, writeVisionModelSetting } from './visionModel.js';
import { DEFAULT_MODEL, buildVisionRequest } from './enrich.js';
const expected = 'ministral-14b-2512';
assert.equal(DEFAULT_MODEL, expected);
assert.equal(VISION_MODEL_OPTIONS.length, 1);
assert.equal(VISION_MODEL_OPTIONS[0].model, expected);
for (const tier of [null, undefined, '', 'medium', 'small', 'nano', '14b', expected]) {
  assert.equal(visionModelFor(tier).model, expected);
  assert.equal(normalizeVisionTier(tier), DEFAULT_VISION_TIER);
}
for (const objectStore of [null, { get: async () => null }, { get: async () => { throw Error('offline'); } }]) {
  const setting = await readVisionModelSetting(objectStore);
  assert.equal(setting.model, expected);
  assert.equal(setting.armed, false);
}
const objects = new Map();
const store = { get: async k => objects.has(k) ? { bytes: objects.get(k) } : null,
  put: async (k,v) => objects.set(k,v) };
for (const record of ['{bad json', JSON.stringify({ tier:'medium', model:'mistral-medium-latest' }), JSON.stringify({tier:'unknown'})]) {
  objects.set(VISION_MODEL_KEY, new TextEncoder().encode(record));
  assert.equal((await readVisionModelSetting(store)).model, expected);
}
const written = await writeVisionModelSetting(store, 'small', { by:'audit', now:new Date('2026-10-18T00:00:00Z') });
const back = await readVisionModelSetting(store);
assert.equal(back.model, expected);
assert.equal(back.armed, true);
assert.equal(back.selectedAt, written.selectedAt);
assert.equal(back.selectedBy, 'audit');
const req = buildVisionRequest({ model:back.model, base64:'AAAA' });
assert.equal(req.model, expected);
assert.equal('reasoning_effort' in req, false);
await assert.rejects(() => writeVisionModelSetting(null, 'small'));
console.log('14B-only model policy: defaults, stale/corrupt settings, selection persistence and wire request passed.');
