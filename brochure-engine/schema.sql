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
  source_type TEXT NOT NULL,      -- pdf | images | flipbook | api
  source_url  TEXT,
  pdf_url     TEXT,
  checksum    TEXT NOT NULL,      -- sha256:… content hash (dedupe/identity key)
  collector   TEXT NOT NULL,      -- which strategy produced it (provenance)
  storage_key TEXT NOT NULL,      -- R2/object prefix for this edition's assets
  is_current  INTEGER NOT NULL DEFAULT 1
);

-- Enforce dedupe at the DB layer: identical bytes can never be stored twice.
CREATE UNIQUE INDEX IF NOT EXISTS ux_checksum ON brochures(checksum);

-- O(1) "latest brochure for this store+region" reads while retaining history.
CREATE INDEX IF NOT EXISTS ix_store_region_current ON brochures(store, region, is_current);
