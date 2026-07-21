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

// Brand relation (§4.2, P2): evidence, never a requirement. Compatible when
// either normalized text contains the other ("sebamed" vs "sebamed baby" —
// granularity wobble is not a conflict); a true conflict scores NEGATIVE but
// never vetoes (requiring brand agreement measured −4.4 points, §7.3 L4).
export function brandRelation(readBrand, productBrand) {
  if (!readBrand || !productBrand) return null; // undeterminable
  if (readBrand === productBrand) return 1;
  if (readBrand.includes(productBrand) || productBrand.includes(readBrand)) return 1;
  return -1;
}

// Score one candidate product against a read (§4.2). Pure. Returns
// { score, vetoed } — vetoed candidates never attach regardless of score.
export function scoreCandidate(read, product, { incumbentId = null, tuning = TUNING } = {}) {
  const W = tuning.weights;
  // Kind gate (§6): assortments match only assortments; a specific-flavor
  // read never attaches to one.
  if ((product.kind || 'product') !== read.kind) return { score: 0, vetoed: true };

  const productSize = product.size_unit != null && product.size_total != null
    ? { unit: product.size_unit, each: product.size_total, pack: product.size_pack || 1 }
    : null;
  if (sizeConflicts(read.size, productSize, tuning)) return { score: 0, vetoed: true };

  // P4: token containment of the read in the ACCUMULATED profile — the
  // workhorse (+22.5 points, 0% false matches at ≥ 0.6).
  const profile = decodeProfile(product.token_profile);
  let hit = 0;
  for (const t of read.tokens) if (profile[t]) hit += 1;
  const containment = read.tokens.length ? hit / read.tokens.length : 0;

  // Weighted evidence over the DETERMINABLE signals only: missing evidence is
  // neutral (excluded from the denominator), never a penalty — P3's "nosize
  // is compatible" generalized to every signal.
  let num = W.containment * containment;
  let den = W.containment;
  if (read.size && productSize) { // conflict already vetoed -> equal here
    num += W.size;
    den += W.size;
  }
  const brand = brandRelation(read.brandText, product.brand_text || null);
  if (brand != null) {
    num += W.brand * brand; // -1 on conflict: negative, never veto (P2)
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
  return { score: Math.max(0, score), vetoed: false };
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
export async function resolveRead(read, ctx, store, { tuning = TUNING, productCount: pcHint } = {}) {
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
      const { score, vetoed } = scoreCandidate(read, p, { incumbentId, tuning });
      if (vetoed) continue;
      considered += 1;
      // Carry the winning ROW, not just its id: the attach path (apply.js) needs
      // the product to teach it and would otherwise re-fetch it (a second
      // getProducts per attach) — we already have it here.
      if (!best || score > best.score) best = { productId: p.id, score, product: p };
    }
  }

  // DECIDE (§3): create-on-doubt below tReview (P1).
  if (!best || best.score < tuning.tReview) {
    return { outcome: 'create', verdict: 'minted', band: MATCH_BAND.CREATED, read, considered };
  }
  if (best.score >= tuning.tAttach) {
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
