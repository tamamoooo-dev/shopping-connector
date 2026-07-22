// registry/review.js — the HUMAN side of the §5.4 asymmetry: merges are
// automated (lifecycle.js); splits and suspicion-clearing are human-gated,
// through exactly three bounded actions (REGISTRY-DESIGN §9 trade-off 3 —
// sampled review, never a standing manual duty):
//
//   clear_flag — the flagged suspicion was benign; the product resumes
//                learning (flags block nothing, but a cleared flag is the
//                recorded human verdict).
//   reassign   — move ONE sighting to the right existing product. The moved
//                sighting lands in the `review` band: attached, never
//                teaching — a human fix must not poison a profile either
//                (§3's containment applies to people too).
//   split      — the split repair: re-mint a NEW product from the sighting's
//                OWN enrichment read (the evidence it always carried) and
//                move the sighting onto it. Possible only while the
//                enrichment row lives; after pruning, reassign is the tool.
//
// Every action writes one ops-audit row — the same reversibility trail as
// merges (§5.4 "logged").

import { candidateDisplayName, readFromIdentityCandidate } from './candidate.js';
import {
  MATCH_BAND, newProductRow, newSightingRow, profileTokens, decodeProfile,
} from './model.js';

export async function applyReviewAction(ctx, { action, productId, offerId, toProductId }) {
  const store = ctx.registryStore;
  let report;

  if (action === 'clear_flag') {
    if (!productId) return { error: "clear_flag needs 'productId'." };
    const done = await store.clearFlag(productId);
    report = done ? { action, productId, done: true } : { error: 'Product not found.' };
  } else if (action === 'reassign') {
    if (!offerId || !toProductId) return { error: "reassign needs 'offerId' and 'toProductId'." };
    let done = await store.reassignSighting(offerId, toProductId);
    if (!done) done = await assignPendingReview(ctx, offerId, toProductId);
    report = done
      ? { action, offerId, toProductId, done: true }
      : { error: 'Sighting or target product not found.' };
  } else if (action === 'split') {
    if (!offerId) return { error: "split needs 'offerId'." };
    report = await splitSighting(ctx, offerId);
  } else {
    return { error: "action must be 'clear_flag', 'reassign' or 'split'." };
  }

  if (!report.error && ctx.opsStore) {
    await ctx.opsStore
      .record({
        ts: new Date().toISOString(),
        action: 'registry:review',
        origin: 'ops',
        ok: true,
        detail: report,
      })
      .catch(() => {});
  }
  return report;
}

// Promote an isolated pending decision into the existing human-review band.
// This is deliberately NOT an auto/created sighting: downstream consumers do
// not trust it and the target profile learns nothing from it.
async function assignPendingReview(ctx, offerId, toProductId) {
  if (!ctx.enrichStore?.getPendingReview) return false;
  const pending = await ctx.enrichStore.getPendingReview(offerId);
  if (!pending) return false;
  const target = (await ctx.registryStore.getProducts([toProductId]))[0];
  if (!target || target.status === 'merged') return false;
  const result = await ctx.registryStore.insertSighting(newSightingRow({
    offerId,
    productId: toProductId,
    band: MATCH_BAND.REVIEW,
    store: pending.store,
    region: pending.region,
    week: pending.week,
    price: pending.price,
    oldPrice: pending.old_price,
  }));
  return result?.inserted === true;
}

// Build the split product only from its persisted Identity Candidate.
// product with it — the §5.4 split primitive. The offer row may already be
// pruned; all identity evidence lives in the candidate, while sighting context
// lives on the sighting itself (§1.3 denormalization pays off here).
async function splitSighting(ctx, offerId) {
  const store = ctx.registryStore;
  const sighting = await store.getSighting(offerId);
  if (!ctx.enrichStore) return { error: 'Enrichment store unavailable.' };
  const pending = sighting ? null : await ctx.enrichStore.getPendingReview?.(offerId);
  if (!sighting && !pending) return { error: 'Sighting or pending Review item not found.' };
  const enr = (await ctx.enrichStore.getForIds([offerId])).get(offerId) || pending;
  if (!enr) {
    return { error: 'Enrichment no longer available for this offer — use reassign instead.' };
  }
  const r = readFromIdentityCandidate(enr.identity_candidate, {
    version: enr.identity_candidate_version,
  });
  if (!r.ok) return { error: `Read no longer mints (${r.verdict}) — use reassign instead.` };

  const product = newProductRow({
    tokens: r.read.tokens,
    week: sighting?.week || pending.week,
    date: sighting?.week || pending.week,
    store: sighting?.store || pending.store,
    kind: r.read.kind,
    displayName: candidateDisplayName(r.candidate),
    displayNameAr: null,
    displayCorroboration: r.read.corroboration,
    brandText: r.read.brandText,
    sizeUnit: r.read.size?.unit ?? null,
    sizeTotal: r.read.size?.each ?? null,
    sizePack: r.read.size?.pack ?? null,
    family: r.read.family,
    category: r.read.category,
  });
  await store.createProduct(product, profileTokens(decodeProfile(product.token_profile)));
  const moved = sighting
    ? await store.reassignSighting(offerId, product.id)
    : (await store.insertSighting(newSightingRow({
        offerId,
        productId: product.id,
        band: MATCH_BAND.REVIEW,
        store: pending.store,
        region: pending.region,
        week: pending.week,
        price: pending.price,
        oldPrice: pending.old_price,
      })))?.inserted === true;
  if (!moved) return { error: 'Review item vanished mid-split.' };
  return { action: 'split', offerId, productId: product.id, done: true };
}
