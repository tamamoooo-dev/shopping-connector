import assert from 'node:assert/strict';
import {
  ARABIC_ROLLOUT_VERSION,
  ARABIC_SHADOW_KEY,
  BUILDER_SCORE_VERSION,
  BUILDER_SCORE_WEIGHTS,
  BUILDER_STATUS,
  buildArabicShadow,
  builtArabicNamesEnabled,
  calculateBuilderScore,
  readArabicBuilderShadow,
  selectArabicName,
  withArabicBuilderShadow,
} from './arabicRollout.js';
import {
  canonicalNameArSql,
  enrichmentNameArSql,
  enrichRowCols,
} from '../storage/enrichStore.js';
import {
  ARABIC_BUILDER_DEBUG_PATH,
  handleArabicBuilderDebug,
} from '../offers/arabicBuilderDebug.js';
import {
  createMemoryEnrichStore,
  createMemoryOfferStore,
} from '../storage/local.js';
import { COMMERCE_SCORE_VERSION } from '../offers/commerceScore.js';

let tests = 0;
const test = async (name, fn) => {
  await fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Arabic rollout:');

const built = buildArabicShadow({
  name_en: 'Arwa Bottled Water 330 ml',
  name_ar: 'مياه أروى',
  brand: 'Arwa',
});

await test('a deterministic build records the complete shadow contract', () => {
  const shadow = built.arabicBuilder;
  assert.equal(shadow.rollout_version, ARABIC_ROLLOUT_VERSION);
  assert.equal(shadow.status, BUILDER_STATUS.BUILT);
  assert.equal(shadow.path, 'BUILT_CANDIDATE');
  assert.equal(shadow.observed_arabic, 'مياه أروى');
  assert.ok(shadow.built_arabic);
  assert.equal(shadow.category.id, 'bottled-water');
  assert.ok(shadow.builder_version);
  assert.ok(shadow.lexicon_version);
  assert.equal(typeof shadow.coverage_score, 'number');
  assert.equal(shadow.builder_score_version, BUILDER_SCORE_VERSION);
  assert.equal(shadow.builder_score, 100);
  assert.equal(shadow.builder_score_components.guard_used, false);
  assert.equal(shadow.commerce_score_version, COMMERCE_SCORE_VERSION);
  assert.equal(typeof shadow.commerce_score, 'number');
  assert.ok(shadow.commerce_score >= 0 && shadow.commerce_score <= 100);
  assert.ok(shadow.commerce_score_breakdown);
  assert.equal(
    Object.values(BUILDER_SCORE_WEIGHTS).reduce((sum, value) => sum + value, 0),
    100,
  );
  assert.ok(Array.isArray(shadow.descriptors));
  assert.ok(Array.isArray(shadow.dropped_fragments));
});

await test('the head-final guard maps to REFUSED_BY_GUARD without a built name', () => {
  const shadow = buildArabicShadow({
    name_en: 'Chocolate Alfa Beta',
    name_ar: 'منتج شوكولاتة',
  }).arabicBuilder;
  assert.equal(shadow.status, BUILDER_STATUS.REFUSED_BY_GUARD);
  assert.equal(shadow.built_arabic, null);
  assert.equal(shadow.builder_score, null);
  assert.equal(shadow.builder_score_components.guard_used, true);
  assert.equal(shadow.path, 'OBSERVED_FALLBACK');
});

await test('a vocabulary miss maps to NO_CATEGORY', () => {
  const shadow = buildArabicShadow({
    name_en: 'Keqiwear KW86 3in1',
    name_ar: 'كيكيوير',
  }).arabicBuilder;
  assert.equal(shadow.status, BUILDER_STATUS.NO_CATEGORY);
});

await test('Arabic-only input maps to FALLBACK_OBSERVED', () => {
  const shadow = buildArabicShadow({ name_ar: 'منتج مرصود' }).arabicBuilder;
  assert.equal(shadow.status, BUILDER_STATUS.FALLBACK_OBSERVED);
  assert.equal(shadow.builder_score, null);
});

await test('Builder Score is deterministic and independent of AI confidence', () => {
  const input = {
    name_en: 'Mughal Royal Basmati Rice 5kg',
    name_ar: 'أرز بسمتي',
    brand: 'Mughal',
    size: '5kg',
  };
  const lowConfidence = buildArabicShadow({ ...input, confidence: 0.01 }).arabicBuilder;
  const highConfidence = buildArabicShadow({ ...input, confidence: 0.99 }).arabicBuilder;
  assert.equal(lowConfidence.builder_score, highConfidence.builder_score);
  assert.deepEqual(
    lowConfidence.builder_score_components,
    highConfidence.builder_score_components,
  );
  assert.ok(lowConfidence.builder_score >= 0 && lowConfidence.builder_score <= 100);
});

await test('unknown and dropped fragments lower an otherwise complete score', () => {
  const complete = buildArabicShadow({ name_en: 'Basmati Rice 5kg' });
  const lossy = buildArabicShadow({ name_en: 'Royal Diamond Basmati Rice 5kg' });
  assert.equal(calculateBuilderScore(
    complete.structuredProduct,
    complete.arabicName,
  ).score, complete.arabicBuilder.builder_score);
  assert.ok(lossy.arabicBuilder.builder_score < complete.arabicBuilder.builder_score);
  assert.ok(lossy.arabicBuilder.builder_score_components.unknown_fragment_count > 0);
  assert.ok(lossy.arabicBuilder.builder_score_components.dropped_fragment_penalty > 0);
});

await test('the global flag is strict and default-off', () => {
  assert.equal(builtArabicNamesEnabled(undefined), false);
  assert.equal(builtArabicNamesEnabled('false'), false);
  assert.equal(builtArabicNamesEnabled('true'), true);
  assert.equal(builtArabicNamesEnabled(true), true);
});

await test('disabled always selects observed Arabic', () => {
  assert.deepEqual(selectArabicName({
    observedArabic: 'مرصود',
    shadow: built.arabicBuilder,
    enabled: false,
  }), { nameAr: 'مرصود', path: 'OBSERVED' });
});

await test('enabled selects built Arabic only for BUILT', () => {
  assert.equal(selectArabicName({
    observedArabic: 'مرصود',
    shadow: built.arabicBuilder,
    enabled: true,
  }).nameAr, built.arabicBuilder.built_arabic);
  assert.equal(selectArabicName({
    observedArabic: 'مرصود',
    shadow: { ...built.arabicBuilder, status: BUILDER_STATUS.NO_CATEGORY },
    enabled: true,
  }).nameAr, 'مرصود');
  assert.equal(selectArabicName({
    observedArabic: 'مرصود',
    shadow: { ...built.arabicBuilder, builder_score: 0 },
    enabled: true,
  }).nameAr, built.arabicBuilder.built_arabic);
  assert.equal(selectArabicName({
    observedArabic: 'مرصود',
    shadow: { ...built.arabicBuilder, commerce_score: 0 },
    enabled: true,
  }).nameAr, built.arabicBuilder.built_arabic);
});

await test('shadow metadata round-trips inside extraction_json', () => {
  const stored = withArabicBuilderShadow({ name_en: 'Water' }, built.arabicBuilder);
  assert.equal(stored.name_en, 'Water');
  assert.deepEqual(readArabicBuilderShadow(JSON.stringify(stored)), stored[ARABIC_SHADOW_KEY]);
  assert.equal(readArabicBuilderShadow('{bad json'), null);
});

await test('legacy enrichment rows backfill idempotently without a schema change', async () => {
  const enrichStore = createMemoryEnrichStore();
  await enrichStore.upsertMany([{
    id: 'legacy:1',
    name: 'Arwa Bottled Water 330 ml',
    name_ar: 'مياه أروى',
    brand: 'Arwa',
    size: '330 ml',
    corroboration: 1,
    enriched_at: '2026-07-26T00:00:00.000Z',
    extraction_json: {
      attributes: ['bottled'],
      _arabic_builder: {
        rollout_version: ARABIC_ROLLOUT_VERSION,
        status: BUILDER_STATUS.BUILT,
      },
    },
  }]);
  assert.equal(await enrichStore.backfillArabicBuilderShadows(), 1);
  assert.equal(await enrichStore.backfillArabicBuilderShadows(), 0);
  const row = (await enrichStore.getForIds(['legacy:1'])).get('legacy:1');
  const shadow = readArabicBuilderShadow(row.extraction_json);
  assert.equal(shadow.status, BUILDER_STATUS.BUILT);
  assert.equal(shadow.commerce_score_version, COMMERCE_SCORE_VERSION);
});

await test('the in-memory production twin rolls back with the same one flag', async () => {
  const enrichStore = createMemoryEnrichStore();
  await enrichStore.upsertMany([{
    id: 'offer:1',
    name: 'Arwa Bottled Water 330 ml',
    name_ar: 'مياه مرصودة',
    brand: 'Arwa',
    size: '330 ml',
    corroboration: 1,
    enriched_at: '2026-07-26T00:00:00.000Z',
    extraction_json: withArabicBuilderShadow({}, built.arabicBuilder),
  }]);
  const observedStore = createMemoryOfferStore({ enrichStore });
  const builtStore = createMemoryOfferStore({
    enrichStore,
    builtArabicNamesEnabled: true,
  });
  const offer = {
    id: 'offer:1',
    price: 1,
    name: null,
    name_ar: null,
    valid_to: '2026-08-01',
  };
  await observedStore.upsertMany([offer]);
  await builtStore.upsertMany([offer]);
  assert.equal((await observedStore.search())[0].e_name_ar, 'مياه مرصودة');
  assert.equal((await builtStore.search())[0].e_name_ar, built.arabicBuilder.built_arabic);
});

await test('disabled SQL is the historical observed-Arabic path', () => {
  assert.equal(enrichmentNameArSql(false), 'e.name_ar');
  assert.ok(enrichRowCols(false).includes('e.name_ar AS e_name_ar'));
  assert.ok(!canonicalNameArSql(false).includes('json_extract'));
});

// 2026-07-30: the served name is `display_arabic` — the model's own Arabic
// cleaned of Latin debris with the brand appended — NOT `built_arabic`. The
// composed name lost whatever the lexicon did not know, and transliterating the
// remainder to stop that read worse than either. `built_arabic` is still
// persisted for diagnostics and the Builder Score; nothing serves it.
await test('enabled SQL serves the cleaned observed name, falling back to raw', () => {
  const sql = canonicalNameArSql(true);
  assert.ok(sql.includes('_arabic_builder.display_arabic'));
  assert.ok(sql.includes('json_valid'));
  assert.ok(sql.includes('ELSE e.name_ar'));
  // The status gate belonged to the built name and must not gate this one: a
  // row the BUILDER refused still has a perfectly good observed name to clean.
  assert.ok(!sql.includes("= 'BUILT'"));
});

await test('debug diagnostics are invisible outside development', async () => {
  const request = new Request(`https://example.test${ARABIC_BUILDER_DEBUG_PATH}/build`, {
    method: 'POST',
    body: JSON.stringify({ name_en: 'Bottled Water' }),
  });
  assert.equal(await handleArabicBuilderDebug(request, { isDevelopment: false }), null);
});

await test('development diagnostics expose the required metadata', async () => {
  const request = new Request(`https://example.test${ARABIC_BUILDER_DEBUG_PATH}/build`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name_en: 'Bottled Water', name_ar: 'مياه' }),
  });
  const response = await handleArabicBuilderDebug(request, {
    isDevelopment: true,
    builtArabicNamesEnabled: false,
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  for (const key of [
    'builder_version', 'lexicon_version', 'coverage_score',
    'builder_score_version', 'builder_score', 'builder_score_components',
    'commerce_score_version', 'commerce_score', 'commerce_score_breakdown',
    'builder_status', 'category', 'descriptors', 'flavor', 'size',
    'dropped_fragments',
  ]) assert.ok(Object.hasOwn(body, key), key);
  assert.equal(body.selected_path, 'OBSERVED');
});

console.log(`Arabic rollout: ${tests} tests passed`);
