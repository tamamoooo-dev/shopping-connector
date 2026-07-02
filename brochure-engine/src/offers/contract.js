// offers/contract.js — the normalized Offer contract plus the PURE helpers that
// turn a raw aggregator product record into an Offer (name derivation from the
// flyer's OCR text, price sanity gates, search-text normalization).
//
// An Offer is ONE product deal extracted from a store's flyer — the structured
// row that lets the price-comparison layer put physical-store prices next to
// the live online prices. It is the brochure analogue of the search connector's
// 10-key result: treat it as a contract.
//
// Offer:
//   { id, store, region, source, offerId, flyerRef, pageRef, edition,
//     name, nameAr, price, oldPrice, currency, categoryId, category,
//     imageUrl, sourceUrl, validFrom, validTo, detectedAt, searchText }
//
// HONESTY NOTE (carried through to the read API): aggregator prices are
// machine-extracted from flyer images by the aggregator ("AI-generated" per
// D4D's own disclaimer). They are structured and comparable, but the flyer
// itself prevails on any mismatch — every Offer keeps `sourceUrl` (the flyer
// page deep-link) and `imageUrl` (the product's own flyer crop) so a human can
// always verify. Nothing here knows any store name.

// --- text normalization (matching-only fold, Arabic + English) ----------------
// Mirrors the frontend's match.js normalization ideas, kept dependency-free:
// lowercase, strip Arabic diacritics/tatweel, unify alef/hamza/taa-marbuta/
// alef-maqsura, fold Arabic-Indic digits to ASCII, drop punctuation.
const AR_DIACRITICS = /[ً-ٰٟـ]/g;
const AR_INDIC = /[٠-٩]/g;
const PUNCT = /[^\p{L}\p{N}\s]/gu;

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(AR_DIACRITICS, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(AR_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- name derivation from the flyer's OCR text --------------------------------
// The aggregator's `description` is raw OCR of the flyer cell: bilingual
// (Arabic + English, sometimes Malayalam/Urdu/Bengali store signage), mixed
// with prices and banner phrases. We derive a best-effort DISPLAY name per
// language; the offer's own flyer-crop image remains the primary identity in
// any UI, and `searchText` (the full normalized text) is what search matches.

const ARABIC_RE = /[؀-ۿ]/;
const LATIN_RE = /[a-z]/i;
// Scripts we neither display nor search (store signage noise on some flyers).
const OTHER_SCRIPT_RE = /[ഀ-ൿঀ-৿ऀ-ॿ஀-௿ఀ-౿一-鿿぀-ヿ가-힯]/;
// Generic flyer-banner phrases that are never a product name.
const BANNER_WORDS = new Set([
  'offer', 'offers', 'deal', 'deals', 'amazing', 'exciting', 'rewards', 'endless',
  'surprises', 'save', 'free', 'price', 'prices', 'happiness', 'special', 'promo',
  'promotion', 'weekly', 'till', 'until', 'only', 'now', 'new',
  'عرض', 'عروض', 'وفر', 'توفير', 'خصم', 'مجانا', 'سعر', 'سعاده', 'حتي', 'فقط', 'جديد',
]);
const UNIT_RE = /(\b|\d)(ml|ltr?|l|kg|gm?|gr|pcs?|pack|pkt|صحن|مل|لتر|كجم|كغ|جم|جرام|غرام|حبه|حبات|قطعه|عبوه)\b/i;

// One line -> a cleaned candidate phrase (numbers/prices stripped) or null.
function cleanLine(line, stopWords) {
  if (OTHER_SCRIPT_RE.test(line)) return null;
  const kept = [];
  for (const tok of normalizeText(line).split(' ')) {
    if (!tok) continue;
    if (/^\d+([.,]\d+)?$/.test(tok)) continue; // bare number / price
    if (/(.)\1{3,}/.test(tok)) continue; // OCR smears like "wwwww"
    if (stopWords.has(tok)) continue;
    kept.push(tok);
  }
  const phrase = kept.join(' ');
  if (phrase.replace(/[\d\s]/g, '').length < 3) return null; // nothing nameable
  // A line made ONLY of banner words is noise ("amazing deals … surprises").
  if (kept.every((t) => BANNER_WORDS.has(t) || /^\d/.test(t))) return null;
  return phrase;
}

// Derive { name, nameAr } from the OCR description. `storeWords` (the store's
// own display names, e.g. "LULU Hypermarket"/"لولو هايبرماركت") become dynamic
// stopwords so the store's flyer header never masquerades as a product name.
export function deriveNames(description, storeWords = []) {
  const stopWords = new Set();
  for (const w of storeWords) {
    for (const tok of normalizeText(w).split(' ')) if (tok) stopWords.add(tok);
  }
  stopWords.add('hypermarket').add('supermarket').add('هايبرماركت').add('ماركت');

  const en = [];
  const ar = [];
  const lines = String(description || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const phrase = cleanLine(raw, stopWords);
    if (!phrase) continue;
    // OCR lines interleave scripts; route by dominant script per line.
    const target = ARABIC_RE.test(phrase) ? ar : LATIN_RE.test(phrase) ? en : null;
    if (target) target.push({ phrase, pos: i });
  }

  // Score: more words + a size/unit token + LATER position (the aggregator's
  // canonical summary line tends to sit at the end of the OCR block).
  const pick = (cands) => {
    let best = null;
    let bestScore = -1;
    for (const c of cands) {
      const words = c.phrase.split(' ').length;
      const score = Math.min(words, 8) * 10 + (UNIT_RE.test(c.phrase) ? 25 : 0) + c.pos;
      if (score > bestScore) {
        best = c.phrase;
        bestScore = score;
      }
    }
    return best ? title80(best) : null;
  };
  return { name: pick(en), nameAr: pick(ar) };
}

const title80 = (s) => (s.length > 80 ? s.slice(0, 79).replace(/\s+\S*$/, '') + '…' : s);

// --- raw record -> Offer -------------------------------------------------------
// `raw` is a source-agnostic flat record the offers source adapter emits:
//   { offerId, flyerRef, pageRef, price, wasPrice, description, categoryId,
//     category, imageUrl, sourceUrl, validFrom, validTo, storeWords }
// Returns a full Offer, or null when the record fails the sanity gates (no
// usable price — we refuse to store a row the comparison layer can't trust).
export function buildOffer(raw, { store, region, source, detectedAt }) {
  const price = Number(raw.price);
  if (!Number.isFinite(price) || price <= 0) return null; // gate: a price is required
  let oldPrice = Number(raw.wasPrice);
  // gate: the "was" price must be a real strike-through (higher than the price).
  if (!Number.isFinite(oldPrice) || oldPrice <= price) oldPrice = null;

  const { name, nameAr } = deriveNames(raw.description, raw.storeWords);
  const searchText = normalizeText(
    [raw.description, raw.category].filter(Boolean).join(' '),
  ).slice(0, 600);

  const offerId = String(raw.offerId ?? '');
  if (!offerId) return null;

  return {
    id: `${store}:${region}:${source}:${offerId}`,
    store,
    region,
    source,
    offerId,
    flyerRef: raw.flyerRef != null ? String(raw.flyerRef) : null,
    pageRef: raw.pageRef != null ? String(raw.pageRef) : null,
    edition: null, // linked to a held brochure edition by the ingest, if matched
    name,
    nameAr,
    price,
    oldPrice,
    currency: raw.currency || 'SAR',
    categoryId: raw.categoryId != null ? String(raw.categoryId) : null,
    category: raw.category ?? null,
    imageUrl: raw.imageUrl ?? null,
    sourceUrl: raw.sourceUrl ?? null,
    validFrom: isoDate(raw.validFrom),
    validTo: isoDate(raw.validTo),
    detectedAt: detectedAt || new Date().toISOString(),
    searchText,
  };
}

// "2026-07-07 20:59:00" | "2026-07-07T…" -> "2026-07-07" (null if unparseable).
export function isoDate(text) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(String(text || ''));
  return m ? m[1] : null;
}

// --- row projection (D1) -------------------------------------------------------
export function offerToRow(o) {
  return {
    id: o.id,
    store: o.store,
    region: o.region,
    source: o.source,
    offer_id: o.offerId,
    flyer_ref: o.flyerRef,
    page_ref: o.pageRef,
    edition: o.edition,
    name: o.name,
    name_ar: o.nameAr,
    price: o.price,
    old_price: o.oldPrice,
    currency: o.currency,
    category_id: o.categoryId,
    category: o.category,
    image_url: o.imageUrl,
    source_url: o.sourceUrl,
    valid_from: o.validFrom,
    valid_to: o.validTo,
    detected_at: o.detectedAt,
    search_text: o.searchText,
  };
}

export function rowToOffer(r) {
  return {
    id: r.id,
    store: r.store,
    region: r.region,
    source: r.source,
    offerId: r.offer_id,
    flyerRef: r.flyer_ref,
    pageRef: r.page_ref,
    edition: r.edition,
    name: r.name,
    nameAr: r.name_ar,
    price: r.price,
    oldPrice: r.old_price,
    currency: r.currency,
    categoryId: r.category_id,
    category: r.category,
    imageUrl: r.image_url,
    sourceUrl: r.source_url,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    detectedAt: r.detected_at,
    // searchText is intentionally NOT exposed on the read API (raw OCR noise);
    // it exists to be matched against, not displayed.
  };
}

// --- query-side relevance (shared by the /offers read API) ---------------------
// Token-AND match over the normalized searchText/name, with a light score so
// name hits outrank description-only hits. Pure, so it is unit-testable.
export function offerRelevance(offer, queryTokens, searchText) {
  if (!queryTokens.length) return 1;
  const name = normalizeText(`${offer.name || ''} ${offer.nameAr || ''}`);
  const hay = searchText || '';
  let score = 0;
  for (const tok of queryTokens) {
    const inName = name.includes(tok);
    const inText = hay.includes(tok);
    if (!inName && !inText) return 0; // every token must appear somewhere
    score += inName ? 3 : 1;
  }
  return score;
}

export function queryTokens(q) {
  return normalizeText(q).split(' ').filter(Boolean).slice(0, 6);
}
