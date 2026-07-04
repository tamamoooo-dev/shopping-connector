// priceHistory.js — CATALOG-WIDE Price History (Pillar 3), redesigned
// 2026-07-04. Price History is a trust feature: it answers "what is the best
// price this product has ever reached?" — for EVERY comparable product, with
// zero manual tagging.
//
// THE MODEL:
//   • Every structured flyer offer is a price observation. The weekly offers
//     ingest (18 stores, ~16k products) IS the automated, catalog-wide price
//     source — no watchlist, no per-product config.
//   • The aggregator's offer_id is per-flyer-extraction (verified in
//     production: the same product in two concurrent flyers carries two
//     different ids), so cross-week identity is DERIVED conservatively at
//     ingest time: store + region + normalized bilingual name + parsed size,
//     hashed. When the deriver can't trust a name (nameless or single-token
//     OCR debris) it records nothing — two products' histories must never mix.
//   • An identity SPLIT (the same product OCR-ing slightly differently in two
//     weeks) is harmless by design: the read API matches identities by QUERY
//     through the matching mirror and merges them per size/variant, so a split
//     only shortens one series — it never corrupts another.
//   • Storage is incremental: one identity row per product (refreshed in
//     place) plus a point row only on first sighting or a price CHANGE.
//   • Every statistic — lowest ever, highest, current, first seen, last
//     updated, trend — is derived from the recorded rows at read time.

import {
  normalizeText,
  parseSize,
  matchStage,
  queryFamily,
  offerFamily,
  productType,
  freshProduceIntent,
  isProcessedProduce,
  producePresence,
} from './matching.js';
import { queryTokens, offerRelevance, relevanceScore } from './offers/contract.js';
import { isoWeek } from './contract.js';

// --- identity derivation ------------------------------------------------------
// FNV-1a 64-bit — deterministic, cheap, and collision-safe at catalog scale
// (this is an identity key, not a security hash).
function fnv64(str) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

// Derive the conservative cross-week identity of an offer, or null when the
// name is too weak to trust (rule: never risk mixing two products' histories —
// a skipped offer just builds no history yet, which the UI communicates).
export function deriveIdentity(offer) {
  const matchText = normalizeText(`${offer.name || ''} ${offer.nameAr || ''}`);
  const tokens = matchText ? matchText.split(' ').filter(Boolean) : [];
  // A single-token name ("casc", "عرض") is not a trustworthy product identity.
  if (new Set(tokens).size < 2) return null;
  const sz = parseSize(`${offer.name || ''} ${offer.nameAr || ''}`, '');
  const sized = sz && sz.unit && sz.total != null;
  const sizeKey = sized ? `${sz.unit}:${Math.round(sz.total)}:${sz.pack || 1}` : 'nosize';
  return {
    id: `ph_${fnv64([offer.store, offer.region, matchText, sizeKey].join('|'))}`,
    matchText,
    sizeUnit: sized ? sz.unit : null,
    sizeTotal: sized ? sz.total : null,
    sizePack: sized ? sz.pack || 1 : null,
  };
}

// --- the ingest-time capture ----------------------------------------------------
// Runs inside each store's offers ingest, on the freshly built Offer objects
// (BEFORE any upsert can overwrite last week's row). D1-only work — it costs
// zero external subrequests. Idempotent: re-ingesting the same week converges.
export async function recordOfferHistory(historyStore, offers, { observedAt } = {}) {
  const report = { offers: (offers || []).length, identities: 0, points: 0, skipped: 0 };
  if (!historyStore || !offers || !offers.length) return report;
  const obs = observedAt || new Date().toISOString();
  const obsDate = obs.slice(0, 10);

  // Group by identity; several concurrent flyers may carry the same product,
  // so the run's representative observation is the BEST advertised price
  // (ties: the longest-valid flyer).
  const byId = new Map();
  for (const offer of offers) {
    const ident = deriveIdentity(offer);
    if (!ident) {
      report.skipped += 1;
      continue;
    }
    const prev = byId.get(ident.id);
    if (
      !prev ||
      offer.price < prev.offer.price ||
      (offer.price === prev.offer.price && String(offer.validTo || '') > String(prev.offer.validTo || ''))
    ) {
      byId.set(ident.id, { ident, offer });
    }
  }
  if (!byId.size) return report;

  const existing = new Map(
    (await historyStore.getByIds([...byId.keys()])).map((r) => [r.id, r]),
  );

  const identityRows = [];
  const points = [];
  for (const { ident, offer } of byId.values()) {
    const prior = existing.get(ident.id);
    const priceChanged = !prior || prior.last_price !== offer.price;
    identityRows.push({
      id: ident.id,
      store: offer.store,
      region: offer.region,
      name: offer.name ?? null,
      name_ar: offer.nameAr ?? null,
      match_text: ident.matchText,
      size_unit: ident.sizeUnit,
      size_total: ident.sizeTotal,
      size_pack: ident.sizePack,
      category: offer.category ?? null,
      image_url: offer.imageUrl ?? null,
      source_url: offer.sourceUrl ?? null,
      currency: offer.currency || 'SAR',
      // first_seen is preserved by the store on refresh (not in the UPDATE set).
      first_seen: prior ? prior.first_seen : obsDate,
      last_seen: obsDate,
      weeks_seen: prior
        ? prior.weeks_seen + (isoWeek(obsDate) !== isoWeek(prior.last_seen) ? 1 : 0)
        : 1,
      last_price: offer.price,
      last_valid_to: offer.validTo ?? null,
    });
    if (priceChanged) {
      points.push({
        identity: ident.id,
        // The validity week buckets the point; a re-ingest of the same window
        // with a corrected price REPLACES its point instead of duplicating.
        week: offer.validFrom || obsDate,
        price: offer.price,
        old_price: offer.oldPrice ?? null,
        observed_at: obs,
      });
    }
  }

  await historyStore.upsertIdentities(identityRows);
  if (points.length) await historyStore.insertPoints(points);
  report.identities = identityRows.length;
  report.points = points.length;
  return report;
}

// --- read shaping ----------------------------------------------------------------
// "n × 250 ml" / "1.5 L" — the human label for a variant bucket.
function variantLabel(unit, total, pack) {
  if (!unit || total == null) return null;
  if (unit === 'pcs') return `${Math.round(total)} pcs`;
  const p = pack || 1;
  const each = total / p;
  const bigUnit = unit === 'ml' ? 'L' : 'kg';
  const trim = (n) => Number(n.toFixed(2)).toString();
  const one = (v) => (v >= 1000 ? `${trim(v / 1000)} ${bigUnit}` : `${trim(v)} ${unit}`);
  return p > 1 ? `${p} × ${one(each)}` : one(total);
}

const pointDoc = (p, ident) => ({
  price: p.price,
  oldPrice: p.old_price ?? null,
  currency: ident.currency || 'SAR',
  store: ident.store,
  region: ident.region,
  week: p.week,
  observedAt: p.observed_at,
  name: ident.name || ident.name_ar || null,
  link: ident.source_url || null,
});

// Rank an identity for the query the way /offers ranks an offer: Search-
// Roadmap stage first (rule 9), then the query's own product family, with the
// fresh-produce demotions mirrored — the honesty layer that keeps a "lemon"
// history from absorbing "Clorox lemon" prices.
function rankIdentity(row, q, tokens, qFamily, freshFam) {
  const pseudo = { name: row.name, nameAr: row.name_ar, category: row.category };
  const rel = offerRelevance(pseudo, tokens, row.match_text || '');
  const score = relevanceScore(rel);
  if (score <= 0) return null;
  const names = `${row.name || ''} ${row.name_ar || ''}`;
  const fam = qFamily ? offerFamily(pseudo) : null;
  let famRank = !qFamily ? 1 : fam === qFamily ? 2 : fam ? 0 : 1;
  if (freshFam) {
    if (famRank === 2) {
      if (productType(names)) famRank = 0;
      else if (isProcessedProduce(names)) famRank = 1;
    } else if (famRank === 1 && producePresence(names, freshFam) === 'flavored') {
      famRank = 0;
    }
  }
  return { stage: matchStage({ name: names }, q), famRank, score };
}

// The full price picture for a QUERY — any query, the whole catalog. Matched
// identities are stage-gated (only the best match band feeds the statistics)
// and merged per size/variant, each variant carrying its own independent
// derived record: lowest ever (price/where/when), highest, latest per store,
// first seen, observation depth in weeks, and trend.
export async function getQueryPricesDoc(historyStore, q, { today } = {}) {
  const query = (q || '').trim();
  const empty = {
    product: query,
    query,
    lowest: null,
    latest: [],
    variants: [],
    observations: 0,
    weeks: 0,
    firstSeen: null,
    lastUpdated: null,
  };
  const tokens = queryTokens(query);
  if (!tokens.length || !historyStore) return empty;

  const rows = await historyStore.searchIdentities({ q: query, limit: 300 });
  const qFamily = queryFamily(query);
  const freshFam = freshProduceIntent(query);
  const ranked = [];
  for (const row of rows) {
    const rank = rankIdentity(row, query, tokens, qFamily, freshFam);
    if (rank) ranked.push({ row, ...rank });
  }
  if (!ranked.length) return empty;

  // The stage gate (rule 9): statistics only reason over the pool's best
  // match band — a flavour/ingredient look-alike is never averaged with the
  // product itself. Unlike the GRID (which sorts stage 5 above 4), history
  // statistics treat all PRIMARY stages as one band: stage 5 vs 4 is only
  // word position ("حليب المراعي" vs "المراعي حليب" are the same product),
  // and the famRank gate below already excludes the other-product-with-scent
  // class ("كلوروكس ليمون") that shares stage 4. Multi-word queries treat all
  // full-coverage stages (≥2) as one band, same as the Shopping Summary.
  const bestStage = Math.max(...ranked.map((r) => r.stage));
  const band = tokens.length > 1 ? 2 : 4;
  const inStage = ranked.filter((r) =>
    bestStage >= band ? r.stage >= band : r.stage === bestStage,
  );
  const bestFam = Math.max(...inStage.map((r) => r.famRank));
  const kept = inStage.filter((r) => r.famRank === bestFam).map((r) => r.row);

  const identById = new Map(kept.map((r) => [r.id, r]));
  const points = await historyStore.pointsForIdentities([...identById.keys()]);
  const on = today || new Date().toISOString().slice(0, 10);

  // Variant buckets: sized identities group by unit+total; unsized stay apart.
  const buckets = new Map();
  for (const r of kept) {
    const sized = r.size_unit && r.size_total != null;
    const key = sized ? `${r.size_unit}:${Math.round(r.size_total)}` : 'unsized';
    let b = buckets.get(key);
    if (!b) {
      b = { key, idents: [], points: [] };
      buckets.set(key, b);
    }
    b.idents.push(r);
  }
  for (const p of points) {
    const ident = identById.get(p.identity);
    if (!ident) continue;
    const sized = ident.size_unit && ident.size_total != null;
    const key = sized ? `${ident.size_unit}:${Math.round(ident.size_total)}` : 'unsized';
    buckets.get(key)?.points.push(p);
  }

  const summarize = (idents, pts) => {
    const docs = pts
      .map((p) => ({ p, ident: identById.get(p.identity) }))
      .filter((x) => x.ident);
    // Lowest ever; ties keep the earliest observation (first time at that low).
    let lowest = null;
    if (docs.length) {
      const best = docs
        .slice()
        .sort(
          (a, z) =>
            a.p.price - z.p.price ||
            String(a.p.observed_at).localeCompare(String(z.p.observed_at)),
        )[0];
      lowest = pointDoc(best.p, best.ident);
    }
    const highest = docs.length ? Math.max(...docs.map((x) => x.p.price)) : null;
    // Latest per store: prefer identities currently on offer, then the most
    // recently seen, then the cheapest — the store's best live/last price.
    const latestByStore = new Map();
    for (const r of idents) {
      const cur = latestByStore.get(r.store);
      const better =
        !cur ||
        (r.last_valid_to >= on ? 1 : 0) - (cur.last_valid_to >= on ? 1 : 0) > 0 ||
        ((r.last_valid_to >= on ? 1 : 0) === (cur.last_valid_to >= on ? 1 : 0) &&
          (r.last_seen > cur.last_seen ||
            (r.last_seen === cur.last_seen && r.last_price < cur.last_price)));
      if (better) latestByStore.set(r.store, r);
    }
    const latest = [...latestByStore.values()].map((r) => ({
      store: r.store,
      price: r.last_price,
      currency: r.currency || 'SAR',
      week: r.last_seen,
      observedAt: r.last_seen,
      current: !!(r.last_valid_to && r.last_valid_to >= on),
      name: r.name || r.name_ar || null,
      link: r.source_url || null,
    }));
    // Trend: the best price of the latest observed week vs the week before it.
    const byWeek = new Map();
    for (const x of docs) {
      const w = x.p.week;
      byWeek.set(w, Math.min(byWeek.get(w) ?? Infinity, x.p.price));
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
      observations: docs.length,
      weeks: idents.length ? Math.max(...idents.map((r) => r.weeks_seen || 1)) : 0,
      firstSeen: idents.length ? idents.map((r) => r.first_seen).sort()[0] : null,
      lastUpdated: idents.length ? idents.map((r) => r.last_seen).sort().pop() : null,
      products: idents.length,
    };
  };

  const variants = [...buckets.values()].map((b) => {
    const ref = b.idents[0];
    const sized = b.key !== 'unsized';
    return {
      key: b.key,
      sizeUnit: sized ? ref.size_unit : null,
      sizeTotal: sized ? ref.size_total : null,
      sizePack: sized ? ref.size_pack || 1 : 1,
      label: sized ? variantLabel(ref.size_unit, ref.size_total, ref.size_pack) : null,
      ...summarize(b.idents, b.points),
    };
  });
  variants.sort(
    (a, z) =>
      (a.key === 'unsized' ? 1 : 0) - (z.key === 'unsized' ? 1 : 0) ||
      z.observations - a.observations ||
      (a.sizeTotal || 0) - (z.sizeTotal || 0),
  );

  const overall = summarize(kept, points);
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

export async function getLowestDoc(historyStore, q, opts) {
  const doc = await getQueryPricesDoc(historyStore, q, opts);
  return doc.lowest;
}
