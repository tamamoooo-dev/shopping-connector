// Read-only: why do current flyers have no offers joined? Production engine
// GETs + the SAME D4D offers request the engine makes (read-only search POST).
import { createD4dOffersSource } from '../src/offers/d4dOffers.js';

const ENGINE = 'https://brochure-engine.tamamoooo.workers.dev';
const HOST = 'https://d4donline.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const j = async (u) => (await fetch(u)).json();

console.log('== 1. engine /health offers ==');
const h = await j(`${ENGINE}/health?cb=${Date.now()}`);
console.log(JSON.stringify({ offers: h.offers, priceHistory: h.priceHistory }));

console.log('\n== 2. stored current offers per store (flyerRef histogram) ==');
for (const store of ['lulu', 'carrefour', 'othaim', 'danube', 'tamimi', 'cityflower', 'prime']) {
  try {
    const d = await j(`${ENGINE}/offers?store=${store}&limit=200&cb=${Date.now()}`);
    const list = d.offers || d.results || [];
    const hist = {};
    for (const o of list) {
      const k = `${o.flyerRef}|${o.validFrom}..${o.validTo}|det ${String(o.detectedAt).slice(0, 10)}`;
      hist[k] = (hist[k] || 0) + 1;
    }
    console.log(store, list.length, JSON.stringify(hist));
  } catch (e) { console.log(store, 'ERR', e.message); }
}

console.log('\n== 3. live D4D offers fetch with production code ==');
const src = createD4dOffersSource();
for (const [company, slug] of [[63, 'lulu-hypermarket-63'], [62, 'carrefour-62'], [72, 'othaim-markets-72'], [556, 'city-flower-556']]) {
  try {
    const raws = await src.listOffers(company, { city: 'riyadh', storePageSlug: slug });
    const byFlyer = {};
    for (const r of raws) byFlyer[r.flyerRef] = (byFlyer[r.flyerRef] || 0) + 1;
    console.log(slug, 'listOffers ->', raws.length, JSON.stringify(byFlyer));
  } catch (e) { console.log(slug, 'listOffers ERR', e.message); }
}

console.log('\n== 4. raw /products/search response (lulu) ==');
const pageUrl = `${HOST}/en/saudi-arabia/riyadh/offers/lulu-hypermarket-63`;
const pr = await fetch(pageUrl, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
const html = await pr.text();
console.log('store page', pr.status, 'bytes', html.length);
const csrf = (/name="_csrf-frontend" value="([^"]+)"/.exec(html) || [])[1];
console.log('csrf input found:', !!csrf, '| meta csrf-token:', /name="csrf-token"/.test(html), '| csrf-param:', (/name="csrf-param" content="([^"]+)"/.exec(html) || [])[1]);
const csrfMeta = (/name="csrf-token" content="([^"]+)"/.exec(html) || [])[1];
const cookie = (pr.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
console.log('cookies:', cookie.split('; ').map((c) => c.split('=')[0]).join(','));
const mentions = [...new Set((html.match(/["'](\/[a-z-]*\/?(?:products?|offers?)\/[a-z-]*search[a-z-]*)["']/gi) || []))];
console.log('search endpoints mentioned in page:', JSON.stringify(mentions.slice(0, 10)));
for (const token of [csrf, csrfMeta].filter(Boolean)) {
  const body = new URLSearchParams({ search: '', offset: '0', limit: '5', company: '63', country: 'SACR', '_csrf-frontend': token });
  const res = await fetch(`${HOST}/products/search`, {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Referer: pageUrl, Cookie: cookie },
    body,
  });
  const text = await res.text();
  console.log(`POST /products/search -> ${res.status} ${res.headers.get('content-type')} bytes=${text.length}`);
  console.log(text.slice(0, 2500));
  try {
    const d = JSON.parse(text);
    console.log('top-level keys:', Object.keys(d));
    const arr = Array.isArray(d.items) ? d.items : null;
    if (arr && arr[0]) console.log('item keys:', Object.keys(arr[0]).join(','));
  } catch { console.log('(not JSON)'); }
}
