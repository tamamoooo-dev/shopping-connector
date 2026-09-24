-- Unpriced flyer items (the flyer viewer's side table).
--
-- Why: since 2026-09-22 D4D publishes new flyers' per-product records with
-- price/was_price "0.000". buildOffer drops them (offers.price is NOT NULL and
-- sanity-gated > 0), so current flyers had no structured rows, the
-- /brochures/hotspots join returned no offers, and the flyer viewer showed bare
-- pages with no tappable products or crops.
--
-- Purely additive: a new table read only by the hotspots join. `offers` and
-- every price-based feature are untouched.
--
-- Rollout order:
--   1. apply this migration;
--   2. deploy the matching Worker;
--   3. run the normal offers ingest once (or wait for the next cron) so current
--      flyers' unpriced items are stored.

CREATE TABLE IF NOT EXISTS flyer_items (
  id          TEXT PRIMARY KEY,   -- `${store}:${region}:${source}:${offer_id}` (= the offers id)
  store       TEXT NOT NULL,
  region      TEXT NOT NULL,
  source      TEXT NOT NULL,      -- offers source adapter (e.g. 'd4d')
  offer_id    TEXT NOT NULL,      -- the source's per-product id (= hotspot offerId)
  flyer_ref   TEXT NOT NULL,      -- the source's flyer id (the hotspots join key)
  page_ref    TEXT,
  name        TEXT,               -- best-effort display name (EN), from OCR
  name_ar     TEXT,               -- best-effort display name (AR), from OCR
  category_id TEXT,
  category    TEXT,
  image_url   TEXT,               -- the product's own flyer crop (CDN)
  source_url  TEXT,               -- provenance only
  valid_from  TEXT,
  valid_to    TEXT,
  detected_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_flyer_items_flyer ON flyer_items(store, region, flyer_ref);
CREATE INDEX IF NOT EXISTS ix_flyer_items_valid ON flyer_items(valid_to);
