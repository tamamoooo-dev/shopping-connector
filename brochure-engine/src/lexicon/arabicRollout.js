// arabicRollout.js — production adapter around the deterministic Arabic Builder.
//
// The builder and lexicon remain pure and policy-free. This module supplies the
// rollout contract: persisted shadow metadata, four operational statuses, and
// the single reversible display-name switch.

import { ARABIC_BUILD_STATUS, buildArabicName } from './arabicBuilder.js';
import { cleanObservedArabic } from './observedArabic.js';
import { buildStructuredProduct, PRODUCT_SOURCES } from './structuredProduct.js';
import { calculateCommerceScore } from '../offers/commerceScore.js';

export const ARABIC_ROLLOUT_VERSION = 'arabic-rollout-v1';
export const ARABIC_SHADOW_KEY = '_arabic_builder';
export const BUILDER_SCORE_VERSION = 'builder-score-v1';

export const BUILDER_SCORE_WEIGHTS = Object.freeze({
  category: 30,
  lexical_coverage: 30,
  brand: 10,
  size: 10,
  descriptor_coverage: 10,
  flavor_coverage: 10,
});

export const BUILDER_STATUS = Object.freeze({
  BUILT: 'BUILT',
  FALLBACK_OBSERVED: 'FALLBACK_OBSERVED',
  REFUSED_BY_GUARD: 'REFUSED_BY_GUARD',
  NO_CATEGORY: 'NO_CATEGORY',
});

export function builtArabicNamesEnabled(value) {
  return value === true || String(value ?? '').trim().toLowerCase() === 'true';
}

function productionStatus(structured, built) {
  if (built?.status === ARABIC_BUILD_STATUS.BUILT && built.name) {
    return BUILDER_STATUS.BUILT;
  }
  if (structured?.category_diagnostics?.reason === 'head_final_guard') {
    return BUILDER_STATUS.REFUSED_BY_GUARD;
  }
  if (structured?.source === PRODUCT_SOURCES.ENGLISH) {
    return BUILDER_STATUS.NO_CATEGORY;
  }
  return BUILDER_STATUS.FALLBACK_OBSERVED;
}

const categoryDiagnostic = (category) => category ? {
  id: category.id,
  en: category.en,
  ar: category.ar,
  matched_phrase: category.matched_phrase,
} : null;

const descriptorDiagnostic = (descriptor) => ({
  id: descriptor.id,
  role: descriptor.role,
  en: descriptor.en,
  ar: descriptor.ar,
  matched_phrase: descriptor.matched_phrase,
});

const present = (value) => typeof value === 'string' && value.trim().length > 0;
const ratio = (resolved, total) => total ? resolved / total : 1;
const roundedRatio = (value) => Number(value.toFixed(3));

// IDENTITY READINESS — "does the Structured Product hold enough deterministic
// information to build a high-quality Arabic identity?" It is NOT a measure of
// the rendered Arabic string, and not a confidence score (VISION-PIPELINE.md
// C-4; QUALITY-SCORES.md §1).
//
// EVERY input is a pure function of `structured`. `built` is a parameter for
// two things only — the `dropped` list and the `isBuilt` gate — and both are
// themselves derived from `structured` alone (`arabicBuilder.js` builds
// `dropped` from `residual_en` + `brand` before composition runs, and returns
// it even on the no-category path). Nothing here reads `built.name`,
// `built.parts` or `built.lines`. Do not start: the position after the builder
// is a call-graph accident, and S8e/S8f are siblings, not a chain.
//
// Model confidence and corroboration are intentionally absent. Unknown
// fragments reduce lexical coverage, while the separate dropped-fragment
// deduction measures what the presentation layer could not express.
export function calculateBuilderScore(structured, built = buildArabicName(structured)) {
  const guardUsed = structured?.category_diagnostics?.reason === 'head_final_guard';
  const isBuilt = built?.status === ARABIC_BUILD_STATUS.BUILT
    && Boolean(built.name)
    && Boolean(structured?.category)
    && !guardUsed;

  const descriptors = structured?.descriptors || [];
  const renderedDescriptors = descriptors.filter((descriptor) => present(descriptor.ar));
  const flavors = descriptors.filter((descriptor) => descriptor.role === 'flavor');
  const renderedFlavors = flavors.filter((descriptor) => present(descriptor.ar));

  const brandExpected = present(structured?.observed?.brand);
  const brandResolved = !brandExpected || present(structured?.brand?.display_ar);
  const sizeExpected = present(structured?.observed?.size) || Boolean(structured?.size);
  const sizeResolved = !sizeExpected || present(structured?.size?.display_ar);
  const lexicalCoverage = Number.isFinite(structured?.coverage)
    ? Math.max(0, Math.min(1, structured.coverage))
    : 0;
  const descriptorCoverage = ratio(renderedDescriptors.length, descriptors.length);
  const flavorCoverage = ratio(renderedFlavors.length, flavors.length);
  const droppedFragmentCount = built?.dropped?.length || 0;
  const droppedFragmentPenalty = Math.min(10, droppedFragmentCount * 2);

  const weightedBeforePenalty =
    (structured?.category ? BUILDER_SCORE_WEIGHTS.category : 0)
    + (BUILDER_SCORE_WEIGHTS.lexical_coverage * lexicalCoverage)
    + (brandResolved ? BUILDER_SCORE_WEIGHTS.brand : 0)
    + (sizeResolved ? BUILDER_SCORE_WEIGHTS.size : 0)
    + (BUILDER_SCORE_WEIGHTS.descriptor_coverage * descriptorCoverage)
    + (BUILDER_SCORE_WEIGHTS.flavor_coverage * flavorCoverage);

  const score = isBuilt
    ? Math.max(0, Math.min(100, Math.round(weightedBeforePenalty - droppedFragmentPenalty)))
    : null;

  return Object.freeze({
    version: BUILDER_SCORE_VERSION,
    score,
    components: Object.freeze({
      category_resolved: Boolean(structured?.category),
      lexical_coverage: roundedRatio(lexicalCoverage),
      brand_expected: brandExpected,
      brand_resolved: brandResolved,
      size_expected: sizeExpected,
      size_resolved: sizeResolved,
      descriptor_count: descriptors.length,
      descriptor_rendered_count: renderedDescriptors.length,
      descriptor_coverage: roundedRatio(descriptorCoverage),
      flavor_count: flavors.length,
      flavor_rendered_count: renderedFlavors.length,
      flavor_coverage: roundedRatio(flavorCoverage),
      unknown_fragment_count: structured?.residual_en?.length || 0,
      dropped_fragment_count: droppedFragmentCount,
      dropped_fragment_penalty: droppedFragmentPenalty,
      guard_used: guardUsed,
      weighted_before_penalty: Number(weightedBeforePenalty.toFixed(3)),
    }),
  });
}

export function createArabicBuilderShadow(
  structured,
  built = buildArabicName(structured),
  commerceContext = {},
) {
  const status = productionStatus(structured, built);
  const builderScore = calculateBuilderScore(structured, built);
  const commerceScore = calculateCommerceScore(structured, commerceContext);
  return Object.freeze({
    rollout_version: ARABIC_ROLLOUT_VERSION,
    builder_version: built.version,
    lexicon_version: structured?.lexicon_version ?? null,
    status,
    path: status === BUILDER_STATUS.BUILT ? 'BUILT_CANDIDATE' : 'OBSERVED_FALLBACK',
    observed_arabic: structured?.observed?.name_ar ?? null,
    built_arabic: status === BUILDER_STATUS.BUILT ? built.name : null,
    // THE SERVED NAME (user decision, 2026-07-30). Not the built name: composing
    // from the lexicon loses whatever the lexicon does not know ("Doux Chicken
    // Nuggets or Fingers" -> "ناجتس دجاج"), and transliterating the remainder to
    // stop that loss read worse still. This is the model's OWN Arabic, stripped
    // of Latin debris, with the brand appended when it is missing — no word is
    // invented, and both of the observed text's mechanical defects are repaired.
    // Null when cleaning leaves nothing, and the read path then serves the raw
    // observed text: a bad name beats no name.
    display_arabic: cleanObservedArabic(structured?.observed?.name_ar ?? null, {
      brandAr: structured?.brand?.display_ar ?? null,
    }),
    display_source: 'observed_cleaned',
    coverage_score: structured?.coverage ?? null,
    builder_score_version: builderScore.version,
    builder_score: builderScore.score,
    builder_score_components: builderScore.components,
    commerce_score_version: commerceScore.version,
    commerce_score: commerceScore.score,
    commerce_score_breakdown: commerceScore.breakdown,
    category: categoryDiagnostic(structured?.category),
    descriptors: (structured?.descriptors || []).map(descriptorDiagnostic),
    flavor: built.parts?.flavor ?? null,
    size: structured?.size ?? null,
    dropped_fragments: built.dropped || [],
  });
}

export function buildArabicShadow(observation = {}) {
  const structuredProduct = buildStructuredProduct(observation);
  const arabicName = buildArabicName(structuredProduct);
  const arabicBuilder = createArabicBuilderShadow(
    structuredProduct,
    arabicName,
    observation,
  );
  return { structuredProduct, arabicName, arabicBuilder };
}

export function withArabicBuilderShadow(observation, shadow) {
  return { ...(observation || {}), [ARABIC_SHADOW_KEY]: shadow };
}

export function readArabicBuilderShadow(extractionJson) {
  if (!extractionJson) return null;
  try {
    const parsed = typeof extractionJson === 'string'
      ? JSON.parse(extractionJson)
      : extractionJson;
    return parsed && typeof parsed === 'object' ? parsed[ARABIC_SHADOW_KEY] ?? null : null;
  } catch {
    return null;
  }
}

export function selectArabicName({
  observedArabic = null,
  shadow = null,
  enabled = false,
} = {}) {
  if (builtArabicNamesEnabled(enabled)
      && shadow?.status === BUILDER_STATUS.BUILT
      && shadow.built_arabic) {
    return { nameAr: shadow.built_arabic, path: 'BUILT' };
  }
  return { nameAr: observedArabic, path: 'OBSERVED' };
}
