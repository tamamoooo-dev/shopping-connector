-- Vision price fallback (offers/priceFallback.js).
--
-- Why: since 2026-09-22 D4D publishes new flyers' per-product records with
-- price/was_price "0.000". buildOffer drops them (a price is required), so
-- current flyers had no offers: no Search/Browse rows and no tappable products
-- in the flyer viewer.
--
-- Additive only:
--   • offers.price_source — NULL for every existing row (= source price), so
--     nothing already stored changes meaning.
--   • price_pending — the fallback's queue.
--
-- Rollout order (the ingest writes price_source, so the column must exist
-- before the new Worker runs):
--   1. apply this migration;
--   2. set the MINISTRAL_14B_API_KEY_1..3 secrets (any subset);
--   3. deploy the matching Worker;
--   4. the next offers ingest queues unpriced records; the 10,30,50 cron drains.

ALTER TABLE offers ADD COLUMN price_source TEXT;

CREATE TABLE IF NOT EXISTS price_pending (
  id            TEXT PRIMARY KEY,   -- `${store}:${region}:${source}:${offer_id}` (= the offers id)
  store         TEXT NOT NULL,
  region        TEXT NOT NULL,
  source        TEXT NOT NULL,
  offer_id      TEXT NOT NULL,
  flyer_ref     TEXT,
  image_url     TEXT NOT NULL,      -- the product crop the fallback reads
  valid_to      TEXT,
  raw_json      TEXT NOT NULL,      -- the unpriced source record, as ingested
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'accepted', 'rejected', 'superseded')),
  attempts      INTEGER NOT NULL DEFAULT 0, -- drains that ended in a transient error
  reason        TEXT,               -- why rejected / superseded / last transient error
  price         REAL,               -- the accepted price (status 'accepted' only)
  old_price     REAL,
  audit_json    TEXT,               -- the reading sequence, model, temperature
  detected_at   TEXT NOT NULL,
  resolved_at   TEXT
);

CREATE INDEX IF NOT EXISTS ix_price_pending_queue ON price_pending(status, valid_to);
