// registry/apply.js — APPLY one resolver decision: the only place registry
// writes happen (REGISTRY-DESIGN.md §3 workflow arrows, §5 update rules, §1.3
// idempotency). resolveRead decides, learn.js computes, this module sequences
// the writes:
//
//   defer  -> nothing (no sighting, no product — today's identity-null shape)
//   create -> sighting (band created) + a new product founded by this read
//   attach -> sighting (band auto) + the product LEARNS (§5.2–§5.3)
//   review -> no sighting; the enrichment verdict journal is the pending queue
//             until guarded human reassign/split creates an untrusted review band
//
// IDEMPOTENCY (§1.3/§6): product_sightings' offer_id PK is the gate. The
// sighting is always written FIRST with an insert-if-absent; when it reports
// "already there", every other write is skipped — a re-run of the same offer
// is a complete no-op (no duplicate product, no double-taught profile).
// Crash containment: if the process dies between the sighting insert and the
// product write, the worst leftover is a created-band sighting whose product
// row is missing — the next §5.4 consolidation notices dangling sightings;
// no path can double-create or double-teach.
//
// Source-agnostic like the resolver: `observation` carries only presentation
// and sighting context projected from the Identity Candidate.

import {
  newProductRow, newSightingRow, MATCH_BAND, profileTokens, decodeProfile,
} from './model.js';
import { learnFromSighting, LEARN_TUNING } from './learn.js';

// Apply `decision` (from resolveRead/resolveOffer) for the observation it was
// decided on. Returns { applied, productId?, inserted } — `inserted: false`
// means the offer already had a sighting and nothing changed.
export async function applyDecision(decision, observation, store, { tuning = LEARN_TUNING } = {}) {
  if (decision.outcome === 'defer') {
    return { applied: 'defer', verdict: decision.verdict, inserted: false };
  }
  // Review is deliberately non-assigning. A proposed match may be useful to a
  // developer/operator, but it must never create a trusted offer -> Product ID
  // edge or appear in downstream product history before confirmation.
  if (decision.outcome === 'review') {
    return {
      applied: 'review',
      proposedProductId: decision.productId ?? null,
      inserted: false,
    };
  }
  const read = decision.read;

  if (decision.outcome === 'create') {
    const product = newProductRow({
      tokens: read.tokens,
      week: observation.week,
      date: observation.week,
      store: observation.store,
      kind: read.kind,
      displayName: observation.name ?? null,
      displayNameAr: observation.nameAr ?? null,
      displayCorroboration: read.corroboration,
      brandText: read.brandText,
      sizeUnit: read.size?.unit ?? null,
      sizeTotal: read.size?.each ?? null,
      sizePack: read.size?.pack ?? null,
      family: read.family,
      category: read.category,
    });
    const { inserted } = await store.insertSighting(
      sightingFor(decision, observation, product.id),
    );
    if (!inserted) return { applied: 'noop', inserted: false }; // re-run
    await store.createProduct(product, profileTokens(decodeProfile(product.token_profile)));
    return { applied: 'create', productId: product.id, inserted: true };
  }

  // Known Product: bind the sighting to the trusted Registry product.
  const { inserted } = await store.insertSighting(
    sightingFor(decision, observation, decision.productId),
  );
  if (!inserted) return { applied: 'noop', inserted: false }; // re-run

  if (decision.band === MATCH_BAND.AUTO) {
    // §5: only the auto band teaches. Read-modify-write is safe: the drain is
    // the single writer (§2 — children run sequentially). Reuse the product row
    // the resolver already fetched (decision.product) instead of a second
    // getProducts; fall back to a fetch only if a caller didn't carry it.
    const product = decision.product || (await store.getProducts([decision.productId]))[0];
    if (product) {
      const { fields, tokens } = learnFromSighting(product, read, observation, tuning);
      await store.updateProduct(product.id, fields, tokens);
    }
  }
  return {
    applied: decision.outcome,
    productId: decision.productId,
    inserted: true,
  };
}

function sightingFor(decision, observation, productId) {
  return newSightingRow({
    offerId: observation.offerId,
    productId,
    band: decision.band,
    score: decision.score ?? null,
    corroboration: decision.read.corroboration,
    store: observation.store,
    region: observation.region,
    week: observation.week,
    price: observation.price,
    oldPrice: observation.oldPrice ?? null,
  });
}
