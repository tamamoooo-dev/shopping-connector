// collectors/pdfIndex.js — the PdfIndexCollector (ARCHITECTURE.md §7.1).
//
// Pattern A: "stable index page -> weekly PDF whose URL rotates". This is the
// reference collector and the M1 deliverable. It is COMPLETELY store-agnostic:
// all store knowledge is supplied as config (indexUrl, headers, and a `resolve`
// function that knows how to find the current PDF for a region on that store's
// index). Adding another PDF-index store (e.g. Farm) is a new provider config
// object + its own small `resolve` — ZERO changes to this file (§10.D.1).
//
// It is a FACTORY: given config it returns a strategy
//   { name, collect(ctx) -> Promise<Candidate[]> }
// mirroring a search strategy's { name, run(query) }.
//
//   Candidate = { doc: PartialBrochureDoc, bytes: Uint8Array, contentType }
//
// Behaviour per run (§7.1): fetch the stable index -> resolve the *current* PDF
// URL for the region (never hardcoded — always discovered this run, defeating
// weekly URL churn, §10.F) -> download the PDF -> emit a candidate. The pipeline
// (not the collector) computes the checksum, dedupes, and persists.

import { buildBrochureDoc } from '../contract.js';

const DEFAULT_HEADERS = {
  // Workers' fetch sends no User-Agent by default and many origins reject that.
  // A polite, identifying UA (we are a considerate personal tool, §1) is enough.
  'User-Agent': 'BrochureEngine/0.1 (+https://github.com/tamamoooo-dev)',
  Accept: '*/*',
};

export function createPdfIndexCollector(config) {
  const {
    name = 'pdfIndex',
    indexUrl,
    headers = {},
    // resolve(ctx) -> { pdfUrl, title?, validFrom?, validTo?, publishedAt? } | null
    // ctx = { indexUrl, indexHtml, region, regionConfig, absolutize(href) }
    resolve,
    fetchImpl = fetch,
  } = config;

  if (!indexUrl) throw new Error('pdfIndex: config.indexUrl is required');
  if (typeof resolve !== 'function') throw new Error('pdfIndex: config.resolve must be a function');

  const reqHeaders = { ...DEFAULT_HEADERS, ...headers };

  // Fetch with a single retry on transient upstream failures (5xx / 429 /
  // network error). Store origins (e.g. Othaim, like Danube in the search
  // connector) occasionally drop a request; one gentle retry avoids a spurious
  // "no brochure" without masking a real, persistent outage. A 4xx (except 429)
  // is treated as final.
  async function fetchWithRetry(url, label) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetchImpl(url, { headers: reqHeaders });
        if (res.ok) return res;
        const transient = res.status >= 500 || res.status === 429;
        if (!transient || attempt === 1) {
          throw new Error(`${label} ${url} -> HTTP ${res.status}`);
        }
      } catch (err) {
        if (attempt === 1) throw err;
      }
      await new Promise((r) => setTimeout(r, 400)); // brief backoff
    }
  }

  async function fetchText(url) {
    const res = await fetchWithRetry(url, 'index fetch');
    return res.text();
  }

  return {
    name,
    async collect({ store, region, regionConfig }) {
      // 1. Fetch the stable index page.
      const indexHtml = await fetchText(indexUrl);

      // 2. Resolve the CURRENT pdf URL for this region (store-specific logic,
      //    supplied by config; the collector stays generic).
      const absolutize = (href) => new URL(href, indexUrl).toString();
      const resolved = await resolve({ indexUrl, indexHtml, region, regionConfig, absolutize });
      if (!resolved || !resolved.pdfUrl) {
        throw new Error(`no current PDF found for region '${region}' on ${indexUrl}`);
      }
      const pdfUrl = absolutize(resolved.pdfUrl);

      // 3. Download the PDF bytes.
      const res = await fetchWithRetry(pdfUrl, 'pdf download');
      const contentType = res.headers.get('content-type') || 'application/pdf';
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0) throw new Error(`pdf download ${pdfUrl} was empty`);

      // Prefer a publish date from the source; fall back to the PDF's
      // Last-Modified so the edition key tracks the real publish week (§5.1).
      const publishedAt =
        resolved.publishedAt || res.headers.get('last-modified') || undefined;

      // 4. Build the (partial) BrochureDoc; the pipeline fills the checksum.
      const doc = buildBrochureDoc({
        store,
        region,
        title: resolved.title ?? null,
        validFrom: resolved.validFrom ?? null,
        validTo: resolved.validTo ?? null,
        publishedAt,
        sourceType: 'pdf',
        sourceUrl: indexUrl,
        pdfUrl,
        collector: name,
      });

      return [{ doc, bytes, contentType }];
    },
  };
}
