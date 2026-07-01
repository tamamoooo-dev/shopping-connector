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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
async function collectBestFirst(provider, region) {
  const regionConfig = provider.regions[region];
  const failures = [];
  for (const strategy of provider.strategies) {
    try {
      const candidates = await strategy.collect({ store: provider.id, region, regionConfig });
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
    collected = await collectBestFirst(provider, region);
  } catch (err) {
    line.failed = 1;
    line.errors = err.failures || [err.message];
    return line;
  }
  for (const candidate of collected.candidates) {
    line.detected += 1;
    try {
      const { status } = await ctx.pipeline.ingest(candidate);
      line[status === 'new' ? 'new' : 'deduped'] += 1;
    } catch (err) {
      line.failed += 1;
      line.errors.push(err.message);
    }
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
      usage: '/brochures?store=<id>&region=<key>',
    });
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

  // Guarded manual ingest (§8) — for testing/backfill without the cron. Shared
  // secret header; cron uses ingestAll directly (no HTTP, no secret needed).
  if (path === '/ingest' && request.method === 'POST') {
    if (!ctx.ingestSecret || request.headers.get('X-Ingest-Secret') !== ctx.ingestSecret) {
      return json({ error: 'Forbidden' }, 403);
    }
    const store = (url.searchParams.get('store') || '').trim() || undefined;
    if (store && !ctx.registry[store]) return json({ error: `Unknown store '${store}'.` }, 404);
    const report = await ingestAll(ctx, { store });
    return json(report);
  }

  return json({ error: 'Not found' }, 404);
}
