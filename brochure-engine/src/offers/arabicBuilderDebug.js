// Development-only Arabic Builder diagnostics. The handler returns null when
// ENVIRONMENT is not "development", so production requests fall through to the
// normal 404 and no builder metadata reaches end-user APIs.

import {
  buildArabicShadow,
  readArabicBuilderShadow,
  selectArabicName,
} from '../lexicon/arabicRollout.js';

export const ARABIC_BUILDER_DEBUG_PATH = '/__dev/arabic-builder';

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers });

function diagnostic(shadow, flagEnabled) {
  if (!shadow) return null;
  const selected = selectArabicName({
    observedArabic: shadow.observed_arabic,
    shadow,
    enabled: flagEnabled,
  });
  return {
    builder_version: shadow.builder_version,
    lexicon_version: shadow.lexicon_version,
    coverage_score: shadow.coverage_score,
    builder_score_version: shadow.builder_score_version,
    builder_score: shadow.builder_score,
    builder_score_components: shadow.builder_score_components,
    commerce_score_version: shadow.commerce_score_version,
    commerce_score: shadow.commerce_score,
    commerce_score_breakdown: shadow.commerce_score_breakdown,
    builder_status: shadow.status,
    builder_path: shadow.path,
    selected_path: selected.path,
    observed_arabic: shadow.observed_arabic,
    built_arabic: shadow.built_arabic,
    selected_name_ar: selected.nameAr,
    category: shadow.category,
    descriptors: shadow.descriptors,
    flavor: shadow.flavor,
    size: shadow.size,
    dropped_fragments: shadow.dropped_fragments,
  };
}

export async function handleArabicBuilderDebug(request, ctx = {}) {
  const url = new URL(request.url);
  const buildPath = `${ARABIC_BUILDER_DEBUG_PATH}/build`;
  if (url.pathname !== ARABIC_BUILDER_DEBUG_PATH && url.pathname !== buildPath) return null;
  if (ctx.isDevelopment !== true) return null;

  if (url.pathname === ARABIC_BUILDER_DEBUG_PATH && request.method === 'GET') {
    const id = url.searchParams.get('id');
    if (!id) return json({ error: 'Query parameter "id" is required.' }, 400);
    const row = (await ctx.enrichStore?.getForIds?.([id]))?.get(id);
    if (!row) return json({ error: 'Enrichment not found.' }, 404);
    const shadow = readArabicBuilderShadow(row.extraction_json);
    if (!shadow) return json({ error: 'Arabic Builder shadow metadata not found.' }, 404);
    return json(diagnostic(shadow, ctx.builtArabicNamesEnabled));
  }

  if (url.pathname === buildPath && request.method === 'POST') {
    let input;
    try {
      input = await request.json();
    } catch {
      return json({ error: 'Request body must be JSON.' }, 400);
    }
    const { arabicBuilder } = buildArabicShadow(input);
    return json(diagnostic(arabicBuilder, ctx.builtArabicNamesEnabled));
  }

  return json({ error: 'Method not allowed.' }, 405);
}
