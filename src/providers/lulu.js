// providers/lulu.js — Lulu Hypermarket KSA (experimental) provider.
//
// ⚠️ BLOCKED since at least 2026-11-03: Lulu's Cloudflare firewall answers
// every request from a Cloudflare Worker with 403 "Attention Required" (even
// robots.txt; the same request from a home connection gets 200, and the API
// refuses cross-origin browser calls too). That is the store's own bot
// protection and is NOT to be worked around. The provider reports `blocked`
// so the engine and the app stop treating it as an outage; it starts
// answering again by itself the day Lulu lets the Worker in. Lulu's prices
// still arrive through its weekly flyers (D4D).
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
    if (!res.ok) {
      const err = new Error(res.status === 403 ? 'HTTP 403 (Lulu refuses automated requests)' : `HTTP ${res.status}`);
      err.blocked = res.status === 403;
      throw err;
    }
    const json = await res.json();
    const products = json && json.products;
    if (!Array.isArray(products)) throw new Error('unexpected response shape');
    return products.map((p) => normalize(p, locale)).filter((r) => r.name);
  },
};

// Lulu sends 99999 for every product until the browser has chosen a region
// (measured 2026-11-12: no pz-locale / pz-currency cookie -> 99999 and English
// names). It is "no price", never a price.
const NO_PRICE = 99999;
const LOCALES = new Set(['ar-sa', 'en-sa']);

// The owner's own browser asked Lulu (relay.js): its products, cut down to the
// fields above, become the same normalized results. Nothing from the browser
// is trusted as an address: the link is rebuilt on Lulu's host and an image
// must be https.
function fromBrowser(answer) {
  const locale = LOCALES.has(answer.locale) ? answer.locale : 'ar-sa';
  const products = (Array.isArray(answer.products) ? answer.products : []).filter(
    (p) => p && typeof p === 'object' && typeof p.absolute_url === 'string' && p.absolute_url.startsWith('/') && !p.absolute_url.startsWith('//'),
  );
  const priced = products.filter((p) => {
    const price = toNumber(p.price);
    // A browser set to another country's Lulu sends that country's money.
    const riyals = String(p.currency_type || 'sar').toLowerCase() === 'sar';
    return riyals && price !== null && price > 0 && price < NO_PRICE;
  });
  if (products.length && !priced.length) {
    const err = new Error('Lulu sent no prices: the browser has no region chosen.');
    err.relayState = 'no-price';
    throw err;
  }
  return priced
    .map((p) => {
      const result = normalize(p, locale);
      if (!result.image.toLowerCase().startsWith('https://')) result.image = '';
      if (result.oldPrice !== null && result.oldPrice >= NO_PRICE) {
        result.oldPrice = null;
        result.discountLabel = '';
      }
      result.name = result.name.slice(0, 200);
      result.brand = result.brand.slice(0, 80);
      return result;
    })
    .filter((r) => r.name);
}

export const luluProvider = {
  id: 'lulu',
  label: 'Lulu',
  strategies: [listJsonStrategy],
  fromBrowser,
};
