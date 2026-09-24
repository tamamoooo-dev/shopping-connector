// Read-only diagnosis: why does the flyer viewer show whole pages (no per-offer
// tap boxes / crops)? GETs only — production engine + D4D HTML. Writes nothing.
import { parseHotspots } from '../src/hotspots.js';

const ENGINE = 'https://brochure-engine.tamamoooo.workers.dev';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const get = async (url, as = 'json') => {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return as === 'json' ? r.json() : r.text();
};
const count = (s, re) => (s.match(re) || []).length;

const { brochures = [] } = await get(`${ENGINE}/brochures?cb=${Date.now()}`);
console.log(`engine /brochures: ${brochures.length} brochures`);
const d4d = brochures.filter((b) => /d4donline\.com/.test(b.sourceUrl || ''));
console.log(`d4d-sourced: ${d4d.length}\n`);

console.log('== A. production /brochures/hotspots per brochure ==');
const rows = [];
for (const b of d4d) {
  try {
    const j = await get(`${ENGINE}/brochures/hotspots?id=${encodeURIComponent(b.id)}&cb=${Date.now()}`);
    const pages = j.pages || [];
    const spots = pages.flatMap((p) => p.spots || []);
    const offers = j.offers || {};
    const joined = spots.filter((s) => offers[s.offerId]).length;
    const row = { id: b.id, validFrom: b.validFrom, validTo: b.validTo, detectedAt: b.detectedAt,
      pagesWithSpots: pages.length, spots: spots.length, joined, offers: Object.keys(offers).length,
      flyerRef: j.flyerRef, sourceUrl: b.sourceUrl };
    rows.push(row);
    console.log(JSON.stringify(row));
  } catch (e) {
    console.log(JSON.stringify({ id: b.id, error: e.message }));
  }
}

console.log('\n== B. current D4D leaflet HTML vs the production parser ==');
const seen = new Set();
for (const r of rows) {
  if (!r.sourceUrl || seen.has(r.sourceUrl)) continue;
  seen.add(r.sourceUrl);
  if (seen.size > 12) break;
  try {
    const html = await get(r.sourceUrl, 'text');
    const parsed = parseHotspots(html);
    const markers = {
      bytes: html.length,
      offerPage: count(html, /<picture class="offer-page"/g),
      offerPageAnyClass: count(html, /class="[^"]*offer-page[^"]*"/g),
      flyerContainer: count(html, /flyer-container/g),
      coordsJsonSQ: count(html, /data-coords-json='/g),
      coordsJsonAny: count(html, /data-coords-json/g),
      nextPageCoords: count(html, /data-next-page-coords/g),
      dataWidth: count(html, /data-width="/g),
      idProduct: count(html, /id_product/g),
      coordinates: count(html, /coordinates/g),
    };
    console.log(JSON.stringify({ id: r.id, storedSpots: r.spots, parsedPages: parsed.length,
      parsedSpots: parsed.reduce((n, p) => n + p.spots.length, 0), markers }));
    if (!parsed.length) {
      const i = html.search(/offer-page|coords|flyer-container/);
      console.log('  --- markup sample around first page marker ---');
      console.log('  ' + html.slice(Math.max(0, i - 600), i + 1400).replace(/\s+/g, ' '));
      const c = html.search(/coords|id_product|coordinates/);
      if (c >= 0) console.log('  --- sample around coords ---\n  ' + html.slice(Math.max(0, c - 400), c + 800).replace(/\s+/g, ' '));
    }
  } catch (e) {
    console.log(JSON.stringify({ id: r.id, sourceUrl: r.sourceUrl, error: e.message }));
  }
}
