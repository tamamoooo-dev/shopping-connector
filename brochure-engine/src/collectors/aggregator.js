// collectors/aggregator.js — the AggregatorCollector (ARCHITECTURE.md §7.2).
//
// Pattern D: "third-party aggregator carries every retailer as per-city
// page-image sets." This is the M2 deliverable and the second reusable
// collector. Like PdfIndexCollector it is COMPLETELY store-agnostic: all store
// knowledge is config (which aggregator slug a store maps to, and how to pick
// that store's Central/Riyadh leaflets), supplied by the provider's region map.
//
// It is ALSO aggregator-agnostic: the aggregator-specific parsing lives behind
// an ADAPTER (§7.2 "one collector, one adapter per aggregator"). Swapping or
// adding an aggregator is a new adapter, not a collector change (§10.F risk #1).
//
// It is a FACTORY: given { adapter, … } it returns a strategy
//   { name, collect(ctx) -> Promise<Candidate[]> }
// mirroring PdfIndexCollector and a search strategy's { name, run(query) }.
//
//   Candidate = { doc: PartialBrochureDoc, pages: [{ index, bytes, contentType, url }] }
//
// Behaviour per run (§7.2): ask the adapter for the store's current leaflets in
// this region -> pick the most current one (one BrochureDoc per store+region,
// §4) -> download its page images -> emit a candidate with sourceType "images".
// The pipeline (not the collector) computes the checksum over the concatenated
// page bytes, dedupes, and persists each page + a meta snapshot.

import { buildBrochureDoc } from '../contract.js';

const DEFAULT_HEADERS = {
  // Workers' fetch sends no User-Agent by default; a polite, identifying UA
  // (we are a considerate personal tool, §1) is enough for these public pages.
  'User-Agent': 'BrochureEngine/0.1 (+https://github.com/tamamoooo-dev)',
  Accept: '*/*',
};

// Choose the single "current" brochure for a store+region from the adapter's
// candidates (§4 "one weekly brochure for one store+region"): prefer one whose
// validity window contains today, then the latest validTo, then the newest id.
function pickCurrent(brochures) {
  const today = new Date().toISOString().slice(0, 10);
  const validNow = (b) => (b.validFrom && b.validTo && b.validFrom <= today && today <= b.validTo ? 1 : 0);
  return [...brochures].sort((a, b) => {
    const v = validNow(b) - validNow(a);
    if (v) return v;
    const vt = (b.validTo || '').localeCompare(a.validTo || '');
    if (vt) return vt;
    return (b.id || 0) - (a.id || 0);
  })[0];
}

export function createAggregatorCollector(config) {
  const {
    name = 'aggregator',
    adapter,
    headers = {},
    fetchImpl = fetch,
    // Bound the work per run so the weekly Cron stays gentle on the aggregator
    // (§10.F legal posture) and within a Worker's per-invocation subrequest
    // budget: at most `maxCandidates` leaflet HTML fetches + `maxPages` images.
    maxCandidates = 4,
    maxPages = 40,
  } = config;

  if (!adapter || typeof adapter.listBrochures !== 'function') {
    throw new Error('aggregator: config.adapter with a listBrochures() method is required');
  }

  const reqHeaders = { ...DEFAULT_HEADERS, ...headers };

  // Single retry on transient upstream failures (5xx / 429 / network), matching
  // PdfIndexCollector and the search connector's Danube hardening (§5). A 4xx
  // (except 429) is final.
  async function fetchWithRetry(url, label) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(url, { headers: reqHeaders });
        if (res.ok) return res;
        const transient = res.status >= 500 || res.status === 429;
        if (!transient || attempt === 1) throw new Error(`${label} ${url} -> HTTP ${res.status}`);
      } catch (err) {
        if (attempt === 1) throw err;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const fetchText = async (url) => (await fetchWithRetry(url, 'aggregator fetch')).text();

  return {
    name,
    async collect({ store, region, regionConfig }) {
      if (!regionConfig || !regionConfig.store) {
        throw new Error(`aggregator: region '${region}' has no aggregator store key configured`);
      }

      // 1. Ask the adapter for this store's candidate leaflets in this region.
      const brochures = await adapter.listBrochures(regionConfig.store, {
        region,
        regionConfig,
        fetchText,
        maxCandidates,
      });
      if (!brochures || !brochures.length) return []; // no brochure -> best-first moves on

      // 2. Pick the current one (one BrochureDoc per store+region).
      const best = pickCurrent(brochures);
      if (!best || !best.pages || !best.pages.length) return [];

      // Currency gate (Brochure Source Migration rule "confirm dates current"):
      // never serve an expired flyer. If the best candidate has a known validTo
      // in the past, yield nothing so best-first falls through to the official-
      // offers-page fallback rather than showing a stale brochure.
      const today = new Date().toISOString().slice(0, 10);
      if (best.validTo && best.validTo < today) return [];

      // 3. Download its page images (bounded). The pipeline hashes + stores them.
      const pageUrls = best.pages.slice(0, maxPages);
      const pages = [];
      for (let i = 0; i < pageUrls.length; i++) {
        const res = await fetchWithRetry(pageUrls[i], 'page image');
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength === 0) continue;
        pages.push({
          index: i,
          bytes,
          contentType: res.headers.get('content-type') || 'image/jpeg',
          url: pageUrls[i],
        });
      }
      if (!pages.length) throw new Error(`aggregator: no page images downloaded for ${store}/${region}`);

      // 4. Build the (partial) BrochureDoc; the pipeline fills checksum + page keys.
      const doc = buildBrochureDoc({
        store,
        region,
        title: best.title ?? null,
        validFrom: best.validFrom ?? null,
        validTo: best.validTo ?? null,
        sourceType: 'images',
        sourceUrl: best.sourceUrl ?? null,
        pdfUrl: null,
        collector: name,
      });

      return [{ doc, pages }];
    },
  };
}
