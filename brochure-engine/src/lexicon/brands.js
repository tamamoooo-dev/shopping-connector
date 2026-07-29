// lexicon/brands.js — the BRAND LEXICON: one canonical brand identity for the
// brand string the extractor observed.
//
// Phase 1 of the post-extraction lexicon work (HISTORY §45). The pipeline is
//   Mistral Medium -> Expanded JSON -> validation -> stored observation
// and this module sits immediately after it, normalizing ONE field: `brand`.
//
// WHAT IT IS
//   A pure, deterministic alias -> canonical-id lookup. Every known spelling of
//   a brand (English, Arabic, cased differently, carrying a ® or ™) resolves to
//   one `brand_id`; everything else resolves to `brand_id: null`. There is no
//   model call, no embedding, no similarity score, and no fuzzy repair here.
//
// WHAT IT IS NOT
//   • Not brand DETECTION. browse/brands.js `detectBrand()` scans a product
//     NAME for a brand token and needs OCR repair + context guards to survive
//     that ambiguity. This module reads a field the extractor already typed as
//     "brand", so it can be strict: exact alias or nothing.
//   • Not canonicalization, product identity, phrase normalization, or search.
//     Those phases CONSUME this module; none of them live here.
//
// IDENTITY NAMESPACE — `brand_id` IS the browse `slug`. Deliberate: Browse
// rails already group offers by `brand_slug`, so reusing the slug means the
// project has ONE brand identifier, not a second parallel namespace that later
// has to be reconciled. The canonical bilingual names come from the same place:
// browse/brands.js `BRANDS` stays the single truth for "which brands exist and
// what are they called". This module owns only the VARIANTS of those names.
//
// FAILURE MODE (the project rule, unchanged): "no brand", never "wrong brand".

import { BRANDS } from '../browse/brands.js';
import { normalizeText } from '../matching.js';

// Bumped whenever the resolution BEHAVIOUR changes (fold, lookup ladder, or
// output shape) — not when a brand or alias is added. Stored alongside a
// resolution so a later phase can tell which rules produced it.
export const BRAND_LEXICON_VERSION = 'brand-lexicon-v1';

export const BRAND_RESOLUTION_STATUS = Object.freeze({
  RESOLVED: 'resolved', // an alias matched a canonical brand
  UNKNOWN: 'unknown',   // a real string that no alias matched
  EMPTY: 'empty',       // null / non-string / whitespace-only — nothing observed
});

// Brands that belong in the LEXICON but must not enter Browse's name-scanning
// index — typically because the name is an ordinary word that would mis-tag
// product names, while being unambiguous in a field the extractor already
// labelled "brand". Same shape as a browse/brands.js entry ({ slug, en, ar }).
// Empty today; this is the documented place for that case, so nobody is
// tempted to loosen browse/brands.js instead.
//
// 2026-07-26 (§47): two entries, both added because the Arabic Builder needs a
// canonical Arabic brand name and neither is safe for Browse's NAME scanner —
// "أروى" is also an ordinary given name, and "Baskin" is a short form that
// detectBrand() would have to guess at inside a product name. In a field the
// extractor already labelled "brand", both are unambiguous.
export const LEXICON_ONLY_BRANDS = Object.freeze([
  { slug: 'arwa', en: 'Arwa', ar: 'أروى' },
  { slug: 'baskin-robbins', en: 'Baskin Robbins', ar: 'باسكن روبنز' },
]);

// --- alias table ---------------------------------------------------------------
// ONLY variants that the deterministic fold below does NOT already collapse.
// Before adding an entry, check: the fold lowercases, strips ®/™/punctuation
// and Latin accents, unifies Arabic alef/hamza/taa-marbuta/alef-maqsura and
// Farsi glyphs, and a second lookup pass removes ALL spaces — so "LURPAK",
// "lurpak", "Lurpak®", "Nestlé", "Ülker", "Kit Kat", "Lay's" and "Al Marai"
// need no alias at all. What DOES need one: a different word order, a dropped
// or added conjunction, a different transliteration, a legal/company suffix.
//
// Never add a guess. An unmapped brand is a correct, safe outcome; a wrong
// mapping silently merges two companies' products for every phase downstream.
export const BRAND_ALIASES = Object.freeze({
  'head-shoulders': ['Head and Shoulders', 'هيد شولدرز', 'هيد آند شولدرز'],
  johnsons: ['Johnson and Johnson', 'Johnson & Johnson', 'جونسون اند جونسون', 'جونسونز'],
  'california-garden': ['كاليفورنيا جاردن'],
  'foster-clarks': ['فوستر كلارك'],
  lurpak: ['لورپاك'], // Farsi pe (U+067E) — a real flyer/keyboard variant
  alwatania: ['Alwatania Poultry', 'الوطنية للدواجن'],
  nestle: ['Nestle SA'],
  kdd: ['Kuwait Danish Dairy'],
  alalali: ['Alalali Foods'],
  americana: ['Americana Foods'],
  // Short forms flyers actually print for the full company name. Explicit
  // aliases, not prefix matching — "Baskin" resolves, "Baskin Ice Cream" does
  // not, exactly as "Lurpak Butter" does not.
  'baskin-robbins': ['Baskin', 'باسكن', 'باسكن روبنز', 'بسكن روبنز'],
  arwa: ['أروى', 'اروى', 'ارواء'],
});

// --- the fold ------------------------------------------------------------------
// Deliberately the SAME fold browse/brands.js uses, so a lexicon key and a
// Browse index key are the same string for the same brand. NFKC (Arabic
// presentation forms, full-width Latin), then the engine's bilingual
// normalizeText (lowercase, Arabic letter unification, punctuation -> space —
// this is what removes &, apostrophes and hyphens), then NFKD + combining mark
// removal so "Ülker" and "ulker" are one key.
//
// Trademark marks are stripped FIRST, and that order is load-bearing: NFKC
// COMPATIBILITY-decomposes ™ into the letters "TM" and ℠ into "SM", so folding
// first would turn "Lurpak™" into the key `lurpaktm` and lose the brand. ® and
// © survive NFKC and would be caught by normalizeText's punctuation rule, but
// they are removed here too so all four behave identically.
const TRADEMARK_MARKS = /[®™©℠℗]/gu;

export function normalizeBrandKey(value) {
  if (typeof value !== 'string') return null;
  const folded = normalizeText(value.replace(TRADEMARK_MARKS, '').normalize('NFKC'))
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return folded || null;
}

// The space-free form of a folded key. Second (and last) lookup pass: it makes
// "Al Marai" ↔ "Almarai", "Kit Kat" ↔ "KitKat" and "Johnson's" ↔ "Johnsons"
// resolve without an alias, in both directions. It is still an EXACT match on
// a pre-built key — no edit distance, no prefix guessing.
function compactKey(key) {
  return key ? key.replace(/\s+/gu, '') : null;
}

function lexiconEntry({ slug, en, ar }) {
  return Object.freeze({
    id: slug,
    display_en: en ?? null,
    display_ar: ar ?? null,
    aliases: Object.freeze([
      ...(en ? [en] : []),
      ...(ar ? [ar] : []),
      ...(BRAND_ALIASES[slug] || []),
    ]),
  });
}

export const BRAND_LEXICON = Object.freeze(
  [...BRANDS, ...LEXICON_ONLY_BRANDS].map(lexiconEntry),
);

export const BRAND_BY_ID = new Map(BRAND_LEXICON.map((entry) => [entry.id, entry]));

// Alias -> id, built ONCE at module load. Every lookup is a single Map hit; no
// consumer ever scans the brand list.
const ALIAS_INDEX = new Map();
const COMPACT_INDEX = new Map();

// Two ids claiming one key would make resolution order-dependent. Declaration
// order wins (deterministic), and the clash is RECORDED rather than swallowed —
// brands.test.mjs asserts this stays empty, so a bad alias fails the tests
// instead of silently shadowing a brand in production.
export const BRAND_ALIAS_COLLISIONS = [];

// Single-character keys can only come from a broken alias; they would match far
// too much to ever be safe.
const MIN_KEY_LENGTH = 2;

// The Arabic definite article is GRAMMAR, not identity: flyers print both
// "سنبلة" and "السنبلة" for one company (measured on the 2026-07-21 production
// observations). Indexing the article-carrying form of a single-word Arabic
// name is the Arabic counterpart of case-insensitivity — the same name, one
// more spelling — not a new mapping, so it stays inside the "never guess" rule.
//
// The reverse (stripping ال from a name that carries it) is deliberately NOT
// done: browse/brands.js measured that bare forms are frequently ordinary
// words ("صافي" = net, "ربيع" = spring, "الكبير" = the big one), so stripping
// would trade a safe miss for a possible wrong brand. Those need an explicit
// alias if they ever turn up.
const ARABIC_WORD = /^[؀-ۿ]+$/u;

function articleVariant(key) {
  if (!key || !ARABIC_WORD.test(key) || key.startsWith('ال')) return null;
  return `ال${key}`;
}

function indexKey(map, key, id, kind) {
  if (!key || key.length < MIN_KEY_LENGTH) return;
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, id);
    return;
  }
  if (existing !== id) BRAND_ALIAS_COLLISIONS.push({ key, kind, kept: existing, dropped: id });
}

for (const entry of BRAND_LEXICON) {
  for (const alias of entry.aliases) {
    const key = normalizeBrandKey(alias);
    indexKey(ALIAS_INDEX, key, entry.id, 'alias');
    indexKey(COMPACT_INDEX, compactKey(key), entry.id, 'compact');
    const withArticle = articleVariant(key);
    if (withArticle) {
      indexKey(ALIAS_INDEX, withArticle, entry.id, 'article');
      indexKey(COMPACT_INDEX, withArticle, entry.id, 'article');
    }
  }
}

export const BRAND_ALIAS_INDEX_SIZE = ALIAS_INDEX.size;

// --- resolution ----------------------------------------------------------------
// The ONE entry point. Pure: same input -> same output, forever, with no I/O.
//
// The returned block is ADDITIVE and never replaces the observation:
//   observed_brand  — the extractor's string, verbatim (the source of truth)
//   brand_id        — canonical id, or null when unknown
//   canonical_brand — the single canonical display string: the English display
//                     name when resolved, otherwise the observed string
//                     unchanged (requirement: unknown brands are NOT guessed)
//   display_en / display_ar — bilingual canonical names, null when unresolved
//   matched_alias   — the folded key that hit, for auditing why it resolved
//   status          — 'resolved' | 'unknown' | 'empty'
//   lexicon_version — the rules that produced this block
export function resolveBrand(observedBrand) {
  const observed_brand = typeof observedBrand === 'string' ? observedBrand : null;
  const key = normalizeBrandKey(observedBrand);
  if (!key) {
    return {
      observed_brand,
      brand_id: null,
      canonical_brand: null,
      display_en: null,
      display_ar: null,
      matched_alias: null,
      status: BRAND_RESOLUTION_STATUS.EMPTY,
      lexicon_version: BRAND_LEXICON_VERSION,
    };
  }
  const compact = compactKey(key);
  const id = ALIAS_INDEX.get(key) ?? COMPACT_INDEX.get(compact) ?? null;
  const entry = id ? BRAND_BY_ID.get(id) : null;
  if (!entry) {
    return {
      observed_brand,
      brand_id: null,
      // Unknown stays as observed — trimmed of surrounding whitespace only.
      canonical_brand: observed_brand.trim() || null,
      display_en: null,
      display_ar: null,
      matched_alias: null,
      status: BRAND_RESOLUTION_STATUS.UNKNOWN,
      lexicon_version: BRAND_LEXICON_VERSION,
    };
  }
  return {
    observed_brand,
    brand_id: entry.id,
    canonical_brand: entry.display_en ?? entry.display_ar,
    display_en: entry.display_en,
    display_ar: entry.display_ar,
    matched_alias: ALIAS_INDEX.has(key) ? key : compact,
    status: BRAND_RESOLUTION_STATUS.RESOLVED,
    lexicon_version: BRAND_LEXICON_VERSION,
  };
}

// Convenience for consumers that only need the id (Registry keys, Browse rails,
// future canonicalization). Same lookup, no allocation of the full block.
export function brandIdFor(observedBrand) {
  const key = normalizeBrandKey(observedBrand);
  if (!key) return null;
  return ALIAS_INDEX.get(key) ?? COMPACT_INDEX.get(compactKey(key)) ?? null;
}
