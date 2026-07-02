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
-- Price History (Pillar 3) — a FEATURE of the Brochure Engine, not a separate
-- service. Each row is the price of a tracked product at a store, ANCHORED to
-- that store's brochure edition: the edition is the "when" (weekly bucket) and
-- the store is the "where". The Brochure Engine's retained editions are thus the
-- backbone of the price history. The price NUMBER comes from the search
-- connector (the only automated price source — brochure images would need OCR,
-- which is out of scope); it is captured once per brochure edition (weekly),
-- never as a daily search-driven time-series. Lows are derived by MIN(price)
-- over these rows (no projection table — kept simple for a personal tool).
CREATE TABLE IF NOT EXISTS price_points (
  id          TEXT PRIMARY KEY,   -- `${product}:${store}:${edition}`
  product     TEXT NOT NULL,      -- tracked product key (config id)
  store       TEXT NOT NULL,      -- where the price occurred (brochure store)
  region      TEXT NOT NULL,
  edition     TEXT NOT NULL,      -- brochure edition (weekly) = the "when" bucket
  price       REAL NOT NULL,
  currency    TEXT,
  name        TEXT,               -- product name as seen at the store
  link        TEXT,
  observed_at TEXT NOT NULL       -- ISO datetime the price was captured
);

-- One price point per product+store+edition — idempotent weekly capture: a
-- re-fire in the same brochure week never adds a duplicate (mirrors the
-- brochure checksum gate).
CREATE UNIQUE INDEX IF NOT EXISTS ux_price_point ON price_points(product, store, edition);

-- Fast "lowest / history for this product" reads.
CREATE INDEX IF NOT EXISTS ix_price_product ON price_points(product, price);

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
