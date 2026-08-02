// providers/noon.js — Noon (experimental) provider.
//
// Noon's main marketplace (www.noon.com) blocks datacenter traffic outright, but
// Noon Minutes (minutes.noon.com, its grocery quick-commerce) server-renders
// search results and serves them freely (Cloudflare in front, but no challenge;
// no cookie, location pin or warehouse code is required for the search page).
// This provider fetches the search page and reads the products out of the SSR
// payload — no browser automation, no auth, no protection bypass.
//
//   GET /{saudi-en|saudi-ar}/search/?q=<query>
//
// PAYLOAD FORMAT (changed 2026): Minutes used to be a Next.js app and shipped an
// RSC flight in self.__next_f.push([1,"<json>"]) chunks. It has since migrated to
// TanStack Start, which streams a seroval payload inside
//
//   <script class="$tsr" id="$tsr-stream-barrier"> ... </script>
//
// That payload is a JavaScript object literal, NOT JSON: keys are unquoted
// (sku:"..." rather than "sku":"...") and repeated values are hoisted into
// $R[n]=<value> back-references. JSON.parse can therefore never be applied to it,
// which is why we locate each product object by its `sku:` key and read the
// handful of fields we need straight out of the object's source text.
//
// Product fields: sku, brand, title, sizeInfo, price (list / was-price),
// salePrice (only when discounted), offerPrice (effective price), imageKey,
// transparentImageUrl.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function detectLang(query) {
  return /[؀-ۿ]/.test(query) ? 'ar' : 'en';
}
function toNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// Isolate the streamed payload script. Scanning the whole document would be
// wrong: HTML attribute quotes are indistinguishable from JS string quotes, so
// the string-aware scan below must run over JavaScript only. Prefer the barrier
// script by id, and fall back to the largest inline script if noon renames it.
function payloadScript(html) {
  let best = '';
  const open = /<script\b[^>]*>/g;
  let m;
  while ((m = open.exec(html)) !== null) {
    const start = m.index + m[0].length;
    const end = html.indexOf('</script>', start);
    if (end === -1) continue;
    const body = html.slice(start, end);
    open.lastIndex = end;
    if (m[0].includes('$tsr-stream-barrier')) return body;
    if (body.length > best.length) best = body;
  }
  return best;
}

// Decode a JS string literal's body. Beyond the usual escapes, seroval emits
// `\x3C` for `<` so the payload can never close its own <script> tag.
function decode(raw) {
  try {
    return JSON.parse(`"${raw.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1')}"`);
  } catch (_) {
    return raw;
  }
}

// Read an object's OWN scalar fields out of its source text.
//
// A regex over the whole slice would be wrong, because a product object embeds
// other objects that reuse the same key names — `childItemsDetails` entries and
// bulk-offer rows both carry `sku` and `title`, and the bulk row's title is the
// pack size ("1L") rather than the product name. Tracking depth and recording
// only depth-1 keys is what keeps those from being read as the product's own.
function ownFields(seg) {
  const fields = {};
  let depth = 0;
  let inString = false;
  let escaped = false;
  let i = 0;

  while (i < seg.length) {
    const c = seg[i];
    if (escaped) { escaped = false; i++; continue; }
    if (c === '\\') { escaped = true; i++; continue; }
    if (inString) { if (c === '"') inString = false; i++; continue; }
    if (c === '"') { inString = true; i++; continue; }
    if (c === '{' || c === '[') { depth++; i++; continue; }
    if (c === '}' || c === ']') { depth--; i++; continue; }

    const prev = seg[i - 1];
    if (depth !== 1 || (prev !== '{' && prev !== ',') || !/[A-Za-z_$]/.test(c)) { i++; continue; }

    let j = i;
    while (j < seg.length && /[A-Za-z0-9_$]/.test(seg[j])) j++;
    if (seg[j] !== ':') { i = j; continue; }
    const key = seg.slice(i, j);

    // Values may be hoisted into a back-reference: `key:$R[12]=<value>`.
    let k = j + 1;
    const ref = /^\$R\[\d+\]=/.exec(seg.slice(k, k + 16));
    if (ref) k += ref[0].length;

    if (seg[k] === '"') {
      let e = k + 1;
      let esc = false;
      for (; e < seg.length; e++) {
        const ch = seg[e];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"') break;
      }
      fields[key] = decode(seg.slice(k + 1, e));
      i = e + 1;
      continue;
    }
    const numMatch = /^-?\d+(?:\.\d+)?/.exec(seg.slice(k, k + 24));
    if (numMatch) {
      fields[key] = toNumber(numMatch[0]);
      i = k + numMatch[0].length;
      continue;
    }
    // Anything else (null, !0/!1, a nested object or array) is not a field we
    // read; hand the position back to the main loop so it tracks depth for us.
    i = k;
  }
  return fields;
}

// Walk the payload once, string-aware, tracking the offsets of open braces. When
// a `sku:` key is seen the innermost open object is flagged; when that object
// closes, its source text is a candidate product record. A single pass keeps
// this linear and — unlike backtracking from the key — never has to guess where
// the enclosing object began.
function extractProducts(payload) {
  const starts = [];
  const flagged = [];
  const bySku = new Map();
  let inString = false;
  let escaped = false;

  for (let i = 0; i < payload.length; i++) {
    const c = payload[i];
    if (escaped) { escaped = false; continue; }
    if (c === '\\') { escaped = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (c === '{') {
      starts.push(i);
      flagged.push(false);
    } else if (c === '}') {
      const start = starts.pop();
      const hasSku = flagged.pop();
      if (start === undefined || !hasSku) continue;
      const product = readProduct(payload.slice(start, i + 1), start);
      if (!product) continue;
      // The real record and its embedded bulk-offer rows share a sku, and the
      // nested ones close first. Keep whichever candidate is the fullest record.
      const held = bySku.get(product.sku);
      if (!held || product.score > held.score) bySku.set(product.sku, product);
    } else if (c === 's' && flagged.length && payload.startsWith('sku:"', i)) {
      flagged[flagged.length - 1] = true;
    }
  }
  // Emit in page order — the grid's own ranking, which close order does not keep.
  return [...bySku.values()].sort((a, b) => a.offset - b.offset);
}

// Turn one object into a product record, or null if it is not a search hit.
// Search pages also embed slim ~240b stubs (recently-viewed and related-item
// references) that carry a sku and a title but no price; requiring a price is
// what separates a sellable result from a stub.
function readProduct(seg, offset) {
  const f = ownFields(seg);
  const now = f.offerPrice != null ? f.offerPrice : f.salePrice != null ? f.salePrice : f.price;
  if (!f.sku || !f.title || now == null) return null;
  // Multi-buy rows ("x 2", "Save 1.45") are options attached to a product, not
  // grid results: they get their own bundle sku, so deduplication cannot merge
  // them away, and their title is the pack size rather than a product name.
  // `qtyText` is the label the UI renders for them and no catalogue record has it.
  if (f.qtyText !== undefined) return null;
  return {
    sku: f.sku,
    title: f.title,
    now,
    // `price` is the was-price; it equals the effective price when not on offer.
    oldPrice: f.price != null && f.price > now ? f.price : null,
    brand: f.brand || '',
    size: f.sizeInfo || '',
    image: f.transparentImageUrl || '',
    imageKey: f.imageKey || '',
    offset,
    // Bulk-offer rows carry a sku, a title and a price but never the catalogue
    // fields, so ranking on those picks the real record without discarding a
    // genuine product that happens to be missing one of them.
    score: (f.brand ? 2 : 0) + (f.sizeInfo ? 1 : 0),
  };
}

function normalize(p, locale) {
  // The payload splits the display name: brand ("Almarai") and title ("Fresh
  // Full Fat Milk") are separate fields and the site renders them together.
  // Rebuild the full name so it stays comparable with the other providers, which
  // all receive brand-inclusive names from their sources.
  const name =
    p.brand && !p.title.toLowerCase().startsWith(p.brand.toLowerCase())
      ? `${p.brand} ${p.title}`
      : p.title;
  const image = p.image || (p.imageKey ? `https://f.nooncdn.com/p/${p.imageKey}.jpg` : '');

  return {
    id: p.sku,
    name: name.trim(),
    image,
    price: p.now,
    oldPrice: p.oldPrice,
    currency: 'SAR',
    link: `https://minutes.noon.com/${locale}/now-product/${p.sku}/`,
    size: p.size.trim(),
    brand: p.brand.trim(),
    discountLabel: p.oldPrice ? `${Math.round((1 - p.now / p.oldPrice) * 100)}% Off` : '',
  };
}

const searchSsrStrategy = {
  name: 'minutes-search-ssr',
  async run(query) {
    const locale = detectLang(query) === 'ar' ? 'saudi-ar' : 'saudi-en';
    const url = `https://minutes.noon.com/${locale}/search/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' } });
    const html = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (html.length < 20000 || /Just a moment|cf-challenge|Attention Required/i.test(html)) {
      throw new Error(`blocked or empty page (${html.length}b)`);
    }
    const payload = payloadScript(html);
    if (!payload) throw new Error(`no SSR payload script (page ${html.length}b)`);
    const products = extractProducts(payload);
    // A payload that carries product records we failed to read is a parse break,
    // not an empty search — say so, because that is exactly the failure that
    // silently emptied this provider when Minutes left Next.js. A genuinely
    // result-less query returns [], which the connector reports as "no results".
    if (!products.length && payload.includes('sku:"')) {
      throw new Error(`product records present but none parsed (payload ${payload.length}b)`);
    }
    return products.map((p) => normalize(p, locale)).filter((r) => r.name);
  },
};

export const noonProvider = {
  id: 'noon',
  label: 'Noon',
  strategies: [searchSsrStrategy],
};
