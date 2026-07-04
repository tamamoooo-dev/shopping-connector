// engine.js — the Brochure Engine Core / framework (ARCHITECTURE.md §3, §6, §8).
//
// The stateful sibling of the search connector's connector.js. It knows NOTHING
// about any store. It:
//   1. handles CORS (a static GitHub Pages frontend calls the read API),
//   2. routes read requests (health, /brochures, /brochures/history, /asset),
//   3. runs the guarded write path (POST /ingest) and the Cron ingest,
//   4. dispatches to providers, running each provider's collectors best-first
//      (exactly like the connector's runProvider), and hands candidates to the
//      idempotent pipeline.
//
// Provider contract (the brochure analogue of the search provider):
//   { id, label, regions: { <canonicalRegion>: <regionConfig> },
//     strategies: [ { name, collect(ctx) -> Promise<Candidate[]> } ] }

import { rowToDoc } from './contract.js';
import { recordPrices, getLowestDoc, getHistoryDoc, getPricesDoc } from './priceHistory.js';
import { ingestOffers } from './offers/ingest.js';
import { rowToOffer, offerRelevance, queryTokens, relevanceScore } from './offers/contract.js';
import { queryFamily, offerFamily, productType, freshProduceIntent, isProcessedProduce, producePresence, matchStage } from './matching.js';
import { pruneStoredBytes } from './retention.js';
import { buildWatch, checkWatches, MAX_WATCHES } from './monitor.js';
import { getHotspotsDoc } from './hotspots.js';

// The honesty disclaimer every offers read carries (the aggregator machine-
// extracts prices from flyer images; the flyer prevails on any mismatch).
const OFFERS_NOTE =
  'Prices are machine-extracted from flyer images by the aggregator; the flyer itself prevails on any mismatch. Each offer links to its flyer page.';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Secret',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

// --- write path: run a provider's collectors best-first (mirrors runProvider) -
// The first collector that yields candidates wins; failures are collected and
// non-fatal, so a later fallback collector (e.g. aggregator, a future milestone)
// still gets its turn. For M1 each provider declares a single [pdfIndex].
async function collectBestFirst(ctx, provider, region) {
  const regionConfig = provider.regions[region];
  // Lets a collector skip re-downloading a brochure the engine already holds
  // (matched by its source URL) — it stays store-agnostic; the collector only
  // sees "is this sourceUrl already held for my store+region?".
  const findHeld = (sourceUrl) =>
    sourceUrl && ctx.metadataStore.getBySourceUrl
      ? ctx.metadataStore.getBySourceUrl(provider.id, region, sourceUrl)
      : null;
  const failures = [];
  for (const strategy of provider.strategies) {
    try {
      const candidates = await strategy.collect({ store: provider.id, region, regionConfig, findHeld });
      if (candidates && candidates.length) return { collector: strategy.name, candidates };
      failures.push(`${strategy.name}: no brochure`);
    } catch (err) {
      failures.push(`${strategy.name}: ${err.message}`);
    }
  }
  const error = new Error(`No collector produced a brochure for ${provider.id}/${region}`);
  error.failures = failures;
  throw error;
}

// Ingest one (provider, region): collect best-first, then persist each candidate
// idempotently. Returns a per-target report line.
async function ingestTarget(ctx, provider, region) {
  const line = { store: provider.id, region, detected: 0, new: 0, deduped: 0, failed: 0, errors: [] };
  let collected;
  try {
    collected = await collectBestFirst(ctx, provider, region);
  } catch (err) {
    line.failed = 1;
    line.errors = err.failures || [err.message];
    return line;
  }
  // A store may hold SEVERAL current brochures at once (concurrent flyers), so
  // "current" is set per RUN, not per row: everything this run confirmed (new,
  // deduped, or already-held `existing`) is current; anything else for this
  // store+region is superseded — but only when nothing failed, so a partial
  // run never un-currents brochures it couldn't confirm.
  const confirmed = [];
  for (const candidate of collected.candidates) {
    line.detected += 1;
    if (candidate.existing) {
      line.deduped += 1;
      confirmed.push(candidate.existing.checksum);
      continue;
    }
    try {
      const { status, doc } = await ctx.pipeline.ingest(candidate);
      line[status === 'new' ? 'new' : 'deduped'] += 1;
      if (doc && doc.checksum) confirmed.push(doc.checksum);
    } catch (err) {
      line.failed += 1;
      line.errors.push(err.message);
    }
  }
  if (confirmed.length && ctx.metadataStore.setCurrent) {
    await ctx.metadataStore.setCurrent(provider.id, region, confirmed, {
      supersedeOthers: line.failed === 0,
    });
  }
  return line;
}

// Ingest every provider/region in the registry (the Cron entry point, §6.1).
export async function ingestAll(ctx, { store } = {}) {
  const providers = store ? [ctx.registry[store]].filter(Boolean) : Object.values(ctx.registry);
  const report = { startedAt: new Date().toISOString(), targets: [] };
  for (const provider of providers) {
    for (const region of Object.keys(provider.regions)) {
      report.targets.push(await ingestTarget(ctx, provider, region));
    }
  }
  report.finishedAt = new Date().toISOString();
  report.totals = report.targets.reduce(
    (t, l) => ({
      detected: t.detected + l.detected,
      new: t.new + l.new,
      deduped: t.deduped + l.deduped,
      failed: t.failed + l.failed,
    }),
    { detected: 0, new: 0, deduped: 0, failed: 0 },
  );
  return report;
}

// --- HTTP router -------------------------------------------------------------
// ctx = { registry, objectStore, metadataStore, pipeline, ingestSecret }
export async function handleRequest(request, ctx) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(request.url);
  const path = url.pathname;

  // Health / discovery (§8).
  if (path === '/' || path === '/health') {
    const held = (await ctx.metadataStore.listCurrent()).map((r) => ({
      store: r.store,
      region: r.region,
      edition: r.edition,
      detectedAt: r.detected_at,
    }));
    return json({
      service: 'brochure-engine',
      status: 'ok',
      stateful: true,
      providers: Object.keys(ctx.registry),
      held,
      offers: ctx.offerStore ? await ctx.offerStore.counts(todayISO()) : null,
      watches: ctx.watchStore
        ? { active: await ctx.watchStore.count(), unseenAlerts: await ctx.watchStore.countUnseen() }
        : null,
      priceHistory: {
        products: (ctx.products || []).map((p) => p.id),
        tracked: ctx.priceStore ? await ctx.priceStore.listProducts() : [],
      },
      usage:
        '/brochures?store=<id>&region=<key>  ·  /offers?q=<query>  ·  /prices?product=<id>',
    });
  }

  // Structured flyer offers — the price-comparison substrate (§8). Current by
  // default (validity contains today); `q` is a normalized token-AND search
  // over the offer's OCR text, ranked by the Search Roadmap stage first.
  if (path === '/offers' && request.method === 'GET') {
    if (!ctx.offerStore) return json({ error: 'Offers unavailable.' }, 503);
    const q = (url.searchParams.get('q') || '').trim();
    const store = (url.searchParams.get('store') || '').trim();
    const region = (url.searchParams.get('region') || '').trim();
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 60, 200));
    if (store && !ctx.registry[store]) return json({ error: `Unknown store '${store}'.` }, 404);

    const rows = await ctx.offerStore.search({
      q,
      store,
      region,
      currentOn: todayISO(),
      // Over-fetch when searching so the name-first re-rank has material —
      // floor of 120 so a small `limit` never shrinks the candidate window
      // (the JS relevance filter needs slack to drop prefilter noise).
      limit: q ? Math.min(Math.max(limit * 3, 120), 300) : limit,
    });
    const tokens = queryTokens(q);
    const qFamily = q ? queryFamily(q) : null;
    const freshFam = q ? freshProduceIntent(q) : null;
    const scored = rows
      .map((r) => {
        const offer = rowToOffer(r);
        const rel = offerRelevance(offer, tokens, r.search_text || '');
        // Family tier: when the query names a product family ("بيض" -> eggs),
        // offers OF that family outrank derived look-alikes (an egg-pastry is
        // pastry, not eggs); family-less offers sit between. The offer's own
        // aggregator category backs up a debris-named offer (name-first).
        const fam = qFamily ? offerFamily(offer) : null;
        let famRank = !qFamily ? 1 : fam === qFamily ? 2 : fam ? 0 : 1;
        // A bare produce query means FRESH: a same-family offer with a FORM
        // word ("رول فراولة") drops to the bottom tier, a processed one
        // (frozen/canned/peeled) to the middle, and a family-less offer that
        // mentions the produce only as a FLAVOUR ("مصاصات بالفراولة") drops
        // to the bottom — mirrors the frontend grid and comparison gates.
        if (freshFam) {
          const text = `${offer.name || ''} ${offer.nameAr || ''}`;
          if (famRank === 2) {
            if (productType(text)) famRank = 0;
            else if (isProcessedProduce(text)) famRank = 1;
          } else if (famRank === 1 && producePresence(text, freshFam) === 'flavored') {
            famRank = 0;
          }
        }
        // The Search Roadmap stage over the offer's bilingual NAME — the
        // primary sort key. Deterministic: a primary product-name match
        // always precedes flavour/ingredient look-alikes (single word) and
        // full-coverage matches always precede offers missing a query term
        // (multi word); famRank/score/price only order within a stage. It
        // subsumes the old name-tier key: any stage ≥1 is a name match, and
        // OCR-text-only matches (stage 0) stay ranked last as before.
        const stage = q ? matchStage({ name: `${offer.name || ''} ${offer.nameAr || ''}` }, q) : 0;
        return { offer, stage, score: relevanceScore(rel), famRank };
      })
      .filter((s) => s.score > 0);
    // Roadmap stage first; within a stage the query's own product family
    // first, then the strongest match (whole-word beats prefix, compound
    // look-alikes are demoted), then cheapest first.
    scored.sort(
      (a, b) =>
        b.stage - a.stage ||
        b.famRank - a.famRank ||
        b.score - a.score ||
        a.offer.price - b.offer.price,
    );
    const offers = scored.slice(0, limit).map((s) => s.offer);
    return json({ query: q || null, count: offers.length, note: OFFERS_NOTE, offers });
  }

  // Per-product tap targets for a held brochure's pages (see hotspots.js):
  // parsed once from the flyer source, cached in KV, joined to the flyer's
  // offers rows so one call powers the whole tappable-brochure experience.
  if (path === '/brochures/hotspots' && request.method === 'GET') {
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return json({ error: "Missing required parameter 'id'." }, 400);
    const { status, doc } = await getHotspotsDoc(ctx, id, { rowToOffer });
    if (doc && doc.offers) doc.note = OFFERS_NOTE;
    return json(doc, status, { 'Cache-Control': 'public, max-age=3600' });
  }

  // Current brochures (§8). Omit store -> all current (a "this week's flyers" grid).
  if (path === '/brochures' && request.method === 'GET') {
    const store = (url.searchParams.get('store') || '').trim();
    const region = (url.searchParams.get('region') || '').trim();
    let rows;
    if (!store) rows = await ctx.metadataStore.listCurrent();
    else if (!region) return json({ error: "Missing required parameter 'region'." }, 400);
    else rows = await ctx.metadataStore.getCurrent(store, region);
    if (store && region && rows.length === 0) {
      if (!ctx.registry[store]) return json({ error: `Unknown store '${store}'.` }, 404);
    }
    return json({ count: rows.length, brochures: rows.map(rowToDoc) });
  }

  // History — prior editions retained for Pillar 3 (§8).
  if (path === '/brochures/history' && request.method === 'GET') {
    const store = (url.searchParams.get('store') || '').trim();
    const region = (url.searchParams.get('region') || '').trim();
    if (!store || !region) return json({ error: "Missing 'store' and 'region'." }, 400);
    if (!ctx.registry[store]) return json({ error: `Unknown store '${store}'.` }, 404);
    const rows = await ctx.metadataStore.getHistory(store, region);
    return json({ count: rows.length, brochures: rows.map(rowToDoc) });
  }

  // Asset streaming — serve the stored PDF/meta bytes from the object store (§8).
  if (path.startsWith('/asset/') && request.method === 'GET') {
    const key = decodeURIComponent(path.slice('/asset/'.length));
    const obj = await ctx.objectStore.get(key);
    if (!obj) return json({ error: 'Asset not found' }, 404);
    return new Response(obj.bytes, {
      status: 200,
      headers: { 'Content-Type': obj.contentType, 'Cache-Control': 'public, max-age=3600', ...CORS },
    });
  }

  // --- Price History (Pillar 3) read API -------------------------------------
  // Lows are derived from the brochure-edition-anchored price points (§ priceHistory).
  const productParam = () => (url.searchParams.get('product') || '').trim();

  // Headline: lowest historical price + where (store) + when (edition/observedAt).
  if (path === '/lowest' && request.method === 'GET') {
    const product = productParam();
    if (!product) return json({ error: "Missing required parameter 'product'." }, 400);
    if (!ctx.priceStore) return json({ error: 'Price history unavailable.' }, 503);
    return json({ product, lowest: await getLowestDoc(ctx.priceStore, product) });
  }

  // Full picture: lowest-ever + latest price per store.
  if (path === '/prices' && request.method === 'GET') {
    const product = productParam();
    if (!product) return json({ error: "Missing required parameter 'product'." }, 400);
    if (!ctx.priceStore) return json({ error: 'Price history unavailable.' }, 503);
    return json(await getPricesDoc(ctx.priceStore, product));
  }

  // The time series itself — the Pillar 3 substrate.
  if (path === '/prices/history' && request.method === 'GET') {
    const product = productParam();
    if (!product) return json({ error: "Missing required parameter 'product'." }, 400);
    if (!ctx.priceStore) return json({ error: 'Price history unavailable.' }, 503);
    const points = await getHistoryDoc(ctx.priceStore, product);
    return json({ product, count: points.length, points });
  }

  // --- Price Monitoring (Personal Alerts) -------------------------------------
  // Watches + alerts (see monitor.js). Reads and user writes are open like the
  // rest of the personal tool's API, but writes are strictly validated and
  // capped (MAX_WATCHES); the check runner stays secret-guarded because it
  // spends the subrequest budget.

  // The watch list with its current state, plus the unseen-alert count (the
  // frontend's badge). One call paints the whole Alerts page.
  if (path === '/watches' && request.method === 'GET') {
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    const watches = await ctx.watchStore.list();
    return json({
      count: watches.length,
      max: MAX_WATCHES,
      unseenAlerts: await ctx.watchStore.countUnseen(),
      watches,
    });
  }

  // Create a watch. Validation + the active-watch cap live in buildWatch/here.
  if (path === '/watches' && request.method === 'POST') {
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be JSON.' }, 400);
    }
    const { watch, error } = buildWatch(body);
    if (error) return json({ error }, 400);
    if ((await ctx.watchStore.count()) >= MAX_WATCHES) {
      return json({ error: `Watch limit reached (${MAX_WATCHES}). Delete one first.` }, 409);
    }
    await ctx.watchStore.create(watch);
    return json({ watch }, 201);
  }

  // Delete a watch (and its alerts).
  if (path === '/watches' && request.method === 'DELETE') {
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return json({ error: "Missing required parameter 'id'." }, 400);
    const removed = await ctx.watchStore.remove(id);
    return removed ? json({ removed: id }) : json({ error: 'Watch not found.' }, 404);
  }

  // Recent alerts (newest first). `unseen=1` narrows to unread ones.
  if (path === '/alerts' && request.method === 'GET') {
    if (!ctx.watchStore) return json({ error: 'Alerts unavailable.' }, 503);
    const unseenOnly = url.searchParams.get('unseen') === '1';
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 200));
    const alerts = await ctx.watchStore.listAlerts({ limit, unseenOnly });
    return json({ count: alerts.length, unseen: await ctx.watchStore.countUnseen(), alerts });
  }

  // Mark all alerts read (the Alerts page calls this when viewed).
  if (path === '/alerts/seen' && request.method === 'POST') {
    if (!ctx.watchStore) return json({ error: 'Alerts unavailable.' }, 503);
    return json({ marked: await ctx.watchStore.markAlertsSeen() });
  }

  // Guarded check runner — evaluates watches NOW. The daily cron fans out to
  // this route in batches (?ids=a,b,c) so each batch gets its own subrequest
  // budget; a bare call checks every active watch (manual/backfill).
  if (path === '/watches/check' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    const idsParam = (url.searchParams.get('ids') || '').trim();
    const ids = idsParam ? idsParam.split(',').map((s) => s.trim()).filter(Boolean) : null;
    return json(await checkWatches(ctx, { ids }));
  }

  // Guarded manual capture — for testing/backfill without the cron. Same secret
  // as /ingest; the cron calls recordPrices directly (see index.js scheduled()).
  if (path === '/prices/record' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    const report = await recordPrices(ctx, { products: ctx.products, searchClient: ctx.searchClient });
    return json(report);
  }

  // Guarded manual ingest (§8) — for testing/backfill without the cron. Shared
  // secret header; the cron's fan-out children hit this same route. Brochures
  // first (offers link to the freshly-committed editions), then that store's
  // structured offers — both fit one child's Free-plan subrequest budget.
  if (path === '/ingest' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    const store = (url.searchParams.get('store') || '').trim() || undefined;
    if (store && !ctx.registry[store]) return json({ error: `Unknown store '${store}'.` }, 404);
    const report = await ingestAll(ctx, { store });
    if (ctx.offerStore && ctx.offersSource && url.searchParams.get('offers') !== '0') {
      report.offers = await ingestOffers(ctx, { store });
    }
    return json(report);
  }

  // Guarded retention run (see retention.js) — the cron coordinator calls
  // pruneStoredBytes directly; this route exists for manual/backfill runs.
  if (path === '/prune' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    return json(await pruneStoredBytes(ctx));
  }

  return json({ error: 'Not found' }, 404);
}

const todayISO = () => new Date().toISOString().slice(0, 10);
