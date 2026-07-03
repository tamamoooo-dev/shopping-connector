// priceHistory.js — Price History (Pillar 3) as a FEATURE of the Brochure
// Engine. Store-agnostic by construction: it knows nothing about any specific
// store; store knowledge lives in the pure-config watchlist (products.js) and,
// for the price number, in the search connector's own providers.
//
// THE MODEL (approved 2026-07-02):
//   • Brochures are the backbone of the history. A price point is ANCHORED to a
//     store's current brochure edition — the edition is the "when" (weekly
//     bucket) and the store is the "where". The Brochure Engine already retains
//     editions as history (§8), so those editions ARE the price-history skeleton.
//   • The price NUMBER is the current market price from the search connector —
//     the only automated price source (brochure images would need OCR, which is
//     out of scope). It is captured ONCE PER BROCHURE EDITION (weekly, on the
//     existing brochure cron), never as a daily search-driven time-series.
//   • "Lowest historical price, where, when" = MIN(price) over the edition-
//     anchored points, carrying that point's store (where) and edition/observed
//     time (when). Derived on read — no projection table (kept simple).

import { parseSize } from './matching.js';

// --- contract ---------------------------------------------------------------
// PricePoint: { id, product, store, region, edition, price, currency, name,
//               link, observedAt }
export function buildPricePoint(partial) {
  const product = req(partial.product, 'product');
  const store = req(partial.store, 'store');
  const region = req(partial.region, 'region');
  const edition = req(partial.edition, 'edition');
  const price = Number(partial.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`PricePoint invalid price '${partial.price}'`);
  }
  return {
    id: `${product}:${store}:${edition}`,
    product,
    store,
    region,
    edition,
    price,
    currency: partial.currency || 'SAR',
    name: partial.name ?? null,
    link: partial.link ?? null,
    observedAt: partial.observedAt || new Date().toISOString(),
  };
}

// Normalize either a camelCase point (memory store) or a snake_case D1 row into
// the read-API doc shape.
export function pointToDoc(r) {
  if (!r) return null;
  return {
    id: r.id,
    product: r.product,
    store: r.store,
    region: r.region,
    edition: r.edition,
    price: r.price,
    currency: r.currency ?? null,
    name: r.name ?? null,
    link: r.link ?? null,
    observedAt: r.observedAt ?? r.observed_at ?? null,
  };
}

// --- picking the price from a search result set ------------------------------
// The best-ranked result that carries a usable numeric price. Providers return
// results best-first (relevance), so this is the representative current price
// for the query at that store. We deliberately do NOT cherry-pick the cheapest
// result per run (that could grab an irrelevant cheap item) — the LOWEST is a
// temporal minimum across editions, not a per-run trick.
export function pickPricedResult(results) {
  if (!Array.isArray(results)) return null;
  for (const r of results) {
    const price = Number(r.price);
    if (Number.isFinite(price) && price > 0) {
      return {
        price,
        currency: r.currency || 'SAR',
        name: (r.name || '').trim() || null,
        link: r.link || null,
      };
    }
  }
  return null;
}

// --- the weekly capture (runs on the existing brochure cron) -----------------
// For each tracked product's store entries: find that store's CURRENT brochure
// edition (skip stores with no brochure — the history is brochure-anchored),
// fetch the current price via the search connector, and record ONE point per
// product+store+edition (idempotent via the unique index).
//
// ctx = { metadataStore, priceStore }.  searchClient.search(provider, q) -> results[].
export async function recordPrices(ctx, { products, searchClient }) {
  const report = {
    startedAt: new Date().toISOString(),
    recorded: 0,
    deduped: 0,
    skipped: 0,
    failed: 0,
    points: [],
    errors: [],
  };
  if (!searchClient) {
    report.errors.push('no search client (CONNECTOR service binding missing)');
    report.finishedAt = new Date().toISOString();
    return report;
  }

  for (const product of products || []) {
    for (const entry of product.stores || []) {
      const where = `${product.id}@${entry.brochureStore}/${entry.region}`;
      try {
        // 1. Anchor to the store's current brochure edition (the "when"/"where").
        // A store may hold several concurrent current flyers; anchor to the
        // PRIMARY weekly edition (a plain "YYYY-Wnn" — concurrent siblings
        // carry a variant suffix), newest week first.
        const current = await ctx.metadataStore.getCurrent(entry.brochureStore, entry.region);
        if (!current.length) {
          report.skipped += 1; // no brochure to anchor to yet
          continue;
        }
        const primary = [...current].sort((a, b) => {
          const plain = (r) => (/^\d{4}-W\d{2}$/.test(r.edition) ? 1 : 0);
          return plain(b) - plain(a) || b.edition.localeCompare(a.edition);
        })[0];
        const edition = primary.edition;

        // 2. Current market price via the search connector (the number only).
        const results = await searchClient.search(entry.searchProvider, product.query);
        const priced = pickPricedResult(results);
        if (!priced) {
          report.skipped += 1; // store returned no usable price this week
          continue;
        }

        // 3. Record one edition-anchored point (idempotent).
        const point = buildPricePoint({
          product: product.id,
          store: entry.brochureStore,
          region: entry.region,
          edition,
          price: priced.price,
          currency: priced.currency,
          name: priced.name,
          link: priced.link,
        });
        const { status } = await ctx.priceStore.record(point);
        report[status === 'new' ? 'recorded' : 'deduped'] += 1;
        report.points.push({ ...point, status });
      } catch (err) {
        report.failed += 1;
        report.errors.push(`${where}: ${err.message}`);
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

// --- read shaping ------------------------------------------------------------
export async function getLowestDoc(priceStore, product) {
  return pointToDoc(await priceStore.getLowest(product));
}

export async function getHistoryDoc(priceStore, product) {
  const rows = await priceStore.getHistory(product);
  return rows.map(pointToDoc);
}

// --- per-size/variant history ------------------------------------------------
// A single product-wide MIN is misleading: a 6-egg pack at 5 SAR and a 30-egg
// tray at 18 SAR are DIFFERENT products, so one lowest-ever number mixes them.
// We bucket the edition-anchored points by their PARSED SIZE and derive an
// independent lowest-ever (price/where/when) + latest-per-store for each. Points
// whose name carries no parseable size fall into the 'unsized' bucket, kept
// separate so a real size's record is never contaminated by an unsized one.
function variantLabel(sz) {
  if (!sz || !sz.unit || sz.total == null) return null;
  if (sz.unit === 'pcs') return `${sz.total} pcs`;
  const bigUnit = sz.unit === 'ml' ? 'L' : 'kg';
  const trim = (n) => Number(n.toFixed(2)).toString();
  const each = sz.each >= 1000 ? `${trim(sz.each / 1000)} ${bigUnit}` : `${trim(sz.each)} ${sz.unit}`;
  if (sz.pack > 1) return `${sz.pack} × ${each}`;
  return sz.total >= 1000 ? `${trim(sz.total / 1000)} ${bigUnit}` : `${trim(sz.total)} ${sz.unit}`;
}

function variantOf(point) {
  const sz = parseSize(point.name || '', '');
  if (!sz || !sz.unit || sz.total == null) {
    return { key: 'unsized', sizeUnit: null, sizeTotal: null, sizePack: 1, label: null };
  }
  return {
    key: `${sz.unit}:${Math.round(sz.total)}`,
    sizeUnit: sz.unit,
    sizeTotal: sz.total,
    sizePack: sz.pack || 1,
    label: variantLabel(sz),
  };
}

// Group point docs (edition-DESC) into per-variant records, each carrying its
// own lowest-ever and latest-per-store snapshot. Sized variants first (most
// observations, then smallest size); the 'unsized' bucket last.
export function groupVariants(history) {
  const buckets = new Map();
  for (const p of history) {
    const v = variantOf(p);
    let b = buckets.get(v.key);
    if (!b) {
      b = { ...v, points: [] };
      buckets.set(v.key, b);
    }
    b.points.push(p);
  }
  const variants = [];
  for (const b of buckets.values()) {
    // Lowest price; ties keep the earliest observation (first time it hit that low).
    const lowest = b.points
      .slice()
      .sort((a, z) => a.price - z.price || String(a.observedAt).localeCompare(String(z.observedAt)))[0];
    // Latest per store (points arrive edition-DESC, so first seen per store wins).
    const latestByStore = {};
    for (const p of b.points) if (!latestByStore[p.store]) latestByStore[p.store] = p;
    variants.push({
      key: b.key,
      sizeUnit: b.sizeUnit,
      sizeTotal: b.sizeTotal,
      sizePack: b.sizePack,
      label: b.label,
      lowest,
      latest: Object.values(latestByStore),
      observations: b.points.length,
    });
  }
  variants.sort(
    (a, z) =>
      (a.key === 'unsized' ? 1 : 0) - (z.key === 'unsized' ? 1 : 0) ||
      z.observations - a.observations ||
      (a.sizeTotal || 0) - (z.sizeTotal || 0),
  );
  return variants;
}

// Everything a shopper wants at a glance: the headline lowest-ever (price, where,
// when) plus the latest observed price per store, AND a per-size/variant
// breakdown (each size keeps its own independent lowest-ever record).
export async function getPricesDoc(priceStore, product) {
  const history = (await priceStore.getHistory(product)).map(pointToDoc);
  const latestByStore = {};
  for (const p of history) {
    // history is edition-DESC, so the first seen per store is the latest.
    if (!latestByStore[p.store]) latestByStore[p.store] = p;
  }
  return {
    product,
    lowest: pointToDoc(await priceStore.getLowest(product)),
    latest: Object.values(latestByStore),
    variants: groupVariants(history),
    observations: history.length,
  };
}

// --- search-connector clients (reuse of the Search engine) -------------------
// Production: a CONNECTOR service binding to the deployed shopping-connector
// Worker (same account, Free plan, $0). Used ONLY to read the current price —
// the connector stays the single source of live prices.
export function createServiceBindingSearchClient({
  connector,
  origin = 'https://shopping-connector.internal',
}) {
  if (!connector || typeof connector.fetch !== 'function') {
    throw new Error('price history: a CONNECTOR service binding (env.CONNECTOR) is required');
  }
  return {
    async search(provider, query) {
      const res = await connector.fetch(
        `${origin}/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query)}`,
      );
      if (!res.ok) throw new Error(`search ${provider} -> HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return body.results || [];
    },
  };
}

// Dev/optional: hit a connector base URL over HTTP (e.g. the local connector or
// the production URL). Same interface as the service-binding client.
export function createHttpSearchClient(base) {
  const root = base.replace(/\/$/, '');
  return {
    async search(provider, query) {
      const res = await fetch(
        `${root}/search?provider=${encodeURIComponent(provider)}&q=${encodeURIComponent(query)}`,
      );
      if (!res.ok) throw new Error(`search ${provider} -> HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return body.results || [];
    },
  };
}

function req(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`PricePoint missing required field '${name}'`);
  }
  return value;
}
