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
// this region -> keep EVERY current one (a store may run several flyers at
// once), ranked main-flyer-first -> download page images within a per-run
// budget -> emit one candidate per flyer with sourceType "images". Flyers the
// engine already holds (matched by sourceUrl via ctx.findHeld) are emitted as
// `existing` candidates without re-downloading anything, so consecutive runs
// converge on the full current set while each run stays inside the Free-plan
// subrequest budget. The pipeline (not the collector) computes the checksum
// over the concatenated page bytes, dedupes, and persists each page + a meta
// snapshot.

import { buildBrochureDoc } from '../contract.js';

const DEFAULT_HEADERS = {
  // Workers' fetch sends no User-Agent by default; a polite, identifying UA
  // (we are a considerate personal tool, §1) is enough for these public pages.
  'User-Agent': 'BrochureEngine/0.1 (+https://github.com/tamamoooo-dev)',
  Accept: '*/*',
};

// Rank a store's current brochures, MAIN WEEKLY FLYER FIRST. A store often runs
// several concurrent flyers (the big weekly brochure plus small 1-page promos);
// the ranking must never prefer a 1-page banner over the main brochure. Order:
// validity window contains today, then MOST PAGES, then the latest validTo,
// then the newest id. Also drops expired flyers (the currency gate) and dedupes
// same-campaign duplicates (aggregators list the same flyer several times for
// branch/language variants — same title + validity), keeping the fullest one.
function rankCurrent(brochures) {
  const today = new Date().toISOString().slice(0, 10);
  const validNow = (b) => (b.validFrom && b.validTo && b.validFrom <= today && today <= b.validTo ? 1 : 0);
  const current = brochures.filter(
    (b) => b.pages && b.pages.length && !(b.validTo && b.validTo < today),
  );
  // Dedupe same campaign: same (title, validFrom, validTo) -> keep the one with
  // the most pages (the full flyer, not a per-branch/subset variant).
  const byCampaign = new Map();
  for (const b of current) {
    const key = `${(b.title || b.slug || '').toLowerCase()}|${b.validFrom || ''}|${b.validTo || ''}`;
    const prior = byCampaign.get(key);
    if (!prior || b.pages.length > prior.pages.length) byCampaign.set(key, b);
  }
  return [...byCampaign.values()].sort((a, b) => {
    const v = validNow(b) - validNow(a);
    if (v) return v;
    const p = b.pages.length - a.pages.length;
    if (p) return p;
    const vt = (b.validTo || '').localeCompare(a.validTo || '');
    if (vt) return vt;
    return (b.id || 0) - (a.id || 0);
  });
}

export function createAggregatorCollector(config) {
  const {
    name = 'aggregator',
    adapter,
    headers = {},
    fetchImpl = fetch,
    // Bound the work per run so the weekly Cron stays gentle on the aggregator
    // (§10.F legal posture) and within a Worker's per-invocation subrequest
    // budget (Free plan: 50/invocation): at most `maxCandidates` leaflet HTML
    // fetches, `maxPages` images per flyer (checksum-stable cap), and
    // `maxTotalPages` image downloads per RUN across all flyers. Flyers that
    // don't fit this run's budget are picked up by the next run (the cron
    // already fires twice a week), because already-held flyers cost nothing.
    maxCandidates = 6,
    // 36 (was 40): leaves ~4 subrequests of the child's 50-budget for the
    // structured-offers pull that now runs in the same per-store invocation.
    // maxPages MUST NOT exceed maxTotalPages — a flyer longer than the per-run
    // budget would otherwise never fit ANY run and starve forever; instead it
    // is truncated to the cap (the tail pages of an oversized flyer are the
    // acceptable cost of structured offers riding the same invocation).
    maxPages = 36,
    maxTotalPages = 36,
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
    async collect({ store, region, regionConfig, findHeld, readHeldPages }) {
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

      // 2. Keep EVERY current flyer, ranked main-first. rankCurrent also applies
      // the currency gate (Brochure Source Migration rule "confirm dates
      // current"): expired flyers are dropped, so an all-expired listing yields
      // nothing and best-first falls through to the official-offers-page
      // fallback rather than showing a stale brochure.
      const ranked = rankCurrent(brochures);
      if (!ranked.length) return [];

      // 3. Build each flyer's identity. The primary (main weekly) flyer keeps
      // the plain weekly edition; concurrent siblings get the aggregator offer
      // id as a variant so same-week flyers don't collide.
      const slots = ranked.map((b, i) =>
        [b, buildBrochureDoc({
          store,
          region,
          title: b.title ?? null,
          validFrom: b.validFrom ?? null,
          validTo: b.validTo ?? null,
          sourceType: 'images',
          sourceUrl: b.sourceUrl ?? null,
          pdfUrl: null,
          collector: name,
          variant: i === 0 ? null : String(b.id ?? i),
        })],
      );
      const claimedIds = new Set(slots.map(([, doc]) => doc.id));

      // 4. Emit a candidate per flyer. Already-held flyers (same sourceUrl) are
      // emitted as `existing` (zero downloads) — unless their held row's id is
      // claimed by ANOTHER flyer this run (the row is about to be superseded),
      // in which case they re-download under their own identity. New flyers
      // download their page images within this run's remaining budget; ones
      // that don't fit wait for the next run.
      const out = [];
      const errors = [];
      let budget = maxTotalPages;
      for (const [best, doc] of slots) {
        try {
          // The tap-geometry snapshot the adapter parsed from the same leaflet
          // HTML, truncated to the pages this run can actually store — it rides
          // every candidate so the pipeline persists it WITH the pages.
          const hotspotsFor = (pageCount) =>
            (best.hotspots || []).filter((p) => p.index < pageCount);

          const held = findHeld ? await findHeld(best.sourceUrl) : null;
          if (held && held.checksum && (held.id === doc.id || !claimedIds.has(held.id))) {
            // Re-render detection: the aggregator can re-render a flyer under
            // the SAME URL (page set re-paginated, or deep-link page ids newly
            // exposed). A held match by sourceUrl alone would freeze the stale
            // copy until the edition rolls over, so compare the held page set
            // with what the source advertises now and re-download on drift.
            // Unreadable held meta (pruned bytes) conservatively counts as
            // unchanged — that keeps the zero-download convergence property.
            let stale = false;
            let heldReadable = false;
            if (readHeldPages) {
              const heldPages = await readHeldPages(held);
              if (heldPages && heldPages.length) {
                heldReadable = true;
                const srcCount = Math.min(best.pages.length, maxPages);
                if (heldPages.length !== srcCount) stale = true;
                else if (
                  (best.pageIds || []).slice(0, maxPages).some(Boolean) &&
                  !heldPages.some((p) => p && p.pageId)
                ) {
                  stale = true; // source now carries deep-link ids the held copy lacks
                }
              }
            }
            if (!stale) {
              // Attach the freshly parsed geometry ONLY when the held page set
              // was readable and confirmed to match the source (the !stale
              // path) — then the snapshot describes the stored rendering and
              // the engine can heal a missing/legacy hotspots.json without any
              // re-download. An unreadable meta (pruned bytes) attaches
              // nothing: never resurrect keys retention deleted.
              out.push({
                existing: held,
                ...(heldReadable ? { hotspots: hotspotsFor(Math.min(best.pages.length, maxPages)) } : {}),
              });
              continue;
            }
          }
          const pageUrls = best.pages.slice(0, maxPages);
          const pageIds = (best.pageIds || []).slice(0, maxPages);
          if (pageUrls.length > budget) continue; // next run's budget picks it up

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
              // the aggregator page id an offer deep-links to (null when unknown)
              pageId: pageIds[i] || null,
            });
          }
          if (!pages.length) throw new Error(`no page images downloaded for ${doc.id}`);
          budget -= pages.length;
          out.push({ doc, pages, hotspots: hotspotsFor(pageUrls.length) });
        } catch (err) {
          errors.push(err.message);
        }
      }
      if (!out.length) {
        throw new Error(
          `aggregator: no page images downloaded for ${store}/${region}${errors.length ? ` (${errors.join('; ')})` : ''}`,
        );
      }
      return out;
    },
  };
}
