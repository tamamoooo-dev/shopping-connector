-- Phase 1/2: first half of the compact Price History trigram representation.
--
-- PRODUCTION EFFECTS WHEN APPLIED (do not run during audit): creates the
-- contentless FTS5 table, reads price_identities rowids 1..39047, and writes
-- search data only. It does not update/delete price identities or history.
-- The split leaves Free-tier write headroom; run shortly before 00:00 UTC and
-- run Phase 2 immediately after the reset. The old Worker ignores this table.

CREATE VIRTUAL TABLE IF NOT EXISTS price_identities_fts USING fts5(
  match_text,
  content='',
  tokenize='trigram',
  detail=none,
  columnsize=0
);

WITH RECURSIVE split(identity_rowid, match_text, rest, word) AS (
  SELECT rowid, match_text, trim(match_text) || ' ', ''
  FROM price_identities WHERE rowid <= 39047
  UNION ALL
  SELECT identity_rowid, match_text,
         substr(rest, instr(rest, ' ') + 1),
         substr(rest, 1, instr(rest, ' ') - 1)
  FROM split WHERE rest <> ''
), canon(identity_rowid, term) AS (
  SELECT DISTINCT identity_rowid,
    CASE
      WHEN word LIKE 'وال%' AND length(substr(word, 4)) >= 2 THEN substr(word, 4)
      WHEN word LIKE 'ال%' AND length(substr(word, 3)) >= 2 THEN substr(word, 3)
      ELSE word
    END
  FROM split WHERE word <> ''
), sentinels(identity_rowid, text) AS (
  SELECT identity_rowid, group_concat('qx' || term || 'xq', ' ')
  FROM canon WHERE length(term) < 3 GROUP BY identity_rowid
)
INSERT INTO price_identities_fts(rowid, match_text)
SELECT p.rowid, p.match_text || COALESCE(' ' || s.text, '')
FROM price_identities p LEFT JOIN sentinels s ON s.identity_rowid = p.rowid
WHERE p.rowid <= 39047;
