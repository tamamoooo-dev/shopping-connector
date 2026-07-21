// registry/read.js — turn an (offer, enrichment) pair into a resolver READ, or
// a DEFER verdict (REGISTRY-DESIGN.md §3 "normalize read"; IDENTITY-V2 §3 mint
// gates + §3.1 verdicts, which carry into this design unchanged).
//
// A read is the normalized evidence one enriched offer contributes:
//   { tokens, size, brandText, family, category, kind, corroboration }
// Tokens follow IDENTITY-V2 §4.2 (EN-preferred per the §7.2 A/B — Arabic read
// variance is enormous; diacritics folded incl. Latin per §7.3 L1; brand-repair
// index applied; banner/size/digit/single-char tokens dropped) EXCEPT: no
// lexicographic sort and no cap of 8 — the registry matches by tolerant SET
// containment (P4), not exact keys, so order is meaningless and the §7.2 A/B
// measured caps immaterial (±2%). Profiles are capped instead (§5.2).
//
// P5 lives here: an uncorroborated read produces NO read — it can neither
// attach nor mint (a hallucination must not create a product).

import {
  normalizeText, parseSize, stripSizes, offerFamily, productType, isProduceFamily,
} from '../matching.js';
import { BANNER_WORDS } from '../offers/contract.js';
import { servable } from '../offers/enrich.js';
import { matchBrandToken } from '../browse/brands.js';
import { PRODUCT_KIND } from './model.js';

// IDENTITY-V2 §3.1 verdicts (the defer reasons). Every excluded offer receives
// exactly one — surfaced as counters, never silent.
export const READ_VERDICT = Object.freeze({
  OK: 'minted',
  NO_ENRICHMENT: 'no_enrichment',
  DECLINED: 'declined',
  LOW_CORROBORATION: 'low_corroboration',
  TOO_FEW_TOKENS: 'too_few_tokens',
  OR_DEAL: 'or_deal',
});

// Explicit assortment markers (IDENTITY-V2 §3 gate 2, revised rule, plus the
// §7.1 crop-review addition selected|مختار). An assortment tile mints a
// DEGRADED assortment read — never keyed on vision's single-flavor reading.
// Bare او/or OR-deal detection is deliberately NOT implemented: IDENTITY-V2
// marks its pattern as needing design + re-measurement before lock.
const ASSORT_RE = /assort|combo|تشكيل|متنوع|اصناف|selected|مختار/;

// Bare OR-deal (IDENTITY-V2 §3 gate 2b, designed here per its "needs design"
// deferral): a tile offering a CHOICE of two products ("Tide 3kg or Persil
// 3kg") is a true two-product tile — it must never mint or attach (either
// identity would inherit the other's prices). The measured trap (§3: 20.7%
// false fire) was matching او/or against raw OCR text, so this gate reads the
// VISION name fields ONLY and demands both sides of the conjunction carry ≥2
// evidence tokens — "fresh or frozen" (one attribute word per side) and brand
// names containing "or" as a substring never fire. The verdict is recorded
// (§3.1), so the live fire rate is a /registry/stats read — the lock-gating
// re-measurement happens automatically once the catalog is enriched.
const OR_SPLIT_EN = /\bor\b/;
const OR_SPLIT_AR = / او /;

export function isOrDeal(name, nameAr) {
  for (const [text, splitter] of [
    [name, OR_SPLIT_EN],
    [nameAr, OR_SPLIT_AR],
  ]) {
    if (!text) continue;
    const sides = normalizeText(String(text)).split(splitter);
    if (sides.length < 2) continue;
    const substantial = sides.filter((s) => evidenceTokens(s).length >= 2);
    if (substantial.length >= 2) return true;
  }
  return false;
}

// Latin diacritic fold on top of the engine normalizer (§7.3 L1: "président"
// vs "president" split keys; same fold browse/brands.js uses).
export function foldToken(t) {
  return t.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

// IDENTITY-V2 §4.3: a numeric range ("7 to 9 kg") is not a pack size — nosize.
const RANGE_RE = /\d\s*(?:to|الي|إلى)\s*\d/i;

// Parse the read's size: the structured vision.size field first, else the
// chosen name (IDENTITY-V2 §4.3). Returns {unit, each, pack} or null (nosize).
export function readSize(sizeField, name) {
  for (const src of [sizeField, name]) {
    if (!src || RANGE_RE.test(String(src))) continue;
    const s = parseSize(src, '');
    if (s && s.unit && s.total != null) return { unit: s.unit, each: s.each, pack: s.pack || 1 };
  }
  return null;
}

// One text -> identity-evidence tokens (IDENTITY-V2 §4.2 steps 1–5).
export function evidenceTokens(text) {
  const out = [];
  for (const raw of normalizeText(stripSizes(text || '')).split(' ')) {
    const t = foldToken(raw);
    if (!t || t.length < 2) continue;             // empty / single-char
    if (/^\d+$/.test(t)) continue;                // digit-only
    if (BANNER_WORDS.has(t)) continue;            // flyer-banner noise
    // Brand-repair index: known misreadings/scripts collapse to the canonical
    // slug ("المراعي" and "Almarai" become one token — cross-script identity).
    out.push(matchBrandToken(t) || t);
  }
  return [...new Set(out)];
}

// (offer, enrichment) -> the source-side OBSERVATION for apply.js: the
// presentation/context fields of this sighting. `week` is the offer's
// valid_from date (the weekly bucket, same convention as price_history),
// falling back to the detection date for the rare undated flyer.
export function observationFromOffer(offer, enrichment) {
  return {
    offerId: offer.id,
    store: offer.store,
    region: offer.region,
    week: offer.valid_from || String(offer.detected_at || '').slice(0, 10),
    price: offer.price,
    oldPrice: offer.old_price ?? null,
    name: enrichment?.name ?? null,
    nameAr: enrichment?.name_ar ?? null,
    source: offer.source,
    category: offer.category || null,
  };
}

// (offer, enrichment) -> { ok: true, read } | { ok: false, verdict }.
// `offer` is the raw offers row (snake_case, as stored); `enrichment` the
// offer_enrichments row or null/undefined when the drain hasn't reached it.
export function readFromOffer(offer, enrichment) {
  // Gate 1 (P5): a servable enrichment or nothing. servable() is the SAME
  // gate name-serving uses — one corroboration floor, owned by enrich.js.
  if (!enrichment) return { ok: false, verdict: READ_VERDICT.NO_ENRICHMENT };
  if (enrichment.name == null && enrichment.name_ar == null) {
    return { ok: false, verdict: READ_VERDICT.DECLINED };
  }
  if (!servable(enrichment)) return { ok: false, verdict: READ_VERDICT.LOW_CORROBORATION };

  // Gate 2b: bare OR-deal tiles (two-product choices) never mint (§3 revised
  // rule) — vision names only; the OCR text is measured noise for this marker.
  if (isOrDeal(enrichment.name, enrichment.name_ar)) {
    return { ok: false, verdict: READ_VERDICT.OR_DEAL };
  }

  // EN-preferred language rule (IDENTITY-V2 §4.1 strategy A, decided by §7.2).
  const name = enrichment.name || enrichment.name_ar;

  // Gate 2: assortment tiles. The marker is looked for in the vision reading
  // AND the tile's own OCR text (§10.1b: a marker in either is the signal).
  const markerHay = normalizeText(
    [enrichment.name, enrichment.name_ar, offer.search_text].filter(Boolean).join(' '),
  );
  const assorted = ASSORT_RE.test(markerHay);

  let tokens = evidenceTokens([name, enrichment.brand].filter(Boolean).join(' '));
  let family = offerFamily({
    name: enrichment.name,
    nameAr: enrichment.name_ar,
    category: offer.category,
  });
  // On an assortment tile a PRODUCE family is the flavor vision happened to
  // name ("MOBI Dishwash Lemon Assorted" is not lemons) — exactly the
  // flavor-specific evidence the degraded rule drops. Not identity, not core.
  if (assorted && isProduceFamily(family)) family = null;

  if (assorted) {
    // Degraded assortment read (IDENTITY-V2 §3 gate 2 revised): brand +
    // product-type core only, plus the literal `assorted` token — never the
    // single flavor vision happened to name. The brand core is vision's own
    // brand field (trusted even off-lexicon: "MOBI Dishwash Assorted") plus
    // any lexicon-matched brand token from the name.
    const core = new Set(evidenceTokens(enrichment.brand || ''));
    for (const t of tokens) if (matchBrandToken(t)) core.add(t);
    if (family) core.add(foldToken(normalizeText(family)));
    const type = productType(name);
    if (type) core.add(foldToken(normalizeText(type)));
    core.add('assorted');
    tokens = [...core];
  }

  // Gate 3: ≥ 2 core tokens — one word is not a product identity.
  if (tokens.length < 2) return { ok: false, verdict: READ_VERDICT.TOO_FEW_TOKENS };

  return {
    ok: true,
    read: {
      tokens,
      size: readSize(enrichment.size, name),
      brandText: enrichment.brand ? foldToken(normalizeText(enrichment.brand)) : null,
      family,
      category: offer.category || null,
      kind: assorted ? PRODUCT_KIND.ASSORTMENT : PRODUCT_KIND.PRODUCT,
      corroboration: Number(enrichment.corroboration) || 0,
    },
  };
}
