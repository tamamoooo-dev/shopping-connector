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

// Ingest one provider/region's offers. Returns a report line.
export async function ingestOffersForTarget(ctx, provider, region) {
  const line = { store: provider.id, region, fetched: 0, stored: 0, dropped: 0, linked: 0, skipped: false, errors: [] };
  const regionConfig = provider.regions[region];
  const cfg = offersConfigFor(regionConfig);
  if (!cfg || !ctx.offersSource || !ctx.offerStore) {
    line.skipped = true;
    return line;
  }

  try {
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
      const offer = buildOffer(raw, {
        store: provider.id,
        region,
        source: ctx.offersSource.name,
        detectedAt,
      });
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
    if (rows.length) await ctx.offerStore.upsertMany(rows);
    line.stored = rows.length;

    // Price History (Pillar 3): every offer is a price observation. Derive
    // identities and record first-sighting/price-change points — D1-only work,
    // zero external subrequests, idempotent on re-ingest (see priceHistory.js).
    if (ctx.historyStore && offers.length) {
      const h = await recordOfferHistory(ctx.historyStore, offers, { observedAt: detectedAt });
      line.history = { identities: h.identities, points: h.points, skipped: h.skipped };
    }
  } catch (err) {
    line.errors.push(err.message);
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
      failed: t.failed + (l.errors.length ? 1 : 0),
    }),
    { fetched: 0, stored: 0, dropped: 0, linked: 0, failed: 0 },
  );
  return report;
}
