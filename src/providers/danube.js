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

// Danube's origin occasionally drops a single request from Cloudflare's edge
// (transient 5xx / connection reset), which surfaced as an intermittent
// "Could not reach Danube". One retry with a short backoff turns those blips
// into a success. A 4xx (except 429) is treated as final — no point retrying.
// The Accept-Language header nudges the origin to serve the normal catalogue.
async function fetchDanubeJson(url, tries = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en,ar;q=0.9',
          'User-Agent': UA,
          // Present as an XHR from the site itself — the Spree JSON API is what
          // the storefront calls, and this reduces the odd edge-dropped request.
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${API_BASE}/`,
        },
      });
      if (res.ok) {
        // A transient edge failure sometimes returns 200 with a non-JSON body
        // (an HTML error/challenge page). Guard the parse so that counts as a
        // retryable blip rather than a hard throw.
        const text = await res.text();
        try {
          return JSON.parse(text);
        } catch {
          lastErr = new Error(`non-JSON body (${text.length}b)`);
        }
      } else {
        // Only transient statuses are worth retrying; a 4xx (except 429) is final.
        const retryable = res.status >= 500 || res.status === 429;
        if (!retryable) throw Object.assign(new Error(`HTTP ${res.status}`), { final: true });
        lastErr = new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      if (err.final) throw err; // don't retry a definitive client error
      lastErr = err; // network error / transient http — fall through to retry
    }
    if (attempt < tries) {
      await new Promise((r) => setTimeout(r, 300 * attempt));
    } else {
      throw lastErr;
    }
  }
  throw lastErr;
}

const productsApiStrategy = {
  name: 'spree-products-json',
  async run(query) {
    const lang = detectLang(query);
    const url = `${API_BASE}/api/products.json?q%5Bname_cont%5D=${encodeURIComponent(query)}&per_page=20`;
    const json = await fetchDanubeJson(url);
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
