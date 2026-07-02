-- migrate-2026-07-offers.sql — one-time migration for the LIVE database
-- (Structured Offers + retention milestone, 2026-07). Fresh installs get all
-- of this from schema.sql; the live DB needs the delta because ALTER TABLE is
-- not idempotent. Apply ONCE:
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-offers.sql
--
-- Safe to re-run only the CREATE statements (IF NOT EXISTS); the ALTER fails
-- with "duplicate column name" if applied twice — that error means it is
-- already applied and can be ignored.

ALTER TABLE brochures ADD COLUMN pruned_at TEXT;

CREATE TABLE IF NOT EXISTS offers (
  id          TEXT PRIMARY KEY,
  store       TEXT NOT NULL,
  region      TEXT NOT NULL,
  source      TEXT NOT NULL,
  offer_id    TEXT NOT NULL,
  flyer_ref   TEXT,
  page_ref    TEXT,
  edition     TEXT,
  name        TEXT,
  name_ar     TEXT,
  price       REAL NOT NULL,
  old_price   REAL,
  currency    TEXT NOT NULL DEFAULT 'SAR',
  category_id TEXT,
  category    TEXT,
  image_url   TEXT,
  source_url  TEXT,
  valid_from  TEXT,
  valid_to    TEXT,
  detected_at TEXT NOT NULL,
  search_text TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_offer ON offers(store, region, source, offer_id);
CREATE INDEX IF NOT EXISTS ix_offers_store_valid ON offers(store, region, valid_to);
CREATE INDEX IF NOT EXISTS ix_offers_valid ON offers(valid_to);
