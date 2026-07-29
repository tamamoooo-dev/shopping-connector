-- Strong local-navigation linkage for structured offers.
--
-- Rollout order:
--   1. apply this migration;
--   2. deploy the matching Worker;
--   3. run the normal all-store ingest once.
--
-- The ingest populates both fields only after it verifies that the exact offer
-- exists on a page in the stored meta/hotspot snapshot. Public reads require
-- both fields, so legacy/unverified rows stop entering the storefront while the
-- refresh converges. Historical rows remain available to offline analytics.

ALTER TABLE offers ADD COLUMN brochure_id TEXT;
ALTER TABLE offers ADD COLUMN page_index INTEGER;

CREATE INDEX IF NOT EXISTS ix_offers_local_navigation
  ON offers(brochure_id, page_index, valid_to);
