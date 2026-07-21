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

import { readFromOffer } from './read.js';
import { servable } from '../offers/enrich.js';
import { newProductRow, profileTokens, decodeProfile } from './model.js';

export async function applyReviewAction(ctx, { action, productId, offerId, toProductId }) {
  const store = ctx.registryStore;
  let report;

  if (action === 'clear_flag') {
    if (!productId) return { error: "clear_flag needs 'productId'." };
    const done = await store.clearFlag(productId);
    report = done ? { action, productId, done: true } : { error: 'Product not found.' };
  } else if (action === 'reassign') {
    if (!offerId || !toProductId) return { error: "reassign needs 'offerId' and 'toProductId'." };
    const done = await store.reassignSighting(offerId, toProductId);
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

// Re-derive the sighting's read from its own enrichment row and found a new
// product with it — the §5.4 split primitive. The offer row may already be
// pruned; everything the read needs (names, brand, size, corroboration) lives
// on the enrichment, and the observation context (store/region/week/price)
// lives on the sighting itself (§1.3 denormalization pays off here).
async function splitSighting(ctx, offerId) {
  const store = ctx.registryStore;
  const sighting = await store.getSighting(offerId);
  if (!sighting) return { error: 'Sighting not found.' };
  if (!ctx.enrichStore) return { error: 'Enrichment store unavailable.' };
  const enr = (await ctx.enrichStore.getForIds([offerId])).get(offerId);
  if (!enr || !servable(enr)) {
    return { error: 'Enrichment no longer available for this offer — use reassign instead.' };
  }
  const r = readFromOffer(
    { id: offerId, store: sighting.store, region: sighting.region, category: null, search_text: '' },
    enr,
  );
  if (!r.ok) return { error: `Read no longer mints (${r.verdict}) — use reassign instead.` };

  const product = newProductRow({
    tokens: r.read.tokens,
    week: sighting.week,
    date: sighting.week,
    store: sighting.store,
    kind: r.read.kind,
    displayName: enr.name ?? null,
    displayNameAr: enr.name_ar ?? null,
    displayCorroboration: r.read.corroboration,
    brandText: r.read.brandText,
    sizeUnit: r.read.size?.unit ?? null,
    sizeTotal: r.read.size?.each ?? null,
    sizePack: r.read.size?.pack ?? null,
    family: r.read.family,
    category: r.read.category,
  });
  await store.createProduct(product, profileTokens(decodeProfile(product.token_profile)));
  const moved = await store.reassignSighting(offerId, product.id);
  if (!moved) return { error: 'Sighting vanished mid-split.' };
  return { action: 'split', offerId, productId: product.id, done: true };
}
