-- migrate-2026-07-offer-stage.sql — Phase 2 of the offers-shortfall fix: add the
-- staging table that makes the structured-offers write ATOMICALLY VISIBLE.
--
-- Phase 1 (separate invocations + fail-loud) fixed the production incident: the
-- offers write now completes in its own subrequest budget. Phase 2 closes the
-- remaining tail risk — a batch error / timeout / Worker restart mid-write could
-- still leave the visible `offers` table partially updated. The ingest now
-- stages a store's whole fetched set here, validates it, then promotes into
-- `offers` in one atomic INSERT…SELECT…ON CONFLICT statement; a failure before
-- the promote leaves the previous complete dataset visible.
--
-- Apply once (idempotent — IF NOT EXISTS):
--   npx wrangler d1 execute brochure-engine --remote --file=migrate-2026-07-offer-stage.sql

CREATE TABLE IF NOT EXISTS offer_stage (
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
CREATE INDEX IF NOT EXISTS ix_offer_stage_srs ON offer_stage(store, region, source);
