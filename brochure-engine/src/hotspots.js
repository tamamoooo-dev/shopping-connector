// hotspots.js — ClickFlyer-style per-product TAP TARGETS for brochure pages.
//
// D4D's flyer viewer embeds, in the SAME leaflet HTML the brochure adapter
// already reads, a per-page `data-coords-json` blob: one polygon per product,
// keyed by `id_product` — the very same id (`idoffer_special`) the structured
// offers ingest stores as offers.offer_id. That makes a fully automatic
// tap-a-product experience possible with data we already hold:
//
//   tap (x,y) on stored pageNN.webp
//     -> hotspot polygon (this module, parsed from the flyer HTML)
//     -> offers row in D1 (price, was-price, bilingual name, product crop)
//
// Serving model: ON DEMAND with a permanent KV cache. Geometry for an edition
// is immutable (same bytes, same coords), so the first request for a brochure
// costs ONE external subrequest (the flyer HTML) + one KV write; every later
// request is a KV read. Nothing changes in the ingest pipeline or its budgets,
// and every ALREADY-HELD brochure gets hotspots immediately — no re-ingest.
// The cached blob lives under the edition's storage prefix, so retention
// prunes it together with the page images.
//
// Page alignment: the flyer HTML keys pages by `data-index` — the exact value
// the brochure adapter stored as each page's `index` in meta.json. Hotspot
// pages therefore join viewer pages on that index, never on ordinal position.
//
// Coordinates: D4D polygons are pixels in the page's `data-width`/`data-height`
// frame. We reduce each polygon to a bounding box normalized to 0..1 fractions
// so the frontend can position tap targets on ANY rendered size of the same
// page image (the stored webp shares the flyer's aspect ratio).

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// --- pure parser ---------------------------------------------------------------
// Flyer HTML -> [{ index, spots: [{ offerId, x, y, w, h }] }] (fractions 0..1).
//
// Two complementary blob locations cover every page (verified live):
//   • the lazy carousel copy wraps each spread's FIRST page:
//       <figure class="image-container flyer-container" data-coords-json='…'>
//         <picture class="offer-page" data-index="N" data-width="W" data-height="H">
//   • the plain copy carries the spread's SECOND page on the preceding picture:
//       <picture class="offer-page" data-index="N" … data-next-page-coords='…'>
//     (those coords belong to page N+1)
// First-seen wins on a duplicate index; pages with no blob simply have no spots.
export function parseHotspots(html) {
  const byIndex = new Map(); // index -> { spots, w, h }
  const dims = new Map(); // index -> { w, h } from any picture sighting

  const pictureRe = /<picture class="offer-page"([^>]*)>/gi;
  for (const m of String(html || '').matchAll(pictureRe)) {
    const attrs = m[1];
    const idx = num(/data-index="(\d+)"/.exec(attrs));
    if (idx == null) continue;
    const w = num(/data-width="(\d+)"/.exec(attrs));
    const h = num(/data-height="(\d+)"/.exec(attrs));
    if (w && h && !dims.has(idx)) dims.set(idx, { w, h });
    const next = /data-next-page-coords='(\[[^']*\])'/.exec(attrs);
    if (next) addPage(byIndex, idx + 1, next[1]);
  }

  // Carousel copy: pair each container blob with the picture nested inside it.
  const containerRe =
    /<figure class="image-container flyer-container" data-coords-json='(\[[^']*\])'>[\s\S]*?<picture class="offer-page"([^>]*)>/gi;
  for (const m of String(html || '').matchAll(containerRe)) {
    const idx = num(/data-index="(\d+)"/.exec(m[2]));
    if (idx == null) continue;
    const w = num(/data-width="(\d+)"/.exec(m[2]));
    const h = num(/data-height="(\d+)"/.exec(m[2]));
    if (w && h && !dims.has(idx)) dims.set(idx, { w, h });
    addPage(byIndex, idx, m[1]);
  }

  const pages = [];
  for (const [index, raw] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    // Pages inherit their own dims; a next-page blob falls back to its
    // sibling's (one flyer's pages share dimensions in practice).
    const d = dims.get(index) || dims.get(index - 1) || dims.get(index + 1);
    if (!d) continue;
    const spots = [];
    for (const prod of raw) {
      const id = prod && prod.id_product != null ? String(prod.id_product) : null;
      const pts = prod && Array.isArray(prod.coordinates) ? prod.coordinates : [];
      if (!id || !pts.length) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        const px = Number(p && p.x);
        const py = Number(p && p.y);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
      if (!(maxX > minX) || !(maxY > minY)) continue;
      const clamp = (v) => Math.min(1, Math.max(0, v));
      const x = clamp(minX / d.w);
      const y = clamp(minY / d.h);
      const spot = {
        offerId: id,
        x: round4(x),
        y: round4(y),
        w: round4(clamp(maxX / d.w) - x),
        h: round4(clamp(maxY / d.h) - y),
      };
      if (spot.w > 0.005 && spot.h > 0.005) spots.push(spot);
    }
    if (spots.length) pages.push({ index, spots });
  }
  return pages;
}

function addPage(byIndex, index, rawJson) {
  if (byIndex.has(index)) return;
  let parsed;
  try {
    parsed = JSON.parse(rawJson.split('\\/').join('/'));
  } catch {
    return; // a malformed blob loses one page's spots, never the request
  }
  if (Array.isArray(parsed)) byIndex.set(index, parsed);
}

const num = (m) => (m ? Number(m[1]) : null);
const round4 = (v) => Math.round(v * 10000) / 10000;

// The D4D flyer id inside a leaflet URL: /offers/<store-slug>/<flyerId>/<slug>.
export function flyerRefFromUrl(sourceUrl) {
  const m = /\/offers\/[^/]+\/(\d+)(?:\/|$)/.exec(String(sourceUrl || ''));
  return m ? m[1] : null;
}

// --- doc builder (the /brochures/hotspots read path) ----------------------------
// getHotspotsDoc(ctx, brochureId) -> { brochure, pages, offers } | { error }.
// `offers` maps offerId -> the same read-API offer shape /offers serves, so the
// frontend joins a tapped spot to its product with zero extra requests.
export async function getHotspotsDoc(ctx, brochureId, { fetchImpl = fetch, rowToOffer } = {}) {
  const row = await ctx.metadataStore.getById(brochureId);
  if (!row) return { status: 404, doc: { error: 'Brochure not found' } };

  const empty = { brochure: brochureId, pages: [], offers: {} };
  // Hotspots exist only for aggregator image sets whose source is a D4D
  // leaflet page (PDF/link brochures have no per-product geometry).
  if (row.source_type !== 'images' || !/^https:\/\/d4donline\.com\//.test(row.source_url || '')) {
    return { status: 200, doc: empty };
  }

  const cacheKey = `brochures/${row.storage_key}/hotspots.json`;
  let pages = null;
  const cached = await ctx.objectStore.get(cacheKey);
  if (cached) {
    try {
      pages = JSON.parse(new TextDecoder().decode(cached.bytes)).pages || [];
    } catch {
      pages = null; // corrupt cache -> refetch below
    }
  }

  if (!pages) {
    let html;
    try {
      const res = await fetchImpl(row.source_url, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch {
      // Source unreachable (or the edition's flyer page is gone): serve "no
      // hotspots" WITHOUT caching, so a transient failure heals on retry.
      return { status: 200, doc: empty };
    }
    pages = parseHotspots(html);
    // Cache even an empty parse: a flyer with no coords stays coord-less for
    // its (immutable) edition — refetching it weekly would be waste.
    await ctx.objectStore.put(
      cacheKey,
      new TextEncoder().encode(JSON.stringify({ pages })),
      { contentType: 'application/json' },
    );
  }

  // Join the spots' products from D1 in one query by the flyer id.
  const offers = {};
  const flyerRef = flyerRefFromUrl(row.source_url);
  if (flyerRef && ctx.offerStore && ctx.offerStore.byFlyer) {
    const rows = await ctx.offerStore.byFlyer(row.store, row.region, flyerRef);
    for (const r of rows) offers[r.offer_id] = rowToOffer ? rowToOffer(r) : r;
  }

  return { status: 200, doc: { brochure: brochureId, flyerRef, pages, offers } };
}
