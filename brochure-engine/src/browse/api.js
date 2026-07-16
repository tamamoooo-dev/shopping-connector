// browse/api.js — the Browse read API's document builders (BROWSE-DESIGN.md
// §7). Pure orchestration over the browse store + canonical knowledge: no SQL
// here, no provider slugs past this point — the documents speak canonical
// department/aisle ids only. engine.js routes and JSON-wraps these.
//
//   getBrowseSummaryDoc(ctx, today)          -> the market floor (one payload)
//   getBrowseOffersDoc(ctx, params, today)   -> the universal listing
//
// Both are honest by construction: every card carries its flyer provenance
// (sourceUrl/pageRef) and derived badges whose formulas live in deals.js; the
// caller attaches the machine-extraction disclaimer.

import { DEPARTMENTS, AISLES, AISLE_BY_ID, OTHER_AISLE } from './taxonomy.js';
import {
  canonicalAisle, refineAisle, FRESH_TO_FROZEN, mappedCategories, PROVIDER_AISLES,
} from './mapping.js';
import { offerBadges } from './deals.js';
import { BRAND_BY_SLUG } from './brands.js';

// Browse V1.1 (2026-07-16): the homepage keeps only the rails that earn their
// place with real data — Biggest Drops and Lowest Ever. Exceptional Deals /
// Ending Soon / New This Week were removed as a product decision (trust over
// feature count); deals.js keeps the scoring pure & tested for when the
// substrate is deep enough to bring Exceptional Deals back.
const RAIL_IDS = ['drops', 'lowest-ever'];
const RAIL_SIZE = 12;

// --- cards ---------------------------------------------------------------------
// A Browse card: the offer contract's read projection plus canonical placement
// and derived badges. Mirrors rowToOffer's field naming so the frontend treats
// Browse cards and /offers cards identically.
function cardDoc(row, today) {
  const aisleId = refineAisle(canonicalAisle(row.source, row.category), row);
  const aisle = AISLE_BY_ID.get(aisleId);
  const brand = row.brand_slug ? BRAND_BY_SLUG.get(row.brand_slug) : null;
  return {
    brand: brand ? { slug: brand.slug, en: brand.en, ar: brand.ar } : null,
    id: row.id,
    store: row.store,
    region: row.region,
    source: row.source,
    offerId: row.offer_id,
    flyerRef: row.flyer_ref,
    pageRef: row.page_ref,
    edition: row.edition,
    name: row.name,
    nameAr: row.name_ar,
    price: row.price,
    oldPrice: row.old_price,
    currency: row.currency,
    imageUrl: row.image_url,
    sourceUrl: row.source_url,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    aisle: aisleId,
    dept: aisle ? aisle.dept : null,
    badges: offerBadges(row, today),
  };
}

// D4D lists branch/language variants of the SAME deal (and concurrent flyers
// repeat products): collapse to one card per real-world deal. The derived
// identity is the strongest key; nameless rows fall back to store+price+image.
function dedupeRows(rows) {
  const seen = new Map();
  for (const row of rows) {
    const key = row.identity
      ? `i:${row.store}:${row.identity}:${row.price}`
      : `f:${row.store}:${row.price}:${row.name || row.name_ar || row.image_url || row.id}`;
    const prev = seen.get(key);
    // Keep the longest-valid variant (the one that stays verifiable longest).
    if (!prev || String(row.valid_to || '') > String(prev.valid_to || '')) seen.set(key, row);
  }
  return [...seen.values()];
}

// --- canonical filter -> store prefilter -----------------------------------------
// Resolve dept/aisle params into the browse store's include/excludeMapped
// shape. Returns null for "no category narrowing".
//
// The fresh->frozen refinement is folded into the include groups so the SQL
// prefilter, the cards, and the tile counts all classify identically:
//   • a requested FRESH aisle with a frozen counterpart excludes rows whose
//     name says frozen (they belong to the counterpart);
//   • a requested FROZEN aisle additionally pulls the frozen-marked rows out
//     of its fresh counterpart categories.
function categoryFilter({ dept, aisle }) {
  let aisleIds = null;
  if (aisle) aisleIds = [aisle];
  else if (dept) aisleIds = AISLES.filter((a) => a.dept === dept).map((a) => a.id);
  if (!aisleIds) return null;
  if (aisleIds.includes(OTHER_AISLE)) {
    // `other` = everything a source does NOT map (incl. null categories).
    return {
      excludeMapped: Object.keys(PROVIDER_AISLES).map((source) => ({
        source,
        categories: mappedCategories(source),
      })),
    };
  }
  const wanted = new Set(aisleIds);
  const include = [];
  for (const [source, map] of Object.entries(PROVIDER_AISLES)) {
    const buckets = { plain: [], exclude: [], only: [] };
    for (const [cat, aisleId] of Object.entries(map)) {
      const frozen = FRESH_TO_FROZEN[aisleId];
      if (wanted.has(aisleId)) {
        if (frozen && !wanted.has(frozen)) buckets.exclude.push(cat);
        else buckets.plain.push(cat);
      } else if (frozen && wanted.has(frozen)) {
        buckets.only.push(cat);
      }
    }
    if (buckets.plain.length) include.push({ source, categories: buckets.plain });
    if (buckets.exclude.length) include.push({ source, categories: buckets.exclude, frozen: 'exclude' });
    if (buckets.only.length) include.push({ source, categories: buckets.only, frozen: 'only' });
  }
  return { include };
}

// --- rails ------------------------------------------------------------------------
// Two rails, both data-backed: Biggest Drops (SQL-sorted advertised cuts) and
// Lowest Ever (history-verified lows from the candidates pool). Every rail is
// deduped and finite.
const dropPct = (r) =>
  r.old_price > r.price ? (r.old_price - r.price) / r.old_price : 0;

const byDropThenPrice = (a, b) => dropPct(b) - dropPct(a) || a.price - b.price;

function lowestEverRows(pool, today) {
  return pool.filter((r) => offerBadges(r, today).lowestEver).sort(byDropThenPrice);
}

async function buildRails(ctx, today) {
  const store = ctx.browseStore;
  const [candidates, drops] = await Promise.all([
    store.candidates(today),
    store.list({ hasDrop: true, sort: 'discount', limit: 40, currentOn: today }),
  ]);

  const take = (rows) => rows.slice(0, RAIL_SIZE).map((r) => cardDoc(r, today));
  return [
    { id: 'drops', items: take(dedupeRows(drops)) },
    { id: 'lowest-ever', items: take(lowestEverRows(dedupeRows(candidates), today)) },
  ].filter((rail) => rail.items.length);
}

// --- the market floor ----------------------------------------------------------------
export async function getBrowseSummaryDoc(ctx, today) {
  const [counts, rails, totals, brandRows] = await Promise.all([
    ctx.browseStore.categoryCounts(today),
    buildRails(ctx, today),
    ctx.offerStore ? ctx.offerStore.counts(today) : null,
    ctx.browseStore.brandCounts ? ctx.browseStore.brandCounts(today) : [],
  ]);

  // Brands — the equal-peer entry point (BROWSE-DESIGN.md §4): every canonical
  // brand with live offers, best-covered first. Bounded by the knowledge base
  // (~100 entries), so the full list ships in the one summary payload.
  const brands = [];
  for (const row of brandRows) {
    const b = BRAND_BY_SLUG.get(row.brand_slug);
    if (b) brands.push({ slug: b.slug, en: b.en, ar: b.ar, offers: row.n, stores: row.stores });
  }

  // Fold provider-category counts through the canonical mapping (read time —
  // a mapping fix reshapes the tiles on the very next request). Frozen-marked
  // rows in a fresh category count toward the frozen counterpart aisle.
  const byAisle = new Map();
  for (const c of counts) {
    let aisle = canonicalAisle(c.source, c.category);
    if (c.frozen_marked && FRESH_TO_FROZEN[aisle]) aisle = FRESH_TO_FROZEN[aisle];
    byAisle.set(aisle, (byAisle.get(aisle) || 0) + c.n);
  }
  const departments = DEPARTMENTS.map((dept) => {
    const aisles = AISLES.filter((a) => a.dept === dept.id)
      .map((a) => ({ id: a.id, en: a.en, ar: a.ar, offers: byAisle.get(a.id) || 0 }))
      .filter((a) => a.offers > 0);
    return {
      id: dept.id,
      en: dept.en,
      ar: dept.ar,
      offers: aisles.reduce((n, a) => n + a.offers, 0),
      aisles,
    };
  }).filter((d) => d.offers > 0);

  return {
    asOf: new Date().toISOString(),
    totals: totals ? { offers: totals.current, stores: totals.stores } : null,
    departments,
    brands,
    rails,
  };
}

// --- the universal listing --------------------------------------------------------------
// params: { dept?, aisle?, store?, rail?, sort?, limit?, offset? } — canonical
// ids only; unknown ids yield an explicit error, never a silent empty page.
export async function getBrowseOffersDoc(ctx, params, today) {
  const { dept, aisle, store, rail, brand } = params;
  const limit = Math.max(1, Math.min(Number(params.limit) || 60, 120));
  const offset = Math.max(0, Number(params.offset) || 0);

  if (dept && !DEPARTMENTS.some((d) => d.id === dept)) {
    return { error: `Unknown department '${dept}'.` };
  }
  if (aisle && !AISLE_BY_ID.has(aisle)) return { error: `Unknown aisle '${aisle}'.` };
  if (rail && !RAIL_IDS.includes(rail)) return { error: `Unknown rail '${rail}'.` };
  if (brand && !BRAND_BY_SLUG.has(brand)) return { error: `Unknown brand '${brand}'.` };

  // Rail "see all": reproduce the rail's population, paged.
  if (rail) {
    let rows;
    if (rail === 'drops') {
      rows = dedupeRows(
        await ctx.browseStore.list({
          hasDrop: true, sort: 'discount', store, brand, limit: 120, offset, currentOn: today,
        }),
      );
    } else {
      // lowest-ever: history-verified lows from the candidates pool.
      const pool = dedupeRows(await ctx.browseStore.candidates(today)).filter(
        (r) => (!store || r.store === store) && (!brand || r.brand_slug === brand),
      );
      rows = lowestEverRows(pool, today).slice(offset, offset + limit);
    }
    return { count: rows.length, offers: rows.slice(0, limit).map((r) => cardDoc(r, today)) };
  }

  const filter = categoryFilter({ dept, aisle }) || {};
  const rows = await ctx.browseStore.list({
    ...filter,
    store,
    brand,
    sort: params.sort,
    limit,
    offset,
    currentOn: today,
  });
  const cards = dedupeRows(rows).map((r) => cardDoc(r, today));
  const doc = { count: cards.length, offers: cards };

  // Brand pages get their identity + product families on the first page: the
  // brand's live offers folded per canonical aisle (same fold as the market
  // floor), so the page can present the brand's structure, not just a list.
  if (brand && offset === 0 && ctx.browseStore.brandFacets) {
    const b = BRAND_BY_SLUG.get(brand);
    doc.brand = { slug: b.slug, en: b.en, ar: b.ar };
    const facetRows = await ctx.browseStore.brandFacets(brand, today);
    const byAisle = new Map();
    for (const f of facetRows) {
      let aisleId = canonicalAisle(f.source, f.category);
      if (f.frozen_marked && FRESH_TO_FROZEN[aisleId]) aisleId = FRESH_TO_FROZEN[aisleId];
      byAisle.set(aisleId, (byAisle.get(aisleId) || 0) + f.n);
    }
    doc.families = [...byAisle]
      .sort((x, y) => y[1] - x[1])
      .map(([id, offers]) => {
        const a = AISLE_BY_ID.get(id);
        return { id, en: a.en, ar: a.ar, dept: a.dept, offers };
      });
  }
  return doc;
}
