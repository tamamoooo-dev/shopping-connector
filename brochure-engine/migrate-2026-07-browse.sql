-- migrate-2026-07-browse.sql — Browse pillar, Milestone 1 (BROWSE-DESIGN.md).
-- Adds the derived cross-week identity to offers rows (the price-history join
-- key Browse badges read: lowest ever, weeks seen) and the indexes the Browse
-- listing filters use. Apply once:
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-browse.sql
-- Then backfill identities for rows ingested before this column existed:
--   curl -X POST -H "X-Ingest-Secret: <secret>" ".../prices/backfill"

ALTER TABLE offers ADD COLUMN identity TEXT;
ALTER TABLE offers ADD COLUMN brand_slug TEXT;

CREATE INDEX IF NOT EXISTS ix_offers_identity ON offers(identity);
CREATE INDEX IF NOT EXISTS ix_offers_category ON offers(category, valid_to);
CREATE INDEX IF NOT EXISTS ix_offers_brand ON offers(brand_slug, valid_to);
