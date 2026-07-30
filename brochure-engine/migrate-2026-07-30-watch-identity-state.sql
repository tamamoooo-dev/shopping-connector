-- Watch identity state machine and monitoring-health separation.
-- Additive and backward-compatible with the 2026-07-29 product-anchor schema.
--
-- npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-30-watch-identity-state.sql

ALTER TABLE watches ADD COLUMN anchor_state TEXT;
ALTER TABLE watches ADD COLUMN source_snapshot TEXT;
ALTER TABLE watches ADD COLUMN anchor_provenance TEXT;
ALTER TABLE watches ADD COLUMN anchor_confidence REAL;
ALTER TABLE watches ADD COLUMN anchor_margin REAL;
ALTER TABLE watches ADD COLUMN anchor_policy_version TEXT;
ALTER TABLE watches ADD COLUMN candidate_snapshot TEXT;
ALTER TABLE watches ADD COLUMN resolution_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watches ADD COLUMN last_resolution_attempt_at TEXT;
ALTER TABLE watches ADD COLUMN identity_resolution_reason TEXT;
ALTER TABLE watches ADD COLUMN monitoring_health TEXT;
ALTER TABLE watches ADD COLUMN monitoring_health_reason TEXT;

-- Preserve every established Registry/spec anchor. Amazon ASINs are trusted
-- identities inside Amazon scope. All remaining unresolved legacy outcomes
-- re-enter background resolution instead of exposing old Registry abstentions.
UPDATE watches
   SET anchor_state = CASE
         WHEN active = 0 THEN 'inactive'
         WHEN registry_product_id IS NOT NULL THEN 'anchored_registry'
         WHEN spec IS NOT NULL THEN 'anchored_spec'
         WHEN lower(provider) = 'amazon'
          AND length(product_id) = 10
          AND upper(substr(product_id, 1, 1)) = 'B' THEN 'anchored_source'
         ELSE 'resolving'
       END,
       anchor_policy_version = 'watch-identity-v3-2026-07-30',
       anchor_provenance = CASE
         WHEN registry_product_id IS NOT NULL
           THEN '{"kind":"migration-preserved-registry"}'
         WHEN spec IS NOT NULL
           THEN '{"kind":"migration-preserved-spec"}'
         WHEN lower(provider) = 'amazon'
          AND length(product_id) = 10
          AND upper(substr(product_id, 1, 1)) = 'B'
           THEN '{"kind":"trusted-source-migration","provider":"amazon"}'
         ELSE '{"kind":"identity-v3-backfill-pending"}'
       END,
       anchor_confidence = CASE
         WHEN registry_product_id IS NOT NULL OR spec IS NOT NULL THEN 1.0
         WHEN lower(provider) = 'amazon'
          AND length(product_id) = 10
          AND upper(substr(product_id, 1, 1)) = 'B' THEN 1.0
         ELSE NULL
       END,
       anchor_margin = CASE
         WHEN registry_product_id IS NOT NULL OR spec IS NOT NULL THEN 1.0
         WHEN lower(provider) = 'amazon'
          AND length(product_id) = 10
          AND upper(substr(product_id, 1, 1)) = 'B' THEN 1.0
         ELSE NULL
       END,
       candidate_snapshot = NULL,
       identity_resolution_reason = CASE
         WHEN registry_product_id IS NOT NULL THEN 'Existing Registry anchor preserved.'
         WHEN spec IS NOT NULL THEN 'Existing specification anchor preserved.'
         WHEN lower(provider) = 'amazon'
          AND length(product_id) = 10
          AND upper(substr(product_id, 1, 1)) = 'B'
           THEN 'Trusted Amazon source identity.'
         ELSE 'Awaiting watch identity v3 backfill.'
       END,
       monitoring_health = CASE
         WHEN registry_product_id IS NULL AND spec IS NULL
          AND NOT (
            lower(provider) = 'amazon'
            AND length(product_id) = 10
            AND upper(substr(product_id, 1, 1)) = 'B'
          ) THEN NULL
         WHEN last_resolution = 'ok' THEN 'ok'
         WHEN last_resolution = 'not-found' THEN 'not_found'
         WHEN last_resolution = 'no-price' THEN 'no_price'
         WHEN last_resolution = 'provider-error' THEN 'provider_error'
         WHEN last_resolution = 'unresolvable' THEN 'anchor_unavailable'
         ELSE 'unchecked'
       END,
       monitoring_health_reason = CASE
         WHEN registry_product_id IS NOT NULL OR spec IS NOT NULL
          OR (
            lower(provider) = 'amazon'
            AND length(product_id) = 10
            AND upper(substr(product_id, 1, 1)) = 'B'
          ) THEN last_resolution_reason
         ELSE NULL
       END,
       last_resolution = CASE
         WHEN registry_product_id IS NOT NULL OR spec IS NOT NULL
          OR (
            lower(provider) = 'amazon'
            AND length(product_id) = 10
            AND upper(substr(product_id, 1, 1)) = 'B'
          ) THEN last_resolution
         ELSE 'pending-migration'
       END,
       last_resolution_reason = CASE
         WHEN registry_product_id IS NOT NULL OR spec IS NOT NULL
          OR (
            lower(provider) = 'amazon'
            AND length(product_id) = 10
            AND upper(substr(product_id, 1, 1)) = 'B'
          ) THEN last_resolution_reason
         ELSE 'Awaiting watch identity v3 backfill.'
       END
 WHERE anchor_state IS NULL;

CREATE INDEX IF NOT EXISTS ix_watches_anchor_state ON watches(anchor_state, active);
