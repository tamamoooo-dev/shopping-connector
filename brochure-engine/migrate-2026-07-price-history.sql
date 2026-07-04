-- migrate-2026-07-price-history.sql — catalog-wide Price History (2026-07-04).
--
-- Replaces the watchlist-based capture (products.js + price_points) with
-- history harvested from the structured-offers ingest: a derived per-product
-- identity table plus a change-only price series. See schema.sql for the model.
--
-- The old `price_points` table is retired but intentionally NOT dropped (16
-- rows of early capture data; harmless). No code reads or writes it anymore.
--
-- Apply with:
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-price-history.sql

CREATE TABLE IF NOT EXISTS price_identities (
  id            TEXT PRIMARY KEY,
  store         TEXT NOT NULL,
  region        TEXT NOT NULL,
  name          TEXT,
  name_ar       TEXT,
  match_text    TEXT NOT NULL,
  size_unit     TEXT,
  size_total    REAL,
  size_pack     INTEGER,
  category      TEXT,
  image_url     TEXT,
  source_url    TEXT,
  currency      TEXT NOT NULL DEFAULT 'SAR',
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL,
  weeks_seen    INTEGER NOT NULL DEFAULT 1,
  last_price    REAL NOT NULL,
  last_valid_to TEXT
);

CREATE INDEX IF NOT EXISTS ix_pi_store ON price_identities(store, region);
CREATE INDEX IF NOT EXISTS ix_pi_last_seen ON price_identities(last_seen);

CREATE TABLE IF NOT EXISTS price_history (
  identity    TEXT NOT NULL,
  week        TEXT NOT NULL,
  price       REAL NOT NULL,
  old_price   REAL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (identity, week)
);

CREATE INDEX IF NOT EXISTS ix_ph_price ON price_history(identity, price);
