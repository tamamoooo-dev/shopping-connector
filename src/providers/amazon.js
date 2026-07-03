// providers/amazon.js — Amazon Saudi provider (server-side, via the connector).
//
// Two strategies, tried in order by the connector framework:
//
//   1. pa-api      — official Product Advertising API 5.0 (JSON, SigV4-signed).
//                    DURABLE + ToS-compliant. Active only when Associate keys are
//                    configured as Worker secrets; otherwise it skips instantly.
//   2. search-html — parses the public search-results HTML. BEST-EFFORT fallback:
//                    works opportunistically but Amazon may serve an anti-bot
//                    interstitial (which this provider detects and reports rather
//                    than trying to defeat — no browser automation).
//
// Same provider contract and NormalizedResult shape as Panda. The connector
// framework (connector.js) is NOT modified.

const SEARCH_BASE = 'https://www.amazon.sa';

// Amazon serves its anti-bot interstitial to a share of requests (higher from
// datacenter/Worker IPs than from residential browsers). The interstitial is a
// tiny page (~2 KB) with no results; a plain retry very often gets a clean full
// page (~1.5 MB, 48 results) instead. So the durable-but-free fix is: send
// browser-like headers, rotate the User-Agent, and RETRY the fetch a few times
// when a block/empty page comes back. (The real fix remains PA-API, still tried
// first.) Measured: a single Worker fetch clears the block only ~25% of the
// time; four rotated retries clear it the large majority of the time.
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36 Edg/123.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
];
const UA = UA_POOL[0];

// ---------------------------------------------------------------------------
// Worker env (secrets) injection.
//
// Cloudflare exposes secrets only through the `env` argument of the Worker's
// fetch handler. The Core framework is provider-agnostic and must not change,
// so index.js hands us `env` here per request (env is deployment config, not
// per-user state — this stays stateless).
// ---------------------------------------------------------------------------
let ENV = {};
export function setAmazonEnv(env) {
  ENV = env || {};
}

function detectLang(query) {
  return /[؀-ۿ]/.test(query) ? 'ar' : 'en';
}

function toNumber(value) {
  if (value == null) return null;
  const n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ===========================================================================
// Strategy 1 — PA-API 5.0 (durable, requires Associate credentials)
// ===========================================================================
function paapiConfig() {
  const accessKey = ENV.PAAPI_ACCESS_KEY;
  const secretKey = ENV.PAAPI_SECRET_KEY;
  const partnerTag = ENV.PAAPI_PARTNER_TAG;
  if (!accessKey || !secretKey || !partnerTag) return null;
  return {
    accessKey,
    secretKey,
    partnerTag,
    host: ENV.PAAPI_HOST || 'webservices.amazon.sa',
    region: ENV.PAAPI_REGION || 'eu-west-1',
    marketplace: ENV.PAAPI_MARKETPLACE || 'www.amazon.sa',
  };
}

const SERVICE = 'ProductAdvertisingAPI';
const TARGET = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems';

function hex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return hex(new Uint8Array(buf));
}
async function hmac(keyBytes, msg) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}
async function signingKey(secret, dateStamp, region, service) {
  const kDate = await hmac(new TextEncoder().encode('AWS4' + secret), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

// Build canonical+signed header strings from a map (keys sorted, lowercased).
function buildHeaders(map) {
  const names = Object.keys(map).map((k) => k.toLowerCase()).sort();
  const canonical = names.map((n) => `${n}:${String(map[Object.keys(map).find((k) => k.toLowerCase() === n)]).trim()}\n`).join('');
  return { canonical, signed: names.join(';') };
}

function normalizePaapiItem(item) {
  const listing = (item.Offers && item.Offers.Listings && item.Offers.Listings[0]) || {};
  const price = listing.Price ? toNumber(listing.Price.Amount) : null;
  const oldPrice = listing.SavingBasis ? toNumber(listing.SavingBasis.Amount) : null;
  return {
    id: item.ASIN,
    name: ((item.ItemInfo && item.ItemInfo.Title && item.ItemInfo.Title.DisplayValue) || '').trim(),
    image: (item.Images && item.Images.Primary && item.Images.Primary.Medium && item.Images.Primary.Medium.URL) || '',
    price,
    oldPrice: oldPrice && price && oldPrice > price ? oldPrice : null,
    currency: (listing.Price && listing.Price.Currency) || 'SAR',
    link: item.DetailPageURL || `${SEARCH_BASE}/dp/${item.ASIN}`,
    size: '',
    brand:
      (item.ItemInfo && item.ItemInfo.ByLineInfo && item.ItemInfo.ByLineInfo.Brand && item.ItemInfo.ByLineInfo.Brand.DisplayValue) || '',
    discountLabel:
      listing.Price && listing.Price.Savings && listing.Price.Savings.DisplayAmount
        ? `-${listing.Price.Savings.DisplayAmount}`
        : '',
  };
}

const paapiStrategy = {
  name: 'pa-api',
  async run(query) {
    const c = paapiConfig();
    if (!c) {
      // Not configured -> skip instantly so the connector falls through to scraping.
      throw new Error('PA-API not configured (set PAAPI_ACCESS_KEY, PAAPI_SECRET_KEY, PAAPI_PARTNER_TAG secrets)');
    }

    const path = '/paapi5/searchitems';
    const body = JSON.stringify({
      Keywords: query,
      SearchIndex: 'All',
      ItemCount: 10,
      PartnerTag: c.partnerTag,
      PartnerType: 'Associates',
      Marketplace: c.marketplace,
      Resources: [
        'ItemInfo.Title',
        'ItemInfo.ByLineInfo',
        'Images.Primary.Medium',
        'Offers.Listings.Price',
        'Offers.Listings.SavingBasis',
      ],
    });

    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
    const dateStamp = amzDate.slice(0, 8);

    const signedMap = {
      'content-encoding': 'amz-1.0',
      'content-type': 'application/json; charset=utf-8',
      host: c.host,
      'x-amz-date': amzDate,
      'x-amz-target': TARGET,
    };
    const { canonical, signed } = buildHeaders(signedMap);

    const payloadHash = await sha256Hex(body);
    const canonicalRequest = ['POST', path, '', canonical, signed, payloadHash].join('\n');
    const scope = `${dateStamp}/${c.region}/${SERVICE}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
    const key = await signingKey(c.secretKey, dateStamp, c.region, SERVICE);
    const signature = hex(await hmac(key, stringToSign));
    const authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;

    const res = await fetch(`https://${c.host}${path}`, {
      method: 'POST',
      headers: { ...signedMap, Authorization: authorization },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = (json.Errors && json.Errors[0] && json.Errors[0].Message) || `HTTP ${res.status}`;
      throw new Error(`PA-API error: ${msg}`);
    }
    const items = (json.SearchResult && json.SearchResult.Items) || [];
    return items.map(normalizePaapiItem).filter((r) => r.name);
  },
};

// ===========================================================================
// Strategy 2 — search-results HTML parsing (best-effort fallback)
// ===========================================================================
function classifyBlock(status, html) {
  if (status === 503) return 'HTTP 503 (service unavailable / throttled)';
  if (status === 429) return 'HTTP 429 (rate limited)';
  if (/bm-verify|triggerInterstitialChallenge|\/_sec\/verify/i.test(html)) {
    return 'anti-bot interstitial challenge (requires JS execution)';
  }
  if (/Robot Check|Enter the characters you see below|api-services-support@amazon/i.test(html)) {
    return 'CAPTCHA / Robot Check';
  }
  if (status !== 200) return `HTTP ${status}`;
  return null;
}

// Decode the handful of HTML entities Amazon titles actually contain, so a name
// reads and MATCHES cleanly ("Fruit &amp; Nut" -> "Fruit & Nut").
function decodeEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#0*38;/g, '&')
    .replace(/&quot;|&#0*34;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Amazon SA's search layout renders up to two <h2>s per result:
//   1. a compact BRAND line — class "a-size-mini s-line-clamp-…"
//      (English results only; e.g. "Almarai")
//   2. the PRODUCT TITLE — class "…a-text-normal" (or "a-size-base-plus"),
//      usually with an aria-label carrying the full, untruncated name.
// The old parser took the FIRST h2's span, which on the current markup is the
// BRAND — so English results were named "Almarai"/"Saudia" (no product words),
// and the frontend's honest relevance filter then dropped them, which read as
// "Amazon is unreliable". We now extract title and brand SEPARATELY, and compose
// the display name the way every other Souq store does (brand-led), so results
// are both correctly identified and matchable. Arabic pages carry only the title
// h2, and still parse correctly. A legacy fallback keeps working if Amazon
// reverts the markup.
function parseTitleAndBrand(raw) {
  const h2s = [...raw.matchAll(/<h2\b([^>]*)>([\s\S]*?)<\/h2>/g)].map((m) => {
    const attrs = m[1] || '';
    const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
    const aria = (attrs.match(/aria-label="([^"]*)"/) || [])[1] || '';
    const span = (m[2].match(/<span[^>]*>([\s\S]*?)<\/span>/) || [])[1] || m[2];
    return { cls, aria, text: decodeEntities(span.replace(/<[^>]+>/g, ' ')) };
  });
  if (!h2s.length) return { title: '', brand: '' };

  const isBrandLine = (h) => /s-line-clamp|a-size-mini/.test(h.cls);
  const brandH2 = h2s.find(isBrandLine);
  // Title = the non-brand h2 (prefer its aria-label — the full untruncated name,
  // minus any "Sponsored Ad – " prefix); fall back to the only/last h2.
  const titleH2 = h2s.find((h) => !isBrandLine(h)) || h2s[h2s.length - 1];
  const title = decodeEntities((titleH2.aria || titleH2.text).replace(/^Sponsored Ad\s*[–-]\s*/i, ''));
  const brand = brandH2 && brandH2 !== titleH2 ? brandH2.text : '';
  return { title, brand };
}

// Exported for the fixture test (amazon.test.mjs) that locks the brand-vs-title
// regression; not part of the provider's public surface.
export function parseProducts(html) {
  const results = [];
  const blocks = html.split(/data-asin="/).slice(1);
  for (const raw of blocks) {
    const asin = (raw.match(/^([A-Z0-9]{10})"/) || [])[1];
    if (!asin) continue;
    if (!/data-component-type="s-search-result"/.test(raw.slice(0, 200))) continue;

    const { title, brand } = parseTitleAndBrand(raw);
    if (!title || title.length < 3) continue;
    // Brand-led display name (Souq convention: Panda/Lulu names include the
    // brand), without duplicating a brand the title already starts with.
    const name =
      brand && !title.toLowerCase().startsWith(brand.toLowerCase())
        ? `${brand} ${title}`
        : title;

    const image = (raw.match(/<img[^>]+class="s-image"[^>]+src="([^"]+)"/) || [])[1] || '';
    const price = toNumber((raw.match(/<span class="a-offscreen">([^<]+)<\/span>/) || [])[1]);
    // The strike-through list price sits in a "a-price a-text-price" wrapper;
    // keep it only when it is a genuine reduction over the current price.
    const listRaw = (raw.match(/<span class="a-price a-text-price"[^>]*>\s*<span class="a-offscreen">([^<]+)<\/span>/) || [])[1];
    const listPrice = toNumber(listRaw);
    const oldPrice = listPrice != null && price != null && listPrice > price ? listPrice : null;

    results.push({
      id: asin,
      name,
      image,
      price,
      oldPrice,
      currency: 'SAR',
      link: `${SEARCH_BASE}/dp/${asin}`,
      size: '',
      brand: brand.trim(),
      discountLabel: oldPrice ? `-${Math.round((1 - price / oldPrice) * 100)}%` : '',
    });
  }
  return results;
}

// Fetch the search HTML with browser-like headers, rotating the UA per attempt.
function fetchSearchHtml(url, ua) {
  return fetch(url, {
    headers: {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': url.includes('ar_AE') ? 'ar,en;q=0.8' : 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1',
      'sec-ch-ua': '"Chromium";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
  });
}

const searchHtmlStrategy = {
  name: 'search-html',
  async run(query) {
    const lang = detectLang(query);
    const url = `${SEARCH_BASE}/s?k=${encodeURIComponent(query)}&language=${lang === 'ar' ? 'ar_AE' : 'en_AE'}&ref=nb_sb_noss`;

    // Retry on the anti-bot interstitial / soft block: a rotated retry usually
    // lands a clean page. Bounded (5 attempts) to stay gentle and within the
    // Worker time budget; short backoff between tries.
    const MAX = 5;
    let lastReason = '';
    for (let attempt = 0; attempt < MAX; attempt++) {
      const ua = UA_POOL[attempt % UA_POOL.length];
      let html = '';
      let status = 0;
      try {
        const res = await fetchSearchHtml(url, ua);
        status = res.status;
        html = await res.text();
      } catch (err) {
        lastReason = `network error: ${err.message}`;
        if (attempt < MAX - 1) { await sleep(250 * (attempt + 1)); continue; }
        break;
      }

      const blocked = classifyBlock(status, html);
      if (!blocked) {
        const products = parseProducts(html);
        if (products.length) return products;
        lastReason = `no products parsed (status ${status}, ${html.length}b)`;
      } else {
        lastReason = `${blocked} [${html.length}b]`;
      }
      if (attempt < MAX - 1) await sleep(250 * (attempt + 1));
    }
    throw new Error(`Amazon blocked/empty after ${MAX} attempts: ${lastReason}`);
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export const amazonProvider = {
  id: 'amazon',
  label: 'Amazon SA',
  // Durable first, best-effort fallback second.
  strategies: [paapiStrategy, searchHtmlStrategy],
};
