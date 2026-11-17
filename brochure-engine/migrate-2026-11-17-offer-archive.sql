-- The permanent flyer price archive (2026-11-17, src/storage/offerArchive.js):
-- one row per flyer offer ever held, written by the daily retention in the
-- same batch that deletes the expired offer, and by the one-time backfill
-- (POST /prices/archive/import). Append-only. The Worker also creates these
-- itself when missing (ensureOfferArchive), so this file needs no manual run.

CREATE TABLE IF NOT EXISTS offer_archive (
  id           TEXT PRIMARY KEY,  -- offers.id (store:region:source:offer_id)
  store        TEXT NOT NULL,
  region       TEXT NOT NULL,
  flyer_ref    TEXT,              -- the flyer the offer was printed in
  brochure_id  TEXT,              -- brochures.id when known
  valid_from   TEXT,              -- the flyer's validity (the offer's date)
  valid_to     TEXT,
  price        REAL NOT NULL,
  old_price    REAL,
  currency     TEXT NOT NULL DEFAULT 'SAR',
  name         TEXT,              -- display name (EN), servable Vision else flyer text
  name_ar      TEXT,              -- display name (AR), same rule
  size         TEXT,              -- package size as read, when Vision read it
  category     TEXT,
  image_url    TEXT,              -- the product's flyer crop
  source_url   TEXT,              -- the flyer page (human verification)
  price_source TEXT,              -- NULL = the flyer's price; 'vision' = read from the crop
  origin       TEXT NOT NULL,     -- 'retention' or 'backfill:<source>'
  match_text   TEXT NOT NULL,     -- normalized bilingual search haystack
  archived_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_offer_archive_store_date ON offer_archive(store, valid_from);

CREATE INDEX IF NOT EXISTS ix_offer_archive_flyer ON offer_archive(store, flyer_ref);

CREATE VIRTUAL TABLE IF NOT EXISTS offer_archive_fts USING fts5(
  match_text,
  content='',
  tokenize='trigram',
  detail=none,
  columnsize=0
);

CREATE TRIGGER IF NOT EXISTS offer_archive_fts_ai
AFTER INSERT ON offer_archive BEGIN
  INSERT INTO offer_archive_fts(rowid, match_text)
  WITH RECURSIVE split(rest, word) AS (
    SELECT trim(new.match_text) || ' ', ''
    UNION ALL
    SELECT substr(rest, instr(rest, ' ') + 1),
           substr(rest, 1, instr(rest, ' ') - 1)
    FROM split WHERE rest <> ''
  ), canon(term) AS (
    SELECT DISTINCT CASE
      WHEN word LIKE 'وال%' AND length(substr(word, 4)) >= 2 THEN substr(word, 4)
      WHEN word LIKE 'ال%' AND length(substr(word, 3)) >= 2 THEN substr(word, 3)
      ELSE word
    END FROM split WHERE word <> ''
  )
  SELECT new.rowid,
         new.match_text || COALESCE(' ' || group_concat('qx' || term || 'xq', ' '), '')
  FROM canon WHERE length(term) < 3;
END;
