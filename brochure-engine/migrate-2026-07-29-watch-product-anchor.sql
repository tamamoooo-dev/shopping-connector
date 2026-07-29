-- migrate-2026-07-29-watch-product-anchor.sql
--
-- A watch is anchored to a REGISTRY PRODUCT (`pr_`), not to derived attributes
-- and not to a retailer catalog id. Identity is resolved ONCE, in the
-- foreground, when the watch is created; every later check only asks "is this
-- listing that product?" through the shared resolver (identity/verify.js).
--
-- Purely additive. Existing rows keep every column they have; the engine
-- resolves a legacy watch's product on first check and writes it back here.
--
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-29-watch-product-anchor.sql
--
-- NOTE ON migrate-2026-07-28-watch-identity-anchor.sql: that migration was
-- never applied and is superseded by this one. Its columns (identity_key,
-- catalog_checked_at, catalog_rebinds) belong to the attribute-tuple design
-- this change replaces. Applying it is harmless but unnecessary.

-- THE ANCHOR. A registry product id. Stable across retailer renames, catalog-id
-- rotation, wording drift and language, because it is an ASSIGNED identity
-- rather than a key derived from whatever text a store published today.
ALTER TABLE watches ADD COLUMN registry_product_id TEXT;

-- THE OTHER ANCHOR. A Flexible Watch is anchored to a CLASS rather than an
-- instance: a JSON object of pinned identity dimensions ({"family":"chicken",
-- "cut":"breast"} = any chicken breast, any brand, any size, per kg). Keys
-- present are pinned, keys absent are free. Exactly one of registry_product_id
-- / spec is set on a resolved watch.
ALTER TABLE watches ADD COLUMN spec TEXT;

-- What the watch covers: 'store' = this one retailer, 'market' = every
-- supported store plus the current flyer offers. This replaces `kind` as the
-- behavioural switch — kind used to select a whole RESOLUTION STRATEGY, and
-- there is now only one of those, so all that is left to vary is breadth.
ALTER TABLE watches ADD COLUMN scope TEXT;

-- OBSERVABILITY: the outcome of the last check, always written.
--   'ok'             a price was read for the watched product
--   'not-found'      the product was not among the candidates
--   'no-price'       found, but no usable price
--   'not-resolved'   the watch has no product anchor yet (legacy / ambiguous)
--   'provider-error' the store did not answer
-- The reason column carries the resolver's own words ("cut-conflict",
-- "below-identity-threshold", …) so a quiet watch can always be explained.
-- Before this, a watch that had silently stopped resolving was indistinguishable
-- from one that was simply above target: both rendered as "Still watching…".
ALTER TABLE watches ADD COLUMN last_resolution TEXT;
ALTER TABLE watches ADD COLUMN last_resolution_reason TEXT;

-- When the watch last actually resolved to a price. `checked_at` records that a
-- check RAN; this records that it SUCCEEDED. Keeping them apart is what makes
-- "checked daily, found nothing for nine days" a visible state.
ALTER TABLE watches ADD COLUMN resolved_at TEXT;

-- Backfill what is already known, so no existing watch starts out worse off.
-- A registry watch's product_id IS a pr_ anchor already.
UPDATE watches SET registry_product_id = product_id
 WHERE kind = 'registry' AND product_id LIKE 'pr_%' AND registry_product_id IS NULL;

-- Scope follows the old kind: a product watch was one retailer, everything else
-- swept the market.
UPDATE watches SET scope = CASE WHEN kind = 'product' THEN 'store' ELSE 'market' END
 WHERE scope IS NULL;

-- THE NO-AMBIGUITY INVARIANT. Every watch that does not come out of this
-- migration already anchored is stamped with an EXPLICIT waiting state, so
-- there is no instant at which a row means "we don't know". A watch is
-- unanchored for exactly one of three declared reasons, never by omission:
--
--   pending-migration   the one-time backfill has not run yet (transient)
--   needs-confirmation  the resolver could not decide alone; the user picks
--   unresolvable        nothing can bind it; the reason names the cause
--
-- The backfill (POST /watches/resolve-legacy) moves each row out of
-- 'pending-migration' into an anchor or into one of the other two states.
-- Until then, a check on an unanchored watch reads its price nowhere and
-- alerts never — it reports this state and stops.
UPDATE watches
   SET last_resolution = 'pending-migration',
       last_resolution_reason = 'Awaiting the one-time product-anchor backfill.'
 WHERE registry_product_id IS NULL
   AND spec IS NULL
   AND last_resolution IS NULL;

-- The invariant, assertable at any time. This MUST return zero rows:
--   SELECT COUNT(*) FROM watches
--    WHERE registry_product_id IS NULL AND spec IS NULL AND last_resolution IS NULL;

-- "Who else watches this product?", and the sweep that re-points watches when a
-- registry merge relocates an identity.
CREATE INDEX IF NOT EXISTS ix_watches_registry_product ON watches(registry_product_id);
