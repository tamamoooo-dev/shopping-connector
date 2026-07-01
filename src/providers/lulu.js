// providers/lulu.js — Lulu Hypermarket KSA (experimental) provider.
//
// Lulu KSA (gcc.luluhypermarket.com) runs on the Akinon platform. Its listing
// page supports a clean JSON output (`format=json`), and region/currency are
// carried by ordinary preference cookies (pz-locale / pz-currency) — not a
// protection bypass. Plain server-side fetch + normalize; no scraping of markup,
// no browser automation.
//
//   GET /{en-sa|ar-sa}/list?search_text=<query>&format=json
//   Cookie: pz-locale=<locale>; pz-currency=sar
//   -> { products: [ { pk, name, price, retail_price, currency_type,
//        absolute_url, productimage_set[].image, attributes.brand } ] }

const HOST = 'https://gcc.luluhypermarket.com';
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
  const set = product.productimage_set;
  if (Array.isArray(set) && set[0] && set[0].image) return set[0].image;
  return '';
}

function normalize(product, locale) {
  const price = toNumber(product.price);
  const retail = toNumber(product.retail_price);
  const oldPrice = retail && price && retail > price ? retail : null;
  const brand =
    product.attributes && typeof product.attributes.brand === 'string' ? product.attributes.brand : '';

  return {
    id: product.pk,
    name: (product.name || '').trim(),
    image: pickImage(product),
    price,
    oldPrice,
    currency: (product.currency_type || 'sar').toUpperCase(),
    link: `${HOST}/${locale}${product.absolute_url}`,
    size: '',
    brand: brand.trim(),
    discountLabel: oldPrice ? `${Math.round((1 - price / oldPrice) * 100)}% Off` : '',
  };
}

const listJsonStrategy = {
  name: 'akinon-list-json',
  async run(query) {
    const locale = detectLang(query) === 'ar' ? 'ar-sa' : 'en-sa';
    const url = `${HOST}/${locale}/list?search_text=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': UA,
        // Preference cookies select the Saudi region + SAR pricing (default is UAE/AED).
        Cookie: `pz-locale=${locale}; pz-currency=sar`,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const products = json && json.products;
    if (!Array.isArray(products)) throw new Error('unexpected response shape');
    return products.map((p) => normalize(p, locale)).filter((r) => r.name);
  },
};

export const luluProvider = {
  id: 'lulu',
  label: 'Lulu',
  strategies: [listJsonStrategy],
};
