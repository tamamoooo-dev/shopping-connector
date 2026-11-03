// watchObserve.js — Value Watch "check with my browser".
//
// Two stores cannot be searched by the connector: Lulu's own firewall refuses
// every Cloudflare Worker (2026-11-03, see the connector's providers/lulu.js),
// and Carrefour has no connector at all. Both answer the owner's own browser.
// When the owner asks, Claude in Chrome reads the store's search results in
// the owner's Chrome — the same JSON the store's own pages read — and posts
// them here (POST /watches/observe). Never on a timer: a check runs only
// because the owner asked for it, and a challenge page stops it.
//
// The browser only READS. Its listings are untrusted input: this module keeps
// the fields a listing may carry and drops everything else, and the sweep then
// decides identity exactly as for every other store (watchIndex.js: rules, the
// two-vote judge, the size check). Nothing here decides what is a match.

export const BROWSER_SOURCE = 'browser';
export const BROWSER_STORES = ['lulu', 'carrefour'];
// The hosts a listing's link may point at, per store.
const STORE_HOSTS = {
  lulu: ['gcc.luluhypermarket.com'],
  carrefour: ['www.carrefourksa.com'],
};
export const MAX_OBSERVED = 300;
// How long one browser check stands as a price: a round's worth (07:00 and
// 19:00 Riyadh). After that the deal it found is no longer known — the next
// check, not the old one, says whether it still stands.
export const BROWSER_FRESH_MS = 12 * 60 * 60 * 1000;

export const browserStateKey = (store) => `${BROWSER_SOURCE}:${store}`;

// The status key a row's store state lives under: flyers share one, a browser
// check of a store is its own (the connector may be blocked while the
// browser answers), every other row its store's.
export function stateKeyOf(row) {
  if (row.source === 'flyer') return 'flyers';
  if (row.source === BROWSER_SOURCE) return browserStateKey(row.store);
  return row.store;
}

// --- barcodes (the connector's providers/gtin.js key, kept in step) -------------

function checkDigit(body) {
  let sum = 0;
  const n = body.length;
  for (let i = 0; i < n; i++) sum += Number(body[n - 1 - i]) * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10;
}

// A store's barcode FIELD -> the comparable key: the 12-digit EAN-13 body,
// `e8:` + 7 for EAN-8, `g14:` + 13 for an outer-pack GTIN-14. In-store and
// coupon ranges are not identities and give null.
export function barcodeKey(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 8) {
    return checkDigit(digits.slice(0, 7)) === Number(digits[7]) ? `e8:${digits.slice(0, 7)}` : null;
  }
  let ean13 = null;
  if (digits.length === 12) ean13 = `0${digits}`;
  else if (digits.length === 13) ean13 = digits;
  else if (digits.length === 14) {
    if (digits[0] !== '0') {
      return checkDigit(digits.slice(0, 13)) === Number(digits[13]) ? `g14:${digits.slice(0, 13)}` : null;
    }
    ean13 = digits.slice(1);
  } else return null;
  const body = ean13.slice(0, 12);
  if (/^0{12}$/.test(body)) return null;
  if (/^(02|04|05|2)/.test(ean13)) return null;
  if (checkDigit(body) !== Number(ean13[12]) && ean13[12] !== '0') return null;
  return body;
}

// --- the supplied listings ------------------------------------------------------

const text = (value, max) => {
  if (typeof value !== 'string') return null;
  const t = value.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
};

const money = (value) => {
  const n = typeof value === 'string' ? Number(value.replace(/,/g, '')) : Number(value);
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null;
};

function httpsUrl(value, hosts = null) {
  if (typeof value !== 'string' || value.length > 600) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (hosts && !hosts.includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

// One supplied listing -> the listing the sweep reads, or null.
export function observedListing(store, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = text(String(raw.id ?? ''), 80);
  if (!id || !/^[\w.~:-]+$/.test(id)) return null;
  const name = text(raw.name, 300);
  const nameEn = text(raw.nameEn, 300);
  if (!name && !nameEn) return null;
  const price = money(raw.price);
  if (price == null) return null;
  const currency = String(raw.currency || 'SAR').toUpperCase();
  if (currency !== 'SAR') return null;
  const oldPrice = money(raw.oldPrice);
  const barcodes = [];
  for (const code of Array.isArray(raw.barcodes) ? raw.barcodes.slice(0, 8) : []) {
    const key = barcodeKey(code);
    if (key && !barcodes.includes(key)) barcodes.push(key);
  }
  return {
    id,
    name: name || nameEn,
    nameEn: name && nameEn && nameEn !== name ? nameEn : null,
    brand: text(raw.brand, 80),
    size: text(raw.size, 60),
    price,
    oldPrice: oldPrice != null && oldPrice > price ? oldPrice : null,
    currency,
    inStock: typeof raw.inStock === 'boolean' ? raw.inStock : null,
    barcodes,
    link: httpsUrl(raw.link, STORE_HOSTS[store]),
    image: httpsUrl(raw.image),
    query: text(raw.query, 120),
  };
}

// The POST body -> { store, listings, complete, dropped } or { error }.
// `complete` = the browser answered every query it was given; only a complete
// check may count a listing it did not return as missing.
export function readObservation(body) {
  const store = String(body?.store || '').trim().toLowerCase();
  if (!BROWSER_STORES.includes(store)) {
    return { error: `store must be one of: ${BROWSER_STORES.join(', ')}` };
  }
  if (!Array.isArray(body?.listings)) return { error: 'listings must be an array' };
  if (body.listings.length > MAX_OBSERVED) return { error: `at most ${MAX_OBSERVED} listings per check` };
  const listings = [];
  const ids = new Set();
  for (const raw of body.listings) {
    const listing = observedListing(store, raw);
    if (!listing || ids.has(listing.id)) continue;
    ids.add(listing.id);
    listings.push(listing);
  }
  return {
    store,
    listings,
    complete: body.complete === true,
    dropped: body.listings.length - listings.length,
  };
}

// What the browser should look for (GET /watches/observe): the profile's
// active Value Watches with their search wording.
export function observePlan(watches, referenceOf) {
  return watches
    .filter((w) => w.active && w.watchTrack === 'indexed_value')
    .map((w) => {
      const reference = referenceOf(w);
      return {
        id: w.id,
        label: w.label,
        name: reference.name || null,
        nameEn: reference.nameEn || null,
        brand: reference.brand?.en || reference.brand?.ar || null,
        item: reference.item || null,
        targetValue: reference.targetValue ?? null,
        queries: (reference.queries || []).filter(Boolean).slice(0, 4),
      };
    });
}

// --- the hand-off window ----------------------------------------------------------
//
// Lulu's page security policy lets its pages connect only to Lulu's own and its
// partners' hosts, so a script in a Lulu tab cannot post to the engine. A
// click on the button the browser-check script adds opens this small page (the
// click is what lets a page open a window); the store tab hands it each request
// by postMessage, and it calls the observe API from the engine's own origin.
// It forwards only the two observe calls, and only for the store tabs.
export const RELAY_PATH = '/watches/observe/relay';
export const RELAY_ORIGINS = ['https://gcc.luluhypermarket.com', 'https://www.carrefourksa.com'];

export function relayPage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Price Watch: browser check</title>
<style>body{margin:0;padding:18px;font:15px/1.5 system-ui,sans-serif;background:#fff;color:#111}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}}</style></head>
<body><p id="s">Waiting for the store tab…</p>
<script>
const ORIGINS = ${JSON.stringify(RELAY_ORIGINS)};
const status = document.getElementById('s');
const allowed = (path) => typeof path === 'string' && /^\\/watches\\/observe\\?[\\w=&%.~-]*$/.test(path);
addEventListener('message', async (event) => {
  if (!ORIGINS.includes(event.origin)) return;
  const msg = event.data || {};
  if (msg.type !== 'lsa-relay-request' || !allowed(msg.path) || !['GET', 'POST'].includes(msg.method)) return;
  if (msg.label) status.textContent = 'Checking ' + msg.label + '…';
  let out;
  try {
    const res = await fetch(msg.path, msg.method === 'POST'
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg.body) }
      : {});
    out = { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    out = { status: 0, body: { error: String((err && err.message) || err) } };
  }
  event.source.postMessage({ type: 'lsa-relay-reply', seq: msg.seq, out }, event.origin);
  status.textContent = 'Sent. This window closes by itself.';
});
if (window.opener) for (const origin of ORIGINS) window.opener.postMessage({ type: 'lsa-relay-ready' }, origin);
</script></body></html>`;
}
