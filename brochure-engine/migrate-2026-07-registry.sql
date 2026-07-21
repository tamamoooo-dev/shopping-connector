-- migrate-2026-07-registry.sql — one-time migration for the LIVE database
-- (Product Registry milestone, REGISTRY-DESIGN.md §1). Fresh installs get this
-- from schema.sql; the live DB needs the delta. Apply ONCE (safe to re-run:
-- only IF NOT EXISTS statements):
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-registry.sql
--
-- Adds the three registry tables ONLY. No existing table is touched, nothing
-- reads or writes these yet (Phase 1 of the rollout: schema present, engine
-- behavior unchanged). V1 identity tables stay frozen in place (IDENTITY-V2
-- §6) — no linkage, no row migration.
--
-- Keep the table definitions byte-identical to schema.sql (the registry
-- section there is the authority; this file is the delta for deployed DBs).

-- §1.1 `products` — the registry. One row per product; identity by ASSIGNMENT:
-- an opaque id minted once, never derived from content.
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

CREATE INDEX IF NOT EXISTS ix_products_status ON products(status, last_seen);
CREATE INDEX IF NOT EXISTS ix_products_brand_slug ON products(brand_slug, status);
CREATE INDEX IF NOT EXISTS ix_products_family ON products(family, status);

-- §1.2 `product_tokens` — the inverted index (blocking): one row per token in
-- an ACTIVE product's profile.
CREATE TABLE IF NOT EXISTS product_tokens (
  token      TEXT NOT NULL,
  product_id TEXT NOT NULL,           -- -> products.id
  PRIMARY KEY (token, product_id)
);

CREATE INDEX IF NOT EXISTS ix_ptokens_product ON product_tokens(product_id);

-- §1.3 `product_sightings` — "this offer was this product, this week, at this
-- price." Sightings outlive their offer rows; offer_id PK = idempotent
-- resolution per offer.
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

CREATE INDEX IF NOT EXISTS ix_sightings_product ON product_sightings(product_id, week);
