// providers/noon.js — Noon (experimental) provider.
//
// Noon's main marketplace (www.noon.com) blocks datacenter traffic outright, but
// Noon Minutes (minutes.noon.com, its grocery quick-commerce) server-renders
// search results and serves them freely (Cloudflare in front, but no challenge;
// the guest cookie it sets is not required for the search page). This provider
// fetches the search page and reads the products out of Next.js' RSC flight
// payload — no browser automation, no auth, no protection bypass.
//
//   GET /{saudi-en|saudi-ar}/search/?q=<query>
//   -> RSC flight with product objects: { sku, title, brand, price, sale_price,
//      image_key, transparent_image_url, size_info }

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function detectLang(query) {
  return /[؀-ۿ]/.test(query) ? 'ar' : 'en';
}
function toNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Reconstruct the RSC flight text from self.__next_f.push([1,"..."]) chunks.
// Manual scan (no big regex) to stay fast and avoid catastrophic backtracking.
function reconstructFlight(html) {
  const marker = 'self.__next_f.push([1,';
  let flight = '';
  let i = 0;
  while ((i = html.indexOf(marker, i)) !== -1) {
    let j = i + marker.length;
    if (html[j] !== '"') {
      i = j;
      continue;
    }
    let k = j + 1;
    let esc = false;
    for (; k < html.length; k++) {
      const c = html[k];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') break;
    }
    try {
      flight += JSON.parse(html.slice(j, k + 1));
    } catch (_) {
      /* ignore */
    }
    i = k + 1;
  }
  return flight;
}

// Find the end index of a balanced {...} object starting at `st` (string-aware).
function objEnd(s, st) {
  let d = 0, q = false, esc = false;
  for (let j = st; j < s.length; j++) {
    const c = s[j];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { q = !q; continue; }
    if (q) continue;
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return j + 1; }
  }
  return -1;
}

// Extract product objects: for each "sku" occurrence, backtrack to the enclosing
// object and keep the ones that look like real products (have brand + image).
function extractProducts(flight, cap) {
  const seen = new Set();
  const out = [];
  let idx = 0;
  while (out.length < cap && (idx = flight.indexOf('"sku":"', idx)) !== -1) {
    // Noon product objects are large (duplicated camel/snake fields), so use a
    // generous backtrack window and skip past any closed nested objects until we
    // reach the brace that actually encloses this sku.
    for (let b = idx; b >= 0 && idx - b < 8000; b--) {
      if (flight[b] === '{') {
        const e = objEnd(flight, b);
        if (e > idx) {
          try {
            const o = JSON.parse(flight.slice(b, e));
            if (o.sku && o.title && o.image_key && o.brand && !seen.has(o.sku)) {
              seen.add(o.sku);
              out.push(o);
            }
          } catch (_) {
            /* ignore malformed candidate */
          }
          break;
        }
      }
    }
    idx += 6;
  }
  return out;
}

function normalize(p, locale) {
  const price = toNumber(p.price);
  const sale = toNumber(p.sale_price);
  const now = sale != null ? sale : price;
  const oldPrice = sale != null && price != null && price > sale ? price : null;
  const image =
    p.transparent_image_url || (p.image_key ? `https://f.nooncdn.com/p/${p.image_key}.jpg` : '');

  return {
    id: p.sku,
    name: (p.title || '').trim(),
    image,
    price: now,
    oldPrice,
    currency: 'SAR',
    link: `https://minutes.noon.com/${locale}/${p.sku}/p/`,
    size: (p.size_info || '').trim(),
    brand: (p.brand || '').trim(),
    discountLabel: oldPrice ? `${Math.round((1 - now / oldPrice) * 100)}% Off` : '',
  };
}

const searchFlightStrategy = {
  name: 'minutes-search-flight',
  async run(query) {
    const locale = detectLang(query) === 'ar' ? 'saudi-ar' : 'saudi-en';
    const url = `https://minutes.noon.com/${locale}/search/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    const html = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (html.length < 20000 || /Just a moment|cf-challenge|Attention Required/i.test(html)) {
      throw new Error(`blocked or empty page (${html.length}b)`);
    }
    const flight = reconstructFlight(html);
    const products = extractProducts(flight, 30);
    if (!products.length) throw new Error(`no products parsed (flight ${flight.length}b)`);
    return products.map((p) => normalize(p, locale)).filter((r) => r.name);
  },
};

export const noonProvider = {
  id: 'noon',
  label: 'Noon',
  strategies: [searchFlightStrategy],
};
