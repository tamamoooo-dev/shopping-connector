-- Phase 2/2: remaining Price History trigrams plus ongoing maintenance.
-- Run immediately after the next 00:00 UTC reset and before deploying the new
-- Worker. Rows inserted since Phase 1 have rowids above 39047 and are included.
-- This writes search representation only; source identity/history rows are not
-- updated or deleted.

WITH RECURSIVE split(identity_rowid, match_text, rest, word) AS (
  SELECT rowid, match_text, trim(match_text) || ' ', ''
  FROM price_identities WHERE rowid > 39047
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
WHERE p.rowid > 39047;

CREATE TRIGGER IF NOT EXISTS price_identities_fts_ai
AFTER INSERT ON price_identities BEGIN
  INSERT INTO price_identities_fts(rowid, match_text)
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

CREATE TRIGGER IF NOT EXISTS price_identities_fts_ad
AFTER DELETE ON price_identities BEGIN
  INSERT INTO price_identities_fts(price_identities_fts, rowid, match_text)
  WITH RECURSIVE split(rest, word) AS (
    SELECT trim(old.match_text) || ' ', ''
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
  SELECT 'delete', old.rowid,
         old.match_text || COALESCE(' ' || group_concat('qx' || term || 'xq', ' '), '')
  FROM canon WHERE length(term) < 3;
END;

CREATE TRIGGER IF NOT EXISTS price_identities_fts_au
AFTER UPDATE OF match_text ON price_identities
WHEN old.match_text IS NOT new.match_text BEGIN
  INSERT INTO price_identities_fts(price_identities_fts, rowid, match_text)
  WITH RECURSIVE split(rest, word) AS (
    SELECT trim(old.match_text) || ' ', ''
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
  SELECT 'delete', old.rowid,
         old.match_text || COALESCE(' ' || group_concat('qx' || term || 'xq', ' '), '')
  FROM canon WHERE length(term) < 3;
  INSERT INTO price_identities_fts(rowid, match_text)
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
