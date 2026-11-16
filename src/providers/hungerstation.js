// providers/hungerstation.js — HungerStation Market (هنقرستيشن ماركت) provider.
//
// HungerStation Market is HungerStation's own grocery darkstore. Its website
// has a product search, and the search page is rendered on HungerStation's
// server: the products arrive inside the page's own data (__NEXT_DATA__,
// props.pageProps.productSearchResult). This provider reads that page, as a
// visitor's browser would, and nothing else (measured 2026-11-16: it answers a
// Cloudflare Worker, 200 in ~0.35 s; robots.txt does not exclude it).
//
//   GET https://hungerstation.com/sa-en/hmarket?query=<q>[&page=<n>]
//       (sa-ar for Arabic words: Arabic names)
//   -> productSearchResult: { items: [ { id (uuid), sku, name (brand and size
//        included), images[{url}], price (selling), originalPrice,
//        activePromotions[] } ], meta: { totalCount, isLastPage } }
//   20 products a page; the first two pages are read together.
//
// The website prices Riyadh from one HungerStation Market store (Al Rabwah,
// the site's own default); there is no way to choose another store on the
// web. Each product opens on HungerStation's site at
// /<locale>/hmarket/product/<name-slug>-<sku>.
//
// Limits (same as every store here): the connector names itself honestly; a
// refusal (401/403/429, or a challenge page instead of the search page)
// reports the store `blocked`, never retried around.

const SITE = 'https://hungerstation.com';
const USER_AGENT = 'SuperSearch-connector/1.0 (price comparison)';
const PAGES = 2;
const CHALLENGE = /attention required|just a moment|cf-chl|captcha|access denied/i;
const NEXT_DATA = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

function detectLang(query) {
  return /[؀-ۿ]/.test(query) ? 'ar' : 'en';
}

function toNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const round2 = (n) => Math.round(n * 100) / 100;
const locale = (lang) => (lang === 'ar' ? 'sa-ar' : 'sa-en');

export function searchUrl(query, page = 1, lang = detectLang(query)) {
  const params = new URLSearchParams({ query });
  if (page > 1) params.set('page', String(page));
  return `${SITE}/${locale(lang)}/hmarket?${params}`;
}

// The product page's address, built as the site builds it: the name in
// lower case, letters and digits only, words joined by "-", then the code.
export function productLink(name, sku, lang = 'en') {
  if (typeof sku !== 'string' || !/^[A-Za-z0-9]{3,20}$/.test(sku)) return '';
  const slug = clean(name)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/[\s-]+/g, '-');
  return `${SITE}/${locale(lang)}/hmarket/product/${encodeURIComponent(slug ? `${slug}-${sku}` : sku)}`;
}

// The search page's own product list, or null when the page is not one.
export function readPage(html) {
  const m = NEXT_DATA.exec(typeof html === 'string' ? html : '');
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const result = data && data.props && data.props.pageProps && data.props.pageProps.productSearchResult;
  if (!result || !Array.isArray(result.items)) return null;
  const meta = result.meta || {};
  return { items: result.items, lastPage: meta.isLastPage === true, total: toNumber(meta.totalCount) };
}

export function normalize(item, lang = 'en') {
  const it = item && typeof item === 'object' ? item : {};
  const sku = typeof it.sku === 'string' ? it.sku : '';
  const name = clean(it.name);
  const selling = toNumber(it.price);
  const price = selling != null && selling > 0 ? round2(selling) : null;
  const original = toNumber(it.originalPrice);
  const oldPrice = price != null && original != null && original > price ? round2(original) : null;
  const first = Array.isArray(it.images) && it.images[0] ? clean(it.images[0].url) : '';
  return {
    id: sku || clean(it.id),
    name,
    image: first.startsWith('https://') ? first : '',
    price,
    oldPrice,
    currency: 'SAR',
    link: productLink(name, sku, lang),
    size: '',
    brand: '',
    discountLabel: oldPrice && price ? `${Math.round((1 - price / oldPrice) * 100)}% Off` : '',
  };
}

async function fetchPage(query, page, lang) {
  const res = await fetch(searchUrl(query, page, lang), {
    headers: { Accept: 'text/html', 'User-Agent': USER_AGENT },
  });
  const html = await res.text();
  if ([401, 403, 429].includes(res.status) || CHALLENGE.test(html.slice(0, 4000))) {
    const err = new Error(`HTTP ${res.status} (HungerStation refused the connector)`);
    err.blocked = true;
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const read = readPage(html);
  if (!read) throw new Error('the search page came without its product list');
  return read;
}

const searchPageStrategy = {
  name: 'search-page',
  async run(query) {
    const lang = detectLang(query);
    // Page 1 decides the answer; page 2 only adds to it when it comes.
    const [first, ...more] = await Promise.allSettled(
      Array.from({ length: PAGES }, (_, i) => fetchPage(query, i + 1, lang)),
    );
    if (first.status === 'rejected') throw first.reason;
    const items = [...first.value.items];
    if (!first.value.lastPage) {
      for (const page of more) if (page.status === 'fulfilled') items.push(...page.value.items);
    }
    const seen = new Set();
    const results = [];
    for (const item of items) {
      const r = normalize(item, lang);
      if (!r.id || !r.name || r.price == null || seen.has(r.id)) continue;
      seen.add(r.id);
      results.push(r);
    }
    return results;
  },
};

export const hungerstationProvider = {
  id: 'hungerstation',
  label: 'HungerStation',
  strategies: [searchPageStrategy],
};
