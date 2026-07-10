// offers/ingest.js — the structured-offers ingest. Store-agnostic: which
// offers source a store uses and how it is addressed there is provider config;
// this module only orchestrates source -> normalize -> gate -> link -> store.
//
// Runs INSIDE the same per-store child invocation as the brochure ingest (the
// Architecture-C fan-out), after it — the freshly-committed brochure editions
// are what offers link to. An offers pull is cheap (1 HTML GET + 2-3 JSON
// POSTs), so brochures (≤ ~43 subrequests) + offers (≤ ~4) fit one child's
// Free-plan 50-subrequest budget.

import { buildOffer, offerToRow } from './contract.js';
import { recordOfferHistory } from '../priceHistory.js';

// The provider's offers addressing:
//   regionConfig.offers = { company: <id> }   (explicit — e.g. a PDF-collector
//                                              store that still has offers)
//   or derived from the aggregator store key's trailing id
//   ("lulu-hypermarket-63" -> 63).
export function offersConfigFor(regionConfig = {}) {
  if (regionConfig.offers && regionConfig.offers.company) {
    return {
      company: regionConfig.offers.company,
      city: regionConfig.offers.city || regionConfig.city || 'riyadh',
      storePageSlug: regionConfig.offers.storePageSlug || regionConfig.store || '',
    };
  }
  const m = /-(\d+)$/.exec(regionConfig.store || '');
  if (m) {
    return {
      company: Number(m[1]),
      city: regionConfig.city || 'riyadh',
      storePageSlug: regionConfig.store,
    };
  }
  return null; // this store has no offers source — skip, not an error
}

// Map a held brochure row's sourceUrl to the offers source's flyer id, so an
// offer can be linked to the exact held edition it came from. The aggregator's
// leaflet URLs end in "/<flyerId>/<slug>"; anything else simply doesn't link.
function flyerIdFromSourceUrl(sourceUrl) {
  const m = /\/(\d+)\/[a-z0-9-]+(?:\?.*)?$/i.exec(String(sourceUrl || ''));
  return m ? m[1] : null;
}

// The minimum fraction of the FETCHED offers that must survive to `stored` for a
// promote to be allowed. Normal buildOffer drops (unpriced records, dedupe) are
// a few percent; a run that would promote far less than the source advertised
// (a source returning mostly-unpriced records) is refused so the previous
// healthy dataset stays visible. Tunable per call.
const DEFAULT_COVERAGE_MIN = 0.5;

// Ingest one provider/region's offers — with ATOMIC VISIBILITY. Returns a line.
//
// PHASE 1 (production incident fix, unchanged): brochure ingest and offers
// ingest run in SEPARATE Worker invocations (engine.js /ingest?mode=offers +
// the scheduler dispatcher), so page-image downloads can't starve the offers
// write, and a batch failure is never swallowed.
//
// PHASE 2 (this function): the write is all-or-nothing. Fetch -> STAGE the whole
// set (invisible) -> VALIDATE (complete + covers the source) -> atomic PROMOTE
// (one INSERT…SELECT…ON CONFLICT) -> CLEANUP. If ANY step before the promote
// fails — batch error, subrequest/CPU/time exhaustion, a Worker restart — the
// promote never runs and the visible `offers` table stays the previous complete
// dataset. Nothing is swallowed: a failure is logged, surfaced on the line, and
// fails the ingest upstream.
export async function ingestOffersForTarget(ctx, provider, region, { coverageMin = DEFAULT_COVERAGE_MIN } = {}) {
  const line = { store: provider.id, region, fetched: 0, stored: 0, dropped: 0, linked: 0, ok: false, skipped: false, errors: [] };
  const regionConfig = provider.regions[region];
  const cfg = offersConfigFor(regionConfig);
  if (!cfg || !ctx.offersSource || !ctx.offerStore) {
    line.skipped = true;
    return line;
  }
  const source = ctx.offersSource.name;

  try {
    if (typeof ctx.offerStore.stageMany !== 'function' || typeof ctx.offerStore.promoteStaged !== 'function') {
      throw new Error('offerStore lacks atomic staging (stageMany/stagedCount/promoteStaged)');
    }

    const raws = await ctx.offersSource.listOffers(cfg.company, {
      city: cfg.city,
      storePageSlug: cfg.storePageSlug,
    });
    line.fetched = raws.length;

    // Link map: offers-source flyer id -> held brochure edition (provenance).
    const editionByFlyer = new Map();
    if (ctx.metadataStore) {
      for (const row of await ctx.metadataStore.getCurrent(provider.id, region)) {
        const fid = flyerIdFromSourceUrl(row.source_url);
        if (fid) editionByFlyer.set(fid, row.edition);
      }
    }

    const detectedAt = new Date().toISOString();
    const rows = [];
    const offers = [];
    for (const raw of raws) {
      const offer = buildOffer(raw, { store: provider.id, region, source, detectedAt });
      if (!offer) {
        line.dropped += 1; // failed the sanity gates (no usable price/id)
        continue;
      }
      const edition = offer.flyerRef ? editionByFlyer.get(offer.flyerRef) : null;
      if (edition) {
        offer.edition = edition;
        line.linked += 1;
      }
      offers.push(offer);
      rows.push(offerToRow(offer));
    }
    const built = rows.length;

    if (built) {
      // STAGE — clean slate, then write the whole set (invisible to readers).
      // A batch failure REJECTS here and jumps to the catch: no promote.
      await ctx.offerStore.clearStage(provider.id, region, source);
      await ctx.offerStore.stageMany(rows);
      const staged = await ctx.offerStore.stagedCount(provider.id, region, source);

      // VALIDATE (before promote):
      //  - successful write completion / no batch failures -> staged === built
      if (staged !== built) {
        throw new Error(`offers staging incomplete for ${provider.id}/${region}: staged ${staged} of ${built} — write interrupted; NOT promoted, previous offers preserved`);
      }
      //  - no unexpected coverage loss vs what the source advertised
      const floor = Math.floor(line.fetched * coverageMin);
      if (line.fetched > 0 && staged < floor) {
        throw new Error(`offers coverage too low for ${provider.id}/${region}: ${staged}/${line.fetched} (< ${Math.round(coverageMin * 100)}%) — NOT promoted, previous offers preserved`);
      }

      // PROMOTE — one atomic statement: previous -> full, never partial. If it
      // fails, SQLite rolls the statement back and the catch runs; the visible
      // table is unchanged.
      await ctx.offerStore.promoteStaged(provider.id, region, source);
      line.stored = staged;

      // CLEANUP — best-effort; the promote already committed, so a cleanup
      // failure never affects visibility (next run's clearStage handles it).
      try { await ctx.offerStore.clearStage(provider.id, region, source); } catch { /* non-fatal */ }
    }
    line.ok = true;

    // Price History (Pillar 3): every offer is a price observation. Runs after a
    // successful promote (the offers are now the visible truth). Idempotent on
    // re-ingest (see priceHistory.js).
    if (ctx.historyStore && offers.length) {
      const h = await recordOfferHistory(ctx.historyStore, offers, { observedAt: detectedAt });
      line.history = { identities: h.identities, points: h.points, skipped: h.skipped };
    }
  } catch (err) {
    // Requirement 4: NEVER swallow. Log it, surface it on the line (a non-empty
    // errors[] fails the ingest upstream: route -> 500 -> cron log), and — since
    // we never promoted — leave the previous complete offers untouched. Drop our
    // staged rows so a failed run can never leak into a later promote.
    console.error('brochure-engine offers ingest FAILED', JSON.stringify({ store: provider.id, region, error: err.message }));
    line.errors.push(err.message);
    line.ok = false;
    try { await ctx.offerStore.clearStage(provider.id, region, source); } catch { /* ignore */ }
  }
  return line;
}

// Ingest offers for every region of one provider (or all providers).
export async function ingestOffers(ctx, { store } = {}) {
  const providers = store ? [ctx.registry[store]].filter(Boolean) : Object.values(ctx.registry);
  const report = { startedAt: new Date().toISOString(), targets: [] };
  for (const provider of providers) {
    for (const region of Object.keys(provider.regions)) {
      report.targets.push(await ingestOffersForTarget(ctx, provider, region));
    }
  }
  report.finishedAt = new Date().toISOString();
  report.totals = report.targets.reduce(
    (t, l) => ({
      fetched: t.fetched + l.fetched,
      stored: t.stored + l.stored,
      dropped: t.dropped + l.dropped,
      linked: t.linked + l.linked,
      ok: t.ok + (l.ok ? 1 : 0),
      failed: t.failed + (l.errors.length ? 1 : 0),
    }),
    { fetched: 0, stored: 0, dropped: 0, linked: 0, ok: 0, failed: 0 },
  );
  return report;
}
