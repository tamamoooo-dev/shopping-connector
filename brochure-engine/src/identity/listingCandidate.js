// identity/listingCandidate.js — the ONLINE LISTING extractor.
//
// The platform resolves product identity through exactly one path:
//
//     Extractors -> Resolver (registry/) -> Ledger (products + sightings)
//
// Extractors are plural by nature — every data source needs its own — while the
// resolver and the ledger are singular. This module is the SECOND extractor.
// The first is the Vision Identity Builder, whose output reaches the resolver
// through registry/candidate.js; this one turns a live online store listing
// into the SAME Identity Candidate contract, so both meet the resolver on
// identical terms and no second matcher is ever written.
//
// INPUT — the connector's normalized listing, identical across all seven
// providers (src/providers/*.js in the connector):
//
//     { id, name, image, price, oldPrice, currency, link, size, brand,
//       discountLabel }
//
// This is RICHER than a flyer crop: `brand` and `size` arrive as their own
// structured fields rather than needing extraction from pixels, so the two
// attributes that dominate resolution are usually free. What must still be
// derived from the title is the semantic core — family, cut, processing,
// variety — and that derivation reuses the engine's existing bilingual
// taxonomy (matching.js). Nothing here classifies text on its own.
//
// OUTPUT — a registry/candidate.js Identity Candidate:
//
//     { brand, family, cut, processing, variety, package, size, count }
//
// DELIBERATELY NOT THREE-VALUED. A field is either a canonical value or null.
// The distinction between "absent" and "unreadable" matters for Vision, where
// an unreadable crop is common; a retailer's own product record does not
// hallucinate, so a missing field here means "not expressed in the title".
// The resolver already treats a missing signal as NEUTRAL rather than as a
// mismatch (resolver.js scoreCandidate: "missing evidence is neutral, never a
// penalty"), which is exactly the required behaviour — so the plain contract
// is sufficient and the vision-motivated extension stays out of this path.
//
// PURE. No I/O, no registry access, no storage. Node- and Workers-compatible.

import {
  isProcessedProduce,
  isProduceFamily,
  normalizeText,
  parseSize,
  productFamily,
  productType,
  stripSizes,
} from '../matching.js';
import { resolveBrand } from '../lexicon/brands.js';
import { detectBrand } from '../browse/brands.js';
import { variantKey } from '../priceWatch.js';
import { candidateDisplayName, readFromIdentityCandidate } from '../registry/candidate.js';
import { newProductRow } from '../registry/model.js';

// Canonical PROCESSING values, bilingual surface forms -> one English value.
// matching.js has PROCESSED_MARKERS, but that is a Set behind a boolean
// (isProcessedProduce) and deliberately includes frozen-food BRAND names for
// its fresh-produce demotion; the resolver needs a canonical VALUE it can
// compare across sources, so the mapping is declared here and kept small.
const PROCESSING = new Map(
  Object.entries({
    frozen: ['frozen', 'مجمد', 'مجمده', 'مجمدة', 'مجمدات'],
    canned: ['canned', 'tinned', 'معلب', 'معلبه', 'معلبة', 'معلبات'],
    dried: ['dried', 'مجفف', 'مجففه', 'مجففة'],
    smoked: ['smoked', 'مدخن', 'مدخنه', 'مدخنة'],
    fresh: ['fresh', 'طازج', 'طازجه', 'طازجة'],
  }).flatMap(([value, words]) => words.map((w) => [normalizeText(w), value])),
);

// Processing words are also VARIANT words in priceWatch.js (a shampoo is not
// "processed", but a "frozen" pizza is). A word may only describe ONE
// dimension, or the same evidence would be counted twice and a candidate that
// expressed it once would conflict with itself.
const PROCESSING_VALUES = new Set(PROCESSING.values());

// Canonical PACKAGE types — the physical container, not the contents. Kept
// deliberately short: a package type is corroboration, never identity (the
// resolver's DISCRIMINATING_FIELDS exclude it), so an incomplete list costs
// nothing while a wrong one would veto.
const PACKAGE = new Map(
  Object.entries({
    bottle: ['bottle', 'زجاجه', 'زجاجة', 'قاروره', 'قارورة'],
    can: ['can', 'علبه', 'علبة', 'كان'],
    pouch: ['pouch', 'كيس', 'أكياس', 'اكياس'],
    jar: ['jar', 'برطمان', 'مرطبان'],
    carton: ['carton', 'كرتون', 'كرتونه', 'كرتونة'],
    sachet: ['sachet', 'ظرف', 'أظرف'],
  }).flatMap(([value, words]) => words.map((w) => [normalizeText(w), value])),
);

function firstWordValue(text, table) {
  for (const word of normalizeText(text).split(' ')) {
    if (table.has(word)) return table.get(word);
    // Article / conjunction-waw prefixes, stripped exactly as the family and
    // produce lexicons strip them ("المجمدة" -> "مجمدة").
    const bare = word.replace(/^(وال|ال|و)/, '');
    if (bare !== word && table.has(bare)) return table.get(bare);
  }
  return null;
}

// The listing's own brand, canonicalized. The retailer's `brand` FIELD is
// preferred because it is structured, but a stale or empty brand column is
// common, so the title gets to speak when the field says nothing. The name
// never OVERRIDES a present field here: that veto belongs to the resolver
// (brandRelation), which sees both sides and can tell a conflict from a gap.
export function listingBrand(listing = {}) {
  const declared = resolveBrand(listing.brand);
  if (declared.brand_id) return declared.brand_id;
  return detectBrand({
    name: listing.name,
    nameAr: listing.nameAr,
    category: listing.category,
    source: listing.source,
  }) || null;
}

// parseSize speaks the engine's base units (g / ml / pcs); the Identity
// Candidate contract accepts g|kg|ml|l for a measured size and expresses a
// piece count as `count`. A weak count ("6's", "12x") is enough to compare
// sizes but was never trustworthy enough to advertise per-piece pricing, so it
// is carried as a count and never promoted to a measured size.
export function listingSize(listing = {}) {
  const parsed = parseSize(listing.name, listing.size);
  if (!parsed || !parsed.unit) return { size: null, count: null };
  const pack = Number(parsed.pack) > 1 ? Math.round(Number(parsed.pack)) : null;
  if (parsed.unit === 'g' || parsed.unit === 'ml') {
    const each = Number(parsed.each);
    if (Number.isFinite(each) && each > 0) return { size: { value: each, unit: parsed.unit }, count: pack };
  }
  if (parsed.unit === 'pcs') {
    const total = Number(parsed.total);
    return { size: null, count: Number.isFinite(total) && total > 0 ? Math.round(total) : null };
  }
  return { size: null, count: pack };
}

// The listing's semantic core. `variety` is the sorted variant-token key the
// engine already derives (priceWatch.variantKey) MINUS anything that belongs
// to `processing`, so each word describes exactly one dimension.
export function listingSemantics(listing = {}) {
  const text = [listing.name, listing.nameAr, listing.size, listing.brand]
    .filter(Boolean)
    .join(' ');
  const family = productFamily(text) || null;
  const cut = productType(text) || null;

  let processing = firstWordValue(text, PROCESSING);
  // A produce marker the value table does not name ("peeled", "crushed") still
  // means the item is processed. But matching.js PROCESSED_MARKERS deliberately
  // ALSO contains frozen-food BRAND names (sadia, seara, alkabeer…) for its
  // fresh-produce demotion, and its own contract says "صدور ساديا etc. are
  // unaffected". Calling it generally would stamp processing:'processed' on
  // every Sadia product from the brand alone — a dimension the resolver then
  // treats as identity-bearing, producing `processing-not-evidenced` vetoes
  // against the same product read from a source that spelled it differently.
  // So the generic fallback is confined to its declared scope: produce.
  if (!processing && isProduceFamily(family) && isProcessedProduce(text)) {
    processing = 'processed';
  }

  const variety = variantKey(stripSizes(text), family)
    .split('|')
    .filter((token) => token && !PROCESSING_VALUES.has(token))
    .join(' ') || null;

  return { family, cut, processing, variety };
}

// The Identity Candidate for one normalized online listing, or null when the
// listing carries no usable name at all. Validation, sufficiency (the
// resolver's "two discriminating dimensions" rule) and read projection all
// remain registry/candidate.js's job — this module only fills the contract.
export function listingIdentityCandidate(listing) {
  if (!listing || !String(listing.name || '').trim()) return null;
  const { family, cut, processing, variety } = listingSemantics(listing);
  const { size, count } = listingSize(listing);
  const packageType = firstWordValue(`${listing.name || ''} ${listing.size || ''}`, PACKAGE);
  return {
    brand: listingBrand(listing),
    family,
    cut,
    processing,
    variety,
    package: packageType ? { type: packageType, expression: null } : null,
    size,
    count,
  };
}

// The registry PRODUCT this listing would found, or null when the listing
// carries too little canonical evidence to establish an identity at all.
//
// This is create-on-doubt (REGISTRY-DESIGN §3 P1) reaching the online world: a
// watch on a product no flyer has ever carried mints that product from the
// listing the user was looking at, once, with the user confirming the name. A
// false split heals later by merge; forcing the watch onto a near-miss product
// would pollute invisibly, which is the trade the registry already made.
export function productFromListing(listing, { week = null, date, store = null } = {}) {
  const candidate = listingIdentityCandidate(listing);
  if (!candidate) return null;
  const projected = readFromIdentityCandidate(candidate);
  if (!projected.ok) return null;
  const { read } = projected;
  return newProductRow({
    tokens: read.tokens,
    week,
    date: date || week || new Date().toISOString().slice(0, 10),
    store,
    kind: read.kind,
    displayName: candidateDisplayName(candidate) || String(listing.name || '').trim(),
    displayCorroboration: read.corroboration,
    brandSlug: candidate.brand || null,
    brandText: candidate.brand || null,
    sizeUnit: read.size?.unit ?? null,
    sizeTotal: read.size?.each ?? null,
    sizePack: read.size?.pack ?? null,
    family: read.family,
    category: read.category,
  });
}
