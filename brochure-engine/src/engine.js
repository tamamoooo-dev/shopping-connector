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
import { getQueryPricesDoc, getLowestDoc, recordOfferHistory, deriveIdentity } from './priceHistory.js';
import { ingestOffers } from './offers/ingest.js';
import { rowToOffer, offerRelevance, queryTokens, relevanceScore } from './offers/contract.js';
import { drainEnrichment, drainOcrEnrichment, applyEnrichment, DEFAULT_MODEL } from './offers/enrich.js';
import { rebuildRow, summarize } from './offers/rebuild.js';
import { readVisionModelSetting } from './offers/visionModel.js';
import { createKeyChain } from './offers/mistralKeys.js';
import { drainRecovery } from './recovery/runner.js';
import { readRecoveryPolicy } from './recovery/policy.js';
import { drainResolution } from './registry/drain.js';
import { runMaintenance } from './registry/lifecycle.js';
import { applyReviewAction } from './registry/review.js';
import { getRegistryPricesDoc } from './registry/history.js';
import { queryFamily, offerFamily, productType, freshProduceIntent, isProcessedProduce, producePresence, matchStage } from './matching.js';
import { pruneStoredBytes } from './retention.js';
import {
  anchorWatch,
  buildWatch,
  buildWatchSettingsUpdate,
  checkWatch,
  checkWatches,
  confirmWatchProduct,
  confirmWatchSource,
  declineWatchCandidates,
  diagnoseWatch,
  repairWatch,
  resolveLegacyWatches,
  manualRefreshReason,
  watchCandidates,
  MAX_WATCHES,
  MAX_WATCHES_TOTAL,
  MAX_WATCH_ROWS,
} from './monitor.js';
import { getHotspotsDoc } from './hotspots.js';
import { getBrowseSummaryDoc, getBrowseOffersDoc } from './browse/api.js';
import { detectBrand } from './browse/brands.js';
import { watchesWithSearchIdentity } from './watchSearchIdentity.js';
import {
  collectD4dBatch,
  isD4dRegion,
  publishD4dCollection,
} from './collectors/d4dResumable.js';

// The honesty disclaimer every offers read carries (the aggregator machine-
// extracts prices from flyer images; the flyer prevails on any mismatch).
const OFFERS_NOTE =
  'Prices are machine-extracted from flyer images by the aggregator; the flyer itself prevails on any mismatch. Each offer links to its flyer page.';

// Only identities that the Registry either created or attached automatically
// are authoritative enough to bypass lexical admission. A review-band sighting
// is deliberately uncertain: it can still serve when its own text matches the
// query, but it must never pull unrelated siblings into another consumer.
const TRUSTED_CANONICAL_BANDS = new Set(['auto', 'created']);

function isTrustedCanonicalBand(band) {
  return TRUSTED_CANONICAL_BANDS.has(band);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Ingest-Secret',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

// Drop the edge-cached /browse summary after a write that reshapes it (offers
// ingest, backfill) so the market floor reflects fresh data immediately
// instead of waiting out the 1h TTL. Cache API deletes are per-colo — which
// covers the single-user reality; other colos simply age out. Best-effort:
// no caches binding (local dev harness) is fine.
async function purgeBrowseCache(url) {
  try {
    const cache = globalThis.caches ? globalThis.caches.default : null;
    if (cache) await cache.delete(new URL('/browse', url.origin).toString());
  } catch {
    /* best-effort */
  }
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
  // Lets a collector compare a held edition's stored page set against what the
  // source advertises NOW (re-render detection): the aggregator can re-render a
  // flyer under the same URL, which findHeld alone can't see. KV read, zero
  // external subrequests. Null when the meta is unreadable (e.g. bytes pruned).
  const readHeldPages = async (heldRow) => {
    if (!heldRow || !heldRow.storage_key || !ctx.objectStore) return null;
    const obj = await ctx.objectStore.get(`brochures/${heldRow.storage_key}/meta.json`);
    if (!obj) return null;
    try {
      const meta = JSON.parse(new TextDecoder().decode(obj.bytes));
      return Array.isArray(meta.pages) ? meta.pages : null;
    } catch {
      return null;
    }
  };
  const failures = [];
  for (const strategy of provider.strategies) {
    try {
      const candidates = await strategy.collect({ store: provider.id, region, regionConfig, findHeld, readHeldPages });
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
      // Snapshot reconciliation for held flyers: the collector attaches
      // freshly parsed tap geometry only after confirming the held page set
      // still matches the source, so reconciling it here (write only when
      // missing/different) heals editions that predate ingest-time capture —
      // with zero re-downloads. See pipeline.ensureHotspots.
      if (candidate.hotspots && ctx.pipeline.ensureHotspots && candidate.existing.storage_key) {
        try {
          const r = await ctx.pipeline.ensureHotspots(candidate.existing.storage_key, candidate.hotspots);
          // 'refused-empty' = the parser produced NO spots for a flyer we hold
          // WITH spots (same bytes) — a likely D4D-markup break. Surface a count
          // in the ingest report so a manual/cron run shows it, not just the log.
          if (r === 'refused-empty') line.hotspotsSuspect = (line.hotspotsSuspect || 0) + 1;
        } catch (err) {
          line.errors.push(`hotspots ${candidate.existing.id}: ${err.message}`);
        }
      }
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

async function ingestD4dResumable(ctx, provider, region, mode) {
  const startedAt = new Date().toISOString();
  let result;
  try {
    // Persist the current source offers first, including unavailable rows. Their
    // flyer_ref values are the candidate policy for the resumable collector,
    // and null navigation fields revoke stale legacy/D4D links immediately.
    let offers = null;
    if (mode !== 'brochures' && ctx.offerStore && ctx.offersSource) {
      offers = await ingestOffers(ctx, { store: provider.id });
    }
    result = await collectD4dBatch(ctx, { store: provider.id, region });

    // Publication is atomic at brochure completion. Once the whole store's
    // advertised flyer set is complete, repeat the cheap offers ingest so every
    // exact page/hotspot mapping becomes navigable in the same invocation.
    if (result.storeComplete && ctx.offerStore && ctx.offersSource) {
      offers = await ingestOffers(ctx, { store: provider.id });
      if (offers.totals.failed) {
        throw new Error(
          `Exact offer linkage refresh failed for ${offers.totals.failed} target(s)`,
        );
      }
      await publishD4dCollection(ctx, result);
    } else if (result.storeComplete) {
      throw new Error('Exact offer linkage refresh is unavailable');
    }
    const status = result.complete
      ? result.status === 'deduped'
        ? 'deduped'
        : 'new'
      : null;
    const target = {
      store: provider.id,
      region,
      detected: result.complete ? 1 : 0,
      new: status === 'new' ? 1 : 0,
      deduped: status === 'deduped' ? 1 : 0,
      failed: 0,
      errors: [],
    };
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      targets: [target],
      totals: {
        detected: target.detected,
        new: target.new,
        deduped: target.deduped,
        failed: 0,
      },
      resumable: result,
      offers,
    };
  } catch (error) {
    await ctx.collectionStore
      ?.markPending(provider.id, region, { error: error.message })
      .catch(() => {});
    return {
      startedAt,
      finishedAt: new Date().toISOString(),
      targets: [{
        store: provider.id,
        region,
        detected: 0,
        new: 0,
        deduped: 0,
        failed: 1,
        errors: [error.message],
      }],
      totals: { detected: 0, new: 0, deduped: 0, failed: 1 },
      resumable: { complete: false, error: error.message },
    };
  }
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
      priceHistory: ctx.historyStore ? await ctx.historyStore.counts() : null,
      usage:
        '/brochures?store=<id>&region=<key>  ·  /offers?q=<query>  ·  /prices?q=<query>',
    });
  }

  // --- Browse (the product-discovery pillar; BROWSE-DESIGN.md) ---------------
  // Read-only views over the offers/price-history substrate, speaking ONLY
  // canonical taxonomy ids (browse/taxonomy.js). /browse is the market floor
  // (departments + rails, one payload); /browse/offers the universal listing.
  // The summary is edge-cached: the substrate changes 3×/week, so an hour of
  // staleness is invisible — and a cold build costs a few D1 queries anyway.
  if (path === '/browse' && request.method === 'GET') {
    if (!ctx.browseStore) return json({ error: 'Browse unavailable.' }, 503);
    const cache = globalThis.caches ? globalThis.caches.default : null;
    if (cache) {
      const hit = await cache.match(request.url);
      if (hit) return hit;
    }
    const doc = await getBrowseSummaryDoc(ctx, todayISO());
    doc.note = OFFERS_NOTE;
    const resp = json(doc, 200, { 'Cache-Control': 'public, max-age=3600' });
    if (cache) await cache.put(request.url, resp.clone());
    return resp;
  }

  if (path === '/browse/offers' && request.method === 'GET') {
    if (!ctx.browseStore) return json({ error: 'Browse unavailable.' }, 503);
    const store = (url.searchParams.get('store') || '').trim();
    if (store && !ctx.registry[store]) return json({ error: `Unknown store '${store}'.` }, 404);
    const doc = await getBrowseOffersDoc(
      ctx,
      {
        dept: (url.searchParams.get('dept') || '').trim() || null,
        aisle: (url.searchParams.get('aisle') || '').trim() || null,
        rail: (url.searchParams.get('rail') || '').trim() || null,
        brand: (url.searchParams.get('brand') || '').trim() || null,
        store: store || null,
        sort: (url.searchParams.get('sort') || '').trim() || undefined,
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      },
      todayISO(),
    );
    if (doc.error) return json(doc, 400);
    doc.note = OFFERS_NOTE;
    return json(doc, 200, { 'Cache-Control': 'public, max-age=600' });
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

    // Vision-canonical search (2026-07-21): one path. Retrieval matched each
    // row's canonical haystack in SQL (offerStore.search); here the SAME gate
    // (offers/enrich.js applyEnrichment -> servable) overlays vision display
    // names, with per-offer OCR extraction fallback. Rows carry their
    // enrichment columns, so there is no second fetch.
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
        const matchHay = applyEnrichment(offer, r);
        const rel = offerRelevance(offer, tokens, matchHay);
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
    // TEMPORARY (pipeline evaluation): ?diag=1 exposes the ranking keys the
    // sort above actually used, so the comparison tool can explain WHY a row
    // moved. Absent the param, both payloads keep their normal shape.
    const diag = url.searchParams.get('diag') === '1';
    const offers = scored.slice(0, limit).map((s) => {
      if (diag) s.offer._diag = { stage: s.stage, famRank: s.famRank, score: Math.round(s.score) };
      return s.offer;
    });

    // Registry annotation (REGISTRY-DESIGN §7 /offers) — the sighting's
    // productId on every resolved result, enabling cross-store same-product
    // grouping. Read-only decoration; ranking above is already final.
    if (ctx.registryStore && offers.length) {
      const sightings = await ctx.registryStore
        .getSightingsForIds(offers.map((o) => o.id))
        .catch(() => new Map());
      for (const o of offers) {
        const s = sightings.get(o.id);
        if (s) {
          o.matchBand = s.match_band;
          // Review-band edges remain operator evidence, never a Known Product
          // assertion. Keeping productId absent prevents Compare, Watch, and
          // other consumers from treating an untrusted review as canonical.
          if (isTrustedCanonicalBand(s.match_band)) o.productId = s.product_id;
        }
      }

      // CANONICAL SIBLING EXPANSION (2026-07-21): a query that matched one
      // retailer's offer must surface the SAME canonical product at every
      // retailer — even a sibling whose extracted name is generic ("Milk" on
      // a tile whose brand lives only in the artwork) and therefore can never
      // match the query lexically. The Registry already joined them; serve
      // that knowledge. Additive only: ranking above stays final, siblings
      // append after it, capped, current-and-filter-respecting.
      if (
        q &&
        offers.length &&
        typeof ctx.registryStore.sightingsForProducts === 'function' &&
        typeof ctx.offerStore.getByIds === 'function'
      ) {
        // Trust is required on BOTH sides of the identity edge. An uncertain
        // lexical hit must not authorize expansion, and an uncertain sibling
        // must not bypass the lexical/family gates merely because its brand is
        // shared with the matched product.
        const canonicalSeeds = offers.filter(
          (o) => o.productId && isTrustedCanonicalBand(o.matchBand),
        );
        const pids = [...new Set(canonicalSeeds.map((o) => o.productId))];
        // BRAND GUARD: 'review'-band sightings can wrongly co-locate brands
        // under one productId (observed live: Al Safi rows on the Nadec UHT
        // product). A sibling is only served when its ingest-stamped brand
        // matches a brand the query actually matched for that product —
        // canonical identity expands reach, never brand.
        const brandsByPid = new Map();
        for (const o of canonicalSeeds) {
          if (!o.productId || !o.brandSlug) continue;
          const set = brandsByPid.get(o.productId) || new Set();
          set.add(o.brandSlug);
          brandsByPid.set(o.productId, set);
        }
        if (pids.length) {
          const served = new Set(offers.map((o) => o.id));
          const sibs = await ctx.registryStore.sightingsForProducts(pids).catch(() => []);
          const bandById = new Map();
          for (const s of sibs) {
            if (!isTrustedCanonicalBand(s.match_band)) continue;
            if (!served.has(s.offer_id)) bandById.set(s.offer_id, s);
          }
          const wantIds = [...bandById.keys()].slice(0, 40);
          if (wantIds.length) {
            const rows = await ctx.offerStore
              .getByIds(wantIds, { currentOn: todayISO(), store, region })
              .catch(() => []);
            let added = 0;
            for (const r of rows) {
              if (added >= 20) break;
              const offer = rowToOffer(r);
              const s = bandById.get(offer.id);
              const okBrands = brandsByPid.get(s.product_id);
              if (!okBrands || !offer.brandSlug || !okBrands.has(offer.brandSlug)) continue;
              added += 1;
              applyEnrichment(offer, r);
              offer.productId = s.product_id;
              offer.matchBand = s.match_band;
              offer.canonicalSibling = true; // reached via Registry identity, not the query text
              offers.push(offer);
            }
          }
        }
      }
    }

    return json({ query: q || null, count: offers.length, note: OFFERS_NOTE, offers });
  }

  // Recompute the PURE derived fields of stored enrichments (offers/rebuild.js)
  // against the current lexicons. No model is called — every input is already in
  // the row — so this costs no Mistral quota and can be run freely while the
  // extraction model stays pinned to Budget Mode.
  //
  //   ?dryRun=1     write nothing; report exactly what would change (DEFAULT
  //                 for the first call an operator should make)
  //   ?reresolve=1  ALSO clear mint_verdict, handing the rows back to the
  //                 registry drain. That DOES mint and attach products, so it
  //                 is opt-in and reported separately.
  //   ?after=<id>&limit=N   cursor paging; the response carries `nextAfter`.
  if (path === '/enrich/rebuild' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.enrichStore?.listForRebuild) return json({ error: 'Rebuild unavailable.' }, 503);
    const dryRun = url.searchParams.get('dryRun') === '1';
    const reresolve = url.searchParams.get('reresolve') === '1';
    const after = url.searchParams.get('after') || '';
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 500, 2000));
    const rows = await ctx.enrichStore.listForRebuild({ after, limit });
    const results = rows.map((r) => rebuildRow(r, {
      identityNormalizationMode: ctx.identityNormalizationMode,
    }));
    const report = summarize(results);
    const writable = results.filter((r) => r.changed.candidate || r.changed.arabic);
    if (!dryRun && writable.length) {
      await ctx.enrichStore.applyRebuild(writable, { reresolve });
    }
    return json({
      mode: dryRun ? 'dry-run (nothing written)' : reresolve ? 'applied + re-resolve' : 'applied',
      reresolve,
      ...report,
      wouldWrite: writable.length,
      written: dryRun ? 0 : writable.length,
      nextAfter: rows.length === limit ? rows[rows.length - 1].id : null,
      // A handful of real before/after pairs so the operator can judge the
      // change by eye rather than by counters alone.
      samples: writable.slice(0, 8).map((r) => ({
        id: r.id,
        dimensions: `${r.dimensionsBefore} -> ${r.dimensionsAfter}`,
        arabicBefore: r.builtArabicBefore,
        arabicAfter: r.builtArabicAfter,
      })),
    });
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
  // Catalog-wide and query-driven: statistics are derived at read time from the
  // offers-harvested identity/point rows (§ priceHistory). The legacy `product`
  // parameter is accepted as a query for compatibility.
  const historyQuery = () =>
    (url.searchParams.get('q') || url.searchParams.get('product') || '').trim();

  // Price History is REGISTRY-FIRST (vision-canonical, 2026-07-21): the
  // registry doc (points = sightings, market-wide) answers whenever it has
  // data for the query. The V1 OCR-identity doc serves only as fallback while
  // registry depth accrues (sightings exist only since resolution went live).
  // TODO: remove the V1 fallback once registry depth covers the catalog.
  const registryPricesDoc = async (q) => {
    if (!ctx.registryStore) return null;
    const doc = await getRegistryPricesDoc(ctx.registryStore, q, { today: todayISO() })
      .catch(() => null);
    const empty = !doc || (!doc.lowest && !(doc.variants && doc.variants.length));
    return empty ? null : doc;
  };

  // Headline: lowest historical price + where (store) + when (week/observedAt).
  if (path === '/lowest' && request.method === 'GET') {
    const q = historyQuery();
    if (!q) return json({ error: "Missing required parameter 'q'." }, 400);
    const doc = await registryPricesDoc(q);
    if (doc) return json({ product: q, lowest: doc.lowest });
    if (!ctx.historyStore) return json({ error: 'Price history unavailable.' }, 503);
    return json({ product: q, lowest: await getLowestDoc(ctx.historyStore, q) });
  }

  // Full picture: per-size/variant records (lowest ever, highest, latest per
  // store, first seen, weeks observed, trend), stage-gated to the query's best
  // match band. Flyer prices are aggregator-extracted — the disclaimer rides.
  if (path === '/prices' && request.method === 'GET') {
    const q = historyQuery();
    if (!q) return json({ error: "Missing required parameter 'q'." }, 400);
    const regDoc = await registryPricesDoc(q);
    if (regDoc) {
      regDoc.note = OFFERS_NOTE;
      return json(regDoc);
    }
    if (!ctx.historyStore) return json({ error: 'Price history unavailable.' }, 503);
    const doc = await getQueryPricesDoc(ctx.historyStore, q);
    doc.note = OFFERS_NOTE;
    return json(doc);
  }

  // Guarded backfill — seed/repair the history from the offers rows ALREADY in
  // D1 (no external fetches). One store per call keeps a run cheap; without
  // `store` every registered store is processed sequentially.
  if (path === '/prices/backfill' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.historyStore || !ctx.offerStore) {
      return json({ error: 'Price history unavailable.' }, 503);
    }
    const store = (url.searchParams.get('store') || '').trim();
    if (store && !ctx.registry[store]) return json({ error: `Unknown store '${store}'.` }, 404);
    const stores = store ? [store] : Object.keys(ctx.registry);
    const report = { startedAt: new Date().toISOString(), targets: [] };
    for (const s of stores) {
      const rows = await ctx.offerStore.listAll({ store: s });
      const offers = rows.map(rowToOffer);
      const h = await recordOfferHistory(ctx.historyStore, offers, {
        observedAt: rows[0]?.detected_at,
      });
      // Browse: stamp the ingest-derived columns (identity + brand) onto rows
      // that predate them (ingest writes both for new rows; this heals the
      // back catalog once). Idempotent: already-derived rows are skipped.
      let stamped = 0;
      if (ctx.offerStore.updateDerived) {
        const updates = [];
        for (let i = 0; i < rows.length; i++) {
          const ident = rows[i].identity || deriveIdentity(offers[i])?.id || null;
          const brand = rows[i].brand_slug || detectBrand(offers[i]);
          if (ident === rows[i].identity && brand === rows[i].brand_slug) continue;
          updates.push({ id: rows[i].id, identity: ident, brand_slug: brand });
        }
        if (updates.length) await ctx.offerStore.updateDerived(updates);
        stamped = updates.length;
      }
      report.targets.push({ store: s, ...h, offersStamped: stamped });
    }
    report.finishedAt = new Date().toISOString();
    await purgeBrowseCache(url); // identities/brands just changed shape
    return json(report);
  }

  // --- Price Monitoring (Personal Alerts) -------------------------------------
  // Watches + alerts (see monitor.js). Every user-facing route is scoped to a
  // LOCAL PROFILE (the frontend's per-browser profile.js id): ?profile=<id> on
  // reads/deletes, body.profileId on create — browsers never see each other's
  // watches, and the MAX_WATCHES cap applies per profile (MAX_WATCHES_TOTAL is
  // the global cron-budget backstop). Writes stay strictly validated; the
  // check runner stays secret-guarded because it spends the subrequest budget.
  const profileParam = (url.searchParams.get('profile') || '').trim();

  // The profile's watch list with its current state, plus its unseen-alert
  // count (the frontend's badge). One call paints the whole Alerts page.
  if (path === '/watches' && request.method === 'GET') {
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    if (!profileParam) return json({ error: "Missing required parameter 'profile'." }, 400);
    // Legacy adoption: watches created before profiles existed (profile_id
    // NULL) belong to this personal tool's single pre-profile user — the
    // first profile to list watches claims them. Idempotent no-op after.
    await ctx.watchStore.adoptOrphans(profileParam);
    const storedWatches = await ctx.watchStore.list({ profileId: profileParam });
    const watches = await watchesWithSearchIdentity(ctx.registryStore, storedWatches);
    return json({
      count: watches.length,
      max: MAX_WATCHES,
      unseenAlerts: await ctx.watchStore.countUnseen(profileParam),
      identity: ctx.watchStore.identityStats
        ? await ctx.watchStore.identityStats(profileParam)
        : null,
      watches,
    });
  }

  // Create a watch. Validation (incl. required profileId) lives in buildWatch;
  // the per-profile cap and the global backstop live here.
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
    // The COMPUTE cap: monitored watches only. An unanchored watch does no
    // daily work, so it never occupies one of these slots.
    if ((await ctx.watchStore.count(watch.profileId)) >= MAX_WATCHES) {
      return json({ error: `Watch limit reached (${MAX_WATCHES}). Delete one first.` }, 409);
    }
    if ((await ctx.watchStore.countActiveTotal()) >= MAX_WATCHES_TOTAL) {
      return json({ error: 'Watch service is at capacity. Try again later.' }, 409);
    }
    // The STORAGE bound, which the compute cap deliberately does not enforce.
    // The error names WHY the rows are there, so the pressure arrives with an
    // explanation the user can act on rather than a bare refusal.
    if (ctx.watchStore.countRows &&
        (await ctx.watchStore.countRows(watch.profileId)) >= MAX_WATCH_ROWS) {
      const pending = ctx.watchStore.countUnanchored
        ? await ctx.watchStore.countUnanchored(watch.profileId)
        : 0;
      return json({
        error: `${MAX_WATCH_ROWS} watches stored`
          + (pending ? `, ${pending} awaiting identity resolution` : '')
          + '. Resolve or delete some first.',
      }, 409);
    }
    // IDENTITY IS RESOLVED HERE — once, in the foreground, while the user is
    // still looking at the product. That is the whole safety argument of the
    // design: an ambiguous identity gets adjudicated by a human at the moment
    // of creation, instead of by an unattended cron that could only choose
    // between guessing and going quiet. The watch is still CREATED either way;
    // an unconfirmed one simply holds an explicit state and monitors nothing.
    const anchored = await anchorWatch(ctx, watch, body.listing || null);
    await ctx.watchStore.create(anchored.watch);
    return json({
      watch: anchored.watch,
      confirmationRequired: anchored.confirmationRequired === true,
      needsConfirmation: anchored.needsConfirmation === true,
      candidates: anchored.candidates || [],
      candidateVersion: anchored.candidateVersion || null,
      createdProduct: anchored.created ? anchored.created.id : null,
    }, 201);
  }

  // Update only the v2 controls on an owned watch. Matching changes re-arm the
  // crossing detector because they may select a different comparison pool.
  if (path === '/watches' && request.method === 'PATCH') {
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    if (!profileParam) return json({ error: "Missing required parameter 'profile'." }, 400);
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return json({ error: "Missing required parameter 'id'." }, 400);
    const watch = await ctx.watchStore.get(id);
    if (!watch || watch.profileId !== profileParam) return json({ error: 'Watch not found.' }, 404);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be JSON.' }, 400);
    }
    // CONFIRMATION: the user answering "which product is this?" for a watch the
    // resolver could not settle alone. One write, owner-scoped.
    if (body && body.registryProductId != null) {
      if (!ctx.registryStore) return json({ error: 'Registry unavailable.' }, 503);
      const result = await confirmWatchProduct(
        ctx, watch, body.registryProductId, body.candidateVersion,
      );
      if (result.error) return json({ error: result.error }, 400);
      return json({ watch: await ctx.watchStore.get(id) });
    }
    if (body && body.sourceProvider != null && body.sourceProductId != null) {
      const result = await confirmWatchSource(ctx, watch, {
        provider: body.sourceProvider,
        productId: body.sourceProductId,
        candidateVersion: body.candidateVersion,
      });
      if (result.error) return json({ error: result.error }, 400);
      return json({ watch: await ctx.watchStore.get(id) });
    }
    if (body?.confirmationAction === 'none') {
      const result = await declineWatchCandidates(ctx, watch, body.candidateVersion);
      if (result.error) return json({ error: result.error }, 400);
      return json({ watch: await ctx.watchStore.get(id) });
    }
    const { fields, error } = buildWatchSettingsUpdate(body, watch);
    if (error) return json({ error }, 400);
    await ctx.watchStore.updateSettings(id, profileParam, fields);
    return json({ watch: await ctx.watchStore.get(id) });
  }

  // The products a user may choose from when confirming an ambiguous watch.
  // Read-only; picking is the PATCH above.
  if (path === '/watches/candidates' && request.method === 'GET') {
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    if (!profileParam) return json({ error: "Missing required parameter 'profile'." }, 400);
    const id = (url.searchParams.get('id') || '').trim();
    const watch = id ? await ctx.watchStore.get(id) : null;
    if (!watch || watch.profileId !== profileParam) return json({ error: 'Watch not found.' }, 404);
    return json(await watchCandidates(ctx, watch));
  }

  // "Why is this watch quiet?" — the real retrieval and the real identity
  // decision, reported per candidate instead of selecting one. Read-only, so
  // it is profile-scoped rather than secret-guarded: it exposes nothing the
  // owner cannot already see, and it is the first thing to reach for when a
  // watch reports not-found against a product that is visibly on sale.
  if (path === '/watches/diagnose' && request.method === 'GET') {
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    if (!profileParam) return json({ error: "Missing required parameter 'profile'." }, 400);
    const id = (url.searchParams.get('id') || '').trim();
    const watch = id ? await ctx.watchStore.get(id) : null;
    if (!watch || watch.profileId !== profileParam) return json({ error: 'Watch not found.' }, 404);
    return json(await diagnoseWatch(ctx, watch));
  }

  // User-initiated identity/monitoring repair. Established anchors are never
  // erased: Registry/spec anchors return diagnostics and a source anchor may
  // only rebind after passing the same continuity safety gates as monitoring.
  if (path === '/watches/repair' && request.method === 'POST') {
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    if (!profileParam) return json({ error: "Missing required parameter 'profile'." }, 400);
    const id = (url.searchParams.get('id') || '').trim();
    const watch = id ? await ctx.watchStore.get(id) : null;
    if (!watch || watch.profileId !== profileParam) return json({ error: 'Watch not found.' }, 404);
    const result = await repairWatch(ctx, watch);
    return json({ ...result, watch: await ctx.watchStore.get(id) });
  }

  // User-initiated monitoring retry for ONE owned watch. This intentionally
  // calls the same evaluator as cron but not the batch wrapper: batch retry may
  // resolve identity, while Refresh Now is forbidden from changing identity.
  if (path === '/watches/refresh' && request.method === 'POST') {
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    if (!profileParam) return json({ error: "Missing required parameter 'profile'." }, 400);
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return json({ error: "Missing required parameter 'id'." }, 400);
    const watch = await ctx.watchStore.get(id);
    if (!watch || watch.profileId !== profileParam) return json({ error: 'Watch not found.' }, 404);
    const reason = manualRefreshReason(watch);
    if (!reason) return json({ error: 'This watch does not need a manual refresh.' }, 409);
    const result = await checkWatch(ctx, watch, { allowIdentityRebind: false });
    return json({ reason, result, watch: await ctx.watchStore.get(id) });
  }

  // The ONE-TIME legacy backfill: settle every pre-anchor watch into an
  // explicit state. Guarded like the other maintenance routes; idempotent.
  if (path === '/watches/resolve-legacy' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    if (!ctx.registryStore) return json({ error: 'Registry unavailable.' }, 503);
    // Small by default — resolution is CPU-heavy against a large registry and
    // a big batch dies at the Worker CPU limit. Idempotent and resumable, so
    // the caller loops until `scanned` is 0. See resolveLegacyWatches.
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 3, 500));
    // ?dryRun=1 reports exactly what WOULD happen and writes nothing — no
    // anchor, no mint. A minted product survives an engine rollback, so the
    // operator gets to see the list before it exists rather than after.
    const dryRun = url.searchParams.get('dryRun') === '1';
    // ?retry=1 re-visits watches already settled into needs-confirmation or
    // unresolvable. Off by default so a plain loop always makes progress.
    const retry = url.searchParams.get('retry') === '1';
    return json(await resolveLegacyWatches(ctx, { limit, dryRun, retry }));
  }

  // Delete a watch (and its alerts) — only the owning profile's.
  if (path === '/watches' && request.method === 'DELETE') {
    if (!ctx.watchStore) return json({ error: 'Watches unavailable.' }, 503);
    const id = (url.searchParams.get('id') || '').trim();
    if (!id) return json({ error: "Missing required parameter 'id'." }, 400);
    if (!profileParam) return json({ error: "Missing required parameter 'profile'." }, 400);
    const removed = await ctx.watchStore.remove(id, profileParam);
    return removed ? json({ removed: id }) : json({ error: 'Watch not found.' }, 404);
  }

  // The profile's recent alerts (newest first). `unseen=1` narrows to unread.
  if (path === '/alerts' && request.method === 'GET') {
    if (!ctx.watchStore) return json({ error: 'Alerts unavailable.' }, 503);
    if (!profileParam) return json({ error: "Missing required parameter 'profile'." }, 400);
    const unseenOnly = url.searchParams.get('unseen') === '1';
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 200));
    const alerts = await ctx.watchStore.listAlerts({ limit, unseenOnly, profileId: profileParam });
    return json({ count: alerts.length, unseen: await ctx.watchStore.countUnseen(profileParam), alerts });
  }

  // Mark the profile's alerts read (the Alerts page calls this when viewed).
  if (path === '/alerts/seen' && request.method === 'POST') {
    if (!ctx.watchStore) return json({ error: 'Alerts unavailable.' }, 503);
    if (!profileParam) return json({ error: "Missing required parameter 'profile'." }, 400);
    return json({ marked: await ctx.watchStore.markAlertsSeen(profileParam) });
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

  // Guarded manual ingest (§8) — for testing/backfill without the cron. Shared
  // secret header; the cron's fan-out children hit this same route. Brochures
  // first (offers link to the freshly-committed editions), then that store's
  // structured offers — both fit one child's Free-plan subrequest budget.
  // `mode=offers|brochures` runs only that half (the Ops Console's partial
  // fan-outs); default runs both, exactly as before.
  if (path === '/ingest' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    const store = (url.searchParams.get('store') || '').trim() || undefined;
    if (store && !ctx.registry[store]) return json({ error: `Unknown store '${store}'.` }, 404);
    const mode = (url.searchParams.get('mode') || '').trim();
    if (mode && mode !== 'offers' && mode !== 'brochures') {
      return json({ error: `Unknown mode '${mode}'.` }, 400);
    }
    const t0 = Date.now();
    const resumableTarget =
      store && mode !== 'offers'
        ? Object.keys(ctx.registry[store].regions)
            .map((region) => ({ provider: ctx.registry[store], region }))
            .find(({ provider, region }) => isD4dRegion(provider, region))
        : null;
    const report =
      mode === 'offers'
        ? { startedAt: new Date().toISOString(), targets: [], totals: { detected: 0, new: 0, deduped: 0, failed: 0 } }
        : resumableTarget
          ? await ingestD4dResumable(ctx, resumableTarget.provider, resumableTarget.region, mode)
          : await ingestAll(ctx, { store });
    if (
      !resumableTarget &&
      mode !== 'brochures' &&
      ctx.offerStore &&
      ctx.offersSource &&
      url.searchParams.get('offers') !== '0'
    ) {
      report.offers = await ingestOffers(ctx, { store });
      await purgeBrowseCache(url); // fresh offers reshape the market floor
    }
    if (resumableTarget && report.offers) {
      await purgeBrowseCache(url);
    }
    // Audit (Ops Console timeline): every ingest run — cron child or manual —
    // records one row. Best-effort: a failed write never fails the ingest.
    if (ctx.opsStore) {
      const bt = report.totals;
      const ot = report.offers?.totals;
      const navigation = ot?.navigation || null;
      const errors = [
        ...report.targets.flatMap((t) => t.errors || []),
        ...(report.offers?.targets || []).flatMap((t) => t.errors || []),
      ];
      await ctx.opsStore
        .record({
          ts: report.startedAt,
          action: 'ingest' + (mode ? ':' + mode : ''),
          origin: request.headers.get('X-Ops-Origin') === 'ops' ? 'ops' : 'cron',
          store: store || null,
          stores: store ? 1 : Object.keys(ctx.registry).length,
          ok:
            bt.failed === 0 &&
            !(ot && ot.failed > 0) &&
            navigation?.failClosed !== true,
          detected: bt.detected,
          new: bt.new,
          deduped: bt.deduped,
          failed: bt.failed,
          offers: ot ? ot.stored : null,
          elapsed_ms: Date.now() - t0,
          error:
            errors[0] ||
            (navigation?.failClosed
              ? `Navigation trust circuit open: ambiguity=${navigation.ambiguityRate}, disagreement=${navigation.disagreementRate}`
              : null),
          detail: navigation ? { navigation } : null,
        })
        .catch(() => {});
    }
    return json(report);
  }

  // Guarded vision-enrichment drain (offers/enrich.js): one PACED batch of
  // debris-offer name extraction. The daily cron dispatches a few of these
  // children sequentially (scheduler.runEnrichDrain), each with its own fresh
  // subrequest budget; callable manually for backfill. Names only — the price
  // path is unreachable from here by construction.
  if (path === '/enrich' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.enrichStore || !ctx.mistralKey) {
      return json({ error: 'Enrichment unavailable (no store or MISTRAL_API_KEY).' }, 503);
    }
    // One crop fetch + Vision + possible OCR = at most three subrequests per
    // offer. Cap at 16 so fallback-heavy Vision First stays within the Worker budget.
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 15, 16));
    // Scope (pipeline milestone): 'all' = every current offer with a crop
    // (full-catalog vision coverage, the default per the evaluation plan);
    // 'debris' = the original deriveNames-defeated subset only.
    const scope = url.searchParams.get('scope') === 'debris' ? 'debris' : 'all';
    // Runtime-only extraction switch. The default is Vision First; operators
    // can set EXTRACTION_STRATEGY on the Worker or override one guarded drain
    // with ?strategy=vision-first|ocr-first|vision-only|ocr-only.
    const strategy = url.searchParams.get('strategy') || ctx.extractionStrategy;
    const identityNormalizationMode = url.searchParams.get('identityMode') || ctx.identityNormalizationMode;
    // Vision Model Selection Policy (offers/visionModel.js). EVERY drain — the
    // enrich cron, the ops Vision Drain, and the background Vision job — reaches
    // Mistral through this one route, so reading the operator's selection here
    // covers all of them and there is no second place to keep in sync.
    //
    // INERT UNTIL ARMED: with no stored selection we pass no `model` key at all,
    // so drainEnrichment's own `model = DEFAULT_MODEL` default applies and this
    // route behaves exactly as it did before the selector existed. Only an
    // explicit operator choice overrides it. Deliberate — the selector ships
    // AHEAD of the frozen extraction baseline, and defaulting to Medium here
    // would silently move production onto a model/prompt pairing nobody has
    // measured. A read failure is inert too, by construction.
    const visionModel = await readVisionModelSetting(ctx.objectStore);
    const t0 = Date.now();
    const report = await drainEnrichment(
      { enrichStore: ctx.enrichStore, mistralKey: ctx.mistralKey, mistralKeyBackup: ctx.mistralKeyBackup },
      {
        limit,
        currentOn: todayISO(),
        scope,
        strategy,
        identityNormalizationMode,
        ...(visionModel.armed ? { model: visionModel.model } : {}),
      },
    );
    // Which model produced this batch, on the report itself: the per-offer rows
    // already carry it, but the console reads the report. This is the model that
    // ACTUALLY ran — while inert that is enrich.js's DEFAULT_MODEL, not the tier
    // the selector happens to be proposing.
    const activeVisionModel = visionModel.armed ? visionModel.model : DEFAULT_MODEL;
    report.visionModel = {
      tier: visionModel.armed ? visionModel.tier : null,
      model: activeVisionModel,
      budget: visionModel.armed ? visionModel.budget : false,
      armed: visionModel.armed,
    };
    // ENRICHMENT ONLY (2026-07-20): resolution is DECOUPLED — it no longer rides
    // this child (the combined enrichment + resolution CPU tripped the per-
    // invocation limit under load). Each cron coordinator (index.js) now runs one
    // drainResolution pass after its enrich children finish; standalone /resolve
    // covers the backlog. Same drainResolution code, just a different caller.
    if (ctx.opsStore) {
      await ctx.opsStore
        .record({
          ts: report.startedAt,
          action: 'enrich',
          origin: request.headers.get('X-Ops-Origin') === 'ops' ? 'ops' : 'cron',
          ok: report.failed === 0,
          failed: report.failed,
          elapsed_ms: Date.now() - t0,
          error: report.errors[0] || null,
          detail: {
            scanned: report.scanned,
            enriched: report.enriched,
            declined: report.declined,
            pruned: report.pruned,
            // Audited per run so a quality regression can always be traced back
            // to the model that was active when the rows were written.
            model: activeVisionModel,
            budgetMode: visionModel.armed && visionModel.budget,
            resolved: report.resolution
              ? {
                  scanned: report.resolution.scanned,
                  attached: report.resolution.attached,
                  reviewed: report.resolution.reviewed,
                  created: report.resolution.created,
                  deferred: report.resolution.deferred,
                }
              : null,
          },
        })
        .catch(() => {});
    }
    return json(report);
  }

  // S5.7 · AUTO recovery drain (VISION-PIPELINE.md C-8). Machine-guarded like
  // every other drain, and INERT by default: the execution policy resolves to
  // Manual/disarmed unless an operator armed it, so this route is a cheap no-op
  // that makes no provider call.
  //
  // NOT WIRED TO A CRON, deliberately. This is left as an operator decision
  // rather than piled onto the enrich cron, whose per-invocation CPU and
  // subrequest budget has been exhausted before (drainResolution, 2026-07-20) —
  // adding a paid drain to that child is how you rediscover that limit. Manual
  // dispatch and "Run Auto now" in the Operations Center both work without it.
  if (path === '/recovery-drain' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.recoveryQueue || !ctx.recoveryRegistry) {
      return json({ error: 'Recovery Queue unavailable.' }, 503);
    }
    const policy = await readRecoveryPolicy(ctx.objectStore, { registry: ctx.recoveryRegistry });
    // Resolved PER PROCESSOR from the credential each descriptor declares, and
    // a processor declaring none gets none. Built once for the run, it would
    // hand every processor the first one's keys; defaulted to the vision chain,
    // it would hand a provider-less rung (the human one) a live API key.
    const chains = {
      ocr: () => createKeyChain([ctx.mistralOcrKey, ctx.mistralOcrKeyBackup]),
      vision: () => createKeyChain([ctx.mistralKey, ctx.mistralKeyBackup]),
    };
    const report = await drainRecovery(
      {
        queue: ctx.recoveryQueue,
        registry: ctx.recoveryRegistry,
        enrichStore: ctx.enrichStore,
        policy,
        contextFor: (processor) => ({
          keyChain: processor.credential ? (chains[processor.credential]?.() ?? null) : null,
          identityNormalizationMode: ctx.identityNormalizationMode,
        }),
      },
      { currentOn: todayISO() },
    );
    if (ctx.opsStore && !report.skipped) {
      await ctx.opsStore.record({
        ts: report.startedAt,
        action: 'recovery-drain',
        origin: 'cron',
        ok: true,
        failed: report.runs.reduce((n, r) => n + (r.failed || 0), 0),
        elapsed_ms: Date.parse(report.finishedAt) - Date.parse(report.startedAt),
        detail: {
          processors: [...policy.processors],
          recovered: report.runs.reduce((n, r) => n + (r.recovered || 0), 0),
        },
      }).catch(() => {});
    }
    return json(report);
  }

  // Guarded asynchronous OCR escalation. This route never calls Vision and
  // returns a successful unavailable report when no OCR credential is present,
  // leaving all rejected offers durably marked ocr_pending.
  if (path === '/ocr-enrich' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.enrichStore) return json({ error: 'OCR enrichment store unavailable.' }, 503);
    if (ctx.ocrFallbackEnabled === false) {
      return json({
        skipped: true,
        reason: 'ocr_disabled',
        pending: await ctx.enrichStore.countPendingOcr(todayISO()),
      });
    }
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 5, 10));
    const identityNormalizationMode = url.searchParams.get('identityMode') || ctx.identityNormalizationMode;
    const report = await drainOcrEnrichment(
      {
        enrichStore: ctx.enrichStore,
        mistralOcrKey: ctx.mistralOcrKey,
        mistralOcrKeyBackup: ctx.mistralOcrKeyBackup,
      },
      { limit, currentOn: todayISO(), identityNormalizationMode },
    );
    if (ctx.opsStore) {
      await ctx.opsStore.record({
        ts: report.startedAt,
        action: 'ocr-enrich',
        origin: 'cron',
        ok: report.failed === 0,
        failed: report.failed,
        elapsed_ms: Date.parse(report.finishedAt) - Date.parse(report.startedAt),
        error: report.errors?.[0] || null,
        detail: {
          scanned: report.scanned,
          completed: report.completed,
          remaining: report.remaining ?? report.pending,
          unavailable: report.unavailable || false,
        },
      }).catch(() => {});
    }
    return json(report);
  }

  // Guarded registry-resolution drain (registry/drain.js): resolve the
  // backlog of stored-but-unresolved enrichments WITHOUT any vision calls —
  // D1-only, so large limits are safe. The backfill path after upload-shadow /
  // backfill-enrich populate offer_enrichments.
  if (path === '/resolve' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.registryStore || !ctx.enrichStore) {
      return json({ error: 'Registry unavailable.' }, 503);
    }
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 200, 500));
    const t0 = Date.now();
    const report = await drainResolution(
      { enrichStore: ctx.enrichStore, registryStore: ctx.registryStore },
      { limit, currentOn: todayISO() },
    );
    if (ctx.opsStore) {
      await ctx.opsStore
        .record({
          ts: report.startedAt,
          action: 'resolve',
          origin: request.headers.get('X-Ops-Origin') === 'ops' ? 'ops' : 'cron',
          ok: report.errors.length === 0,
          failed: report.errors.length,
          elapsed_ms: Date.now() - t0,
          error: report.errors[0] || null,
          detail: {
            scanned: report.scanned,
            attached: report.attached,
            reviewed: report.reviewed,
            created: report.created,
            deferred: report.deferred,
            verdicts: report.verdicts,
          },
        })
        .catch(() => {});
    }
    return json(report);
  }

  // Registry §8 standing metrics — a dashboard read, never an investigation
  // (IDENTITY-V2 §3.1 rationale). Public read-only aggregates.
  if (path === '/registry/stats' && request.method === 'GET') {
    if (!ctx.registryStore) return json({ error: 'Registry unavailable.' }, 503);
    const stats = await ctx.registryStore.stats();
    const verdicts = ctx.enrichStore
      ? await ctx.enrichStore.verdictCounts().catch(() => ({}))
      : {};
    return json(
      { ...stats, verdicts },
      200,
      { 'Cache-Control': 'public, max-age=60' },
    );
  }

  // Guarded registry maintenance (registry/lifecycle.js): §5.1 dormancy sweep,
  // §5.4 conservative consolidation, dangling-sighting healing — the manual
  // twin of the weekly cron duty (index.js). D1-only.
  if (path === '/registry/maintain' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.registryStore) return json({ error: 'Registry unavailable.' }, 503);
    return json(await runMaintenance(ctx, { today: todayISO() }));
  }

  // The §5.4/§6 review surface — the human side of the split asymmetry (merge
  // automated, split human-gated). GET lists what needs eyes: flagged products
  // (size/brand conflicts, split suspicion) and a sample of review-band
  // sightings with their flyer crops for adjudication. Guarded: operator data.
  if (path === '/registry/review' && request.method === 'GET') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.registryStore) return json({ error: 'Registry unavailable.' }, 503);
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 200));
    const [flagged, sightings, pending] = await Promise.all([
      ctx.registryStore.listFlagged(limit),
      ctx.registryStore.listReviewSightings(limit),
      ctx.enrichStore?.listPendingReviews
        ? ctx.enrichStore.listPendingReviews(limit)
        : Promise.resolve([]),
    ]);
    // Keep the public operator contract unchanged: pending decisions and
    // historical review-band sightings share the existing reviewSightings
    // collection. `review_state`/`trusted` are additive diagnostics.
    return json({ flagged, reviewSightings: [...pending, ...sightings].slice(0, limit) });
  }

  // Review actions (guarded): the bounded human loop the design accepts
  // (REGISTRY-DESIGN §9 trade-off 3).
  //   clear_flag — the suspicion was benign; the product resumes learning.
  //   reassign   — move ONE sighting to the right product (band `review`:
  //                attached, never teaching — a human fix must not poison a
  //                profile either).
  //   split      — the split repair: re-mint a NEW product from the sighting's
  //                own enrichment read and move the sighting onto it.
  if (path === '/registry/review' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    if (!ctx.registryStore) return json({ error: 'Registry unavailable.' }, 503);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body must be JSON.' }, 400);
    }
    const report = await applyReviewAction(ctx, body || {});
    return json(report, report.error ? 400 : 200);
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
