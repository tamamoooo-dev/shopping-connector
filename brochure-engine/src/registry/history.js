// registry/history.js — Price History V2 (REGISTRY-DESIGN.md §7): the
// registry-substrate answer to "what is the best price this product has ever
// reached?" — points = SIGHTINGS, market-wide by construction (product ids
// are store-agnostic), no second bookkeeping path to drift out of sync.
//
// Served behind the SAME pipeline flag as /offers: /prices?pipeline=vision
// (or SEARCH_PIPELINE=vision) answers from here; the OCR default keeps V1
// (priceHistory.js) byte-identical. The doc SHAPE mirrors V1 exactly —
// variants, lowest/latest/trend, weeks — so the existing UI and the user's
// comparative evaluation work unchanged.
//
// Interpretation discipline (journey coherence, HISTORY §34): candidate
// products pass the SAME shared gate ladder (matching.js resolveJourneyPool,
// 'history' tier) over their display names that V1 identities pass — a
// store's history is never built from a product the Shopping Summary would
// exclude. What is V2-specific and declared here:
//   • retrieval is the registry's own §4.1 blocking (token index), not SQL
//     LIKE, and admission adds a query-token CONTAINMENT floor against the
//     token profile — the profile is richer identity evidence than any one
//     name string (§1.1);
//   • "weeks" counts DISTINCT SIGHTING WEEKS across all stores (a market-wide
//     fact), where V1 counted per-identity refresh weeks;
//   • per-product confidence (§4.3) rides on every variant (products,
//     stores, weeks) so consumers can render 1-sighting hypotheses
//     differently from 5-week facts.

import {
  matchStage, offerFamily, productType, resolveJourneyPool, querySize, sizeContradicts,
} from '../matching.js';
import { queryTokens, offerRelevance, relevanceScore } from '../offers/contract.js';
import { variantLabel } from '../priceHistory.js';
import { evidenceTokens } from './read.js';
import { distinctiveTokens, TUNING } from './resolver.js';
import { decodeProfile } from './model.js';

// Admission floor: the share of the query's evidence tokens the product's
// profile must contain. 0.6 is the measured containment workhorse (§7.3, P4)
// applied in the query direction: a two-token query demands both tokens.
const QUERY_CONTAINMENT_FLOOR = 0.6;

const emptyDoc = (query) => ({
  product: query,
  query,
  lowest: null,
  latest: [],
  variants: [],
  observations: 0,
  weeks: 0,
  firstSeen: null,
  lastUpdated: null,
});

// One product -> the candidate shape the shared gate ladder consumes
// ({ stage, family, type, text }), or null when relevance excludes it.
// Same prefilter V1 applies to identity rows (offerRelevance > 0), with the
// profile tokens as the haystack (the registry's analog of match_text).
function interpretProduct(p, q, tokens) {
  const pseudo = { name: p.display_name, nameAr: p.display_name_ar, category: p.category };
  const hay = Object.keys(decodeProfile(p.token_profile)).join(' ');
  const rel = offerRelevance(pseudo, tokens, hay);
  if (relevanceScore(rel) <= 0) return null;
  const names = `${p.display_name || ''} ${p.display_name_ar || ''}`;
  return {
    row: p,
    stage: matchStage({ name: names }, q),
    family: offerFamily(pseudo),
    type: productType(names),
    text: names,
  };
}

// The full price picture for a QUERY from the registry substrate.
export async function getRegistryPricesDoc(registryStore, q, { today } = {}) {
  const query = (q || '').trim();
  const empty = emptyDoc(query);
  if (!query || !registryStore) return empty;
  const evTokens = evidenceTokens(query);
  const lexTokens = queryTokens(query);
  if (!evTokens.length || !lexTokens.length) return empty;

  // BLOCK (§4.1, same primitives as the resolver): products sharing at least
  // one distinctive query token.
  const [productCount, freqs] = await Promise.all([
    registryStore.productCount(),
    registryStore.tokenFrequencies(evTokens),
  ]);
  const blockTokens = distinctiveTokens(evTokens, freqs, productCount, TUNING);
  const ids = blockTokens.length ? await registryStore.candidateIds(blockTokens) : [];
  if (!ids.length) return empty;

  // ADMIT: containment floor over the profile (the substrate-specific
  // precision gate), then the shared gate ladder over display names.
  const ranked = [];
  for (const p of await registryStore.getProducts(ids)) {
    if (p.status === 'merged') continue; // losers fold in via their sightings
    const profile = decodeProfile(p.token_profile);
    let hit = 0;
    for (const t of evTokens) if (profile[t]) hit += 1;
    if (hit / evTokens.length < QUERY_CONTAINMENT_FLOOR) continue;
    const cand = interpretProduct(p, query, lexTokens);
    if (cand) ranked.push(cand);
  }
  if (!ranked.length) return empty;
  let kept = resolveJourneyPool(ranked, query, 'history').kept.map((r) => r.row);

  // SIZE PRECISION — identical rule to V1: a query-named size excludes
  // products of a KNOWN different size; size-less products stay (statistics
  // refuse to guess). Registry sizes are per-each; contradiction is judged on
  // the grand total, the same figure V1 identities carry.
  const qSize = querySize(query);
  if (qSize) {
    kept = kept.filter(
      (p) =>
        p.size_unit == null ||
        !sizeContradicts(
          { unit: p.size_unit, total: (p.size_total || 0) * (p.size_pack || 1) },
          qSize,
        ),
    );
    if (!kept.length) return empty;
  }

  // POINTS = sightings of the kept products PLUS the products merged into
  // them (their sightings keep the original id — the read follows the
  // tombstones, §5.4 reversibility).
  const keptIds = kept.map((p) => p.id);
  const loserMap = await registryStore.mergedLoserIds(keptIds);
  const rows = await registryStore.sightingsForProducts([...keptIds, ...loserMap.keys()]);
  const productById = new Map(kept.map((p) => [p.id, p]));
  const sightings = rows.map((s) => ({
    ...s,
    // Fold merged losers' sightings into their survivor for bucketing.
    owner: productById.get(s.product_id) || productById.get(loserMap.get(s.product_id)) || null,
  })).filter((s) => s.owner);
  if (!sightings.length) return empty;

  const on = today || new Date().toISOString().slice(0, 10);

  // Variant buckets: sized products group by unit + grand total; unsized stay
  // apart — V1's exact bucketing, driven by the product row instead of the
  // identity row.
  const buckets = new Map();
  for (const p of kept) {
    const sized = p.size_unit != null && p.size_total != null;
    const key = sized ? `${p.size_unit}:${Math.round(p.size_total * (p.size_pack || 1))}` : 'unsized';
    let b = buckets.get(key);
    if (!b) {
      b = { key, products: [], sightings: [] };
      buckets.set(key, b);
    }
    b.products.push(p);
  }
  for (const s of sightings) {
    const p = s.owner;
    const sized = p.size_unit != null && p.size_total != null;
    const key = sized ? `${p.size_unit}:${Math.round(p.size_total * (p.size_pack || 1))}` : 'unsized';
    buckets.get(key)?.sightings.push(s);
  }

  const pointDoc = (s) => ({
    price: s.price,
    oldPrice: s.old_price ?? null,
    currency: s.o_currency || 'SAR',
    store: s.store,
    region: s.region,
    week: s.week,
    observedAt: s.resolved_at,
    name: s.owner.display_name || s.owner.display_name_ar || null,
    link: s.o_source_url || null,
  });

  const summarize = (products, sPoints) => {
    // Lowest ever; ties keep the earliest observation (first time at that low).
    let lowest = null;
    if (sPoints.length) {
      const best = sPoints
        .slice()
        .sort(
          (a, z) =>
            a.price - z.price ||
            String(a.week).localeCompare(String(z.week)) ||
            String(a.resolved_at).localeCompare(String(z.resolved_at)),
        )[0];
      lowest = pointDoc(best);
    }
    const highest = sPoints.length ? Math.max(...sPoints.map((s) => s.price)) : null;
    // Latest per store: prefer sightings whose offer is still valid, then the
    // most recent week, then the cheapest — V1's "best live/last price".
    const latestByStore = new Map();
    for (const s of sPoints) {
      const cur = latestByStore.get(s.store);
      const sCur = s.o_valid_to && s.o_valid_to >= on ? 1 : 0;
      const cCur = cur && cur.o_valid_to && cur.o_valid_to >= on ? 1 : 0;
      const better =
        !cur ||
        sCur - cCur > 0 ||
        (sCur === cCur &&
          (s.week > cur.week || (s.week === cur.week && s.price < cur.price)));
      if (better) latestByStore.set(s.store, s);
    }
    const latest = [...latestByStore.values()].map((s) => ({
      store: s.store,
      price: s.price,
      currency: s.o_currency || 'SAR',
      week: s.week,
      observedAt: s.week,
      current: !!(s.o_valid_to && s.o_valid_to >= on),
      name: s.owner.display_name || s.owner.display_name_ar || null,
      link: s.o_source_url || null,
    }));
    // Trend: best price of the latest observed week vs the week before it.
    const byWeek = new Map();
    for (const s of sPoints) {
      byWeek.set(s.week, Math.min(byWeek.get(s.week) ?? Infinity, s.price));
    }
    const weeksSorted = [...byWeek.keys()].sort();
    let trend = null;
    if (weeksSorted.length >= 2) {
      const last = byWeek.get(weeksSorted[weeksSorted.length - 1]);
      const prev = byWeek.get(weeksSorted[weeksSorted.length - 2]);
      trend = last < prev ? 'down' : last > prev ? 'up' : 'flat';
    }
    return {
      lowest,
      highest,
      latest,
      trend,
      observations: sPoints.length,
      weeks: byWeek.size, // market-wide distinct sighting weeks (V2 semantics)
      firstSeen: weeksSorted[0] || null,
      lastUpdated: weeksSorted[weeksSorted.length - 1] || null,
      products: products.length,
      // §4.3 per-product confidence, aggregated: consumers may render a
      // 1-sighting hypothesis differently from a 5-week 3-store fact.
      confidence: {
        sightings: sPoints.length,
        stores: new Set(sPoints.map((s) => s.store)).size,
        weeks: byWeek.size,
      },
    };
  };

  const variants = [...buckets.values()]
    .filter((b) => b.sightings.length)
    .map((b) => {
      const ref = b.products[0];
      const sized = b.key !== 'unsized';
      return {
        key: b.key,
        sizeUnit: sized ? ref.size_unit : null,
        sizeTotal: sized ? ref.size_total * (ref.size_pack || 1) : null,
        sizePack: sized ? ref.size_pack || 1 : 1,
        label: sized ? variantLabel(ref.size_unit, ref.size_total * (ref.size_pack || 1), ref.size_pack) : null,
        ...summarize(b.products, b.sightings),
      };
    });
  variants.sort(
    (a, z) =>
      (a.key === 'unsized' ? 1 : 0) - (z.key === 'unsized' ? 1 : 0) ||
      z.observations - a.observations ||
      (a.sizeTotal || 0) - (z.sizeTotal || 0),
  );

  const overall = summarize(kept, sightings);
  return {
    product: query,
    query,
    lowest: overall.lowest,
    latest: overall.latest,
    variants,
    observations: overall.observations,
    weeks: overall.weeks,
    firstSeen: overall.firstSeen,
    lastUpdated: overall.lastUpdated,
    trend: overall.trend,
  };
}
