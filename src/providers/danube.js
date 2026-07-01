// providers/danube.js — Danube (experimental) provider.
//
// Danube (BinDawood Holding) runs on Spree Commerce and exposes a public JSON
// API. Like Panda/Tamimi, this is a plain server-side fetch + normalize — no
// scraping, no auth, no protection bypass.
//
//   GET /api/products.json?q[name_cont]=<query>&per_page=20
//   -> { products: [ { id, name, name_en, price, on_sale, original_price,
//                       slug, brand, brand_en, master.images[].large_url } ] }
//   Both languages ship in every response, so no locale param is needed.

const API_BASE = 'https://danube.sa';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function detectLang(query) {
  return /[؀-ۿ]/.test(query) ? 'ar' : 'en';
}

function toNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function pickImage(product) {
  const imgs = (product.master && product.master.images) || product.images || [];
  const i = imgs[0];
  return (i && (i.large_url || i.product_url || i.small_url)) || '';
}

function normalize(product, lang) {
  const price = toNumber(product.price);
  const original = product.on_sale ? toNumber(product.original_price) : null;
  const oldPrice = original && price && original > price ? original : null;
  const name = lang === 'en' ? product.name_en || product.name : product.name || product.name_en;
  const brand = lang === 'en' ? product.brand_en || product.brand : product.brand || product.brand_en;

  return {
    id: product.id,
    name: (name || '').trim(),
    image: pickImage(product),
    price,
    oldPrice,
    currency: 'SAR',
    link: `${API_BASE}/${lang}/products/${product.slug}`,
    size: '',
    brand: (brand || '').trim(),
    discountLabel: (product.discount_text || '').trim(),
  };
}

const productsApiStrategy = {
  name: 'spree-products-json',
  async run(query) {
    const lang = detectLang(query);
    const url = `${API_BASE}/api/products.json?q%5Bname_cont%5D=${encodeURIComponent(query)}&per_page=20`;
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const products = json && json.products;
    if (!Array.isArray(products)) throw new Error('unexpected response shape');
    return products.map((p) => normalize(p, lang)).filter((r) => r.name);
  },
};

export const danubeProvider = {
  id: 'danube',
  label: 'Danube',
  strategies: [productsApiStrategy],
};
