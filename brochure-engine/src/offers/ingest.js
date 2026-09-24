// offers/ingest.js — the structured-offers ingest. Store-agnostic: which
// offers source a store uses and how it is addressed there is provider config;
// this module only orchestrates source -> normalize -> gate -> link -> store.
//
// Runs INSIDE the same per-store child invocation as the brochure ingest (the
// Architecture-C fan-out), after it — the freshly-committed brochure editions
// are what offers link to. An offers pull is cheap (1 HTML GET + 2-3 JSON
// POSTs), so brochures (≤ ~43 subrequests) + offers (≤ ~4) fit one child's
// Free-plan 50-subrequest budget.

import { buildOffer, isUnpriced, offerToRow, pricePendingRow } from './contract.js';
import { deriveIdentity, recordOfferHistory } from '../priceHistory.js';
import { detectBrand } from '../browse/brands.js';
import {
  acceptedNavigation,
  addPageEvidence,
  aggregateNavigationHealth,
  assessNavigation,
} from './navigationPolicy.js';

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

function decodeJson(obj) {
  if (!obj || !obj.bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(obj.bytes));
  } catch {
    return null;
  }
}

// Build the exact source-offer -> downloaded-page linkage from COMPLETE local
// snapshots. meta.json is the publication commit marker: partial/resumable
// page objects are deliberately invisible until every advertised page and the
// matching hotspots snapshot have been stored.
async function localNavigationByFlyer(ctx, store, region) {
  const out = new Map();
  if (!ctx.metadataStore || !ctx.objectStore) return out;

  for (const row of await ctx.metadataStore.getCurrent(store, region)) {
    if (row.source_type !== 'images' || row.pruned_at || !row.storage_key) continue;
    const flyerRef = flyerIdFromSourceUrl(row.source_url);
    if (!flyerRef) continue;
    const base = `brochures/${row.storage_key}`;
    const [metaObj, hotspotsObj] = await Promise.all([
      ctx.objectStore.get(`${base}/meta.json`),
      ctx.objectStore.get(`${base}/hotspots.json`),
    ]);
    const meta = decodeJson(metaObj);
    if (
      !meta ||
      meta.complete !== true ||
      !Number.isInteger(meta.advertisedPageCount) ||
      !Array.isArray(meta.pages) ||
      meta.pages.length !== meta.advertisedPageCount ||
      !meta.pages.length
    ) continue;
    const indexes = new Set(meta.pages.map((page) => page.index));
    if (
      indexes.size !== meta.advertisedPageCount ||
      !meta.pages.every((page, index) => page.index === index && page.imageUrl)
    ) continue;
    // Both source identifiers are represented as SETS of stored pages. A plain
    // Map<id,page> is last-write-wins and silently converts a future duplicate
    // into a trusted answer. Policy B requires us to observe and reject that
    // ambiguity instead.
    const byPageRef = new Map();
    for (const page of meta.pages) {
      if (page.pageId != null && Number.isInteger(page.index)) {
        addPageEvidence(byPageRef, page.pageId, page.index);
      }
    }
    const byOfferId = new Map();
    const hotspots = decodeJson(hotspotsObj);
    if (!hotspots || !Array.isArray(hotspots.pages)) continue;
    for (const page of hotspots?.pages || []) {
      if (!Number.isInteger(page.index) || !indexes.has(page.index)) continue;
      for (const spot of page.spots || []) {
        addPageEvidence(byOfferId, spot.offerId, page.index);
      }
    }
    out.set(String(flyerRef), {
      brochureId: row.id,
      edition: row.edition,
      byPageRef,
      byOfferId,
    });
  }
  return out;
}

// Ingest one provider/region's offers. Returns a report line.
export async function ingestOffersForTarget(ctx, provider, region) {
  const line = {
    store: provider.id,
    region,
    fetched: 0,
    stored: 0,
    dropped: 0,
    unpriced: 0,
    visionPriced: 0,
    linked: 0,
    unbacked: 0,
    mappingAnomalies: 0,
    skipped: false,
    errors: [],
  };
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

    const navigationByFlyer = await localNavigationByFlyer(ctx, provider.id, region);

    const detectedAt = new Date().toISOString();
    const built = { store: provider.id, region, source: ctx.offersSource.name, detectedAt };
    const offers = [];
    const unpriced = []; // [{ raw, row }] — the vision price fallback's intake
    for (const raw of raws) {
      const offer = buildOffer(raw, built);
      if (!offer) {
        // No usable source price (D4D since 2026-09-22): queue it for the
        // vision price fallback (offers/priceFallback.js) instead of losing it.
        const row = isUnpriced(raw) ? pricePendingRow(raw, built) : null;
        if (row) unpriced.push({ raw, row });
        else line.dropped += 1; // failed the sanity gates (no usable price/id)
        continue;
      }
      // Stamp the derived cross-week identity (the SAME derivation the price
      // history harvest uses) so Browse can join an offer to its history with
      // one indexed lookup. Null when the OCR name is too weak — by design.
      // Transitional Browse/legacy-history analytics only. This `ph_*` key is
      // isolated from Registry's authoritative `pr_*` Product IDs.
      const ident = deriveIdentity(offer);
      offer.identity = ident ? ident.id : null;
      // Stamp the canonical brand (Browse's brand entry point). The weekly
      // upsert refreshes it, so a brand-knowledge addition reaches every
      // CURRENT offer on the next ingest with no backfill.
      offer.brandSlug = detectBrand(offer);
      offers.push(offer);
    }

    // Vision price fallback intake. A record the fallback already PRICED is
    // rebuilt here as a normal offer with its accepted price, so it keeps the
    // same navigation, identity, brand and history stamping as every other
    // offer on each ingest. Everything else is (re)queued; the queue keeps its
    // decisions across ingests, so nothing is read twice. Best-effort: a queue
    // failure must never fail the ingest (the brochure publisher treats an
    // offers-ingest error as fatal). NOTE the offers upsert itself writes
    // price_source, so migrate-2026-09-24-price-fallback.sql must be applied
    // BEFORE this Worker is deployed.
    line.unpriced = unpriced.length;
    if (unpriced.length && typeof ctx.offerStore.upsertPricePending === 'function') {
      try {
        const decided = new Map(
          (await ctx.offerStore.pricePendingByIds(unpriced.map((u) => u.row.id)))
            .map((p) => [p.id, p]),
        );
        for (const { raw, row } of unpriced) {
          const p = decided.get(row.id);
          if (p?.status !== 'accepted' || !(Number(p.price) > 0)) continue;
          const offer = buildOffer({ ...raw, price: p.price, wasPrice: p.old_price }, built);
          if (!offer) continue;
          const ident = deriveIdentity(offer);
          offer.identity = ident ? ident.id : null;
          offer.brandSlug = detectBrand(offer);
          offer.priceSource = 'vision';
          offers.push(offer);
          line.visionPriced += 1;
        }
        await ctx.offerStore.upsertPricePending(unpriced.map((u) => u.row));
      } catch (err) {
        line.priceFallbackError = err.message;
      }
    }

    // Fetch the still-current stored rows once, before writing. They are part
    // of the trust assessment even when D4D omitted them from today's response,
    // and the same snapshot/decision is reused by the relinker below.
    const currentOn = new Date().toISOString().slice(0, 10);
    const storedByFlyer = new Map();
    if (typeof ctx.offerStore.byFlyer === 'function') {
      for (const flyerRef of navigationByFlyer.keys()) {
        const stored = (await ctx.offerStore.byFlyer(provider.id, region, flyerRef))
          .filter((row) => row.valid_to && row.valid_to >= currentOn);
        storedByFlyer.set(flyerRef, stored);
      }
    }

    const candidates = new Map(offers.map((offer) => [offer.id, offer]));
    for (const stored of storedByFlyer.values()) {
      for (const row of stored) {
        if (!candidates.has(row.id)) candidates.set(row.id, row);
      }
    }
    const assessment = assessNavigation(
      navigationByFlyer,
      [...candidates.values()],
      ctx.navigationPolicy,
    );
    line.navigation = assessment.health;

    // Stamp Policy B on fresh rows. Dual evidence always wins. The fallback is
    // accepted only when the exact hotspot occurs on one page AND the target's
    // ambiguity/disagreement circuit remains closed.
    const rows = [];
    for (const offer of offers) {
      const nav = offer.flyerRef
        ? navigationByFlyer.get(String(offer.flyerRef))
        : null;
      const resolution = assessment.resolutions.get(offer.id);
      const accepted = acceptedNavigation(resolution, assessment.health);
      if (!nav || !accepted) {
        line.unbacked += 1;
        if (nav) line.mappingAnomalies += 1;
        // Keep the raw offer (and exact flyer_ref) as unavailable data. This
        // clears stale links while preserving the source evidence for recovery.
        offer.brochureId = null;
        offer.pageIndex = null;
        offer.navigationProvenance = null;
        offer.edition = null;
      } else {
        offer.brochureId = nav.brochureId;
        offer.pageIndex = accepted.pageIndex;
        offer.navigationProvenance = accepted.provenance;
        offer.edition = nav.edition;
        line.linked += 1;
      }
      rows.push(offerToRow(offer));
    }
    if (rows.length) await ctx.offerStore.upsertMany(rows);
    line.stored = rows.length;

    // Relink every still-current stored row for each completed flyer, not only
    // rows returned by this particular D4D response. D4D's current response can
    // omit offers that remain valid and indexed; those rows must recover their
    // exact local page when the brochure becomes complete.
    if (
      typeof ctx.offerStore.byFlyer === 'function' &&
      typeof ctx.offerStore.updateNavigation === 'function'
    ) {
      const updates = [];
      let restored = 0;
      for (const [flyerRef, nav] of navigationByFlyer) {
        const storedOffers = storedByFlyer.get(flyerRef) || [];
        for (const stored of storedOffers) {
          const resolution = assessment.resolutions.get(stored.id);
          const accepted = acceptedNavigation(resolution, assessment.health);
          if (accepted && !stored.brochure_id) restored += 1;
          updates.push({
            id: stored.id,
            brochureId: accepted ? nav.brochureId : null,
            pageIndex: accepted ? accepted.pageIndex : null,
            navigationProvenance: accepted ? accepted.provenance : null,
            edition: accepted ? nav.edition : null,
          });
        }
      }
      if (updates.length) await ctx.offerStore.updateNavigation(updates);
      line.relinked = updates.length;
      line.restored = restored;
    }

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
      unpriced: t.unpriced + (l.unpriced || 0),
      visionPriced: t.visionPriced + (l.visionPriced || 0),
      linked: t.linked + l.linked,
      restored: t.restored + (l.restored || 0),
      unbacked: t.unbacked + l.unbacked,
      mappingAnomalies: t.mappingAnomalies + l.mappingAnomalies,
      failed: t.failed + (l.errors.length ? 1 : 0),
    }),
    {
      fetched: 0,
      stored: 0,
      dropped: 0,
      unpriced: 0,
      visionPriced: 0,
      linked: 0,
      restored: 0,
      unbacked: 0,
      mappingAnomalies: 0,
      failed: 0,
    },
  );
  report.totals.navigation = aggregateNavigationHealth(
    report.targets.map((target) => target.navigation),
  );
  return report;
}
