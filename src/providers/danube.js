// providers/danube.js — Danube (experimental) provider.
//
// Danube (BinDawood Holding) runs on Spree Commerce and exposes a public JSON
// API. Like Panda/Tamimi, this is a plain server-side fetch + normalize — no
// scraping, no auth, no protection bypass.
//
//   GET /api/products.json?q[name_cont]=<query>&per_page=20
//   -> { products: [ { id, name, name_en, full_name, full_name_en, pack_size,
//                       pack_unit, price, on_sale, original_price, slug, brand,
//                       brand_en, master.images[].large_url } ] }
//   Both languages ship in every response, so no locale param is needed.
//   `name` is the bare product line ("تندرينا تونه ناعمه"); the package size
//   only lives in `pack_size` + `pack_unit` ("١٨٥" + "غرام", Arabic-Indic
//   digits) and in the
//   full names ("Goody Tenderina Soft Tuna 185g"). Price Monitoring compares
//   per item, so the size must reach it.

import { gtinsFromUrls } from './gtin.js';

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

// Arabic-Indic and Persian digits, and the Arabic decimal separator, as ASCII.
export function foldDigits(text) {
  return String(text || '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
}

function pickImage(product) {
  const imgs = (product.master && product.master.images) || product.images || [];
  const i = imgs[0];
  return (i && (i.large_url || i.product_url || i.small_url)) || '';
}

export function normalize(product, lang) {
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
    size: foldDigits([product.pack_size, product.pack_unit].filter(Boolean).join(' '))
      .replace(/\s+/g, ' ').trim(),
    brand: (brand || '').trim(),
    discountLabel: (product.discount_text || '').trim(),
    // Additive: both languages and the full titles (brand + line + size).
    nameEn: (product.name_en || '').trim() || null,
    fullName: foldDigits(product.full_name).trim() || null,
    fullNameEn: (product.full_name_en || '').trim() || null,
    brandEn: (product.brand_en || '').trim() || null,
    // Danube names product photos by barcode (…/6281014620208.01.jpg).
    barcodes: gtinsFromUrls(((product.master && product.master.images) || [])
      .flatMap((i) => [i.large_url, i.product_url])),
    inStock: typeof product.in_stock === 'boolean' ? product.in_stock : null,
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
      // A 429 is a burst limit: wait it out properly.
      const pause = /HTTP 429/.test(lastErr?.message || '') ? 1500 * attempt : 300 * attempt;
      await new Promise((r) => setTimeout(r, pause));
    } else {
      throw lastErr;
    }
  }
  throw lastErr;
}

// --- search ----------------------------------------------------------------------
//
// The API filters with Ransack, and only some predicates are allowed. Measured
// 2026-11-03:
//   • `name` is the bare product line, in both languages: "تندرينا تونه ناعمه".
//     The brand and the size are NOT in it, so the old phrase search
//     (`name_cont`) found nothing for "نادك", "بيبسي", "قودي تندرينا" or
//     "تندرينا 185", and the spelling had to be exact (تونة ≠ تونه, الأجل ≠
//     الاجل; the catalogue itself writes both).
//   • `name_matches_all[]` takes LIKE patterns: every word must appear, in any
//     order, and `_` stands for one letter, so "%تون_%" finds تونة / تونه / تونا.
//   • `description_matches_all[]`: the Arabic description names the brand
//     ("تؤكد لك قودي ان تونة تندرينا هي الأفضل").
//   • `slug_cont_all[]`: the slug is usually the English full title
//     ("nadec-long-life-milk-full-fat-12x1ltr").
//   • `q[m]=or` ORs the predicates of one request. Ransack groupings (`q[g]`)
//     answer 422.
// Unknown predicates are silently ignored (the whole catalogue comes back), so
// only these are used.

const PER_PAGE = 30;
// Words that never carry identity in a store title, and pack words Danube
// keeps out of `name` (the count lives in pack_size: "بيبسي علب" found nothing).
const FILLER = new Set([
  'في', 'مع', 'من', 'و', 'او', 'على', 'with', 'in', 'of', 'and', 'the', 'for', '&',
  'علب', 'علبة', 'علبه', 'عبوة', 'عبوه', 'عبوات', 'كرتون', 'حبة', 'حبه', 'حبات', 'قطع', 'قطعة',
  'pack', 'cans', 'can', 'bottles', 'bottle', 'pcs', 'pieces',
]);
// A unit word right after a number belongs to the size ("185 جم", "1 L").
const UNIT = /^(g|gm|gr|grams?|kg|ml|l|lt|ltr|liters?|litres?|cl|oz|pcs?|غ|غم|غرام|جرام|جم|كغ|كجم|كيلو|مل|لتر|ل|حبة|حبه|حبات|قطعة|قطع|علبة|علب|عبوة|عبوات)$/i;
const MAX_WORDS = 5;

// The identity words of a query: sizes, pack counts and filler dropped, the
// shopper's own spelling kept.
export function searchWords(query) {
  const words = foldDigits(query).replace(/[×*]/g, ' x ').split(/\s+/).filter(Boolean);
  const out = [];
  let afterNumber = false;
  for (const raw of words) {
    const w = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!w) continue;
    if (/\d/.test(w) || /^x$/i.test(w)) { afterNumber = true; continue; }
    if (afterNumber && UNIT.test(w)) { afterNumber = false; continue; }
    afterNumber = false;
    if (FILLER.has(w.toLowerCase()) || w.length < 2) continue;
    out.push(w);
  }
  return out.slice(0, MAX_WORDS);
}

// One word as a LIKE pattern that forgives the spellings Arabic catalogues
// mix: any alef form inside a word (أ إ آ ا ٱ), and ة/ه, ى/ي at its end. At
// least 3 letters stay literal, and a final ا stays literal: "%نوف_%" matched
// نوفلتي, "%مي__%" matched almost anything.
export function likePattern(word) {
  const escaped = String(word).replace(/[%_\\]/g, '');
  // Hamza varies on an alef that starts the word or follows the article
  // (أصلي / اصلي, الأجل / الاجل); a medial ا is a plain letter (مياه).
  const inner = escaped.replace(/[أإآٱ]/g, '_').replace(/^((?:[وفبكل]?ال)|لل)?ا(?=.)/u, (m, prefix) => `${prefix || ''}_`);
  const ending = inner.replace(/[ةهىي]$/u, '_');
  const literal = (text) => text.replace(/_/g, '').length;
  const loose = literal(ending) >= 3 ? ending : literal(inner) >= 3 ? inner : escaped;
  return `%${loose}%`;
}

const isLatin = (w) => /^[a-z][a-z'-]{2,}$/i.test(w);

const param = (key, values) => values
  .map((v) => `q%5B${key}%5D%5B%5D=${encodeURIComponent(v)}`).join('&');

// The requests one search makes, in order. Predicates of one request are
// ANDed, so "the line in the name AND the brand in the description" is one
// request — the brand word may lead ("قودي تونة") or trail ("مياه نوفا").
export function searchPlan(query) {
  const words = searchWords(query);
  if (!words.length) {
    return [`q%5Bname_cont%5D=${encodeURIComponent(String(query).trim())}`];
  }
  const like = (list) => list.map(likePattern);
  const plan = [param('name_matches_all', like(words))];
  // One word that is in no name is a brand ("بيبسي"): the description.
  if (words.length === 1) plan.push(param('description_matches_all', like(words)));
  if (words.length >= 2) {
    const [first, last] = [words[0], words[words.length - 1]];
    const head = words.slice(1);
    const tail = words.slice(0, -1);
    plan.push(`${param('name_matches_all', like(head))}&${param('description_matches_all', like([first]))}`);
    plan.push(`${param('name_matches_all', like(tail))}&${param('description_matches_all', like([last]))}`);
    // The slug is the English full title: an English brand lives there.
    if (isLatin(first)) plan.push(`${param('name_matches_all', like(head))}&${param('slug_cont_all', [first.toLowerCase()])}`);
  }
  const latin = words.filter(isLatin).map((w) => w.toLowerCase()).slice(0, 3);
  if (latin.length) plan.push(param('slug_cont_all', latin));
  return [...new Set(plan)];
}

const searchUrl = (filter) => `${API_BASE}/api/products.json?per_page=${PER_PAGE}&${filter}`;

async function searchProducts(filter) {
  const json = await fetchDanubeJson(searchUrl(filter));
  const products = json && json.products;
  if (!Array.isArray(products)) throw new Error('unexpected response shape');
  return products;
}

// `wide` (Price Monitoring's index): run every step and merge, in plan order —
// a watch must reach the listing even when an earlier step returns something
// else. The steps run one after another: Danube answers 429 to bursts (5
// parallel requests did it on 2026-11-03; 40 sequential ones in 20 s did not).
// Otherwise (shopping search) each later step runs only when every earlier
// one found nothing, so a search that works costs one request.
async function runPlan(plan, { wide = false } = {}) {
  if (wide) {
    const settled = [];
    for (const filter of plan) {
      try {
        settled.push({ status: 'fulfilled', value: await searchProducts(filter) });
      } catch (reason) {
        settled.push({ status: 'rejected', reason });
        if (settled.length === 1) break;
      }
    }
    // The first step is the store's answer: its failure fails the search.
    if (settled[0].status === 'rejected') throw settled[0].reason;
    // Round-robin, so every step's best results survive the caller's limit.
    const lists = settled.map((s) => (s.status === 'fulfilled' ? s.value : []));
    const seen = new Set();
    const merged = [];
    for (let rank = 0; lists.some((l) => rank < l.length); rank += 1) {
      for (const list of lists) {
        const p = list[rank];
        if (!p || seen.has(p.id)) continue;
        seen.add(p.id);
        merged.push(p);
      }
    }
    if (!merged.length && settled.some((s) => s.status === 'rejected')) {
      throw settled.find((s) => s.status === 'rejected').reason;
    }
    return merged;
  }
  let lastErr = null;
  for (const [index, filter] of plan.entries()) {
    let products;
    try {
      products = await searchProducts(filter);
    } catch (err) {
      if (index === 0) throw err;
      lastErr = err;
      continue;
    }
    if (products.length) return products;
  }
  // A widening step failed after empty answers: unknown, not "no such product".
  if (lastErr) throw lastErr;
  return [];
}

const productsApiStrategy = {
  name: 'spree-products-json',
  async run(query, options = {}) {
    const lang = detectLang(query);
    const products = await runPlan(searchPlan(query), options);
    return products.map((p) => normalize(p, lang)).filter((r) => r.name);
  },
};

export const danubeProvider = {
  id: 'danube',
  label: 'Danube',
  strategies: [productsApiStrategy],
};
