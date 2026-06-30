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
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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

function parseProducts(html) {
  const results = [];
  const blocks = html.split(/data-asin="/).slice(1);
  for (const raw of blocks) {
    const asin = (raw.match(/^([A-Z0-9]{10})"/) || [])[1];
    if (!asin) continue;
    if (!/data-component-type="s-search-result"/.test(raw.slice(0, 200))) continue;

    const title =
      (raw.match(/<h2[^>]*>.*?<span[^>]*>([^<]{3,})<\/span>/s) || [])[1] ||
      (raw.match(/<span[^>]*class="[^"]*a-text-normal[^"]*"[^>]*>([^<]{3,})<\/span>/) || [])[1];
    if (!title) continue;

    const image = (raw.match(/<img[^>]+class="s-image"[^>]+src="([^"]+)"/) || [])[1] || '';
    const price = toNumber((raw.match(/<span class="a-offscreen">([^<]+)<\/span>/) || [])[1]);

    results.push({
      id: asin,
      name: title.trim(),
      image,
      price,
      oldPrice: null,
      currency: 'SAR',
      link: `${SEARCH_BASE}/dp/${asin}`,
      size: '',
      brand: '',
      discountLabel: '',
    });
  }
  return results;
}

const searchHtmlStrategy = {
  name: 'search-html',
  async run(query) {
    const lang = detectLang(query);
    const url = `${SEARCH_BASE}/s?k=${encodeURIComponent(query)}&language=${lang === 'ar' ? 'ar_AE' : 'en_AE'}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': lang === 'ar' ? 'ar,en;q=0.8' : 'en-US,en;q=0.9',
      },
    });
    const html = await res.text();

    const blocked = classifyBlock(res.status, html);
    if (blocked) throw new Error(`Amazon blocked the request: ${blocked} [${html.length}b]`);

    const products = parseProducts(html);
    if (!products.length) {
      throw new Error(`No products parsed (status ${res.status}, ${html.length}b) — layout change or soft block`);
    }
    return products;
  },
};

export const amazonProvider = {
  id: 'amazon',
  label: 'Amazon SA',
  // Durable first, best-effort fallback second.
  strategies: [paapiStrategy, searchHtmlStrategy],
};
