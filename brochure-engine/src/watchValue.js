// watchValue.js — Value Watch (price monitoring v4), the PURE half.
//
// What a watch means (user directive 2026-11-03): THIS exact product — same
// brand, same product line and variant, same size PER ITEM — in ANY pack, at
// ANY store, and the hunt is VALUE: "12 cans for 50" beats "one can for 5"
// because 50 / 12 = 4.17 per can. So:
//
//   • identity is decided once per listing, by an indexer that searches every
//     store, verifies each candidate (deterministic rules first, then an AI
//     judge for the ones rules cannot settle) and remembers the verdict;
//   • the comparison figure is the price PER ITEM of the watched size, and the
//     user's target is converted to the same figure from the pack they saw;
//   • an alert fires when the cheapest verified listing CROSSES to the target,
//     never twice for the same deal, and the watch re-arms only on evidence
//     (the deal itself seen above target, or gone for two rounds while its
//     store answered) — a store that is down can neither re-arm nor starve it.
//
// What went wrong before (measured on production, 2026-11-03): the v3 "general"
// contract pinned only brand + family, so a 125 ml milk at 1.25 fired a 50 SAR
// 12-pack watch, 6 × 1.5 L bottles fired a 40 × 330 ml watch, "fine tuna" fired
// a "tuna in sunflower oil" watch; the store with the real deal (Panda, 3.66
// for the watched 80 g tin) was never matched; and once Lulu started refusing
// the Worker (2026-10-22) every round was "partial", which pinned is_below = 1
// for good — no watch could alert again. Each rule below answers one of those.
//
// No I/O here. watchIndex.js does the searching, the AI call and the storage.

import { normalizeText, parseSize, stripSizes } from './matching.js';
import { effectivePurchasePrice } from './priceWatch.js';
import { resolveBrand } from './lexicon/brands.js';
import { listingIdentityCandidate } from './identity/listingCandidate.js';
import { SHOPPING_CATEGORIES, normalizeShoppingText } from './lexicon/shopping.js';

export const VALUE_WATCH_VERSION = 'value-v1';

// Two listings are the same SIZE PER ITEM when their item sizes are within 6%.
// Wider than the 3% product-equivalence tolerance on purpose: stores round
// (1.5 L vs 1500 ml is exact, but 185 g vs 180 g net drained weight is not),
// and a different real size is never that close (80 g vs 185 g, 330 vs 250 ml).
export const ITEM_SIZE_TOLERANCE = 0.06;
// Already below target, a further drop of at least 5% per item is news.
export const LOWER_ALERT_STEP = 0.05;
// A verified listing absent from its store's answers this many rounds in a row
// (while the store DID answer) is treated as gone — out of stock or delisted.
export const MISSING_ROUNDS_GONE = 2;
// The AI judge reads this many candidates per request, and at most this many
// per sweep (the rest wait for the next sweep, ranked by evidence).
export const JUDGE_BATCH = 20;
export const MAX_JUDGED_PER_SWEEP = 60;
export const MAX_QUERIES = 4;

const EPS = 1e-9;

export const VERDICT = Object.freeze({
  MATCH: 'match',
  REJECT: 'reject',
  PENDING: 'pending',
});

// --- quantities --------------------------------------------------------------

// Light normalization that keeps the multiplication signs parseSize ignores
// after normalizeText strips punctuation.
function packText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ');
}

// An explicit multipack phrase parseSize does not read: "عبوة من 6",
// "(6 قطع)", "Pack of 40", "40 حبة", "24 علبة", "6-pack". Returned as a
// CANDIDATE count only — "20 قطعة" can also be the nuggets inside one box, so
// the caller corroborates it (watchQuantity below) before multiplying.
const PACK_PHRASES = [
  { re: /(?:عبوه|عبوات|علبه|كرتونه|كرتون|باكيت|باك|pack|box|case)\s*(?:من|of)\s*(\d{1,3})(?!\s*(?:g|gm|kg|ml|l|غ|جم|غرام|جرام|كجم|كغ|مل|لتر))/u, strong: true },
  { re: /(\d{1,3})\s*-?\s*(?:pack|packs|pk|cans|bottles|tins|cartons|علب|علبه|عبوات|عبوه|زجاجات|زجاجه|قوارير|كراتين)(?![\p{L}])/u, strong: true },
  { re: /(\d{1,3})\s*(?:حبه|حبات|pcs|pc|pieces|piece|قطع|قطعه|count|ct)(?![\p{L}])/u, strong: false },
];

export function readPackPhrase(text) {
  const hay = packText(text);
  for (const { re, strong } of PACK_PHRASES) {
    const m = re.exec(hay);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isInteger(n) && n >= 2 && n <= 200) return { count: n, strong };
  }
  return null;
}

const textOf = (listing = {}) => [
  listing.name, listing.nameEn, listing.fullName, listing.fullNameEn,
].filter((v) => typeof v === 'string' && v.trim()).join(' · ');

const sizeOf = (listing = {}) => {
  const size = listing.size;
  if (typeof size === 'string') return size;
  if (size && typeof size === 'object' && size.value && size.unit) {
    return `${listing.count > 1 ? `${listing.count} x ` : ''}${size.value} ${size.unit}`;
  }
  return '';
};

// A store size field that names ONE item ("1 لتر", "170 جرام"), or null.
function singleSize(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const p = parseSize(text, '');
  if (!(p?.unit && p.unit !== 'pcs' && p.each) || Math.round(p.pack || 1) !== 1) return null;
  return { value: Math.round(p.each * 1000) / 1000, unit: p.unit };
}

// "A x B unit" in a title, read against a known per-item size: B items of A
// ("1x4 لتر" beside a 1 L size field) or A items of B ("12×1 ل", a short
// litre sign parseSize does not know). The count, or null.
const UNIT_ALIAS = { 'ل': 'لتر', 'لت': 'لتر' };
function multipliedCount(text, item) {
  const re = /(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*([\p{L}]+)/gu;
  const hay = packText(text).replace(/,/g, '.');
  for (const m of hay.matchAll(re)) {
    const unit = UNIT_ALIAS[m[3]] || m[3];
    for (const [count, value] of [[m[2], m[1]], [m[1], m[2]]]) {
      const n = Number(count);
      if (!(Number.isInteger(n) && n >= 2 && n <= 200)) continue;
      if (sameItemSize(singleSize(`${value} ${unit}`), item) === true) return n;
    }
  }
  return null;
}

// "18 x 330-355 مل" (Tamimi: the can is 330 or 355 ml, by supply) is read as
// its smaller size — a narrow range only (at most 20% wide); parseSize alone
// reads one 355 ml can.
function collapseRange(text) {
  return String(text || '').replace(/(\d+(?:[.,]\d+)?)\s*[-–]\s*(\d+(?:[.,]\d+)?)(?=\s*[\p{L}])/gu, (m, a, b) => {
    const lo = Number(a.replace(',', '.'));
    const hi = Number(b.replace(',', '.'));
    return lo > 0 && hi > lo && hi <= lo * 1.2 ? a : m;
  });
}

// The per-item size and the number of items, as the listing's own text states
// them. `aiItems` is the judge's count; it only ever corroborates text — a
// number the AI read that is not written in the listing is not believed.
export function watchQuantity(listing = {}, { aiItems = null } = {}) {
  const text = collapseRange(textOf(listing));
  const size = collapseRange(sizeOf(listing));
  // Each name on its own first: a bilingual pair would otherwise read the
  // Arabic size and the English size as one "2-pack".
  let parsed = null;
  for (const raw of [listing.name, listing.fullName, listing.nameEn, listing.fullNameEn]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const candidate = collapseRange(raw);
    const p = parseSize(candidate, size);
    if (p?.unit && p.unit !== 'pcs' && p.each) { parsed = p; break; }
  }
  if (!parsed) parsed = parseSize(text, size);
  const measured = parsed?.unit && parsed.unit !== 'pcs' && parsed.each ? parsed : null;
  let each = measured ? { value: Math.round(measured.each * 1000) / 1000, unit: measured.unit } : null;
  let pack = measured ? Math.max(1, Math.round(measured.pack || 1)) : 1;
  let packSource = measured && pack > 1 ? 'text' : 'single';
  // Panda writes some multipacks size first — "عبوة متعددة 1x4 لتر" is four
  // 1 L cartons, "170x6 جرام" six 170 g cups — and its size field states the
  // size per item ("1 لتر"). A title that disagrees with that field, or reads
  // no multiplier at all ("12×1 ل"), is read against the field (2026-11-03:
  // the 4 x 1 L Nadec pack at 4.50 per litre was rejected as one 4 L carton).
  const field = singleSize(size);
  if (field && (pack === 1 || (each && sameItemSize(each, field) === false))) {
    const count = multipliedCount(text, field);
    if (count) {
      each = field;
      pack = count;
      packSource = 'text';
    }
  }
  const phrase = readPackPhrase(`${text} ${size}`);
  const written = (n) => new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(packText(`${text} ${size}`));
  const ai = Number.isInteger(Number(aiItems)) && Number(aiItems) >= 1 ? Number(aiItems) : null;
  if (pack === 1 && phrase) {
    // A strong multipack phrase ("pack of 6", "24 cans") stands on its own;
    // a piece word ("6 قطع") needs the judge to agree it counts packages.
    if (phrase.strong && (ai == null || ai === phrase.count)) {
      pack = phrase.count;
      packSource = 'text';
    } else if (ai === phrase.count) {
      pack = phrase.count;
      packSource = 'text+ai';
    }
  } else if (pack === 1 && ai && ai > 1 && ai <= 200 && written(ai)) {
    pack = ai;
    packSource = 'ai';
  }
  // A unitless piece count ("12 rolls") with no measured size: the items ARE
  // the pieces. Kept as each = 1 piece so per-item maths still works.
  if (!each && parsed?.unit === 'pcs' && parsed.src === 'count' && parsed.pack > 1) {
    return { each: { value: 1, unit: 'pcs' }, pack: parsed.pack, packSource: 'text' };
  }
  return { each, pack, packSource };
}

// The pack count a listing states beyond doubt, or null: a multipack its text
// reads plainly ("12 x 1 L", "Pack of 12"), or a single with no count phrase
// at all. "4 حبات 1 لتر" is null — the count still needs corroboration.
export function statedPack(listing = {}) {
  const q = watchQuantity(listing);
  if (!q.each) return null;
  if (q.packSource === 'text') return q.pack;
  return readPackPhrase(`${textOf(listing)} ${sizeOf(listing)}`) ? null : 1;
}

export function sameItemSize(a, b, tolerance = ITEM_SIZE_TOLERANCE) {
  if (!a || !b || !a.unit || !b.unit) return null; // unknown: neither same nor different
  if (a.unit !== b.unit) return false;
  const hi = Math.max(a.value, b.value);
  if (!(hi > 0)) return null;
  return (hi - Math.min(a.value, b.value)) / hi <= tolerance;
}

export function formatItem(item) {
  if (!item) return null;
  if (item.unit === 'ml') return item.value >= 1000 ? `${+(item.value / 1000).toFixed(3)} L` : `${item.value} ml`;
  if (item.unit === 'g') return item.value >= 1000 ? `${+(item.value / 1000).toFixed(3)} kg` : `${item.value} g`;
  if (item.unit === 'pcs') return `${item.value} pc`;
  return `${item.value} ${item.unit}`;
}

// --- the reference (what the user picked) --------------------------------------

function brandOf(listing = {}) {
  for (const value of [listing.brand, listing.brandEn]) {
    const resolved = resolveBrand(typeof value === 'string' ? value : null);
    if (resolved.brand_id) return resolved;
  }
  const candidate = listingIdentityCandidate({ name: textOf(listing) || listing.name || '' });
  if (candidate?.brand) {
    const resolved = resolveBrand(candidate.brand);
    if (resolved.brand_id) return resolved;
  }
  const raw = [listing.brand, listing.brandEn].find((v) => typeof v === 'string' && v.trim());
  return raw ? resolveBrand(raw) : null;
}

// Queries a store's search box understands: the size-free name, cut at the
// first clause ("…, 80g, ideal for sandwiches, 16 g protein" is shop copy).
// The words keep the listing's OWN spelling: stripSizes() folds letters for
// matching (ة→ه, أ→ا), and a store that searches literally (Danube) finds
// "تونة" but never "تونه" (measured 2026-11-03: 5 results vs 0).
export function shortQuery(text, maxWords = 6) {
  const head = String(text || '').split(/[،,|(\-–—:]/u)[0] || '';
  const left = new Map();
  for (const t of stripSizes(head).split(' ')) if (t) left.set(t, (left.get(t) || 0) + 1);
  const words = [];
  for (const raw of head.split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const parts = stripSizes(word).split(' ').filter(Boolean);
    // A word the size strip consumed in context ("185 جم", "12*1لتر") is gone.
    if (!word || !parts.length || !parts.every((p) => left.get(p) > 0)) continue;
    for (const p of parts) left.set(p, left.get(p) - 1);
    if (!/^\d+$/.test(parts.join(''))) words.push(word);
  }
  return words.slice(0, maxWords).join(' ').slice(0, 80).trim();
}

export function referenceQueries({ name, nameEn, brand, customQuery, userQuery } = {}) {
  const out = [];
  const add = (q) => {
    const text = String(q || '').replace(/\s+/g, ' ').trim();
    if (text.length < 2) return;
    const key = normalizeText(text);
    if (!key || out.some((existing) => normalizeText(existing) === key)) return;
    out.push(text);
  };
  add(customQuery);
  add(shortQuery(name));
  // What the shopper typed to find the product: a store's own search already
  // proved it surfaces this product. A one-word query ("تونة") is too broad
  // to reach it within a store's first page, so it only counts with two words.
  const typed = shortQuery(userQuery);
  if (typed.split(' ').length >= 2) add(typed);
  add(shortQuery(nameEn));
  // Brand + the product noun: catches the stores whose titles word the same
  // product differently ("تونا" for "تونة", English-only titles on Amazon).
  if (brand?.display_ar || brand?.display_en) {
    // One language per query: an Arabic title pairs the Arabic brand with its
    // own noun, an English title the English brand with the product family.
    const arabic = /[؀-ۿ]/u.test(name || '');
    const brandWord = arabic ? brand.display_ar || brand.display_en : brand.display_en || brand.display_ar;
    const family = listingIdentityCandidate({ name: name || nameEn || '' })?.family;
    const noun = shortQuery(name, 2).split(' ')
      .find((w) => ![brand.display_ar, brand.display_en].some((b) => b && normalizeText(b) === normalizeText(w)));
    add([brandWord, arabic ? noun : family || noun].filter(Boolean).join(' '));
    // An Arabic-only title gets an English query too: Tamimi files some
    // products under an Arabic name that never says what they are ("علبة",
    // the regular Pepsi can at 3.00 a can) and only its English search
    // surfaces them (measured 2026-11-03).
    if (arabic && !nameEn && brand.display_en) add([brand.display_en, englishNoun(name)].filter(Boolean).join(' '));
  }
  return out.slice(0, MAX_QUERIES);
}

// The English word for the first Arabic product noun in a title ("تونة" →
// tuna), from the shopping lexicon; null when none is known.
const CATEGORY_BY_ARABIC = new Map();
for (const entry of SHOPPING_CATEGORIES) {
  const ar = normalizeShoppingText(entry.ar || '');
  if (ar && !ar.includes(' ') && !CATEGORY_BY_ARABIC.has(ar)) CATEGORY_BY_ARABIC.set(ar, [].concat(entry.en)[0]);
}
function englishNoun(name) {
  for (const word of shortQuery(name).split(' ')) {
    const en = CATEGORY_BY_ARABIC.get(normalizeShoppingText(word));
    if (en) return en;
  }
  return null;
}

// The value contract stored with the watch (watches.reference_json).
export function buildValueReference({
  listing = {}, label = null, query = null, sizeText = null, targetPrice, customQuery = null,
} = {}) {
  const source = { ...listing };
  // A store's FULL title (Danube: brand + line + size) is the better reference.
  if (source.fullName) source.name = source.fullName;
  if (source.fullNameEn) source.nameEn = source.fullNameEn;
  if (!source.name) source.name = label || query || '';
  if (!sizeOf(source) && sizeText) source.size = sizeText;
  const brand = brandOf(source);
  const quantity = watchQuantity(source);
  const pack = quantity.pack || 1;
  const target = Number(targetPrice);
  return {
    v: VALUE_WATCH_VERSION,
    name: String(source.name || '').slice(0, 200),
    nameEn: source.nameEn || null,
    brand: brand ? {
      id: brand.brand_id || null,
      ar: brand.display_ar || (/[؀-ۿ]/u.test(brand.observed_brand || '') ? brand.observed_brand : null),
      en: brand.display_en || (/[a-z]/i.test(brand.observed_brand || '') ? brand.observed_brand : null),
    } : null,
    store: source.provider || source.store || null,
    listingId: source.id != null ? String(source.id) : null,
    item: quantity.each,
    pack,
    packSource: quantity.packSource,
    targetPackPrice: Number.isFinite(target) ? Math.round(target * 100) / 100 : null,
    targetValue: Number.isFinite(target) ? Math.round((target / pack) * 10000) / 10000 : null,
    // The picked listing's barcode keys: the same keys in another store are
    // the same pack of the same product, whatever its title says.
    barcodes: barcodesOf(source).slice(0, 6),
    queries: referenceQueries({
      name: source.name, nameEn: source.nameEn, brand: brand ? {
        display_ar: brand.display_ar || null, display_en: brand.display_en || null,
      } : null, customQuery, userQuery: query,
    }),
  };
}

export function parseReference(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

// --- value of one listing --------------------------------------------------------

// The price per item of the watched size, or null when it cannot be stated
// honestly. `sizeVerified` says whether this listing's item size was READ and
// equals the reference's; only verified listings may raise an alert.
export function listingValue(listing, reference, { aiItems = null, aiItem = null } = {}) {
  const purchasePrice = effectivePurchasePrice(listing);
  if (purchasePrice == null) return null;
  const q = watchQuantity(listing, { aiItems });
  const item = q.each || aiItem || null;
  const pack = q.pack || 1;
  const same = sameItemSize(item, reference?.item);
  if (same === false) return null; // a different product size is not this product
  let value = purchasePrice / pack;
  // Inside the tolerance, normalize to the watched size so 180 g and 185 g
  // tins compare fairly.
  if (same && item.value !== reference.item.value) value = (purchasePrice / (pack * item.value)) * reference.item.value;
  return {
    purchasePrice,
    pack,
    packSource: q.packSource,
    item,
    value: Math.round(value * 10000) / 10000,
    sizeVerified: same === true || (!reference?.item && !item),
  };
}

// --- store listings -----------------------------------------------------------------

// A store product that lists several PACK SIZES (Tamimi's variants: 1 L,
// 4 x 1 L, 12 x 1 L …) becomes one listing per pack, each with its own price,
// stock and barcodes. The first pack keeps the product's own id (it is the
// listing every other consumer sees); the others are `<id>~v<variant id>`.
export function expandVariants(listing) {
  if (!listing || typeof listing !== 'object') return [];
  const { variants, ...base } = listing;
  if (!Array.isArray(variants) || variants.length <= 1) return [base];
  return variants.map((v, index) => ({
    ...base,
    id: index === 0 ? base.id : `${base.id}~v${v.id}`,
    size: v.size || base.size,
    price: v.price ?? null,
    oldPrice: v.oldPrice ?? null,
    inStock: v.inStock ?? null,
    barcodes: Array.isArray(v.barcodes) ? v.barcodes : [],
    variantOf: index === 0 ? null : base.id,
  }));
}

// The barcode keys a listing carries (connector gtin.js: the 12-digit EAN-13
// body, so every store's spelling of one pack compares equal).
export function barcodesOf(listing) {
  return Array.isArray(listing?.barcodes)
    ? listing.barcodes.filter((b) => typeof b === 'string' && b.length >= 8)
    : [];
}

export function sharesBarcode(listing, keys) {
  if (!keys?.length) return false;
  return barcodesOf(listing).some((b) => keys.includes(b));
}

// The GS1 company prefix, coarsely: the first 7 digits of a Saudi (628)
// body identify the maker (6281014 Goody, 6281057 Nadec, 6281011 Afia). Only
// ever EVIDENCE for the judge — one brand can be made by several companies.
export function makerPrefix(key) {
  return /^628\d{9}$/.test(String(key || '')) ? key.slice(0, 7) : null;
}

// --- deterministic verification --------------------------------------------------

const STOP = new Set([
  'من', 'في', 'مع', 'و', 'او', 'ب', 'ل', 'على', 'بال', 'لل', 'عبوه', 'حبه', 'قطعه',
  'with', 'and', 'the', 'of', 'in', 'for', 'a', 'an', 'pack', 'x',
].map(normalizeText));

export function coreTokens(text) {
  return new Set(
    normalizeText(stripSizes(String(text || '')))
      .split(' ')
      .map((w) => w.replace(/^(وال|ال)/, ''))
      .filter((w) => w.length >= 2 && !/^\d+$/.test(w) && !STOP.has(w)),
  );
}

function referenceTokens(reference) {
  const tokens = new Set([...coreTokens(reference.name), ...coreTokens(reference.nameEn)]);
  for (const b of [reference.brand?.ar, reference.brand?.en]) for (const t of coreTokens(b)) tokens.add(t);
  return tokens;
}

export function tokenOverlap(listing, reference) {
  const ref = referenceTokens(reference);
  const cand = coreTokens(textOf(listing) + ' ' + (listing.brand || ''));
  let n = 0;
  for (const t of cand) if (ref.has(t)) n += 1;
  return n;
}

const sizeFree = (text) => [...coreTokens(text)].sort().join(' ');

// --- conflicts: what the text itself proves is a different product ---------------
//
// Measured 2026-11-03 on 2,505 live candidates for 8 watches: the 14B judge
// passed laban for milk, low fat for full fat, Al Khair for Goody and Tania
// for Nova; these checks rejected 1,205 of 2,444 wrong candidates and none of
// the 55 right ones, nor any of 1,060 same-barcode pairs across stores. A
// one-sided "diet / light / no sugar" marker and a missing "fresh" were
// tried and dropped: stores omit them on the same product.

// NFKC first: Panda writes "شوكوﻻتة" with the presentation-form ligature ﻻ.
const foldPhrase = (text) => ` ${String(text || '').normalize('NFKC').toLowerCase()
  .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()} `;

// Each group: values that exclude one another. Both sides must state exactly
// one value for a conflict.
const CONFLICT_GROUPS = Object.freeze({
  fat: {
    'full fat': ['كامل الدسم', 'full fat', 'full cream', 'whole milk'],
    'low fat': ['قليل الدسم', 'ق الدسم', 'low fat', 'semi skimmed'],
    skimmed: ['خالي الدسم', 'منزوع الدسم', 'skimmed', 'skim', 'fat free', 'non fat'],
  },
  freshness: {
    fresh: ['طازج', 'fresh'],
    'long-life': ['طويل الاجل', 'long life', 'uht'],
  },
  dairy: {
    milk: ['حليب', 'milk'],
    laban: ['لبن', 'laban'],
    yogurt: ['زبادي', 'روب', 'yogurt', 'yoghurt'],
  },
  medium: {
    oil: ['زيت', 'oil'],
    'water / brine': ['بالماء', 'ماء وملح', 'الماء والملح', 'محلول ملحي', 'محلول مالح', 'brine', 'in water', 'spring water'],
  },
  oil: {
    sunflower: ['دوار الشمس', 'دوار شمس', 'sunflower'],
    olive: ['زيت الزيتون', 'زيت زيتون', 'olive oil'],
    corn: ['زيت الذره', 'زيت ذره', 'corn oil'],
    soy: ['صويا', 'soybean oil', 'soya'],
  },
});
const FOLDED_GROUPS = Object.entries(CONFLICT_GROUPS).map(([group, values]) => [
  group, Object.entries(values).map(([value, phrases]) => [value, phrases.map(foldPhrase)]),
]);

function statedValues(folded, values) {
  return values.filter(([, phrases]) => phrases.some((p) => folded.includes(p))).map(([value]) => value);
}

// Flavours a candidate states as a word (with Arabic clitics: و / ف, then
// ب / ل / ك, then ال — "بالليمون", "والفلفل").
const FLAVOURS = Object.freeze({
  lemon: ['ليمون', 'lemon'], lime: ['لايم', 'lime'], pepper: ['فلفل', 'pepper'],
  chili: ['حار', 'شطه', 'هالبينو', 'chili', 'chilli', 'spicy', 'jalapeno', 'hot'],
  garlic: ['ثوم', 'garlic'], strawberry: ['فراوله', 'strawberry'],
  chocolate: ['شوكولاته', 'شوكولا', 'كاكاو', 'chocolate', 'choco', 'cocoa'],
  banana: ['موز', 'banana'], vanilla: ['فانيليا', 'vanilla'], mango: ['مانجو', 'mango'],
  dates: ['تمر', 'dates'], cherry: ['كرز', 'cherry'], orange: ['برتقال', 'orange'],
  mint: ['نعناع', 'mint'], tomato: ['طماطم', 'tomato'], herbs: ['اعشاب', 'herbs'],
  smoked: ['مدخن', 'smoked'], curry: ['كاري', 'curry'], bbq: ['باربكيو', 'bbq', 'barbecue'],
  saffron: ['زعفران', 'saffron'], cardamom: ['هيل', 'cardamom'], honey: ['عسل', 'honey'],
  coffee: ['قهوه', 'coffee'], caramel: ['كراميل', 'caramel'],
});
const wordPattern = (w) => new RegExp(String.raw`\s(?:[وف]?[بلك]?(?:ال)?)` + foldPhrase(w).trim() + String.raw`(?=\s)`, 'u');
const FLAVOUR_WORDS = Object.entries(FLAVOURS).map(([flavour, words]) => [flavour, words.map(wordPattern)]);
// Any hint of a flavour, filling or sauce in the reference keeps the flavour
// rule off: a spelling the word list misses ("شوكلاته", "فانيلا", "كارميل")
// must never make a flavoured reference look plain.
const FLAVOUR_HINTS = [
  'ليمون', 'لايم', 'فلفل', 'حار', 'شط', 'هالبين', 'هالابين', 'جلابين', 'ثوم', 'فراول', 'شوك', 'فانيل',
  'مانج', 'تمر', 'كرز', 'برتقال', 'نعناع', 'طماطم', 'اعشاب', 'مدخن', 'كاري', 'باربكيو', 'زعفران', 'هيل',
  'عسل', 'قهو', 'كرامي', 'كارمي', 'محشي', 'نكهه', 'طعم', 'صلص', 'موز', 'بارد', 'توت', 'فواكه', 'تفاح',
  'عنب', 'اناناس', 'خوخ', 'رمان', 'flavo', 'lemon', 'lime', 'pepper', 'chil', 'spic', 'jalap', 'hot',
  'garlic', 'strawb', 'choc', 'cocoa', 'banana', 'vanil', 'mango', 'date', 'cherr', 'orange', 'mint',
  'tomat', 'herb', 'smok', 'curry', 'bbq', 'barbe', 'saffron', 'cardam', 'honey', 'coffee', 'caram',
  'stuff', 'sauce', 'taste', 'cool', 'fruit', 'berry', 'apple', 'grape', 'pineapple', 'peach',
].map((hint) => foldPhrase(hint).trim());
// Only where a flavour word always means another variant. Not drinks or tea:
// a store titles plain Sprite "بنكهة الليمون والليمون الأخضر" and Mirinda
// "برتقال علبة" (live probe 2026-11-03). Whole words: "روب" is inside "مشروب".
const FLAVOUR_TYPES = [
  'تونه', 'تونا', 'tuna', 'سردين', 'sardine', 'sardines', 'حليب', 'milk', 'لبن', 'laban', 'زبادي', 'روب',
  'yogurt', 'yoghurt', 'جبن', 'جبنه', 'cheese', 'لبنه', 'labneh',
].map(wordPattern);

function listingBrand(listing) {
  for (const value of [listing.brand, listing.brandEn]) {
    const resolved = resolveBrand(typeof value === 'string' ? value : null);
    if (resolved.brand_id) return resolved;
  }
  const candidate = listingIdentityCandidate({ name: textOf(listing) || '' });
  if (candidate?.brand) {
    const resolved = resolveBrand(candidate.brand);
    if (resolved.brand_id) return resolved;
  }
  return null;
}

// The reason the listing is provably another product, or null.
export function conflictWith(listing, reference) {
  const refText = foldPhrase([reference.name, reference.nameEn].filter(Boolean).join(' · '));
  const text = foldPhrase(textOf(listing));
  // A different known brand — unless either side's title names the other's
  // brand (a store brand field can be a sub-brand or simply wrong).
  if (reference.brand?.id) {
    const brand = listingBrand(listing);
    if (brand && brand.brand_id !== reference.brand.id) {
      const refNamed = [reference.brand.ar, reference.brand.en].filter(Boolean).some((n) => text.includes(foldPhrase(n)));
      const candNamed = [brand.display_ar, brand.display_en, brand.canonical_brand].filter(Boolean)
        .some((n) => refText.includes(foldPhrase(n)));
      if (!refNamed && !candNamed) {
        return `another brand: ${brand.canonical_brand} ≠ ${reference.brand.en || reference.brand.ar}`;
      }
    }
  }
  // A bundle of two products is priced for both (Ninja: "سويتز كيك 280 جم &
  // المراعي حليب طازج 1 لتر" at 21.00). Each side must state its own size, so
  // "Rich & Creamy 1L" and Tamimi's "10 + 2 x 150 مل" stay one product.
  const bundled = [listing.name, listing.nameEn, listing.fullName, listing.fullNameEn].some((field) => {
    const parts = typeof field === 'string' ? field.split(/\s[&+]\s/) : [];
    return parts.length >= 2 && parts.filter((part) => parseSize(part, '')?.unit).length >= 2;
  });
  if (bundled) return 'a bundle with another product';
  for (const [group, values] of FOLDED_GROUPS) {
    const ref = statedValues(refText, values);
    const own = statedValues(text, values);
    if (ref.length === 1 && own.length === 1 && ref[0] !== own[0]) return `${group}: ${own[0]} ≠ ${ref[0]}`;
  }
  // A flavour on a plain reference (2026-11-03: the judge matched Tendrina
  // "بالليمون والفلفل الأسود" to the plain sunflower-oil tin). Only a plain
  // reference: between two flavoured ones the judge decides.
  if (FLAVOUR_TYPES.some((word) => word.test(refText)) && !FLAVOUR_HINTS.some((hint) => refText.includes(hint))) {
    const flavours = FLAVOUR_WORDS.filter(([, words]) => words.some((w) => w.test(text))).map(([f]) => f);
    if (flavours.length) return `flavour: ${flavours.join(', ')} (the watched one is plain)`;
  }
  return null;
}

// Rules settle what needs no judgement: the listing the user picked, a size
// that contradicts the watched one, text with nothing in common, and the same
// product title as the reference. Everything else goes to the judge.
// `barcodes.match` / `barcodes.reject`: keys of listings whose identity is
// SETTLED (the reference, the anchor, a user verdict) — never of an AI
// verdict or another barcode match, so no mistake can spread.
// The listing the watch was created from.
export function isAnchor(listing, reference, store) {
  return Boolean(reference?.store && reference.listingId != null &&
    String(store || listing?.provider || '') === String(reference.store) &&
    String(listing?.id) === String(reference.listingId));
}

export function ruleVerdict(listing, reference, { store, barcodes = null } = {}) {
  if (isAnchor(listing, reference, store)) {
    return { verdict: VERDICT.MATCH, by: 'anchor', reason: 'the listing this watch was created from' };
  }
  const q = watchQuantity(listing);
  const same = sameItemSize(q.each, reference.item);
  if (same === false) {
    return {
      verdict: VERDICT.REJECT, by: 'rules',
      reason: `size per item ${formatItem(q.each)} ≠ ${formatItem(reference.item)}`,
    };
  }
  // A shared barcode is the same pack of the same product (measured
  // 2026-11-03: Tamimi files the 80 g sunflower-oil tin under "تونة تندرينا
  // ناعمة"; its barcode is the sunflower tin's at Panda, Danube and Ninja).
  if (sharesBarcode(listing, barcodes?.match)) {
    return { verdict: VERDICT.MATCH, by: 'barcode', reason: 'same barcode as a verified listing' };
  }
  if (sharesBarcode(listing, barcodes?.reject)) {
    return { verdict: VERDICT.REJECT, by: 'barcode', reason: 'same barcode as a listing you rejected' };
  }
  if (tokenOverlap(listing, reference) === 0) {
    return { verdict: VERDICT.REJECT, by: 'rules', reason: 'nothing in common with the watched product' };
  }
  const clash = conflictWith(listing, reference);
  if (clash) return { verdict: VERDICT.REJECT, by: 'conflict', reason: clash };
  const refKeys = [reference.name, reference.nameEn].filter(Boolean).map(sizeFree);
  const candKeys = [listing.name, listing.nameEn, listing.fullName, listing.fullNameEn]
    .filter(Boolean).map(sizeFree);
  // The same title still goes to the judge when its pack count needs the
  // judge's corroboration ("6 قطع" read but not believed yet).
  const phrase = readPackPhrase(`${textOf(listing)} ${sizeOf(listing)}`);
  const packOpen = q.pack === 1 && phrase && !phrase.strong;
  if (same === true && !packOpen && candKeys.some((k) => k && refKeys.includes(k))) {
    return { verdict: VERDICT.MATCH, by: 'rules', reason: 'same title and size' };
  }
  return null; // the judge decides
}

// --- the AI judge (request + reply) ---------------------------------------------

// Measured 2026-11-03 on 8 watches and 2,505 live candidates, after the
// conflict rules: this few-shot prompt found 59 of 60 right listings with 1-2
// wrong ones a run, against 41 of 60 with 10-12 wrong for the previous one.
// Its examples are deliberately not the benchmark products.
const JUDGE_SYSTEM = [
  'You check product identity for a grocery price watch in Saudi Arabia.',
  'The shopper watches ONE product and compares the price PER ITEM across stores, in any pack size.',
  'For each candidate answer: is it the same product as the reference — same brand, same product line, same type, same variant?',
  'Size and pack count are checked by code, not by you. A single item, a 4-pack, a 12-pack and a carton of 40 of the same product are all "yes". Never answer "no" or "unsure" because of a size, a size range or a pack count.',
  'Rules:',
  '- Brand: Arabic and English spellings of one brand are one brand (قودي = جودي = Goody). When the title names no brand, the store brand field is the brand. Another brand is "no".',
  '- Line: when the reference names a product line (Tendrina / تندرينا), a candidate naming another line is "no"; one naming no line is "unsure".',
  '- Type: milk (حليب) ≠ laban (لبن) ≠ yogurt (زبادي); tuna ≠ sardines.',
  '- Variant: full fat ≠ low fat ≠ skimmed; fresh ≠ long-life; regular ≠ diet / zero; flavours; sunflower oil ≠ olive oil ≠ brine; flakes ≠ chunks. A title that names no flavour, diet or zero is the regular product. A store title that leaves out a word the reference has (long-life, in sunflower oil) is still "yes" when nothing it says contradicts the reference.',
  'Examples (reference → candidate → answer):',
  '- "المراعي لبن كامل الدسم 2 لتر" → "المراعي لبن كامل الدسم عبوة 4×2 لتر" → yes (same laban, another pack)',
  '- "الربيع عصير مانجو 1 لتر" → "Mango Juice [store brand field: Al Rabie]" → yes (brand from the field)',
  '- "المراعي لبن كامل الدسم 2 لتر" → "المراعي لبن قليل الدسم 2 لتر" → no (low fat)',
  '- "سفن أب علب 6*330مل" → "علبة [store brand field: سفن أب] [store size field: 24 x 330-355 مل]" → yes (the regular 7Up can)',
  '- "سفن أب علب 6*330مل" → "دايت علبة [store brand field: سفن أب]" → no (diet)',
  '- "عافية تونة تندر بايت بزيت دوار الشمس 185 جم" → "عافية تونة قطعة واحدة بزيت دوار الشمس 185 جم" → no (another line)',
  '- "عافية تونة تندر بايت بزيت دوار الشمس 185 جم" → "عافية تونة بزيت دوار الشمس 185 جم" → unsure (no line named)',
  '- "نادك زبادي طازج كامل الدسم 1كغم" → "الصافي زبادي طازج كامل الدسم 1كغم" → no (another brand)',
  'If you cannot tell, answer "unsure" — never guess "yes".',
  '"items": the number of separately packaged items sold together (a pack of 6 tins = 6); null if not stated. "itemSize": the size of ONE item as written; null if not stated.',
  'Reply with compact JSON on one line, nothing else: {"results":[{"i":<n>,"same":"yes"|"no"|"unsure","items":<n|null>,"itemSize":"<text|null>","why":"<at most 6 words>"}]}',
].join('\n');

function describeListing(listing) {
  const name = listing.fullName || listing.name;
  const nameEn = listing.fullNameEn || listing.nameEn;
  const bits = [String(name || '').slice(0, 220)];
  if (nameEn && nameEn !== name) bits.push(`(EN: ${String(nameEn).slice(0, 160)})`);
  if (listing.brand) bits.push(`[store brand field: ${String(listing.brand).slice(0, 40)}]`);
  const size = sizeOf(listing);
  if (size) bits.push(`[store size field: ${String(size).slice(0, 40)}]`);
  // What code read (Panda's "1x4 لتر" is four 1 L cartons, not one 4 L one).
  const q = watchQuantity(listing);
  if (q.each) bits.push(`[read as: ${q.pack > 1 && q.packSource === 'text' ? `${q.pack} × ` : ''}${formatItem(q.each)}]`);
  return bits.join(' ');
}

// The reference title without its pack count: told the shopper saw 12 —
// as a line or in the title ("(Pack of 12)") — the judge answered "no, wrong
// pack size" to 4-packs (measured 2026-11-03). Size per item stays.
export function withoutPackCount(title) {
  return String(title || '')
    .replace(/\(?\s*\bpack\s+of\s+\d+\s*\)?/giu, ' ')
    .replace(/\b\d+\s*-?\s*(?:pack|pcs|pieces|count|cans|bottles)\b/giu, ' ')
    .replace(/(^|\s)\d+\s*(?:حبات|حبة|حبه|علب|علبة|عبوات|قطع)(?=\s|$)/gu, ' ')
    .replace(/(^|[^\d.,])\d+\s*[x×*]\s*(?=\d)/gu, '$1')
    .replace(/(\d\s*(?:ml|l|g|kg|ltr|liter|litre|مل|لتر|ل|جم|غ|غرام|جرام|كغ|كجم)(?!\p{L}))\s*[x×*]\s*\d+(?![\d.,\p{L}])/giu, '$1')
    .replace(/\s*\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildJudgeRequest(reference, candidates, { model }) {
  const ref = [
    `Reference product: ${withoutPackCount(reference.name).slice(0, 220)}`,
    reference.nameEn ? `English title: ${withoutPackCount(reference.nameEn).slice(0, 160)}` : null,
    reference.brand ? `Brand: ${[reference.brand.en, reference.brand.ar].filter(Boolean).join(' / ')}` : null,
    `Size per item: ${formatItem(reference.item) || 'not stated'}`,
  ].filter(Boolean).join('\n');
  const list = candidates.map((c, index) => `${index + 1}. [${c.store}] ${describeListing(c.listing)}`).join('\n');
  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    // The model pretty-prints its JSON (~48 tokens a result, measured
    // 2026-11-03); at 45 a result 12 of 22 batches were cut off mid-reply.
    max_tokens: 120 + candidates.length * 80,
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: `${ref}\n\nCandidates:\n${list}` },
    ],
  };
}

function parsedItemSize(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const p = parseSize(text, '');
  return p?.unit && p.unit !== 'pcs' && p.each ? { value: p.each, unit: p.unit } : null;
}

// Reply -> one entry per candidate index (1-based in the prompt). Anything
// missing or malformed is `pending`, never a match.
export function parseJudgeReply(raw, count) {
  let parsed = null;
  try {
    const match = /\{[\s\S]*\}/.exec(String(raw || ''));
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    parsed = salvageJudgeReply(raw);
  }
  const byIndex = new Map();
  for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
    const i = Number(r?.i);
    if (!Number.isInteger(i) || i < 1 || i > count || byIndex.has(i)) continue;
    const same = String(r.same ?? '').toLowerCase();
    byIndex.set(i, {
      same: same === 'yes' || r.same === true ? 'yes' : same === 'no' || r.same === false ? 'no' : 'unsure',
      items: Number.isInteger(Number(r.items)) && Number(r.items) >= 1 ? Number(r.items) : null,
      item: parsedItemSize(r.itemSize),
      why: String(r.why || '').slice(0, 80),
    });
  }
  const reference = parsed?.reference && typeof parsed.reference === 'object' ? {
    items: Number.isInteger(Number(parsed.reference.items)) && Number(parsed.reference.items) >= 1
      ? Number(parsed.reference.items) : null,
    item: parsedItemSize(parsed.reference.itemSize),
  } : null;
  return {
    reference,
    results: Array.from({ length: count }, (_, k) => byIndex.get(k + 1) || null),
  };
}

// The judge's answer, held to the rules: a size the listing states that
// contradicts the watched size rejects whatever the judge said.
// A reply cut off mid-way still holds every answer it finished: each result
// is a flat object, so the complete ones are read one by one.
function salvageJudgeReply(raw) {
  const text = String(raw || '');
  const read = (body) => { try { return JSON.parse(body); } catch { return null; } };
  const results = [...text.matchAll(/\{[^{}]*"i"\s*:\s*\d+[^{}]*\}/g)].map((m) => read(m[0])).filter(Boolean);
  const ref = /"reference"\s*:\s*(\{[^{}]*\})/.exec(text);
  return results.length || ref ? { reference: ref ? read(ref[1]) : null, results } : null;
}

// Each product is asked twice, in batches with other neighbours and order;
// the judge at temperature 0 still flips between batches (2026-11-03: Tamimi's
// unbranded sunflower tuna "unsure", then "yes" a sweep later). A match needs
// both yeses. A yes against a no or an unsure is an "unsure" — kept for that
// title like any verdict, so asking again is never another chance at a yes.
export function combineVotes(a, b) {
  if (!a || !b) return null;
  if (a.same === b.same) {
    if (a.same !== 'yes') return a;
    return {
      ...a,
      items: a.items === b.items ? a.items : null,
      item: a.item && b.item && sameItemSize(a.item, b.item) === true ? a.item : null,
    };
  }
  if (a.same === 'yes' || b.same === 'yes') {
    return { same: 'unsure', items: null, item: null, why: `checks disagree: ${[a, b].map((v) => v.why || v.same).join(' / ')}`.slice(0, 120) };
  }
  return a.same === 'no' ? a : b;
}

export function judgedVerdict(listing, reference, answer) {
  // No answer (cut off, or the call failed) is asked again next sweep; an
  // "unsure" is an answer, kept like any verdict (by 'ai').
  if (!answer) return { verdict: VERDICT.PENDING, by: null, reason: 'no answer from the checker yet' };
  if (answer.same === 'no') return { verdict: VERDICT.REJECT, by: 'ai', reason: answer.why || 'different product' };
  if (answer.same === 'unsure') {
    return { verdict: VERDICT.PENDING, by: 'ai', reason: `unsure: ${answer.why || 'not enough detail'}` };
  }
  const q = watchQuantity(listing, { aiItems: answer.items });
  const item = q.each || answer.item;
  if (sameItemSize(item, reference.item) === false) {
    return { verdict: VERDICT.REJECT, by: 'ai+rules', reason: `size per item ${formatItem(item)} ≠ ${formatItem(reference.item)}` };
  }
  return { verdict: VERDICT.MATCH, by: 'ai', reason: answer.why || 'same product', aiItems: answer.items, aiItem: answer.item };
}

// --- deals and alerts --------------------------------------------------------------

export function dealKey({ store, name, purchasePrice }) {
  return `${store || ''}|${normalizeText(name || '').slice(0, 120)}|${Number(purchasePrice).toFixed(2)}`;
}

// The alert state machine. Pure: (previous state, this round) -> decision.
//
//   prev  = { isBelow, isClose, deal: { store, listingId, dealKey, value } | null,
//             lastAlert: { dealKey, value } | null, episode }
//   round = { best: observation | null, target, closeBoundary,
//             dealStatus: 'seen-above' | 'gone' | 'seen-below' | 'unknown' | null }
//
// dealStatus describes the PREVIOUS deal's own listing this round, which is the
// only thing that may end a deal: a different store being quiet, or the deal
// simply not being on the first results page once, ends nothing.
export function decideAlert(prev = {}, round = {}) {
  const { best, target, closeBoundary = null, dealStatus = null } = round;
  const hit = Boolean(best) && best.value <= target + EPS;
  const close = !hit && Boolean(best) && closeBoundary != null && best.value <= closeBoundary + EPS;
  const conclusive = dealStatus === 'seen-above' || dealStatus === 'gone' || !prev.deal;
  let episode = Number(prev.episode) || 0;
  let isBelow = hit;
  let isClose = close;
  let lastAlert = prev.lastAlert || null;
  let alertType = null;

  if (!hit && prev.isBelow) {
    if (conclusive) {
      episode += 1; // the deal ended: the next one is a new event
      // A deal that went away and comes back unchanged is not news; one whose
      // price was seen going UP and then comes back down is.
      if (dealStatus === 'seen-above') lastAlert = null;
    } else {
      isBelow = true; // cannot tell — keep the watch where it was
      isClose = false;
    }
  }
  if (!hit && !close && prev.isClose && !conclusive) isClose = true;

  if (hit) {
    const key = best.dealKey;
    if (!prev.isBelow) {
      if (!lastAlert || lastAlert.dealKey !== key) alertType = 'target';
    } else if (lastAlert?.value != null && best.value <= lastAlert.value * (1 - LOWER_ALERT_STEP) + EPS) {
      alertType = 'lower';
    }
  } else if (close && !prev.isClose && !prev.isBelow && (!lastAlert || lastAlert.dealKey !== best.dealKey)) {
    alertType = 'close';
  }
  if (alertType) lastAlert = { dealKey: best.dealKey, value: best.value, type: alertType };

  const deal = hit || close
    ? { store: best.store, listingId: best.listingId, dealKey: best.dealKey, value: best.value }
    : (isBelow || isClose) ? prev.deal || null : null;
  return { alertType, isBelow, isClose, deal, lastAlert, episode };
}
