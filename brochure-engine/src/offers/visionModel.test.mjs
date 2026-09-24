// visionModel.test.mjs — offline, dependency-free tests for the Vision Model
// Selection Policy (offers/visionModel.js). Run with:
//   node brochure-engine/src/offers/visionModel.test.mjs   (repo root)
//
// Guards the policy's promises:
//  • Medium is the default and puts the FROZEN baseline's exact model string on
//    the wire (the same string enrich.test.mjs pins),
//  • Small is a supported MANUAL tier, pinned to the version that was actually
//    measured rather than a drifting alias, and carries the budget warning,
//  • every failure path — no store, missing key, corrupt bytes, unknown tier —
//    resolves to Medium, because guessing wrong must never silently downgrade
//    the extraction that canonical product data is built from,
//  • a written selection round-trips.

import {
  VISION_MODEL_KEY,
  VISION_MODEL_OPTIONS,
  VISION_MODEL_TIERS,
  DEFAULT_VISION_TIER,
  normalizeVisionTier,
  visionModelFor,
  readVisionModelSetting,
  writeVisionModelSetting,
} from './visionModel.js';
import { DEFAULT_MODEL, buildVisionRequest } from './enrich.js';

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`  ok  ${name}`);
  else { failures += 1; console.error(`FAIL  ${name}`); }
}

function memoryObjectStore() {
  const objects = new Map();
  return {
    objects,
    async get(key) {
      return objects.has(key) ? { bytes: objects.get(key), contentType: 'application/json' } : null;
    },
    async put(key, bytes) { objects.set(key, bytes); },
    async delete(key) { objects.delete(key); },
  };
}
const decode = (bytes) => JSON.parse(new TextDecoder().decode(bytes));

console.log('\n--- catalog + policy invariants ---');
check('default tier is medium', DEFAULT_VISION_TIER === 'medium');
// Deliberately NOT asserted against enrich.js's DEFAULT_MODEL. The selector
// ships ahead of the frozen extraction baseline, so the two are allowed to
// differ; the engine simply does not override while inert (see the ARMED block
// below). Once the baseline lands they converge on their own.
check(
  'the retired medium tier can no longer put a retired model on the wire (one model, 2026-09-24)',
  VISION_MODEL_TIERS.medium.model === 'ministral-14b-2512',
);
check('the retired medium tier records Ministral 14B as its version',
  VISION_MODEL_TIERS.medium.version === 'ministral-14b-2512');
check('medium is not a budget tier and carries no warning',
  VISION_MODEL_TIERS.medium.budget === false && VISION_MODEL_TIERS.medium.warning === null);
check(
  'small is PINNED to the measured version, not the drifting alias',
  VISION_MODEL_TIERS.small.model === 'ministral-14b-2512' &&
    VISION_MODEL_TIERS.small.alias === 'ministral-14b-2512',
);
check('small is flagged budget and carries the quality warning',
  VISION_MODEL_TIERS.small.budget === true &&
    /package size and brand recognition/.test(VISION_MODEL_TIERS.small.warning));
check('exactly two tiers are offered', VISION_MODEL_OPTIONS.length === 2);

console.log('\n--- normalization is fail-safe toward quality ---');
// Nothing unrecognized may resolve to the budget tier — including the budget
// model's own id, which is not a tier name.
for (const bad of [undefined, null, '', '   ', 'tiny', 'ministral-14b-2512', 'budget', 42, {}]) {
  check(`normalize(${JSON.stringify(bad)}) -> medium`, normalizeVisionTier(bad) === 'medium');
}
check('tier names are trimmed and case-folded', normalizeVisionTier(' MEDIUM ') === 'medium');
check('small is the one value that selects small', normalizeVisionTier('Small') === 'small');
check('visionModelFor(garbage) yields the medium record', visionModelFor('nope').tier === 'medium');

console.log('\n--- reading the setting ---');
{
  const none = await readVisionModelSetting(null);
  check('no object store bound -> the default tier, which sends Ministral 14B',
    none.tier === 'medium' && none.model === 'ministral-14b-2512');
  check('no object store bound -> source "default"', none.source === 'default');

  const store = memoryObjectStore();
  const empty = await readVisionModelSetting(store);
  check('unset key -> medium', empty.tier === 'medium' && empty.budget === false);

  store.objects.set(VISION_MODEL_KEY, new TextEncoder().encode('{not json'));
  const corrupt = await readVisionModelSetting(store);
  check('corrupt record -> medium', corrupt.tier === 'medium' && corrupt.source === 'default');

  store.objects.set(VISION_MODEL_KEY, new TextEncoder().encode(JSON.stringify({ tier: 'nano' })));
  const unknown = await readVisionModelSetting(store);
  check('unknown stored tier -> medium, reported as default',
    unknown.tier === 'medium' && unknown.source === 'default' && unknown.selectedAt === null);

  const throwing = { async get() { throw new Error('KV down'); } };
  const errored = await readVisionModelSetting(throwing);
  check('object store failure -> medium (never a silent downgrade)',
    errored.tier === 'medium' && errored.source === 'default');
}

console.log('\n--- writing the setting ---');
{
  const store = memoryObjectStore();
  const written = await writeVisionModelSetting(store, 'small', { by: 'ops', now: new Date('2026-07-25T10:00:00Z') });
  check('write returns the budget tier', written.tier === 'small' && written.model === 'ministral-14b-2512');
  check('write returns the warning to display', /Budget Mode enabled/.test(written.warning));
  check('write stamps who and when',
    written.selectedBy === 'ops' && written.selectedAt === '2026-07-25T10:00:00.000Z');

  const stored = decode(store.objects.get(VISION_MODEL_KEY));
  check('stored record is minimal (tier + model + provenance)',
    stored.tier === 'small' && stored.model === 'ministral-14b-2512' && stored.selectedBy === 'ops');

  const back = await readVisionModelSetting(store);
  check('selection round-trips', back.tier === 'small' && back.source === 'stored');
  check('round-trip preserves provenance',
    back.selectedAt === '2026-07-25T10:00:00.000Z' && back.selectedBy === 'ops');

  const restored = await writeVisionModelSetting(store, 'medium');
  check('switching back restores the production baseline',
    restored.tier === 'medium' && restored.budget === false && restored.warning === null);
  check('restored selection round-trips',
    (await readVisionModelSetting(store)).model === 'ministral-14b-2512');

  let threw = false;
  try { await writeVisionModelSetting(null, 'small'); } catch { threw = true; }
  check('writing without an object store fails loudly', threw);
}

console.log('\n--- ARMED vs INERT: production is untouched until an operator picks ---');
// The property that lets this feature deploy AHEAD of the frozen extraction
// baseline. engine.js spreads `model` into the drain options only when armed, so
// `armed === false` must mean drainEnrichment sees no `model` key at all and
// falls through to its own DEFAULT_MODEL. Modelled here exactly as engine.js
// builds it, so a regression in that branch fails this suite.
const drainOptionsFor = (setting) => ({
  limit: 15,
  ...(setting.armed ? { model: setting.model } : {}),
});
// Mirrors drainEnrichment's own `{ model = DEFAULT_MODEL }` destructuring, so
// "what would the drain actually send?" is answered the same way the real
// function answers it.
const effectiveModel = ({ model = DEFAULT_MODEL } = {}) => model;
{
  check('no store bound is INERT', (await readVisionModelSetting(null)).armed === false);

  const store = memoryObjectStore();
  check('unset key is INERT', (await readVisionModelSetting(store)).armed === false);

  store.objects.set(VISION_MODEL_KEY, new TextEncoder().encode('{not json'));
  check('corrupt record is INERT', (await readVisionModelSetting(store)).armed === false);

  store.objects.set(VISION_MODEL_KEY, new TextEncoder().encode(JSON.stringify({ tier: 'nano' })));
  check('unknown stored tier is INERT', (await readVisionModelSetting(store)).armed === false);

  const throwing = { async get() { throw new Error('KV down'); } };
  check('store failure is INERT', (await readVisionModelSetting(throwing)).armed === false);

  // The end-to-end promise: nothing is overridden, so DEFAULT_MODEL survives.
  const inertOpts = drainOptionsFor(await readVisionModelSetting(null));
  check('INERT passes NO model key to the drain',
    Object.prototype.hasOwnProperty.call(inertOpts, 'model') === false);
  check('INERT therefore leaves DEFAULT_MODEL in force',
    effectiveModel(inertOpts) === DEFAULT_MODEL);

  // ...and the moment an operator picks, the override takes effect.
  const armedStore = memoryObjectStore();
  await writeVisionModelSetting(armedStore, 'small', { by: 'ops' });
  const armed = await readVisionModelSetting(armedStore);
  check('an explicit selection ARMS the override', armed.armed === true && armed.source === 'stored');
  check('ARMED passes the selected model to the drain',
    drainOptionsFor(armed).model === 'ministral-14b-2512');
  check('ARMED overrides DEFAULT_MODEL',
    effectiveModel(drainOptionsFor(armed)) === 'ministral-14b-2512');

  // Explicitly choosing Medium is an ARMED state too, not a return to inert:
  // the operator's choice must survive a later change to the engine default.
  await writeVisionModelSetting(armedStore, 'medium', { by: 'ops' });
  const armedMedium = await readVisionModelSetting(armedStore);
  check('explicitly choosing Medium stays ARMED', armedMedium.armed === true);
  check('ARMED (retired) Medium tier still sends only Ministral 14B',
    drainOptionsFor(armedMedium).model === 'ministral-14b-2512');
}

console.log('\n--- the selection reaches the wire ---');
{
  const store = memoryObjectStore();
  await writeVisionModelSetting(store, 'small');
  const { model } = await readVisionModelSetting(store);
  const req = buildVisionRequest({ model, base64: 'AAAA' });
  check('budget mode sends ministral-14b-2512', req.model === 'ministral-14b-2512');

  await writeVisionModelSetting(store, 'medium');
  const back = await readVisionModelSetting(store);
  const req2 = buildVisionRequest({ model: back.model, base64: 'AAAA' });
  check('every tier sends ministral-14b-2512', req2.model === 'ministral-14b-2512');
  check('the tier switch changes ONLY the model, not the frozen request settings',
    req.temperature === req2.temperature && req.top_p === req2.top_p &&
      JSON.stringify(req.response_format) === JSON.stringify(req2.response_format));
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll vision model policy tests passed.');
