// registry/resolver.js — Registry Resolution (REGISTRY-DESIGN.md §3–§4): match
// one normalized OBSERVATION (a "read") into the registry with tolerance, and
// decide one of the four outcomes:
//
//   attach — best candidate ≥ tAttach   (band `auto`: teaches the profile)
//   review — tReview ≤ best < tAttach   (band `review`: attaches to best but
//            does NOT teach; sampled human review heals mistakes — §3's
//            containment between "usable now" and "cautious forever")
//   create — best < tReview or no candidates (P1 create-on-doubt: a false
//            split heals by merge; a forced match would pollute invisibly)
//   defer  — the observation failed a mint gate (read.js; verdict says which)
//
// SOURCE-AGNOSTIC BY CONTRACT: resolveRead() knows nothing about vision, OCR
// or flyers — it consumes a normalized read ({tokens, size, brandText, family,
// category, kind, corroboration}) plus an opaque observation context. All
// source-specific normalization and gating lives in read.js (the current
// vision-enrichment normalizer); a future source only needs to produce reads.
// `corroboration` is a generic observation-trust scalar in 0..1, defined by
// the source (for vision reads: token overlap vs the tile's own OCR text).
//
// Phase 2 boundary: this module DECIDES and never writes — sighting storage
// and profile learning are Phase 3.

import { readFromOffer } from './read.js';
import { decodeProfile, MATCH_BAND } from './model.js';
import { matchBrandToken } from '../browse/brands.js';
import {
  canonicalToken, expandToken, normalizeText, productFamily, productType,
} from '../matching.js';
import { BANNER_WORDS } from '../offers/contract.js';
import { PROVIDER_AISLES } from '../browse/mapping.js';
import { AISLE_BY_ID } from '../browse/taxonomy.js';

// CALIBRATION PRIORS, not fixed design (§4.2: "priors for review, not
// constants to defend"). One object so the Phase 4 replay harness can sweep
// values without touching source: every scoring/decision function accepts an
// optional `tuning` override. Initialized from the measured evidence:
//   tAttach/tReview — the §7.3 containment separation (matches clustered
//     ≥ 0.6 at 0.00% false-match: 0.6 alone lands in review; attach demands
//     corroborating signals), biased by P1 (prefer false splits).
//   weights — §4.2 table: containment dominant, size strong, others small.
//   corroborationFull — full trust from 0.6 up (spike: verified reads scored
//     0.40–1.00, the one hallucination 0.00; floor 0.3 lives in enrich.js).
//   commonTokenShare/Floor — §4.1: a token in >2% of products blocks nothing;
//     the floor keeps the ceiling meaningful while the registry is small.
//   sizeTolerance — the engine-wide 3% size-equivalence figure (matching.js).
export const TUNING = Object.freeze({
  tAttach: 0.7,
  tReview: 0.45,
  weights: Object.freeze({
    containment: 0.55,
    size: 0.2,
    brand: 0.1,
    family: 0.05,
    category: 0.05,
  }),
  stickyBonus: 0.05,
  corroborationFull: 0.6,
  commonTokenShare: 0.02,
  commonTokenFloor: 10,
  sizeTolerance: 0.03,
});

// §4.1: size incompatibility filters BEFORE scoring (P3: a conflicting size is
// a veto). Both sized: units must agree and grand totals (each × pack) must be
// within tolerance. One side nosize -> compatible (nosize must match sized,
// per the §7.3 L2→L3 gains).
export function sizeConflicts(a, b, tuning = TUNING) {
  if (!a || !b) return false;
  if (a.unit !== b.unit) return true;
  const ta = a.each * (a.pack || 1);
  const tb = b.each * (b.pack || 1);
  const hi = Math.max(ta, tb);
  return hi > 0 && (hi - Math.min(ta, tb)) / hi > tuning.sizeTolerance;
}

// Brand relation (§4.2, P2 revised 2026-07-21): evidence, never a
// REQUIREMENT — a missing brand on either side stays neutral (that is the
// −4.4-point trap §7.3 L4 measured). But an outright CONFLICT (both sides
// determinable, neither contains the other) is now a veto, not a −0.1 nudge:
// production showed "NADEC UHT MILK FULL FAT" attaching to the Al Safi UHT
// product at 0.674 purely on generic-token containment (milk/uht/full/fat),
// polluting sightings cross-brand. Create-on-doubt (P1) makes the veto safe:
// a real same-product brand misread heals by merge; a forced cross-brand
// attach pollutes invisibly. Compatible when either normalized text contains
// the other ("sebamed" vs "sebamed baby" — granularity wobble).
// Canonical compare form: per-token brand-repair (cross-script المراعي ≡
// almarai) then space-stripped ("al safi" ≡ "alsafi") — applied to BOTH sides
// at compare time so stored brand_text and fresh reads meet on equal footing
// whatever normalization era wrote them.
function canonBrand(text) {
  return text.split(' ').map((t) => matchBrandToken(t) || t).join('');
}

export function brandRelation(readBrand, productBrand) {
  if (!readBrand || !productBrand) return null; // undeterminable
  const a = canonBrand(readBrand);
  const b = canonBrand(productBrand);
  if (!a || !b) return null;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 1;
  return -1;
}

// --- lexical + semantic admission ---------------------------------------------
// Scoring is deliberately NOT the first identity gate. Brand and equal package
// size are useful corroboration after two observations have established that
// they describe the same kind of product, but production proved they can push
// unrelated same-brand/same-size rows over both decision thresholds (Sadia
// corn/beans/chicken, Almarai butter/cake). Admission therefore operates on a
// product-core view of the token sets before size or brand is consulted.

const CORE_CONNECTORS = [
  'and', 'or', 'with', 'without', 'for', 'from', 'of', 'in', 'on', 'at', 'by',
  'to', 'per', 'plus', 'the', 'a', 'an',
  'او', 'مع', 'بدون', 'من', 'في', 'على', 'الي', 'لكل', 'و',
];
const CORE_PACKAGING = [
  'pack', 'packs', 'packet', 'packets', 'pkt', 'bag', 'bags', 'box', 'boxes',
  'bottle', 'bottles', 'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'piece',
  'pieces', 'pcs', 'pc', 'count', 'ct', 'tray', 'rolls',
  'عبوه', 'عبوات', 'كيس', 'اكياس', 'علبه', 'علب', 'زجاجه', 'زجاجات', 'حبه',
  'حبات', 'قطعه', 'قطع', 'صحن', 'رول',
];
const CORE_PROMOTIONAL = [
  'fresh', 'frozen', 'local', 'imported', 'selected', 'assorted', 'regular',
  'spicy', 'hot', 'original', 'premium', 'classic', 'natural', 'jumbo', 'mini',
  'large', 'small', 'medium', 'astd', 'mixed',
  'طازج', 'مجمد', 'محلي', 'مستورد', 'مختار', 'مشكل', 'عادي', 'حار', 'اصلي',
  'فاخر', 'كلاسيك', 'طبيعي', 'كبير', 'صغير', 'وسط',
];
const CORE_STOP = new Set(
  [...BANNER_WORDS, ...CORE_CONNECTORS, ...CORE_PACKAGING, ...CORE_PROMOTIONAL]
    .map((t) => canonicalToken(t))
    .filter(Boolean),
);
const PACKAGE_TOKEN_RE = /^\d+(?:[.,]\d+)?(?:ml|ltr?|l|kg|kgs|g|gm|grm?|pcs?|pc|pack|pkt|ct|s)$/u;

function normalizedTokens(text) {
  return normalizeText(text).split(' ').map(canonicalToken).filter(Boolean);
}

function brandTokenSet(...texts) {
  return new Set(texts.flatMap((t) => normalizedTokens(t || '')));
}

// Tokens used by the admission containment calculation. The stored profile is
// left intact (presentation/learning compatibility); only the resolver's
// identity lens removes non-product evidence.
export function productCoreTokens(tokens, ...brandTexts) {
  const brands = brandTokenSet(...brandTexts);
  const out = new Set();
  for (const raw of tokens || []) {
    const t = canonicalToken(raw);
    if (!t || CORE_STOP.has(t) || PACKAGE_TOKEN_RE.test(t) || /^\d+$/.test(t)) continue;
    if (brands.has(t) || matchBrandToken(t)) continue;
    out.add(t);
  }
  return [...out];
}

function coreHits(readCore, productCore) {
  const p = new Set(productCore);
  let hits = 0;
  const matched = [];
  for (const token of readCore) {
    if (expandToken(token).some((v) => p.has(v))) {
      hits += 1;
      matched.push(token);
    }
  }
  return { hits, matched };
}

// Product FORM is intentionally resolver-local and narrower than the Search
// family ontology. Existing productType() supplies the common forms; the
// additions below cover the observed registry collisions that family alone
// cannot distinguish (breast/liver are both chicken, for example).
const EXTRA_FORM_TERMS = Object.freeze({
  corn: ['corn', 'sweetcorn', 'ذره'],
  beans: ['bean', 'beans', 'فاصوليا', 'فاصولياء'],
  butter: ['butter', 'زبده'],
  cake: ['cake', 'cakes', 'muffin', 'muffins', 'كيك', 'كيكه', 'مافن'],
  broasted: ['broast', 'broasted', 'بروست', 'بروستد'],
  liver: ['liver', 'livers', 'كبد', 'كبده', 'اكباد'],
  gizzard: ['gizzard', 'gizzards', 'قوانص', 'قانصه'],
  drumstick: ['drumstick', 'drumsticks', 'ساق', 'سيقان'],
  thigh: ['thigh', 'thighs', 'فخذ', 'افخاذ'],
  whole: ['whole', 'griller', 'كامل', 'كامله', 'شوايه'],
  popcorn: ['popcorn', 'بوبكورن'],
  tender: ['tender', 'tenders', 'تندر', 'مسحب'],
  sausage: ['frank', 'franks'],
});
const EXTRA_FORM_INDEX = new Map(
  Object.entries(EXTRA_FORM_TERMS)
    .flatMap(([form, terms]) => terms.map((t) => [canonicalToken(t), form])),
);
const PROTEIN_FAMILIES = new Set(['chicken', 'meat', 'fish']);

function semanticForms(tokens, family) {
  const out = new Set();
  const type = productType((tokens || []).join(' '));
  if (type) out.add(type);
  for (const token of tokens || []) {
    const t = canonicalToken(token);
    const extra = EXTRA_FORM_INDEX.get(t);
    if (extra && (extra !== 'whole' || PROTEIN_FAMILIES.has(family))) out.add(extra);
  }
  return out;
}

const FORM_COMPATIBLE = new Set([
  'breast|fillet', 'fillet|breast',
  'breast|tender', 'tender|breast',
  'fillet|tender', 'tender|fillet',
]);
function formsCompatible(a, b) {
  for (const x of a) for (const y of b) {
    if (x !== y && !FORM_COMPATIBLE.has(`${x}|${y}`)) return false;
  }
  return true;
}

const SPECIES_TERMS = Object.freeze({
  chicken: ['chicken', 'دجاج', 'فراخ'],
  beef: ['beef', 'بقري', 'بقر'],
  lamb: ['lamb', 'mutton', 'غنم', 'ضأن', 'خروف'],
  camel: ['camel', 'hashi', 'حاشي', 'جمل'],
  veal: ['veal', 'عجل'],
  goat: ['goat', 'تيس', 'ماعز'],
  fish: ['fish', 'سمك'],
  shrimp: ['shrimp', 'shrimps', 'prawn', 'prawns', 'روبيان', 'جمبري'],
  turkey: ['turkey', 'ديك', 'رومي'],
});
const SPECIES_INDEX = new Map(
  Object.entries(SPECIES_TERMS)
    .flatMap(([species, terms]) => terms.map((t) => [canonicalToken(t), species])),
);
function species(tokens) {
  const out = new Set();
  for (const token of tokens || []) {
    const hit = SPECIES_INDEX.get(canonicalToken(token));
    if (hit) out.add(hit);
  }
  return out;
}

const FAMILY_COMPATIBLE = new Set([
  'cheese|cream', 'cream|cheese',
  'milk|powder', 'powder|milk',
]);

// Provider mappings are the canonical category vocabulary already used by
// Browse. Resolve a raw category only when every configured provider that
// knows it maps it to the same aisle; ambiguity stays neutral, never a veto.
const NON_VETO_AISLES = new Set(['other', 'frozen-food']);
const CATEGORY_CLASSES = (() => {
  const classes = new Map();
  const ambiguous = new Set();
  for (const map of Object.values(PROVIDER_AISLES)) {
    for (const [category, aisle] of Object.entries(map)) {
      const next = NON_VETO_AISLES.has(aisle) ? null : {
        aisle,
        department: AISLE_BY_ID.get(aisle)?.dept || null,
      };
      if (!next) continue;
      if (
        classes.has(category) &&
        (classes.get(category).aisle !== next.aisle ||
          classes.get(category).department !== next.department)
      ) ambiguous.add(category);
      else classes.set(category, next);
    }
  }
  for (const category of ambiguous) classes.delete(category);
  return classes;
})();
function categoryClass(category) {
  if (!category) return null;
  return CATEGORY_CLASSES.get(String(category).toLowerCase()) || null;
}

function admissionSide(tokens, family, category, ...brandTexts) {
  return {
    tokens: tokens || [],
    core: productCoreTokens(tokens, ...brandTexts),
    forms: semanticForms(tokens, family),
    species: species(tokens),
    family: family || null,
    category: categoryClass(category),
  };
}

function productAdmissionSide(product, cache) {
  const signature = [
    product.token_profile || '{}', product.brand_text || '', product.brand_slug || '',
    product.family || '', product.category || '',
  ].join('\u0000');
  const cached = cache?.get(product.id);
  if (cached?.signature === signature) return cached.side;
  const profileTokens = Object.keys(decodeProfile(product.token_profile));
  const side = admissionSide(
    profileTokens,
    product.family,
    product.category,
    product.brand_text,
    product.brand_slug,
  );
  if (cache) cache.set(product.id, { signature, side });
  return side;
}

function lexicalSideFamily(side) {
  if (Object.prototype.hasOwnProperty.call(side, 'lexicalFamily')) {
    return side.lexicalFamily;
  }
  side.lexicalFamily = productFamily(side.tokens.join(' ')) || null;
  return side.lexicalFamily;
}

// Pure admission verdict, exported for focused tests and offline replay
// diagnostics. `semanticOnly` means a trusted family/form relation admitted a
// spelling-poor observation; resolveRead caps that edge at review so it cannot
// teach until lexical evidence appears.
export function candidateAdmission(read, product, preparedRead = null, productCache = null) {
  const a = preparedRead || admissionSide(
    read.tokens, read.family, read.category, read.brandText,
  );
  const b = productAdmissionSide(product, productCache);
  const readCore = a.core;
  const productCore = b.core;
  const { hits, matched } = coreHits(readCore, productCore);
  const formKnown = a.forms.size > 0 && b.forms.size > 0;
  const formMatch = formKnown && formsCompatible(a.forms, b.forms);
  if (formKnown && !formMatch) {
    return { admitted: false, reason: 'form-conflict', readCore, productCore, hits };
  }
  if ((a.forms.size > 0) !== (b.forms.size > 0)) {
    const specificHit = matched.some(
      (token) => !expandToken(token).some((variant) => SPECIES_INDEX.has(variant)),
    );
    if (!specificHit) {
      return { admitted: false, reason: 'form-specificity', readCore, productCore, hits };
    }
  }

  if (a.species.size && b.species.size && ![...a.species].some((s) => b.species.has(s))) {
    return { admitted: false, reason: 'species-conflict', readCore, productCore, hits };
  }

  let readFamily = a.family;
  let productFamilyValue = b.family;
  if (readFamily && productFamilyValue && readFamily !== productFamilyValue) {
    // A secondary-language enrichment or category fallback can occasionally
    // disagree with the actual identity tokens (for example exact English
    // sunflower-oil names whose Arabic text contains the word "powder"). Only
    // on a prospective hard conflict, prefer lexical family when determinable.
    readFamily = lexicalSideFamily(a) || readFamily;
    productFamilyValue = lexicalSideFamily(b) || productFamilyValue;
  }
  const familyMatch = !!readFamily && readFamily === productFamilyValue;
  const familyCompatible = !!readFamily && !!productFamilyValue &&
    FAMILY_COMPATIBLE.has(`${readFamily}|${productFamilyValue}`);
  if (readFamily && productFamilyValue && !familyMatch && !familyCompatible) {
    return { admitted: false, reason: 'family-conflict', readCore, productCore, hits };
  }

  if (
    a.category && b.category &&
    (a.category.department !== b.category.department || a.category.aisle !== b.category.aisle)
  ) {
    return { admitted: false, reason: 'category-conflict', readCore, productCore, hits };
  }

  const categoryMatch = !!a.category && !!b.category &&
    a.category.department === b.category.department && a.category.aisle === b.category.aisle;
  const semanticEvidence = formMatch || (familyMatch && categoryMatch);
  if (hits === 0 && !semanticEvidence) {
    return { admitted: false, reason: 'no-product-core', readCore, productCore, hits };
  }
  return {
    admitted: true,
    reason: hits > 0 ? 'shared-product-core' : 'semantic-evidence',
    readCore,
    productCore,
    hits,
    semanticOnly: hits === 0,
    semanticEvidence,
  };
}

// Score one candidate product against a read (§4.2). Pure. Returns
// { score, vetoed } — vetoed candidates never attach regardless of score.
export function scoreCandidate(
  read,
  product,
  {
    incumbentId = null, tuning = TUNING, admissionRead = null,
    admissionCache = null,
  } = {},
) {
  const W = tuning.weights;
  // Kind gate (§6): assortments match only assortments; a specific-flavor
  // read never attaches to one.
  if ((product.kind || 'product') !== read.kind) return { score: 0, vetoed: true };

  // Identity admission precedes every corroborating signal. In particular,
  // size and brand below can improve a score only after product-core or
  // trusted semantic evidence has established eligibility.
  const admission = candidateAdmission(read, product, admissionRead, admissionCache);
  if (!admission.admitted) return { score: 0, vetoed: true, admission };

  const productSize = product.size_unit != null && product.size_total != null
    ? { unit: product.size_unit, each: product.size_total, pack: product.size_pack || 1 }
    : null;
  if (sizeConflicts(read.size, productSize, tuning)) return { score: 0, vetoed: true };

  // Brand conflict veto (P2 revised — see brandRelation): both sides read a
  // brand and they disagree -> this candidate can never attach, whatever the
  // token overlap says. Missing brand on either side stays neutral below.
  const brand = brandRelation(read.brandText, product.brand_text || null);
  if (brand === -1) return { score: 0, vetoed: true };

  // P4: token containment of the read in the ACCUMULATED profile — the
  // workhorse (+22.5 points, 0% false matches at ≥ 0.6).
  const containment = admission.readCore.length
    ? admission.hits / admission.readCore.length
    : admission.semanticEvidence ? 0.6 : 0;

  // Weighted evidence over the DETERMINABLE signals only: missing evidence is
  // neutral (excluded from the denominator), never a penalty — P3's "nosize
  // is compatible" generalized to every signal.
  let num = W.containment * containment;
  let den = W.containment;
  if (read.size && productSize) { // conflict already vetoed -> equal here
    num += W.size;
    den += W.size;
  }
  if (brand != null) {
    num += W.brand * brand; // conflicts vetoed above; here brand is 1
    den += W.brand;
  }
  if (read.family && product.family) {
    num += W.family * (read.family === product.family ? 1 : 0);
    den += W.family;
  }
  if (read.category && product.category) {
    num += W.category * (read.category === product.category ? 1 : 0);
    den += W.category;
  }

  let score = num / den;
  if (incumbentId && product.id === incumbentId) {
    score = Math.min(1, score + tuning.stickyBonus); // §3 sticky incumbency
  }
  // Corroboration scaling last: it dampens ALL evidence of a shaky read.
  score *= Math.min(1, read.corroboration / tuning.corroborationFull);
  return { score: Math.max(0, score), vetoed: false, admission };
}

// The blocking token set (§4.1): read tokens whose registry frequency is under
// the commonness ceiling. `freqs` is Map(token -> product count).
export function distinctiveTokens(tokens, freqs, productCount, tuning = TUNING) {
  const ceiling = Math.max(
    tuning.commonTokenFloor,
    Math.ceil(productCount * tuning.commonTokenShare),
  );
  return tokens.filter((t) => (freqs.get(t) || 0) <= ceiling);
}

// Resolve one normalized observation against the registry. DECIDES ONLY.
//
// `ctx` is the observation's context, opaque to the matcher:
//   { offerId, store, region, textKey } — textKey is a per-source text
//   fingerprint consulted ONLY by the sticky-incumbency fast-path (below).
//
// STICKY INCUMBENCY IS A FAST-PATH, NOT A DEPENDENCY: the incumbent lookup
// (store.findIncumbentProductId) is a replaceable optimization behind the
// store interface. When it returns null — text legitimately changed, source
// swapped, lookup removed — resolution proceeds purely on profile matching
// and only tie-break hysteresis is lost, never correctness.
//
// `store` is the registry store (storage/registryStore.js or a twin).
// Returns { outcome, verdict, band?, productId?, score?, read?, considered? }.
export async function resolveRead(
  read,
  ctx,
  store,
  { tuning = TUNING, productCount: pcHint, admissionCache = null } = {},
) {
  // BLOCK (§4.1): products sharing ≥1 distinctive token, UNION the sticky
  // incumbent (the observation's own prior counterpart's product).
  // `productCount` is a batch-invariant (it feeds only the distinctness ceiling,
  // already an approximate prior) — the drain snapshots it ONCE and passes it in
  // via pcHint so we don't re-run SELECT COUNT(*) per offer (one saved D1
  // subrequest × every offer in the batch).
  const [productCount, freqs, incumbentId] = await Promise.all([
    pcHint != null ? Promise.resolve(pcHint) : store.productCount(),
    store.tokenFrequencies(read.tokens),
    store.findIncumbentProductId({
      store: ctx.store,
      region: ctx.region,
      searchText: ctx.textKey || '',
      excludeOfferId: ctx.offerId,
    }),
  ]);
  const blockTokens = distinctiveTokens(read.tokens, freqs, productCount, tuning);
  const ids = new Set(blockTokens.length ? await store.candidateIds(blockTokens) : []);
  if (incumbentId) ids.add(incumbentId);
  const admissionRead = admissionSide(
    read.tokens, read.family, read.category, read.brandText,
  );

  // SCORE (§4.2). Merged tombstones redirect single-hop to their survivor
  // (§5.1 guarantees the survivor is never itself merged).
  let best = null;
  let considered = 0;
  if (ids.size) {
    const products = await store.getProducts([...ids]);
    const survivors = new Map(); // id -> row, after tombstone redirect
    const redirects = [];
    for (const p of products) {
      if (p.status === 'merged') {
        if (p.merged_into && !ids.has(p.merged_into)) redirects.push(p.merged_into);
      } else {
        survivors.set(p.id, p);
      }
    }
    if (redirects.length) {
      for (const p of await store.getProducts(redirects)) {
        if (p.status !== 'merged') survivors.set(p.id, p);
      }
    }
    for (const p of survivors.values()) {
      const { score, vetoed, admission } = scoreCandidate(
        read, p, { incumbentId, tuning, admissionRead, admissionCache },
      );
      if (vetoed) continue;
      considered += 1;
      // Carry the winning ROW, not just its id: the attach path (apply.js) needs
      // the product to teach it and would otherwise re-fetch it (a second
      // getProducts per attach) — we already have it here.
      if (!best || score > best.score) best = { productId: p.id, score, product: p, admission };
    }
  }

  // DECIDE (§3): create-on-doubt below tReview (P1).
  if (!best || best.score < tuning.tReview) {
    return { outcome: 'create', verdict: 'minted', band: MATCH_BAND.CREATED, read, considered };
  }
  if (best.score >= tuning.tAttach) {
    // Size-unknown demotion (2026-07-21): auto-attach demands the size
    // relation be CONFIRMED — both sides sized and equal (conflicts already
    // vetoed) or both nosize (no size evidence exists anywhere). When exactly
    // one side carries a size, the tile may be a different pack of the same
    // line (4×1L vs 12×1L collapsed through an unparsable/dual-size string):
    // attach for serving, but in the review band — no teaching, sampled
    // review heals it. Both-nosize stays auto or nosize categories freeze.
    const p = best.product;
    const productSized = p.size_unit != null && p.size_total != null;
    if (!!read.size !== productSized || best.admission?.semanticOnly) {
      return {
        outcome: 'review', verdict: 'minted', band: MATCH_BAND.REVIEW,
        productId: best.productId, product: best.product, score: best.score, read, considered,
      };
    }
    return {
      outcome: 'attach', verdict: 'minted', band: MATCH_BAND.AUTO,
      productId: best.productId, product: best.product, score: best.score, read, considered,
    };
  }
  return {
    outcome: 'review', verdict: 'minted', band: MATCH_BAND.REVIEW,
    productId: best.productId, product: best.product, score: best.score, read, considered,
  };
}

// Convenience composition for the current source: vision-enriched flyer
// offers. All vision/OCR specifics live in readFromOffer; the core above
// stays source-agnostic.
export async function resolveOffer(offer, enrichment, store, opts = {}) {
  const r = readFromOffer(offer, enrichment);
  if (!r.ok) return { outcome: 'defer', verdict: r.verdict };
  return resolveRead(
    r.read,
    {
      offerId: offer.id,
      store: offer.store,
      region: offer.region,
      textKey: offer.search_text || '',
    },
    store,
    opts,
  );
}
