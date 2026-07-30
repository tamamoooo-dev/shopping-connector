// lexicon/structuredProduct.js — the STRUCTURED PRODUCT: one shopping record
// assembled from the ENGLISH extraction by the deterministic lexicon layers.
//
// Phase 2 of the post-extraction lexicon work (HISTORY §47). This is the join
// point of the pipeline:
//
//   Vision -> English name (primary)
//     -> Brand Lexicon      (lexicon/brands.js, §45)
//     -> Shopping Lexicon    (lexicon/shopping.js — category)
//     -> Package Size Parser (lexicon/packageSize.js)
//     -> Descriptor Parser   (lexicon/shopping.js — descriptors)
//     -> [Structured Product]
//     -> Arabic Builder      (lexicon/arabicBuilder.js)
//
// THE CONTRACT (user directive, 2026-07-26): the STRUCTURED ENGLISH RECORD is
// the authoritative product data — identity, search, matching and future
// lexicon expansion all read from it. The Arabic name generated downstream is a
// PRESENTATION layer built from this record and must never constrain it. So
// nothing in this module is shaped by what reads well in Arabic; a descriptor
// with no Arabic term is still recorded here, it simply does not reach the
// Arabic Builder.
//
// ARABIC OCR IS A FALLBACK SOURCE. When the English name is missing or
// unusable, `source` is 'arabic-fallback': the observed Arabic name is carried
// through unchanged and NO structure is invented from it. There is no Arabic
// -> structure direction in this phase, and guessing one would be exactly the
// "wrong category" failure the lexicon exists to prevent.
//
// PURE AND UNPERSISTED, like §45. Same input -> same output, no I/O. Every
// field here is derivable on read from the columns `offer_enrichments` already
// stores, so this phase adds no column and no migration; persisting any of it
// is a later phase's denormalization decision.

import { hasUsableEnglish } from '../usableEnglish.js';
import { resolveBrand } from './brands.js';
import {
  resolveCategory, resolveDescriptors, resolvePackageType,
  normalizeShoppingText, SHOPPING_STOPWORDS, SHOPPING_LEXICON_VERSION,
} from './shopping.js';
import { parsePackageSize } from './packageSize.js';

export const STRUCTURED_PRODUCT_VERSION = 'structured-product-v1';

export const PRODUCT_SOURCES = Object.freeze({
  ENGLISH: 'english',                 // structure built from the English name
  ARABIC_FALLBACK: 'arabic-fallback', // no usable English; Arabic carried through
  NONE: 'none',                       // no usable name in either script
});

const present = (value) => typeof value === 'string' && value.trim().length > 0;

// The same admission bar S3 applies to `name_en`, and now literally the same
// code: this layer must never treat as usable a name the extraction contract
// already rejected. Re-exported so callers that read structure from here keep
// asking one module one question (R10).
export { hasUsableEnglish };

function tokenize(value) {
  const normalized = normalizeShoppingText(value);
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

// Tokens that a size expression already accounts for. normalizeText keeps
// "330ml" and "5kg" as single tokens (it strips punctuation, not letters), so a
// leading digit is the reliable marker, plus the bare unit words that follow a
// separated number.
const SIZE_UNIT_WORDS = new Set([
  'l', 'lt', 'ltr', 'liter', 'litre', 'liters', 'litres', 'ml',
  'kg', 'kgs', 'kilo', 'kilos', 'g', 'gm', 'gr', 'gram', 'grams',
  'pcs', 'pc', 'piece', 'pieces', 'x', 'pack', 'packs', 'pk', 'ct',
]);
const NUMERIC_LEAD = /^\d/u;

function sizeTokenIndices(tokens) {
  const marked = new Set();
  tokens.forEach((token, index) => {
    if (NUMERIC_LEAD.test(token)) {
      marked.add(index);
      // "330 ml" — the unit word belongs to the number before it.
      if (SIZE_UNIT_WORDS.has(tokens[index + 1])) marked.add(index + 1);
    }
  });
  return marked;
}

function brandTokenIndices(tokens, brandStrings) {
  const brandWords = new Set(brandStrings.filter(present).flatMap((value) => tokenize(value)));
  const marked = new Set();
  tokens.forEach((token, index) => { if (brandWords.has(token)) marked.add(index); });
  return marked;
}

// Descriptors the model reported in its own `attributes` array (Expanded JSON,
// §44 — preserved in `extraction_json` and, until now, read by nothing). They
// are a SECOND source for the same descriptor vocabulary, never a source of
// categories: the array holds marketing fragments ("INSTANT COFFEE", "RED"),
// and letting it name the product would override the head-noun rule.
//
// `categoryPhrase` is the guard against the measured duplication case: the
// NAJJAR crop returns category "instant coffee" AND attribute "INSTANT COFFEE",
// which composed to "قهوة سريعة التحضير سريع التحضير". A descriptor whose term
// is already part of the category's own phrase is not new information.
function descriptorsFromAttributes(attributes, seen, categoryPhrase = '') {
  const categoryWords = new Set(tokenize(categoryPhrase));
  const out = [];
  for (const attribute of Array.isArray(attributes) ? attributes : []) {
    if (!present(attribute)) continue;
    for (const descriptor of resolveDescriptors(attribute)) {
      if (seen.has(descriptor.id)) continue;
      if (tokenize(descriptor.matched_phrase).every((word) => categoryWords.has(word))) continue;
      seen.add(descriptor.id);
      out.push({ ...descriptor, span: null, from: 'attributes' });
    }
  }
  return out;
}

// --- the entry point -----------------------------------------------------------
// `observation` is the extractor's record, in either the stored shape
// (name/name_ar/brand/size) or the Expanded JSON shape (name_en/package_size/
// quantity/package_type/attributes). Both are accepted so a caller never has to
// reshape a row before asking.
export function buildStructuredProduct(observation = {}) {
  const nameEn = observation.name_en ?? observation.productName ?? observation.name ?? null;
  const nameAr = observation.name_ar ?? observation.arabicName ?? observation.nameAr ?? null;
  const brandObserved = observation.brand ?? null;
  const sizeObserved = observation.size ?? observation.package_size ?? null;
  const packCount = observation.pack_count ?? observation.packCount ?? observation.quantity ?? null;
  const packageTypeObserved = observation.package_type ?? observation.packageType ?? null;
  const attributes = observation.attributes ?? null;
  // Disambiguation context from the retailer's category, supplied by the caller
  // (offers/enrich.js productKnowledge). Absent = false = pre-v2 behaviour.
  const nonGrocery = observation.non_grocery ?? observation.nonGrocery ?? false;

  const brand = resolveBrand(brandObserved);
  const size = parsePackageSize({ size: sizeObserved, name: nameEn, packCount, nonGrocery });
  const packageType = resolvePackageType(packageTypeObserved);

  const usableEnglish = hasUsableEnglish(nameEn);
  const source = usableEnglish
    ? PRODUCT_SOURCES.ENGLISH
    : present(nameAr) ? PRODUCT_SOURCES.ARABIC_FALLBACK : PRODUCT_SOURCES.NONE;

  const base = {
    source,
    observed: {
      name_en: nameEn ?? null,
      name_ar: nameAr ?? null,
      brand: brandObserved ?? null,
      size: sizeObserved ?? null,
      package_type: packageTypeObserved ?? null,
    },
    brand,
    category: null,
    category_diagnostics: null,
    content_tokens: [],
    descriptors: [],
    size,
    package_type: packageType,
    residual_en: [],
    coverage: null,
    lexicon_version: SHOPPING_LEXICON_VERSION,
    version: STRUCTURED_PRODUCT_VERSION,
  };

  if (source !== PRODUCT_SOURCES.ENGLISH) return Object.freeze(base);

  const tokens = tokenize(nameEn);
  // Brand and size tokens are removed BEFORE the head noun is chosen: a brand
  // called "Cream" or a "500 G" fragment must never be able to name the
  // product. This is the same discipline browse/brands.js applies in reverse.
  const skipTokens = new Set([
    ...brandTokenIndices(tokens, [brandObserved, brand.display_en, brand.canonical_brand]),
    ...sizeTokenIndices(tokens),
  ]);

  const resolve = (candidate) => {
    const consumed = new Set(skipTokens);
    if (candidate) for (let i = candidate.span[0]; i < candidate.span[1]; i += 1) consumed.add(i);
    const found = resolveDescriptors(nameEn, { skipTokens: consumed })
      .map((descriptor) => ({ ...descriptor, from: 'name_en' }));
    for (const descriptor of found) {
      for (let i = descriptor.span[0]; i < descriptor.span[1]; i += 1) consumed.add(i);
    }
    return { consumed, found };
  };

  let category = resolveCategory(nameEn, { skipTokens });
  let { consumed, found: nameDescriptors } = resolve(category);
  // Why a category is absent, for the standing coverage measurement: a refusal
  // and a vocabulary miss are different problems with different fixes, and
  // without this the instrument cannot tell them apart.
  let categoryDiagnostics = category ? null : { reason: 'no_match', candidate: null, trailing_unknown: 0 };

  // THE HEAD-FINAL GUARD. English retail names are head-final, so a matched
  // category with several UNKNOWN content words still after it is almost never
  // the head noun — it is a modifier of a product this lexicon does not know.
  // Measured on the 1000-row corpus: "Deligos Milk/Wheat Rusk" built as حليب
  // and "Fluffy Chocolate Pancake" as شوكولاتة, both flatly wrong. Refusing
  // here converts those into the safe outcome (no category, fall back to the
  // observed Arabic), which is the project's standing failure-mode rule.
  //
  // Two, not one: a single trailing unknown is usually a variant word the crop
  // added ("Diaper (Pants)", "Rice Sella"), and refusing on one would throw
  // away correct names to avoid a rarer wrong one.
  const HEAD_FINAL_TOLERANCE = 2;
  if (category) {
    const trailingUnknown = tokens.filter((token, index) => index >= category.span[1]
      && !consumed.has(index) && !SHOPPING_STOPWORDS.has(token)).length;
    if (trailingUnknown >= HEAD_FINAL_TOLERANCE) {
      categoryDiagnostics = {
        reason: 'head_final_guard',
        candidate: category.id,
        trailing_unknown: trailingUnknown,
      };
      category = null;
      ({ consumed, found: nameDescriptors } = resolve(null));
    }
  }

  const seen = new Set(nameDescriptors.map((descriptor) => descriptor.id));

  const descriptors = [
    ...nameDescriptors,
    ...descriptorsFromAttributes(attributes, seen, category?.matched_phrase),
  ];

  // Content tokens = the English name minus brand, size and stopwords. Coverage
  // is how much of what the crop SAYS about the product this lexicon
  // understood. It is a MEASUREMENT output, never a gate: by user directive the
  // Arabic Builder composes whatever it has and silently drops the rest.
  const ignored = (token, index) => skipTokens.has(index) || SHOPPING_STOPWORDS.has(token);
  const contentTokens = tokens.filter((token, index) => !ignored(token, index));
  const residual = tokens.filter((token, index) => !consumed.has(index) && !SHOPPING_STOPWORDS.has(token));
  const coverage = contentTokens.length
    ? Number(((contentTokens.length - residual.length) / contentTokens.length).toFixed(3))
    : null;

  return Object.freeze({
    ...base,
    category,
    category_diagnostics: categoryDiagnostics,
    descriptors: Object.freeze(descriptors),
    residual_en: Object.freeze(residual),
    content_tokens: Object.freeze(contentTokens),
    coverage,
  });
}
