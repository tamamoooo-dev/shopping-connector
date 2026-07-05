// collectors/adapters/d4d.js — the D4D Online adapter for the generic
// AggregatorCollector (ARCHITECTURE.md §7.2). Replaces the retired OffersInMe
// adapter as the project's sole aggregator (Brochure Source Migration).
//
// ONE adapter per aggregator. This is aggregator-generic, NOT store-specific:
// it knows D4D's URL scheme and page markup, nothing about any store. The
// store-specific bits (which D4D store slug+id a store maps to, and which city
// = region to read) arrive as `regionConfig` from the provider (project rule 2
// / §5.3), so a new aggregator store is a provider config addition, not an
// adapter change.
//
// Why D4D (replacing OffersInMe): D4D Online server-renders clean, fetchable
// pages for the KSA stores, scopes offers by CITY in the URL path (so Riyadh =
// Central is selected by the URL, not a slug matcher), and — crucially — carries
// CURRENT Riyadh flyers with machine-readable validity dates (JSON-LD
// datePublished/expires), which OffersInMe increasingly lacked (stale/lagging
// flyers). The AggregatorCollector is adapter-driven precisely so this swap is a
// one-file change (§10.F risk #1: "don't hard-depend on one aggregator").
//
// D4D shape (verified live against the KSA site):
//   store page:  https://d4donline.com/en/saudi-arabia/<city>/offers/<slug>-<id>
//                -> offer cards: <a href=".../offers/<slug>-<id>/<offerId>/<offerSlug>"
//                                   class="book-cover" title="… . <expiresISO>">
//                   (the store page's raw HTML lists only CURRENT offers; the
//                    expired archive is loaded client-side and never fetched)
//   leaflet page: https://d4donline.com/en/saudi-arabia/<city>/offers/<slug>-<id>/<offerId>/<offerSlug>
//                -> JSON-LD CreativeWork: name / datePublished / expires
//                -> page images as <picture class="offer-page" data-index="<n>">
//                     <img src="https://cdn.d4donline.com/u/d/YY/MM/DD/<hash>.webp" alt="Page n+1">
//                   (data-index is the 0-based page order; the hash filename
//                    carries no index, so we key on data-index)
//
// Interface (the brochure analogue of a search adapter), identical to the one
// the AggregatorCollector expects:
//   name
//   listBrochures(storeKey, ctx) -> Promise<Brochure[]>
//     ctx = { region, regionConfig, fetchText, maxCandidates }
//     Brochure = { id, slug, title, validFrom, validTo, pages:[imageUrl…],
//                  pageIds:[…], hotspots:[{index,spots}…], sourceUrl }
// The collector downloads the page-image BYTES (the heavy part) for only the
// chosen brochure; this adapter fetches only HTML.
//
// SNAPSHOT-AT-INGEST: the leaflet HTML parsed here is the ONLY D4D fetch the
// hotspot experience ever makes — per-product tap geometry (hotspots.js
// parseHotspots) is extracted from the SAME document that lists the page
// images, remapped to the stored ordinal page indexes, and carried on the
// Brochure so the pipeline persists it next to the pages. Nothing at runtime
// re-reads D4D, so a later D4D re-render/markup change cannot invalidate a
// brochure that already ingested.

import { parseHotspots, remapHotspotPages } from '../../hotspots.js';

const HOST = 'https://d4donline.com';
const DEFAULT_CITY = 'riyadh'; // Central region == Riyadh for this project

// today's date (UTC, YYYY-MM-DD) — the currency cutoff.
const todayISO = () => new Date().toISOString().slice(0, 10);

// Escape a store slug for safe interpolation into a RegExp.
function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The store page lists its current offers as `book-cover` links whose `title`
// attribute ends with the offer's expiry ISO. Extract { id, slug, url, expiry }
// per offer, deduped by offer id.
function extractOffers(html, storeKey, city) {
  const seen = new Map(); // offerId -> offer
  const re = new RegExp(
    `/offers/${esc(storeKey)}/(\\d+)/([a-z0-9-]+)"\\s+class="book-cover"\\s+title="([^"]*)"`,
    'gi',
  );
  for (const m of html.matchAll(re)) {
    const id = Number(m[1]);
    if (seen.has(id)) continue;
    const expiry = (/(\d{4}-\d{2}-\d{2})T[\d:]+Z/.exec(m[3]) || [])[1] || null;
    seen.set(id, {
      id,
      slug: m[2].toLowerCase(),
      url: `${HOST}/en/saudi-arabia/${city}/offers/${storeKey}/${m[1]}/${m[2]}`,
      expiry,
    });
  }
  return [...seen.values()];
}

// "2026-06-30T21:30:00Z" -> "2026-06-30" (null if absent/unparseable).
function isoDate(text) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(text || '');
  return m ? m[1] : null;
}

// Parse one leaflet page into a Brochure (title + validity from JSON-LD, ordered
// page images from the <picture class="offer-page"> blocks).
function parseLeaflet(html, offer) {
  const title =
    (/"@type":"CreativeWork","name":"([^"]*)"/.exec(html) || [])[1] || offer.slug || null;
  const validFrom = isoDate((/"datePublished":"([^"]+)"/.exec(html) || [])[1]);
  const validTo = isoDate((/"expires":"([^"]+)"/.exec(html) || [])[1]) || offer.expiry;

  // Each flyer page is a <picture class="offer-page" … data-index="N"
  // [data-page-id="PID"]> … <img (src|data-page-src)="cdn…">. D4D renders each
  // page twice (a plain copy carrying the image URL and a lazy carousel copy
  // carrying the data-page-id an OFFER deep-links to via its `?page=<PID>` /
  // `pageRef`); merging by data-index gives each page BOTH its image and its
  // page id, so a flyer offer can later open the in-app viewer on ITS page
  // rather than page 1. Pages with no image are skipped; a missing page id is
  // simply null (the viewer then opens at the first page).
  const byIndex = new Map(); // index -> { url, pageId }
  const re = /<picture class="offer-page"([^>]*)>([\s\S]*?)<\/picture>/gi;
  for (const m of html.matchAll(re)) {
    const idx = Number((/data-index="(\d+)"/.exec(m[1]) || [])[1]);
    if (!Number.isInteger(idx)) continue;
    const pageId = (/data-page-id="(\d+)"/.exec(m[1]) || [])[1] || null;
    const url =
      (/<img[^>]+\ssrc="(https:\/\/cdn\.d4donline\.com\/[^"]+?)"/i.exec(m[2]) || [])[1] ||
      (/data-page-src="(https:\/\/cdn\.d4donline\.com\/[^"]+?)"/i.exec(m[2]) || [])[1] ||
      null;
    const prev = byIndex.get(idx) || { url: null, pageId: null };
    byIndex.set(idx, { url: prev.url || url, pageId: prev.pageId || pageId });
  }
  const entries = [...byIndex.entries()].filter(([, v]) => v.url).sort((a, b) => a[0] - b[0]);
  const pages = entries.map(([, v]) => v.url);
  const pageIds = entries.map(([, v]) => v.pageId);

  // Per-product tap geometry, captured from THIS SAME document (snapshot-at-
  // ingest) and remapped from D4D's data-index onto the ordinal position each
  // page will be STORED under — so hotspots.json and meta.json always describe
  // the same rendering with the same indexes, even if a source page had no
  // image and shifted the ordinals.
  const hotspots = remapHotspotPages(parseHotspots(html), entries.map(([srcIdx]) => srcIdx));

  return { id: offer.id, slug: offer.slug, title, validFrom, validTo, pages, pageIds, hotspots, sourceUrl: offer.url };
}

export const d4dAdapter = {
  name: 'd4d',

  async listBrochures(storeKey, { region, regionConfig = {}, fetchText, maxCandidates = 4 } = {}) {
    if (!storeKey) throw new Error(`d4d: region '${region}' has no store slug configured`);
    if (typeof fetchText !== 'function') throw new Error('d4d: fetchText is required');

    const city = regionConfig.city || DEFAULT_CITY;
    const html = await fetchText(`${HOST}/en/saudi-arabia/${city}/offers/${storeKey}`);

    // Currency (§ rule "confirm dates are current"): keep only offers that are
    // NOT expired. D4D scopes offers to the city in the URL, so — unlike the
    // OffersInMe adapter — no per-store slug include/exclude is needed for
    // region selection; the region IS the city path.
    const cutoff = todayISO();
    let offers = extractOffers(html, storeKey, city).filter(
      (o) => !o.expiry || o.expiry >= cutoff,
    );

    // Newest first (higher offer id == more recently published), then cap the
    // number of leaflet pages we fetch — gentle on the aggregator (§10.F).
    offers.sort((a, b) => b.id - a.id);
    offers = offers.slice(0, maxCandidates);

    const out = [];
    for (const offer of offers) {
      try {
        const parsed = parseLeaflet(await fetchText(offer.url), offer);
        if (parsed.pages.length) out.push(parsed);
      } catch {
        /* skip a leaflet that fails to fetch/parse; others still count */
      }
    }
    return out;
  },
};
