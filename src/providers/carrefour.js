// providers/carrefour.js — Carrefour KSA, through the owner's own browser only.
//
// Carrefour's site answers a server with an empty shell on every path (its
// pages are filled in by a browser; FEASIBILITY-VALIDATION.md). That is the
// store's own protection and is not worked around: this provider never asks
// Carrefour itself. It reports `blocked`, and a search the owner starts with
// their code is run in the owner's own Chrome (relay.js); `fromBrowser` turns
// what that browser read into the same normalized results as every store.
//
// The browser reads Carrefour's search page and sends each product card cut
// down to: productId, productName, sellingPrice, markedPrice, currency,
// productUrl, imageUrl, isSoldByWeight.

const HOST = 'https://www.carrefourksa.com';

function toNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

const browserOnly = {
  name: 'browser-only',
  async run() {
    const err = new Error('Carrefour answers only a browser.');
    err.blocked = true;
    throw err;
  },
};

// Nothing from the browser is trusted as an address: the link is rebuilt on
// Carrefour's host from a /mafsau/ path, and an image must be https.
function fromBrowser(answer) {
  const seen = new Set();
  const results = [];
  for (const p of Array.isArray(answer.products) ? answer.products : []) {
    if (!p || typeof p !== 'object') continue;
    const id = p.productId == null ? '' : String(p.productId).slice(0, 60);
    const name = typeof p.productName === 'string' ? p.productName.trim().slice(0, 200) : '';
    const price = toNumber(p.sellingPrice);
    const path = typeof p.productUrl === 'string' ? p.productUrl : '';
    if (!id || !name || seen.has(id)) continue;
    if (price === null || price <= 0) continue;
    // A per-kilo price is not the price of a pack.
    if (p.isSoldByWeight) continue;
    if (String(p.currency || 'SAR').toUpperCase() !== 'SAR') continue;
    if (!path.startsWith('/mafsau/') || path.includes('//')) continue;
    seen.add(id);
    const marked = toNumber(p.markedPrice);
    const oldPrice = marked !== null && marked > price ? marked : null;
    const image = typeof p.imageUrl === 'string' && p.imageUrl.toLowerCase().startsWith('https://') ? p.imageUrl : '';
    results.push({
      id,
      name,
      image,
      price,
      oldPrice,
      currency: 'SAR',
      link: `${HOST}${path.slice(0, 300)}`,
      size: '',
      brand: '',
      discountLabel: oldPrice ? `${Math.round((1 - price / oldPrice) * 100)}% Off` : '',
    });
  }
  return results;
}

export const carrefourProvider = {
  id: 'carrefour',
  label: 'Carrefour',
  strategies: [browserOnly],
  fromBrowser,
};
