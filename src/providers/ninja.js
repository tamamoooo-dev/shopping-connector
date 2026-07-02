// providers/ninja.js — Ninja (نينجا) Market provider.
//
// Ninja (ananinja.com) is a Saudi quick-commerce grocery ("market") app. Its web
// storefront searches a public catalogue service ("fahras", Arabic for index)
// that only needs a GUEST bearer token — no login. The token is issued as a
// `DeviceToken` cookie by any page load on the storefront, so a single cheap
// request bootstraps it. Plain server-side fetch + normalize; no scraping, no
// login, no protection bypass.
//
//   1. GET https://ananinja.com/sa/en/<404>  -> Set-Cookie: DeviceToken=<jwt>
//   2. GET https://public.ananinja.com/fahras/search/products?storeId=1&q=<query>
//        &includes=...   Authorization: Bearer <DeviceToken>
//      -> [ { id:"1-7518", name, nameAr, brandCode, medias:[{url}], priceCents,
//             discountedPriceCents, originalPriceCents, isAvailable, weight } ]
//
// storeId=1 is the Riyadh (Central) default store, matching the rest of Souq.
// Prices are in cents (÷100). Search is broad/fuzzy, so it is capped and the
// client's ranking narrows it.

const WEB_BASE = 'https://ananinja.com';
const SEARCH_BASE = 'https://public.ananinja.com/fahras/search';
const STORE_ID = 1; // Riyadh / Central
const INCLUDES =
  'id,name,nameAr,brandCode,medias,priceCents,discountedPriceCents,originalPriceCents,isAvailable,weight';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_RESULTS = 40;

function detectLang(query) {
  return /[؀-ۿ]/.test(query) ? 'ar' : 'en';
}

function toNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// A guest DeviceToken (JWT) valid for ~90 days. Cache it in the isolate so we
// don't bootstrap on every request; refetch on 401 or when missing. This is
// deployment/anonymous config, not per-user state — the connector stays
// effectively stateless (a cold isolate just re-bootstraps).
let cachedToken = null;

async function fetchGuestToken() {
  // Any non-API path issues the cookie; a 404 route is the smallest response.
  const res = await fetch(`${WEB_BASE}/sa/en/_souq_token_probe`, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    redirect: 'manual',
  });
  // Cloudflare Workers expose Set-Cookie via getSetCookie() (or the folded header).
  const cookies =
    (typeof res.headers.getSetCookie === 'function' && res.headers.getSetCookie()) ||
    (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  for (const c of cookies) {
    const m = /DeviceToken=([^;]+)/.exec(c);
    if (m) return m[1];
  }
  throw new Error('could not obtain Ninja guest token');
}

async function ninjaSearch(query, lang, token) {
  const url =
    `${SEARCH_BASE}/products?storeId=${STORE_ID}&q=${encodeURIComponent(query)}` +
    `&includes=${INCLUDES}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Language': lang === 'ar' ? 'ar' : 'en',
      'X-Agent-Country': 'sa',
      'User-Agent': UA,
    },
  });
  return res;
}

function slugify(name) {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function normalize(p, lang) {
  // priceCents is the effective price; when a discount is active,
  // discountedPriceCents holds the sale price and originalPriceCents the
  // strike-through. Fall back gracefully so no discount => no oldPrice.
  const disc = toNumber(p.discountedPriceCents);
  const base = toNumber(p.priceCents);
  const orig = toNumber(p.originalPriceCents);
  const price = disc && disc > 0 ? disc / 100 : base != null ? base / 100 : null;
  const oldPrice = orig != null && price != null && orig / 100 > price ? orig / 100 : null;

  const name = lang === 'ar' ? p.nameAr || p.name : p.name || p.nameAr;
  const media = Array.isArray(p.medias) && p.medias[0] ? p.medias[0].url : '';
  // id is "<storeId>-<productId>"; the web product URL is /product/<slug>-<productId>.
  const numeric = String(p.id || '').split('-').pop();

  return {
    id: p.id,
    name: (name || '').trim(),
    image: media || '',
    price,
    oldPrice,
    currency: 'SAR',
    link: `${WEB_BASE}/sa/${lang}/product/${slugify(name)}-${numeric}`,
    size: '',
    brand: (p.brandCode || '').trim(),
    discountLabel: oldPrice ? `${Math.round((1 - price / oldPrice) * 100)}% Off` : '',
  };
}

const marketSearchStrategy = {
  name: 'fahras-market',
  async run(query) {
    const lang = detectLang(query);
    if (!cachedToken) cachedToken = await fetchGuestToken();

    let res = await ninjaSearch(query, lang, cachedToken);
    if (res.status === 401 || res.status === 403) {
      // Token expired/invalid — bootstrap a fresh one once and retry.
      cachedToken = await fetchGuestToken();
      res = await ninjaSearch(query, lang, cachedToken);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('unexpected response shape');
    return data
      .filter((p) => p && p.isAvailable !== false)
      .slice(0, MAX_RESULTS)
      .map((p) => normalize(p, lang))
      .filter((r) => r.name);
  },
};

export const ninjaProvider = {
  id: 'ninja',
  label: 'Ninja',
  strategies: [marketSearchStrategy],
};
