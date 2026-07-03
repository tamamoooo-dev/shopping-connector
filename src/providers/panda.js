// providers/panda.js — server-side Panda provider for the connector.
//
// This is a faithful port of the frozen frontend Panda provider
// (live-shopping-assistant/src/providers/panda.js). It produces the EXACT same
// NormalizedResult objects. The only difference is statefulness:
//
//   Frontend:  keeps one X-SESSION-ID in localStorage per device.
//   Connector: stateless — a fresh random UUID per request. (Verified: any UUID
//              works; Panda only needs *some* session id to bind a default
//              branch and return a catalogue.)
//
// The connector framework knows none of this; it only sees `{ id, label, strategies }`.

const API_BASE = 'https://api.panda.sa/v3';
const WEB_BASE = 'https://panda.sa';
const IMG_BASE = 'https://images.todoorstep.com';

function sessionId() {
  return crypto.randomUUID();
}

function headers(lang) {
  return {
    Accept: 'application/json',
    // Cloudflare Workers' fetch() sends no User-Agent by default, and
    // api.panda.sa returns 403 to requests without one. Browsers always send a
    // UA (which is why the browser-direct frontend works), so the connector
    // must set one explicitly. Any non-empty value is accepted.
    'User-Agent': 'ShoppingConnector/0.1 (+https://github.com/)',
    'X-Panda-Source': 'PandaClick',
    'X-PandaClick-Agent': '4',
    'api-version': '2025-10-01',
    'X-Language': lang === 'ar' ? 'ar' : 'en',
    'X-SESSION-ID': sessionId(),
  };
}

// Arabic input -> Arabic catalogue, otherwise English.
function detectLang(query) {
  return /[؀-ۿ]/.test(query) ? 'ar' : 'en';
}

async function apiGet(path, lang) {
  const res = await fetch(`${API_BASE}${path}`, { headers: headers(lang) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- normalization helpers (identical to the frozen frontend) ----------------
function toNumber(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function slugify(name) {
  return (name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function productLink(id, name, lang) {
  return `${WEB_BASE}/${lang}/p/${id}.${slugify(name)}`;
}

function pickImage(variety) {
  const sets = variety && variety.images;
  if (Array.isArray(sets) && sets.length && Array.isArray(sets[0]) && sets[0][0]) {
    return sets[0][0];
  }
  if (variety && variety.sku) return `${IMG_BASE}/product/${variety.sku}/En.jpg`;
  return '';
}

export function normalizeProduct(product, lang) {
  const variety = (product.varieties && product.varieties[0]) || {};
  const price = toNumber(variety.price);
  const undiscounted = toNumber(variety.undiscounted_price);
  const oldPrice = undiscounted && price && undiscounted > price ? undiscounted : null;

  // NAVIGATION FIX: panda.sa's product page is keyed by the VARIETY id, not the
  // catalogue `product.id`. The product-list API returns product.id (18499) but
  // the storefront's /p/<id> page (and its /v3/products/<id> detail call) resolve
  // only the variety id (28874) — using product.id landed the user on a live
  // Panda page that then rendered "No products found". The suggestions strategy
  // already emitted the variety id, so this aligns the two paths. Fall back to
  // product.id only if a product somehow has no variety.
  const varietyId = variety.id != null ? variety.id : product.id;

  return {
    id: varietyId,
    name: (product.name || '').trim(),
    image: pickImage(variety),
    price,
    oldPrice,
    currency: 'SAR',
    link: productLink(varietyId, product.name, lang),
    size: [variety.size, variety.unit].filter(Boolean).join(' ').trim(),
    brand: product.brand && product.brand.name ? product.brand.name.trim() : '',
    discountLabel: variety.discount_label || '',
  };
}

// --- strategies (declared best-first) ----------------------------------------
const productsStrategy = {
  name: 'products-v3',
  async run(query) {
    const lang = detectLang(query);
    const path = `/products?search_key=${encodeURIComponent(query)}&page=1`;
    const json = await apiGet(path, lang);
    const list = json && json.data && json.data.products;
    if (!Array.isArray(list)) throw new Error('unexpected response shape');
    return list.map((p) => normalizeProduct(p, lang)).filter((r) => r.name);
  },
};

const suggestionsStrategy = {
  name: 'suggestions-v3',
  async run(query) {
    const lang = detectLang(query);
    const path = `/products/search_suggestions?search_key=${encodeURIComponent(query)}&page=1`;
    const json = await apiGet(path, lang);
    const groups = json && json.data && json.data.search_suggestions;
    if (!Array.isArray(groups)) throw new Error('unexpected response shape');

    const results = [];
    for (const group of groups) {
      for (const s of group.suggestions || []) {
        if (s.type !== 'product' || !s.id) continue;
        const name = (s.terms || '').trim();
        results.push({
          id: s.id,
          name,
          image: `${IMG_BASE}/product/${s.id}/En.jpg`,
          price: null,
          oldPrice: null,
          currency: 'SAR',
          link: productLink(s.id, name, lang),
          size: '',
          brand: '',
          discountLabel: '',
        });
      }
    }
    return results;
  },
};

export const pandaProvider = {
  id: 'panda',
  label: 'Panda',
  strategies: [productsStrategy, suggestionsStrategy],
};
