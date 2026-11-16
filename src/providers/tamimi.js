// providers/tamimi.js — Tamimi Markets provider.
//
// 2026-11-16: Tamimi moved its online shop. shop.tamimimarkets.com (ZopSmart,
// /api/layout/search) now answers every address with a 301 to
// www.tamimimarkets.com, a new site whose search page arrives empty and is
// filled in the visitor's browser by Tamimi's search service, Constructor
// (ac.cnstrc.com). This provider reads that same service. The owner chose
// this on 2026-11-16, with these limits:
//   - the connector names itself honestly; it never poses as a browser;
//   - search only, and only when someone searches or a Price Watch round runs;
//   - a refusal (a 4xx: blocked, rate-limited, or the key retired) reports the
//     store `blocked`. Never look for another key or another way in.
//
// The keys are the public browser keys printed in every visitor's page. The
// site keeps two indexes and switches by language: English names, or Arabic
// names and brands.
//
//   GET https://ac.cnstrc.com/v1/search/<q>?key=<key>&section=Products
//       &num_results_per_page=50&fmt_options[variations_return_type]=all
//       &fmt_options[hidden_fields]=<field>.<branch> …&us=<branch>
//   -> response.results[]: { value (name, no brand, no size), data: { id,
//        url, brand, image_url, variant (size), barcode, variation_id,
//        price{branch} (list price), net_price{branch} (selling price),
//        discount{branch}, in_stock{branch} }, variations[] }
//   One product lists every pack (single EA, multipack PAK, case CS) as a
//   variation with its own size, price, stock and barcode. The top-level
//   result is the pack the search shows; `variants` carries them all, so
//   Price Monitoring can price each pack per item (as with ZopSmart).
//
// Prices are the same at every branch (measured 2026-11-16 on 100 products
// across Riyadh V131 / V134 / V148 and the site's default V152); only stock
// differs. The branch is Olaya, Riyadh (V131), like every other store here.

import { gtinKeys } from './gtin.js';

const SEARCH = 'https://ac.cnstrc.com/v1/search/';
const SITE = 'https://www.tamimimarkets.com';
const KEYS = { en: 'key_87HUpZO6lbVJRtwV', ar: 'key_nx6GIIy1DgcBsOjt' };
export const BRANCH = 'V131';
const FIELDS = ['price', 'net_price', 'discount', 'in_stock'];
const PAGE_SIZE = 50;
const USER_AGENT = 'SuperSearch-connector/1.0 (price comparison)';

function detectLang(query) {
  return /[؀-ۿ]/.test(query) ? 'ar' : 'en';
}

function toNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
const atBranch = (field) => (field && typeof field === 'object' ? field[BRANCH] : undefined);
const round2 = (n) => Math.round(n * 100) / 100;

export function searchUrl(query, lang = detectLang(query)) {
  const params = new URLSearchParams({
    key: KEYS[lang] || KEYS.en,
    section: 'Products',
    page: '1',
    num_results_per_page: String(PAGE_SIZE),
    'fmt_options[variations_return_type]': 'all',
    us: BRANCH,
  });
  for (const field of FIELDS) params.append('fmt_options[hidden_fields]', `${field}.${BRANCH}`);
  return `${SEARCH}${encodeURIComponent(query)}?${params}`;
}

// One pack's price at the branch. A sold-out pack can show 0.00: no price.
export function packPrice(data = {}) {
  const net = toNumber(atBranch(data.net_price));
  const list = toNumber(atBranch(data.price));
  const selling = net ?? list;
  const price = selling != null && selling > 0 ? round2(selling) : null;
  const oldPrice = price != null && list != null && list > price ? round2(list) : null;
  const stock = atBranch(data.in_stock);
  return { price, oldPrice, inStock: typeof stock === 'boolean' ? stock : null };
}

// The product page on Tamimi's own site (the service names another host).
function productLink(url) {
  try {
    const { pathname } = new URL(url);
    if (pathname.startsWith('/products/')) return `${SITE}${pathname}`;
  } catch {
    // no usable address
  }
  return '';
}

// Tamimi's product numbers: kept as numbers, as the old shop gave them.
function productId(data) {
  const id = data.id ?? data.variation_id;
  return typeof id === 'string' && /^\d{1,15}$/.test(id) ? Number(id) : id;
}

export function normalize(result) {
  const data = (result && result.data) || {};
  const packs = Array.isArray(result && result.variations) && result.variations.length
    ? result.variations
    : [{ value: result && result.value, data }];
  // The pack the search shows comes first: it keeps the product's own id.
  const shown = (p) => Boolean(p && p.data && p.data.variation_id === data.variation_id);
  const ordered = [...packs].sort((a, b) => shown(b) - shown(a));
  const { price, oldPrice, inStock } = packPrice(data);
  const image = clean(data.image_url);

  return {
    id: productId(data),
    name: clean(result && result.value),
    image: image.startsWith('https://') ? image : '',
    price,
    oldPrice,
    currency: 'SAR',
    link: productLink(data.url),
    size: clean(data.variant),
    brand: clean(data.brand),
    discountLabel: oldPrice && price ? `${Math.round((1 - price / oldPrice) * 100)}% Off` : '',
    barcodes: gtinKeys([data.barcode]),
    inStock,
    variants: ordered.map((p) => {
      const d = (p && p.data) || {};
      return {
        id: d.variation_id,
        size: clean(d.variant),
        ...packPrice(d),
        barcodes: gtinKeys([d.barcode]),
      };
    }),
  };
}

const constructorSearchStrategy = {
  name: 'constructor-search',
  async run(query) {
    const res = await fetch(searchUrl(query), {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
    // A refusal is the end of it: no retry, no other key, no other way in.
    if (res.status >= 400 && res.status < 500 && res.status !== 404) {
      const err = new Error(`HTTP ${res.status} (Tamimi's search refused the connector)`);
      err.blocked = true;
      throw err;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const results = json && json.response && json.response.results;
    if (!Array.isArray(results)) throw new Error('unexpected response shape');
    return results.map(normalize).filter((r) => r.name);
  },
};

export const tamimiProvider = {
  id: 'tamimi',
  label: 'Tamimi',
  strategies: [constructorSearchStrategy],
};
