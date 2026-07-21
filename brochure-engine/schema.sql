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
  search_text TEXT,               -- normalized OCR text + category (matching)
  identity    TEXT,               -- derived cross-week identity (nullable) ->
                                  -- price_identities.id; Browse's history join
                                  -- (see migrate-2026-07-browse.sql)
  brand_slug  TEXT                -- canonical brand (browse/brands.js), nullable
);

-- Idempotent ingest: one row per source product id per store+region.
CREATE UNIQUE INDEX IF NOT EXISTS ux_offer ON offers(store, region, source, offer_id);

-- "Current offers for a store" and global currency filters.
CREATE INDEX IF NOT EXISTS ix_offers_store_valid ON offers(store, region, valid_to);
CREATE INDEX IF NOT EXISTS ix_offers_valid ON offers(valid_to);

-- Browse (BROWSE-DESIGN.md): the history join + canonical-aisle prefilters.
CREATE INDEX IF NOT EXISTS ix_offers_identity ON offers(identity);
CREATE INDEX IF NOT EXISTS ix_offers_category ON offers(category, valid_to);
CREATE INDEX IF NOT EXISTS ix_offers_brand ON offers(brand_slug, valid_to);

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
  profile_id   TEXT,               -- owning local profile (frontend profile.js
                                  -- id) — the isolation boundary: every user-
                                  -- facing read/write is scoped to it. NULL
                                  -- only on pre-profile rows, claimed by the
                                  -- first profile to list (adoptOrphans).
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

-- Profile-scoped reads and the per-profile cap gate (Local Profile milestone).
CREATE INDEX IF NOT EXISTS ix_watches_profile ON watches(profile_id, active);

-- ---------------------------------------------------------------------------
-- Operations Console (ops/ subsystem) — the audit timeline. One row per
-- operation run: every cron fan-out child, every cron coordinator summary and
-- every manual console operation records here (storage/opsStore.js). This is
-- the ONLY table the console writes; engine data stays read-only to it.
CREATE TABLE IF NOT EXISTS ops_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,      -- run start, ISO datetime
  action     TEXT NOT NULL,      -- 'ingest' | 'ingest:offers' | 'ingest:brochures'
                                 -- | 'cron:fanout' | 'cron:watches' | 'ops:*'
  origin     TEXT NOT NULL,      -- 'cron' (scheduler) | 'ops' (console operator)
  store      TEXT,               -- single-store runs; NULL for coordinator rows
  stores     INTEGER,            -- number of stores the run targeted
  ok         INTEGER NOT NULL,
  detected   INTEGER,            -- brochure totals (per-store ingest rows)
  new_count  INTEGER,            -- `new` is an SQL keyword; interface maps it
  deduped    INTEGER,
  failed     INTEGER,
  offers     INTEGER,            -- offers stored by the run
  coverage   REAL,               -- post-run average coverage %, when verified
  elapsed_ms INTEGER,
  error      TEXT,               -- first error message, for the diagnostics view
  detail     TEXT                -- JSON drill-down blob
);

CREATE INDEX IF NOT EXISTS ix_ops_runs_store ON ops_runs(store, id);
CREATE INDEX IF NOT EXISTS ix_ops_runs_origin ON ops_runs(origin, id);

-- Vision enrichment (offers/enrich.js): side-car names for offers whose OCR
-- debris defeated deriveNames. Joins offers 1:1 by id; never holds prices.
-- NULL name+name_ar = "attempted, model declined" (no API re-spend). The
-- serving gate is corroboration (model self-confidence is audit-only).
CREATE TABLE IF NOT EXISTS offer_enrichments (
  id            TEXT PRIMARY KEY,   -- offers.id (store:region:source:offerId)
  name          TEXT,               -- vision-read English display name
  name_ar       TEXT,               -- vision-read Arabic display name
  brand         TEXT,
  size          TEXT,
  confidence    REAL,               -- model self-report (kept for audit only)
  corroboration REAL,               -- token overlap vs the offer's own OCR text
  model         TEXT,
  crop_url      TEXT,               -- the image the model read (auditability)
  enriched_at   TEXT NOT NULL,
  match_text    TEXT,               -- normalized vision haystack (name+name_ar+
                                    -- brand through normalizeText) — the vision
                                    -- pipeline's SQL-retrieval substrate
  mint_verdict  TEXT                -- registry resolution verdict (IDENTITY-V2
                                    -- §3.1: minted | declined | low_corroboration
                                    -- | too_few_tokens). NULL = not yet resolved;
                                    -- the resolution drain processes NULLs once.
);

-- Background Manual Vision jobs (Vision Milestone 2 §2). One durable row per
-- operator-launched "Run Vision" job (id 'active' = the single live job); the
-- self-continuing /enrich/step chain updates it after every batch so the
-- Operations Center shows live progress even after the browser closes.
CREATE TABLE IF NOT EXISTS vision_jobs (
  id             TEXT PRIMARY KEY,   -- 'active' (single live job)
  status         TEXT NOT NULL,      -- running | done | stopped | error
  scope          TEXT,               -- all | debris
  total          INTEGER,            -- queue depth captured at start (% + ETA)
  processed      INTEGER,            -- offers scanned so far
  enriched       INTEGER,            -- offers a name was read from
  declined       INTEGER,            -- offers the model declined
  failed         INTEGER,            -- offers skipped on an isolated error
  remaining      INTEGER,            -- countDebris after the latest hop
  hops           INTEGER,            -- batches run so far (runaway guard)
  started_at     TEXT NOT NULL,
  updated_at     TEXT,
  finished_at    TEXT,
  last_error     TEXT,
  provider_limit TEXT,               -- JSON: last observed 429 rate-limit signal
  origin         TEXT,               -- 'ops'
  lease_until    TEXT                -- single-writer lease held by the draining
                                     -- 1-min `visionDrain` fire (ISO ts); others skip
);

-- ---------------------------------------------------------------------------
-- Product Registry (REGISTRY-DESIGN.md) — identity by ASSIGNMENT, not
-- derivation. A product's identity is an opaque registry row minted once;
-- every later sighting MATCHES INTO it with tolerance (resolver, §3–§4).
-- Replaces derived identity keys, which measurement falsified (IDENTITY-V2
-- §7.2: 60.5% cross-week agreement under exact hashing vs 86.9–99.0% under
-- tolerant comparison at 0.00% precision cost). V1 identity tables above stay
-- frozen in place (IDENTITY-V2 §6) — no linkage, no migration.

-- §1.1 `products` — the registry. One row per product; small and denormalized
-- enough that a resolver pass reads candidates in one query. The token
-- profile IS the product's identity evidence — richer than any single read.
CREATE TABLE IF NOT EXISTS products (
  id              TEXT PRIMARY KEY,   -- pr_<random>; minted once; NEVER derived from content
  status          TEXT NOT NULL DEFAULT 'active',  -- active | merged | dormant (§5.1)
  merged_into     TEXT,               -- survivor product id when status='merged'
                                      -- (tombstone; single-hop enforced, §5.1)
  kind            TEXT NOT NULL DEFAULT 'product', -- product | assortment
                                      -- (IDENTITY-V2 §3 gate 2: assortments
                                      -- match only assortments)
  display_name    TEXT,               -- best-evidence pick (§5.3) — presentation
  display_name_ar TEXT,               --   only, never matching input
  display_corroboration REAL,         -- provenance of the current display pick:
  display_week    TEXT,               --   its read's corroboration + week, so
                                      --   "highest-corroboration recent read
                                      --   wins" is decidable incrementally
  brand_slug      TEXT,               -- canonical (detectBrand) when known; metadata
  brand_text      TEXT,               -- best raw vision brand read; matching EVIDENCE
  size_unit       TEXT,               -- ml | g | pcs, nullable (§5.3 adoption)
  size_total      REAL,
  size_pack       INTEGER,
  family          TEXT,               -- engine lexicon value; blocking + Browse
  category        TEXT,               -- aggregator taxonomy slug
  token_profile   TEXT NOT NULL DEFAULT '{}', -- JSON: token -> {count, week}
                                      -- (§1.1 seen_count/last_seen_week; capped
                                      -- at ~24 tokens, §5.2)
  sightings       INTEGER NOT NULL DEFAULT 0, -- evidence summary (denormalized)
  stores_seen     TEXT NOT NULL DEFAULT '[]', -- JSON array of distinct store slugs
  first_seen      TEXT NOT NULL,      -- ISO date
  last_seen       TEXT NOT NULL,      -- ISO date (dormancy clock, §5.1)
  review_flag     TEXT,               -- NULL = clear; else a reason slug
                                      -- (split suspicion / size conflict, §5.3 §6)
  algo_version    INTEGER NOT NULL    -- resolver version that last touched it
);

-- Dormancy sweeps and "active products" scans (§5.1).
CREATE INDEX IF NOT EXISTS ix_products_status ON products(status, last_seen);
-- Browse joins (§7): brand rails and family shelves read the registry directly.
CREATE INDEX IF NOT EXISTS ix_products_brand_slug ON products(brand_slug, status);
CREATE INDEX IF NOT EXISTS ix_products_family ON products(family, status);

-- §1.2 `product_tokens` — the inverted index (blocking). One row per token in
-- an ACTIVE product's profile; candidate retrieval = products sharing at least
-- one distinctive token with the incoming read (§4.1). ~10× `products` in rows,
-- but keeps retrieval indexed — a full-registry scan per offer would not
-- survive D1 at 30k+ products.
CREATE TABLE IF NOT EXISTS product_tokens (
  token      TEXT NOT NULL,
  product_id TEXT NOT NULL,           -- -> products.id
  PRIMARY KEY (token, product_id)
);

-- Rewriting one product's index rows on profile update / merge / dormancy.
CREATE INDEX IF NOT EXISTS ix_ptokens_product ON product_tokens(product_id);

-- §1.3 `product_sightings` — the atomic fact: "this offer was this product,
-- this week, at this price." Price History V2 derives ENTIRELY from sightings;
-- there is no second bookkeeping path to drift out of sync. The offers table
-- is untouched (offer ids churn weekly — sightings absorb that churn), and
-- sightings OUTLIVE their offer rows (offers are retention-pruned; history is
-- forever). offer_id as PK makes resolution idempotent per offer by
-- construction (§6: re-runs are no-ops).
CREATE TABLE IF NOT EXISTS product_sightings (
  offer_id      TEXT PRIMARY KEY,     -- offers.id (store:region:source:offerId)
  product_id    TEXT NOT NULL,        -- the assignment -> products.id
  match_band    TEXT NOT NULL,        -- auto | review | created (§3)
  match_score   REAL,                 -- audit + §8 metrics
  corroboration REAL,                 -- the read's corroboration at resolve time
  store         TEXT NOT NULL,        -- denormalized for history/queries
  region        TEXT NOT NULL,
  week          TEXT NOT NULL,        -- the offer's valid_from date (weekly
                                      -- bucket, same convention as price_history)
  price         REAL NOT NULL,
  old_price     REAL,                 -- strike-through price as printed (raw
                                      -- observation, only when > price — same
                                      -- gate as offers.old_price)
  algo_version  INTEGER NOT NULL,     -- §6: stamps enable re-resolution of a
                                      -- poisoned window
  resolved_at   TEXT NOT NULL         -- ISO datetime (audit)
);

-- Price History V2 reads: all sightings of a product, week-ordered (§7).
CREATE INDEX IF NOT EXISTS ix_sightings_product ON product_sightings(product_id, week);
