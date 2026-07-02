-- migrate-2026-07-watches.sql — one-time delta for the LIVE D1 database:
-- adds the Price Monitoring tables (watches + alerts). Purely additive; the
-- canonical schema for fresh installs is schema.sql (kept in sync).
--
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-watches.sql

CREATE TABLE IF NOT EXISTS watches (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  label        TEXT,
  query        TEXT NOT NULL,
  provider     TEXT,
  product_id   TEXT,
  link         TEXT,
  image        TEXT,
  target_price REAL NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'SAR',
  size_unit    TEXT,
  size_total   REAL,
  active       INTEGER NOT NULL DEFAULT 1,
  is_below     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  checked_at   TEXT,
  last_price   REAL,
  last_store   TEXT,
  last_source  TEXT,
  last_name    TEXT,
  last_link    TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id           TEXT PRIMARY KEY,
  watch_id     TEXT NOT NULL,
  price        REAL NOT NULL,
  target_price REAL NOT NULL,
  currency     TEXT,
  store        TEXT,
  source       TEXT,
  name         TEXT,
  link         TEXT,
  observed_at  TEXT NOT NULL,
  seen         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_alerts_watch ON alerts(watch_id, observed_at);
CREATE INDEX IF NOT EXISTS ix_alerts_seen ON alerts(seen);
