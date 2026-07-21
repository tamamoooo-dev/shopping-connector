-- migrate-2026-07-enrichments.sql — one-time migration for the LIVE database
-- (Vision Enrichment milestone, 2026-07-18). Fresh installs get this from
-- schema.sql; the live DB needs the delta. Apply ONCE (safe to re-run: only
-- IF NOT EXISTS statements):
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-enrichments.sql
--
-- Side-car table: vision-extracted names for offers whose OCR debris defeated
-- deriveNames (offers/enrich.js). Joins offers 1:1 by id; NEVER holds prices.
-- A row with NULL name+name_ar records "attempted, model declined" so the
-- drain never re-spends an API call on a hopeless crop. corroboration is the
-- serving gate (see enrich.js — model self-confidence is measured useless).

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

-- If the table was ALREADY created from an earlier version of this migration
-- (before match_text/mint_verdict existed), the CREATE above is a no-op — run
-- these two instead (each errors harmlessly if the column already exists):
--   ALTER TABLE offer_enrichments ADD COLUMN match_text TEXT;
--   ALTER TABLE offer_enrichments ADD COLUMN mint_verdict TEXT;
