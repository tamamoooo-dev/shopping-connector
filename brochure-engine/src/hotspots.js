// hotspots.js — ClickFlyer-style per-product TAP TARGETS for brochure pages.
//
// D4D's flyer viewer embeds, in the SAME leaflet HTML the brochure adapter
// already reads, a per-page `data-coords-json` blob: one polygon per product,
// keyed by `id_product` — the very same id (`idoffer_special`) the structured
// offers ingest stores as offers.offer_id. That makes a fully automatic
// tap-a-product experience possible with data we already hold:
//
//   tap (x,y) on stored pageNN.webp
//     -> hotspot polygon (this module, parsed from the flyer HTML AT INGEST)
//     -> offers row in D1 (price, was-price, bilingual name, product crop)
//
// SNAPSHOT MODEL (the runtime-reliability contract): geometry is parsed at
// INGEST TIME, from the same leaflet HTML fetch that yields the page list —
// the d4d adapter runs parseHotspots on that HTML, the collector carries the
// result on each candidate, and the pipeline writes `hotspots.json` next to
// the page images it stores from the same document. Pages and geometry are
// therefore two views of ONE rendering and can never misalign, and D4D
// changing anything after ingestion (re-rendered flyers, changed markup,
// removed pages) cannot invalidate what is already stored. The read path
// below serves ONLY the stored snapshot — it never fetches from D4D.
//
// A D4D markup change now degrades cleanly at ingest (an empty geometry
// snapshot, no spots rendered) and self-heals on the next ingest after the
// parser is fixed — it can no longer break brochures that were already
// working.
//
// Page alignment: hotspot pages are keyed by the STORED ordinal page index
// (the `index` field in meta.json / the NN in pageNN.webp). The adapter
// remaps D4D's `data-index` to that ordinal via remapHotspotPages, so a
// source page with no image (skipped at ingest) can never shift the join.
//
// Coordinates: D4D polygons are pixels in the page's `data-width`/`data-height`
// frame. We reduce each polygon to a bounding box normalized to 0..1 fractions
// so the frontend can position tap targets on ANY rendered size of the same
// page image (the stored webp shares the flyer's aspect ratio).

// --- pure parser ---------------------------------------------------------------
// Flyer HTML -> [{ index, spots: [{ offerId, x, y, w, h }] }] (fractions 0..1),
// keyed by the SOURCE `data-index` (remap to stored ordinals before persisting).
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

// Remap parser output (keyed by SOURCE data-index) onto the STORED ordinal
// page indexes. `sourceIndexes[i]` is the source data-index of the page stored
// at ordinal i — the adapter derives it from the same leaflet HTML. Hotspots
// for source pages that were not stored (no image) are dropped; the join
// between hotspots.json and meta.json becomes identity by construction.
export function remapHotspotPages(hotspotPages, sourceIndexes) {
  const ordinalBySource = new Map();
  (sourceIndexes || []).forEach((src, i) => {
    if (src != null && !ordinalBySource.has(src)) ordinalBySource.set(src, i);
  });
  const out = [];
  for (const p of hotspotPages || []) {
    const ordinal = ordinalBySource.get(p.index);
    if (ordinal != null) out.push({ index: ordinal, spots: p.spots });
  }
  return out.sort((a, b) => a.index - b.index);
}

// The D4D flyer id inside a leaflet URL: /offers/<store-slug>/<flyerId>/<slug>.
export function flyerRefFromUrl(sourceUrl) {
  const m = /\/offers\/[^/]+\/(\d+)(?:\/|$)/.exec(String(sourceUrl || ''));
  return m ? m[1] : null;
}

// --- doc builder (the /brochures/hotspots read path) ----------------------------
// getHotspotsDoc(ctx, brochureId) -> { brochure, pages, offers } | { error }.
// STORAGE-ONLY: reads the hotspots.json snapshot the ingest stored next to the
// page images, joins the flyer's offers rows from D1, and never fetches from
// the aggregator. A brochure with no snapshot (ingested before capture, or a
// flyer whose HTML carried no geometry) simply serves no spots — the next
// ingest run heals it. `offers` maps offerId -> the same read-API offer shape
// /offers serves, so the frontend joins a tapped spot with zero extra requests.
export async function getHotspotsDoc(ctx, brochureId, { rowToOffer } = {}) {
  const row = await ctx.metadataStore.getById(brochureId);
  if (!row) return { status: 404, doc: { error: 'Brochure not found' } };

  const empty = { brochure: brochureId, pages: [], offers: {} };
  // Only image-set brochures have per-product geometry (PDF/link ones don't).
  if (row.source_type !== 'images') return { status: 200, doc: empty };

  let pages = [];
  const stored = await ctx.objectStore.get(`brochures/${row.storage_key}/hotspots.json`);
  if (stored) {
    try {
      pages = JSON.parse(new TextDecoder().decode(stored.bytes)).pages || [];
    } catch {
      pages = []; // corrupt snapshot -> no spots; the next ingest rewrites it
    }
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
