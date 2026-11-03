-- Value Watch (price monitoring v4, 2026-11-03): "this exact product, any pack,
-- any store, cheapest per item". Additive: no column or row is dropped, and the
-- v3 columns stay readable for rollback. Apply BEFORE deploying the engine:
--   npx wrangler d1 execute brochure-engine --remote --file=migrate-2026-11-03-value-watch.sql
--
-- watch_listings is the per-watch INDEX: every listing any store returned for
-- the watch, with the verdict that says whether it is the watched product
-- (match / reject / pending), who decided (anchor / rules / ai / user), and the
-- last price and per-item value seen. Identity is decided once per listing and
-- remembered; a round only re-prices.

CREATE TABLE IF NOT EXISTS watch_listings (
  watch_id        TEXT NOT NULL,
  store           TEXT NOT NULL,
  listing_id      TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'online',   -- online | flyer
  name            TEXT,
  name_key        TEXT,                             -- normalized title; a rename re-verifies
  brand           TEXT,
  size_text       TEXT,
  link            TEXT,
  image           TEXT,
  item_value      REAL,                             -- size per item (g / ml / pcs)
  item_unit       TEXT,
  pack_count      INTEGER,
  verdict         TEXT NOT NULL CHECK (verdict IN ('match', 'reject', 'pending')),
  verdict_by      TEXT,                             -- anchor | barcode | rules | conflict | ai | ai+rules | user
  verdict_reason  TEXT,
  ai_items        INTEGER,
  size_verified   INTEGER NOT NULL DEFAULT 0,
  query           TEXT,
  first_seen_at   TEXT NOT NULL,
  last_seen_at    TEXT,
  last_checked_at TEXT,
  last_price      REAL,
  last_value      REAL,
  missing_rounds  INTEGER NOT NULL DEFAULT 0,
  barcodes        TEXT,                             -- barcode keys (12-digit EAN-13 bodies), comma-joined
  in_stock        INTEGER,                          -- 1 / 0 as the store said; NULL unknown
  PRIMARY KEY (watch_id, store, listing_id)
);

CREATE INDEX IF NOT EXISTS ix_watch_listings_watch
  ON watch_listings(watch_id, verdict);

-- The value contract (reference product, per-item size, pack, target per item,
-- queries), the index bookkeeping, and the deal/alert state.
ALTER TABLE watches ADD COLUMN reference_json TEXT;
ALTER TABLE watches ADD COLUMN index_state TEXT;     -- pending | indexing | ready | failed
ALTER TABLE watches ADD COLUMN index_due_at TEXT;    -- next background index pass (lease while indexing)
ALTER TABLE watches ADD COLUMN index_json TEXT;      -- stats + per-store status of the last pass
ALTER TABLE watches ADD COLUMN deal_json TEXT;       -- current deal, last alert, episode

CREATE INDEX IF NOT EXISTS ix_watches_index_due
  ON watches(index_due_at) WHERE index_due_at IS NOT NULL;
