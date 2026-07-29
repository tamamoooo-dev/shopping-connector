// identity/verify.js — "is this observation THAT product?"
//
// A watch does not ask the resolver's question. Resolution asks "WHICH product
// is this?" and must search the whole registry to answer; verification asks
// "is this MY product?" against one already-known product, and the answer is a
// single pure comparison. That difference is the entire reason a watch check
// costs one D1 read instead of a registry lookup per candidate:
//
//   resolution   blocking index -> N candidates -> score each -> decide
//   verification                    ONE product -> score       -> threshold
//
// Both use the SAME scoring function (registry/resolver.js scoreCandidate), so
// there is no second matcher and no second set of thresholds. Everything that
// makes the resolver trustworthy — the size veto, the brand-conflict veto, the
// dimension-conflict vetoes, and above all "missing evidence is neutral, never
// a penalty" — applies here unchanged. That last property is precisely what
// the deleted watch matcher got backwards.
//
// PURE except `productForWatch`, which reads the registry to follow merges.

import { brandRelation, scoreCandidate, sizeConflicts, TUNING } from '../registry/resolver.js';
import { readFromIdentityCandidate } from '../registry/candidate.js';
import { listingIdentityCandidate } from './listingCandidate.js';

// The bar for "this listing IS that product". Deliberately the SAME constant
// the registry uses to assert an identity (tAttach): a watch may not act on
// weaker evidence than the platform would accept for an assignment. It is one
// named constant so the whole subsystem has exactly one place to tune.
export const VERIFY_THRESHOLD = TUNING.tAttach;

// Why a candidate did not verify. Every rejection carries one of these — a
// watch check may never discard a candidate silently, because a silent
// discard is indistinguishable from "the product is simply not on offer".
export const VERIFY_REASON = Object.freeze({
  NO_NAME: 'listing-has-no-name',
  INSUFFICIENT: 'listing-identity-too-thin',
  CONFLICT: 'attribute-conflict',
  BELOW: 'below-identity-threshold',
});

// Project a listing into a resolver read, or explain why it cannot be.
export function listingRead(listing) {
  const candidate = listingIdentityCandidate(listing);
  if (!candidate) return { ok: false, reason: VERIFY_REASON.NO_NAME, candidate: null };
  const projected = readFromIdentityCandidate(candidate);
  if (!projected.ok) {
    return { ok: false, reason: VERIFY_REASON.INSUFFICIENT, candidate, verdict: projected.verdict };
  }
  return { ok: true, read: projected.read, candidate };
}

// Which of scoreCandidate's non-admission vetoes fired. Mirrors its order so
// the name always matches the reason the score was actually zeroed.
function namedVeto(read, product, tuning) {
  if ((product.kind || 'product') !== read.kind) return 'kind-conflict';
  const productSize = product.size_unit != null && product.size_total != null
    ? { unit: product.size_unit, each: product.size_total, pack: product.size_pack || 1 }
    : null;
  if (sizeConflicts(read.size, productSize, tuning)) return 'size-conflict';
  if (brandRelation(read.brandText, product.brand_text || null) === -1) return 'brand-conflict';
  return VERIFY_REASON.CONFLICT;
}

// Is `listing` the product in `product`? Returns
//   { matched, score, reason }
// `reason` is null on a match and always populated on a rejection.
export function verifyListing(listing, product, { threshold = VERIFY_THRESHOLD, tuning = TUNING } = {}) {
  if (!product) return { matched: false, score: 0, reason: 'no-product' };
  const projected = listingRead(listing);
  if (!projected.ok) return { matched: false, score: 0, reason: projected.reason };

  const { score, vetoed, admission } = scoreCandidate(projected.read, product, { tuning });
  if (vetoed) {
    return {
      matched: false,
      score: 0,
      // The admission reason ("cut-conflict", "family-conflict",
      // "variety-not-evidenced") is far more useful than a bare "no match".
      // scoreCandidate's OTHER vetoes — size, brand, kind — return no admission
      // at all, so name them here rather than reporting the useless generic:
      // "attribute-conflict" is exactly the vague answer this redesign exists
      // to stop giving.
      reason: admission?.reason || namedVeto(projected.read, product, tuning),
    };
  }
  if (score < threshold) {
    return { matched: false, score, reason: VERIFY_REASON.BELOW };
  }
  return { matched: true, score, reason: null };
}

// The product a watch is bound to, following the merge chain. A registry id is
// stable identity, but a MERGE relocates that identity, so a watch re-anchors
// on the survivor exactly as the registry's own consumers do. Bounded and
// cycle-safe; returns the living product plus the id actually landed on so the
// caller can persist the hop.
export async function productForWatch(registryStore, productId, { maxHops = 8 } = {}) {
  if (!registryStore || !productId) return { product: null, productId, moved: false };
  let id = productId;
  let [product] = await registryStore.getProducts([id]);
  if (!product) return { product: null, productId: id, moved: false };
  const walked = new Set([id]);
  while (product.status === 'merged' && product.merged_into && walked.size < maxHops) {
    if (walked.has(product.merged_into)) break;
    id = product.merged_into;
    walked.add(id);
    const [next] = await registryStore.getProducts([id]);
    if (!next) break;
    product = next;
  }
  return { product, productId: id, moved: id !== productId };
}
