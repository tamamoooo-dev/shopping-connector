// offers/d4dOffers.js — the D4D Online STRUCTURED-OFFERS source adapter.
//
// Where the d4d brochure adapter reads flyers as page-image sets, this adapter
// reads D4D's per-PRODUCT offer records: for every product on a current flyer,
// D4D publishes { price, was_price, validity, category, product image crop,
// flyer deep-link, OCR text } — the structured shopping data this engine
// exists to expose. Verified live AND from a Worker (datacenter IP): D4D
// serves both the HTML and the JSON endpoint without bot-walls.
//
// Flow (one store, ≤ ~4 subrequests):
//   1. GET the store's offers page -> the `_csrf-frontend` token + session
//      cookies (the JSON endpoint requires both).
//   2. POST /products/search (form-encoded, XHR-style) with
//      { company: <id>, country: 'SACR', offset, limit } -> { items: [...] }.
//      Page by offset until a short page or `maxOffers`.
//
// Aggregator-generic, store-agnostic: which D4D company id a store maps to is
// provider config. One adapter per offers source (same discipline as brochure
// adapters); swapping/adding a source is a new adapter, not an ingest change.
//
// D4D's own UI marks these prices "AI-generated — official flyer prices
// prevail". The Offer contract carries the flyer deep-link + product image so
// the claim is always verifiable; the read API repeats the disclaimer.

const HOST = 'https://d4donline.com';
const CDN = 'https://cdn.d4donline.com';
const DEFAULT_CITY = 'riyadh';
const COUNTRY = 'SACR'; // D4D's Saudi-Central market key (verified live)
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// D4D's global product-category taxonomy (id -> slug), harvested 2026-07-02
// across several store pages. Categories are global on D4D (same ids for every
// store). Unknown ids fall back to null — the category is a convenience label,
// never load-bearing.
export const D4D_CATEGORIES = {
  1: 'large-appliances', 2: 'mobiles', 4: 'fresh-fruits', 6: 'meat-fresh-chilled',
  7: 'frozen-fruits-veg', 8: 'cakes-pastry', 11: 'health-care', 12: 'cleaning',
  13: 'disposables', 14: 'baby-care', 15: 'home-fixtures-fittings', 17: 'computer-laptop',
  19: 'gifts-toys', 20: 'school-stationary', 21: 'tools-hardware', 22: 'ready-to-eat',
  23: 'dried-fruits-dates', 24: 'frozen-meat', 25: 'frozen-fish', 26: 'furniture',
  28: 'accessories', 29: 'ice-ice-cream', 30: 'pets', 31: 'small-appliances',
  32: 'tv', 33: 'camera', 34: 'gaming', 35: 'tabs', 36: 'monitors-projectors',
  37: 'fresh-vegetables', 38: 'rice', 39: 'oil-ghee', 40: 'milk-laban',
  41: 'fresh-fish', 42: 'fresh-chicken-poultry', 43: 'tea-coffee', 44: 'baby-diapers',
  45: 'foils-cling', 46: 'kitchen-appliance', 47: 'toilet-paper-tissue',
  48: 'canned-packeted', 49: 'facial-tissue', 50: 'flour-baking', 51: 'dishwasher',
  52: 'sauces-spreads', 53: 'insect-repellent', 54: 'pasta-noodles', 55: 'laundry',
  56: 'cereals-bars', 58: 'salts-spices-paste', 59: 'baby-toys-accesories',
  60: 'sugar-sweetener', 61: 'baby-feeding', 62: 'pulses-beans-grains', 63: 'printer',
  65: 'cosmetics', 66: 'fragrance', 67: 'juices-drinks', 68: 'water',
  69: 'powdered-drinks-syrups', 70: 'malt-beverages', 71: 'yogurt-labneh',
  72: 'cheese-creame', 73: 'butter-margarine', 74: 'deli-speaclity-meats',
  75: 'feminine-hygiene', 76: 'bread-buns', 77: 'biscuits', 78: 'chocolates-candies',
  79: 'pudding-desserts', 80: 'snacks', 81: 'dining-serving', 82: 'cookware',
  83: 'home-furnishing-decor', 84: 'household-essentials', 85: 'lighting',
  87: 'women-clothing', 88: 'kids-wear', 89: 'accessories-fashion', 90: 'footwear',
  91: 'outdoors-garden', 92: 'luggage', 93: 'bath-body', 94: 'skin-face-care',
  95: 'hair-care', 96: 'shaving-hair-removal', 97: 'dental-care', 101: 'men-clothing',
  112: 'sweets', 113: 'soft-drinks', 114: 'eggs', 115: 'other-frozen-food',
  116: 'sports-wear', 117: 'powdered-condensed-milk', 118: 'smart-watch',
  124: 'frozen-chicken-poultry',
};

// One D4D item -> the source-agnostic raw record buildOffer() consumes.
function toRaw(item, city) {
  return {
    offerId: item.idoffer_special,
    flyerRef: item.idoffer_company,
    pageRef: item.idoffer_list,
    price: item.price,
    wasPrice: item.was_price,
    description: item.description,
    categoryId: item.idproduct_category,
    category: D4D_CATEGORIES[Number(item.idproduct_category)] || null,
    imageUrl: item.image_url ? `${CDN}/${String(item.image_url).replace(/^\/+/, '')}` : null,
    sourceUrl: item.url || null,
    validFrom: item.valid_from,
    validTo: item.valid_to,
    // The store's own display names become dynamic stopwords for name
    // derivation (the flyer header is never a product name).
    storeWords: [item.text_footer_en, item.text_footer_ar].filter(Boolean),
    _city: city,
  };
}

export function createD4dOffersSource({ fetchImpl = fetch } = {}) {
  return {
    name: 'd4d',

    // listOffers(companyId, { city, storePageSlug, maxOffers }) -> raw records[].
    // `storePageSlug` (e.g. "lulu-hypermarket-63") names the page used to mint
    // the CSRF token; any store page works, so the store's own is the polite one.
    async listOffers(companyId, { city = DEFAULT_CITY, storePageSlug, maxOffers = 1500 } = {}) {
      if (!companyId) throw new Error('d4dOffers: companyId is required');
      const pageUrl = `${HOST}/en/saudi-arabia/${city}/offers/${storePageSlug || ''}`.replace(/\/$/, '');

      // 1. CSRF token + session cookies from the store page.
      const pageRes = await fetchImpl(pageUrl, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
      });
      if (!pageRes.ok) throw new Error(`d4dOffers: store page -> HTTP ${pageRes.status}`);
      const html = await pageRes.text();
      const csrf = (/name="_csrf-frontend" value="([^"]+)"/.exec(html) || [])[1];
      if (!csrf) throw new Error('d4dOffers: CSRF token not found on store page');
      const setCookies =
        typeof pageRes.headers.getSetCookie === 'function' ? pageRes.headers.getSetCookie() : [];
      const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');

      // 2. Page through the JSON endpoint. 500/POST keeps a full store at
      // ~2-3 subrequests; a short page means we've seen everything.
      const limit = 500;
      const out = [];
      const seen = new Set();
      for (let offset = 0; offset < maxOffers; offset += limit) {
        const body = new URLSearchParams({
          search: '',
          offset: String(offset),
          limit: String(Math.min(limit, maxOffers - offset)),
          company: String(companyId),
          country: COUNTRY,
          '_csrf-frontend': csrf,
        });
        const res = await fetchImpl(`${HOST}/products/search`, {
          method: 'POST',
          headers: {
            'User-Agent': UA,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: pageUrl,
            Cookie: cookie,
          },
          body,
        });
        if (!res.ok) throw new Error(`d4dOffers: products/search -> HTTP ${res.status}`);
        const data = await res.json().catch(() => null);
        const items = data && Array.isArray(data.items) ? data.items : [];
        for (const item of items) {
          const id = String(item.idoffer_special ?? '');
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push(toRaw(item, city));
        }
        if (items.length < limit) break;
      }
      return out;
    },
  };
}
