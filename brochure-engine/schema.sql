-- schema.sql — D1 (SQLite) schema for the Brochure Engine MetadataStore.
-- ARCHITECTURE.md §5.2. Apply with:
--   npx wrangler d1 execute brochure-engine --file=./schema.sql            (local)
--   npx wrangler d1 execute brochure-engine --remote --file=./schema.sql   (deployed)

CREATE TABLE IF NOT EXISTS brochures (
  id          TEXT PRIMARY KEY,   -- `${store}:${region}:${edition}`
  store       TEXT NOT NULL,
  region      TEXT NOT NULL,
  edition     TEXT NOT NULL,      -- YYYY-Www or detected-YYYY-MM-DD
  title       TEXT,
  valid_from  TEXT,               -- ISO date | null
  valid_to    TEXT,               -- ISO date | null
  detected_at TEXT NOT NULL,      -- ISO datetime
  source_type TEXT NOT NULL,      -- pdf | images | flipbook | api | link
  source_url  TEXT,
  pdf_url     TEXT,
  checksum    TEXT NOT NULL,      -- sha256:… content hash (dedupe/identity key)
  collector   TEXT NOT NULL,      -- which strategy produced it (provenance)
  storage_key TEXT NOT NULL,      -- R2/object prefix for this edition's assets
  is_current  INTEGER NOT NULL DEFAULT 1,
  pruned_at   TEXT                -- retention: when this edition's BYTES were
                                  -- deleted (the row itself is forever)
);

-- Enforce dedupe at the DB layer: identical bytes can never be stored twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_checksum ON brochures(checksum);

-- O(1) "latest brochure for this store+region" reads while retaining history.
CREATE INDEX IF NOT EXISTS ix_store_region_current ON brochures(store, region, is_current);

-- ---------------------------------------------------------------------------
-- Price History (Pillar 3) — CATALOG-WIDE, harvested from the structured-offers
-- ingest (redesigned 2026-07-04; the old watchlist-based `price_points` table
-- is retired but left in the deployed DB — see migrate-2026-07-price-history.sql).
--
-- THE MODEL: every flyer offer is a price observation. The aggregator's
-- offer_id is per-flyer-extraction (NOT stable across weeks — verified in
-- production), so cross-week product identity is DERIVED conservatively at
-- ingest: store + region + normalized bilingual name + parsed size, hashed.
-- Identities the deriver can't trust (nameless / single-token OCR debris) are
-- skipped rather than risked (never mix two products' histories). An identity
-- split (the same product OCR-ing slightly differently two weeks apart) is
-- harmless: the read API matches identities by QUERY and merges them per
-- size/variant, so stats degrade gracefully instead of mixing.
--
-- Storage is incremental: one identity row per product (refreshed in place),
-- and a point row ONLY when the price actually changes (plus the first
-- sighting). All statistics (lowest ever, highest, current, first seen, trend)
-- are derived from these rows at read time — nothing is hard-coded.
CREATE TABLE IF NOT EXISTS price_identities (
  id            TEXT PRIMARY KEY, -- ph_<fnv64(store|region|names|size)>
  store         TEXT NOT NULL,
  region        TEXT NOT NULL,
  name          TEXT,             -- display name (EN), from the offer
  name_ar       TEXT,             -- display name (AR)
  match_text    TEXT NOT NULL,    -- normalized bilingual name (query matching)
  size_unit     TEXT,             -- parsed size (ml | g | pcs) or null
  size_total    REAL,
  size_pack     INTEGER,
  category      TEXT,             -- aggregator category slug (family backup)
  image_url     TEXT,             -- latest flyer crop (display)
  source_url    TEXT,             -- latest flyer deep-link (human verification)
  currency      TEXT NOT NULL DEFAULT 'SAR',
  first_seen    TEXT NOT NULL,    -- ISO date of the first observation
  last_seen     TEXT NOT NULL,    -- ISO date of the latest observation
  weeks_seen    INTEGER NOT NULL DEFAULT 1, -- distinct ISO weeks observed (depth)
  last_price    REAL NOT NULL,    -- latest observed price (the change detector)
  last_valid_to TEXT              -- latest offer's validity end ("current" test)
);

CREATE INDEX IF NOT EXISTS ix_pi_store ON price_identities(store, region);
CREATE INDEX IF NOT EXISTS ix_pi_last_seen ON price_identities(last_seen);

-- The append-only price series: first sighting + every price CHANGE, keyed by
-- the offer's validity week so idempotent re-ingests never duplicate a point
-- (a corrected extraction in the same window replaces its point in place).
CREATE TABLE IF NOT EXISTS price_history (
  identity    TEXT NOT NULL,      -- -> price_identities.id
  week        TEXT NOT NULL,      -- the offer's valid_from date (weekly bucket)
  price       REAL NOT NULL,
  old_price   REAL,               -- strike-through price, when the flyer had one
  observed_at TEXT NOT NULL,
  PRIMARY KEY (identity, week)
);

CREATE INDEX IF NOT EXISTS ix_ph_price ON price_history(identity, price);

-- ---------------------------------------------------------------------------
-- Structured Offers — the price-comparison substrate. One row per PRODUCT deal
-- machine-extracted from a store's flyer by the aggregator: price, was-price,
-- validity, category, product image crop, flyer deep-link, plus the flyer's
-- OCR text (normalized into search_text for matching). "Current" is derived
-- from valid_to at read time; rows are retained as recent history and pruned
-- after ~6 months (see retention.js). Prices are aggregator-AI-extracted: the
-- read API carries a disclaimer and every row links to its flyer page.
CREATE TABLE IF NOT EXISTS offers (
  id          TEXT PRIMARY KEY,   -- `${store}:${region}:${source}:${offer_id}`
  store       TEXT NOT NULL,
  region      TEXT NOT NULL,
  source      TEXT NOT NULL,      -- offers source adapter (e.g. 'd4d')
  offer_id    TEXT NOT NULL,      -- the source's per-product id
  flyer_ref   TEXT,               -- the source's flyer id (links to a brochure)
  page_ref    TEXT,               -- the source's flyer-page id
  edition     TEXT,               -- held brochure edition this offer came from
  name        TEXT,               -- best-effort display name (EN), from OCR
  name_ar     TEXT,               -- best-effort display name (AR), from OCR
  price       REAL NOT NULL,      -- offer price (sanity-gated: finite, > 0)
  old_price   REAL,               -- strike-through price (only if > price)
  currency    TEXT NOT NULL DEFAULT 'SAR',
  category_id TEXT,
  category    TEXT,               -- aggregator category slug (e.g. milk-laban)
  image_url   TEXT,               -- the product's own flyer crop (CDN)
  source_url  TEXT,               -- flyer page deep-link (human verification)
  valid_from  TEXT,
  valid_to    TEXT,
  detected_at TEXT NOT NULL,
  search_text TEXT                -- normalized OCR text + category (matching)
);

-- Idempotent ingest: one row per source product id per store+region.
CREATE UNIQUE INDEX IF NOT EXISTS ux_offer ON offers(store, region, source, offer_id);

-- "Current offers for a store" and global currency filters.
CREATE INDEX IF NOT EXISTS ix_offers_store_valid ON offers(store, region, valid_to);
CREATE INDEX IF NOT EXISTS ix_offers_valid ON offers(valid_to);

-- ---------------------------------------------------------------------------
-- Price Monitoring (the Keepa-inspired Personal Alerts feature — monitor.js).
-- A watch is a user-set target price on either a specific identifiable product
-- (kind 'product': provider + stable product id, e.g. an Amazon ASIN) or a
-- grocery query (kind 'grocery': evaluated across ALL sources — live online
-- stores + current flyer offers). Checked by a daily cron; an alert row is
-- written when the price CROSSES down to the target (is_below tracks the
-- arming state so one drop produces one alert).
CREATE TABLE IF NOT EXISTS watches (
  id           TEXT PRIMARY KEY,   -- w_<random>
  kind         TEXT NOT NULL,      -- 'product' | 'grocery'
  label        TEXT,
  query        TEXT NOT NULL,      -- the search query that re-finds the product
  provider     TEXT,               -- kind=product: search-connector provider id
  product_id   TEXT,               -- kind=product: the stable result id (ASIN…)
  link         TEXT,
  image        TEXT,
  target_price REAL NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'SAR',
  size_unit    TEXT,               -- kind=grocery: reference size (the size gate)
  size_total   REAL,               --   e.g. 'ml' + 2000 for a 2 L milk
  active       INTEGER NOT NULL DEFAULT 1,
  is_below     INTEGER NOT NULL DEFAULT 0, -- crossing detector state
  created_at   TEXT NOT NULL,
  checked_at   TEXT,
  last_price   REAL,               -- best trustworthy price at the last check
  last_store   TEXT,
  last_source  TEXT,               -- 'online' | 'flyer'
  last_name    TEXT,
  last_link    TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id           TEXT PRIMARY KEY,   -- a_<random>
  watch_id     TEXT NOT NULL,
  price        REAL NOT NULL,
  target_price REAL NOT NULL,
  currency     TEXT,
  store        TEXT,
  source       TEXT,               -- 'online' | 'flyer'
  name         TEXT,
  link         TEXT,
  observed_at  TEXT NOT NULL,
  seen         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_alerts_watch ON alerts(watch_id, observed_at);
CREATE INDEX IF NOT EXISTS ix_alerts_seen ON alerts(seen);
