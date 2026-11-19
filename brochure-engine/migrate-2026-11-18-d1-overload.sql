-- D1 "overloaded" in the ops console, 2026-11-18.
--
-- D1 runs one statement at a time per database. The console's Vision and
-- Pipeline screens (and /registry/stats) count enrichments per mint_verdict.
-- With no index, that statement read all ~90,000 offer_enrichments rows and
-- their JSON: 5.7 s each on production (wrangler d1 insights). Everything
-- queued behind it waited too long, and D1 refused it with
-- "D1 DB is overloaded. Requests queued for too long."
--
-- Measured on the local copy (backups/retention-analysis-20260826-fast.sqlite):
--   verdict counts   346 ms -> 21 ms   (covering index scan)
--   sightings bands   22 ms -> 12 ms
--   sightings weekly  24 ms ->  1 ms
--   resolution feed  107 ms -> 78 ms   (mint_verdict IS NULL)
-- No query plan got worse. No Worker code changes; same DDL as schema.sql.
--
-- Run once against production, from brochure-engine/, as a --command (a
-- --file run goes through D1's import path, which can hold the database for
-- the whole import):
--   npx wrangler d1 execute brochure-engine --remote --command "CREATE INDEX IF NOT EXISTS ix_offer_enrichments_mint_verdict ON offer_enrichments(mint_verdict); CREATE INDEX IF NOT EXISTS ix_sightings_week_band ON product_sightings(week, match_band);"
-- Building the first index reads the table once (a few seconds); run it once.

CREATE INDEX IF NOT EXISTS ix_offer_enrichments_mint_verdict
  ON offer_enrichments(mint_verdict);

CREATE INDEX IF NOT EXISTS ix_sightings_week_band
  ON product_sightings(week, match_band);
