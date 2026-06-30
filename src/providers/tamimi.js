// providers/tamimi.js — Tamimi Markets (experimental) provider.
//
// Tamimi's store (shop.tamimimarkets.com) runs on the ZopSmart platform and
// exposes a clean, public JSON API. Like Panda, this is a plain server-side
// fetch + normalize — no scraping, no auth, no protection bypass.
//
//   GET /api/layout/search?q=<query>&storeId=4   (Accept-Language: en|ar)
//   (the `q` param is what actually filters; `searchKeyword` is ignored.)
//   -> data.page.layouts[].value.collection.product[]
//      product: { id, name, slug, brand.name, variants[] }
//      variant: { name (size), images[], storeSpecificData[].{ mrp, discount } }
//   price = mrp - discount ;  oldPrice = mrp (when discounted)

const API_BASE = 'https://shop.tamimimarkets.com';
const STORE_ID = 4;

function detectLang(query) {
  return /[؀-ۿ]/.test(query) ? 'ar' : 'en';
}

function toNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Find the layout holding the product collection (robust to layout ordering).
function findProducts(json) {
  const layouts = json && json.data && json.data.page && json.data.page.layouts;
  if (!Array.isArray(layouts)) return [];
  for (const l of layouts) {
    const products = l && l.value && l.value.collection && l.value.collection.product;
    if (Array.isArray(products) && products.length) return products;
  }
  return [];
}

function normalize(product, lang) {
  const variant = (product.variants && product.variants[0]) || {};
  const ss = (variant.storeSpecificData && variant.storeSpecificData[0]) || {};
  const mrp = toNumber(ss.mrp);
  const discount = toNumber(ss.discount) || 0;
  const price = mrp != null ? Math.round((mrp - discount) * 100) / 100 : null;
  const oldPrice = mrp != null && discount > 0 ? mrp : null;
  const image =
    (variant.images && variant.images[0]) || (product.images && product.images[0]) || '';

  return {
    id: product.id,
    name: (product.name || '').trim(),
    image,
    price,
    oldPrice,
    currency: 'SAR',
    link: `${API_BASE}/${lang}/product/${product.slug}`,
    size: (variant.name || '').trim(),
    brand: product.brand && product.brand.name ? product.brand.name.trim() : '',
    discountLabel: discount > 0 && mrp ? `${Math.round((discount / mrp) * 100)}% Off` : '',
  };
}

const layoutSearchStrategy = {
  name: 'layout-search',
  async run(query) {
    const lang = detectLang(query);
    const url = `${API_BASE}/api/layout/search?q=${encodeURIComponent(query)}&storeId=${STORE_ID}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'Accept-Language': lang === 'ar' ? 'ar' : 'en' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const products = findProducts(json);
    if (!Array.isArray(products)) throw new Error('unexpected response shape');
    return products.map((p) => normalize(p, lang)).filter((r) => r.name);
  },
};

export const tamimiProvider = {
  id: 'tamimi',
  label: 'Tamimi',
  strategies: [layoutSearchStrategy],
};
