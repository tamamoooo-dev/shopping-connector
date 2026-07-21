// registry/model.js — the Product Registry DATA MODEL (REGISTRY-DESIGN.md §1).
//
// Identity by ASSIGNMENT, not derivation: a product is an opaque registry row
// minted once; every later sighting matches INTO it with tolerance (§0). This
// module owns the row shapes and their invariants — constants, id minting,
// token-profile (de)serialization, and the constructors that turn a resolved
// read into `products` / `product_sightings` rows. It holds NO matching logic
// (resolver, Phase 2) and NO storage (registryStore, Phase 2): pure data,
// Workers- and Node-compatible, dependency-free.
//
// Tables (schema.sql, migrate-2026-07-registry.sql):
//   products          §1.1 — the registry; token_profile IS the identity evidence
//   product_tokens    §1.2 — inverted index for candidate blocking
//   product_sightings §1.3 — "this offer was this product, this week, at this price"

// Resolver generation stamp (§1.1 `algo_version`, §6 "algo_version stamps
// enable re-resolution of a poisoned window"). Bump on any resolver rule
// change, exactly like IDENTITY-V2 §9 versioning.
export const REGISTRY_ALGO_VERSION = 1;

// §5.1 lifecycle: created → active ⇄ dormant → (merged).
export const PRODUCT_STATUS = Object.freeze({
  ACTIVE: 'active',
  MERGED: 'merged',
  DORMANT: 'dormant',
});

// §1.1 `kind` — IDENTITY-V2 §3 gate 2 carries over: assortment products match
// only assortment reads; a specific-flavor read never attaches to one (§6).
export const PRODUCT_KIND = Object.freeze({
  PRODUCT: 'product',
  ASSORTMENT: 'assortment',
});

// §1.3 / §3 match bands. `auto` teaches the profile; `review` attaches but
// does NOT teach; `created` minted a new product from this read.
export const MATCH_BAND = Object.freeze({
  AUTO: 'auto',
  REVIEW: 'review',
  CREATED: 'created',
});

// §5.1: dormant after N (=6) weeks unseen — excluded from current-facing
// views, retained forever for history.
export const DORMANT_AFTER_WEEKS = 6;

// §5.2: profile capped at ~24 tokens (unbounded profiles drift toward
// matching everything). The cap is enforced by the Phase 3 update rule; the
// constant lives here because it is a property of the model, not the updater.
export const PROFILE_TOKEN_CAP = 24;

// §1.1: opaque id, minted once, NEVER derived from content. Same minting
// idiom as the engine's other opaque ids (monitor.js).
export function mintProductId() {
  return `pr_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// --- token profile ------------------------------------------------------------
// §1.1: `token_profile` is JSON `token -> { count, week }` (seen_count /
// last_seen_week). Stored as TEXT; consumed as a plain object. Decoding is
// defensive: a corrupt blob degrades to an empty profile (the product then
// re-learns) rather than throwing inside a drain.

export function decodeProfile(text) {
  let raw;
  try {
    raw = JSON.parse(text || '{}');
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const profile = {};
  for (const [token, v] of Object.entries(raw)) {
    if (!token || !v || typeof v !== 'object') continue;
    const count = Number(v.count);
    if (!Number.isFinite(count) || count < 1) continue;
    profile[token] = { count: Math.floor(count), week: typeof v.week === 'string' ? v.week : null };
  }
  return profile;
}

export function encodeProfile(profile) {
  return JSON.stringify(profile && typeof profile === 'object' ? profile : {});
}

// §3 CREATE outcome: "profile = this read" — every token of the founding read,
// seen once, stamped with the founding week.
export function profileFromRead(tokens, week) {
  const profile = {};
  for (const t of tokens || []) {
    if (typeof t === 'string' && t) profile[t] = { count: 1, week: week ?? null };
  }
  return profile;
}

// The tokens a profile contributes to the inverted index (§1.2): one
// product_tokens row per profile token.
export function profileTokens(profile) {
  return Object.keys(profile || {});
}

// --- row constructors ---------------------------------------------------------
// Constructors produce COMPLETE row objects (snake_case, column-per-key) so
// the store layer binds them positionally without reconstruction, mirroring
// how enrichStore rows are shaped.

// §1.1 + §3 CREATE: a new product founded by a single resolved read. The read
// supplies presentation fields and evidence; the caller (resolver, Phase 2)
// supplies normalized tokens.
export function newProductRow({
  tokens,
  week,
  date,
  store,
  kind = PRODUCT_KIND.PRODUCT,
  displayName = null,
  displayNameAr = null,
  displayCorroboration = null,
  brandSlug = null,
  brandText = null,
  sizeUnit = null,
  sizeTotal = null,
  sizePack = null,
  family = null,
  category = null,
}) {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    throw new Error('newProductRow: tokens are required (P5: a product needs evidence)');
  }
  if (!date) throw new Error('newProductRow: date is required');
  if (!Object.values(PRODUCT_KIND).includes(kind)) {
    throw new Error(`newProductRow: unknown kind "${kind}"`);
  }
  return {
    id: mintProductId(),
    status: PRODUCT_STATUS.ACTIVE,
    merged_into: null,
    kind,
    display_name: displayName,
    display_name_ar: displayNameAr,
    // §5.3 provenance: the founding read is the current display pick.
    display_corroboration: displayName || displayNameAr ? displayCorroboration : null,
    display_week: displayName || displayNameAr ? week ?? null : null,
    brand_slug: brandSlug,
    brand_text: brandText,
    size_unit: sizeUnit,
    size_total: sizeTotal,
    size_pack: sizePack,
    family,
    category,
    token_profile: encodeProfile(profileFromRead(tokens, week)),
    sightings: 1,
    stores_seen: JSON.stringify(store ? [store] : []),
    first_seen: date,
    last_seen: date,
    review_flag: null,
    algo_version: REGISTRY_ALGO_VERSION,
  };
}

// §1.3: the atomic fact. offer_id is the PK — resolution is idempotent per
// offer by construction; re-runs are no-ops (§6).
export function newSightingRow({
  offerId,
  productId,
  band,
  score = null,
  corroboration = null,
  store,
  region,
  week,
  price,
  oldPrice = null,
  resolvedAt = new Date().toISOString(),
}) {
  if (!offerId || !productId) throw new Error('newSightingRow: offerId and productId are required');
  if (!Object.values(MATCH_BAND).includes(band)) {
    throw new Error(`newSightingRow: unknown band "${band}"`);
  }
  if (!store || !region || !week) throw new Error('newSightingRow: store, region, week are required');
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('newSightingRow: price must be a finite positive number');
  }
  return {
    offer_id: offerId,
    product_id: productId,
    match_band: band,
    match_score: score,
    corroboration,
    store,
    region,
    week,
    price,
    // Raw observation, same gate as offers.old_price: a strike-through price
    // only counts when it is a real one (finite, above the offer price).
    old_price: Number.isFinite(oldPrice) && oldPrice > price ? oldPrice : null,
    algo_version: REGISTRY_ALGO_VERSION,
    resolved_at: resolvedAt,
  };
}
