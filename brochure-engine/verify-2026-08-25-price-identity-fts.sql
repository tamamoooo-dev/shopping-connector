-- Read-only production acceptance checks for the 2026-08-25 FTS rollout.
-- Contentless FTS5 tables cannot be scanned directly, so complete coverage is
-- established by the two migration result counts plus FTS integrity-check.

SELECT COUNT(*) AS identity_count, MIN(rowid) AS min_rowid, MAX(rowid) AS max_rowid
FROM price_identities;

SELECT name, type
FROM sqlite_schema
WHERE type = 'trigger'
  AND name IN (
    'price_identities_fts_ai',
    'price_identities_fts_ad',
    'price_identities_fts_au'
  )
ORDER BY name;

SELECT 'legacy_milk' AS sample, group_concat(id, '|') AS ids
FROM (
  SELECT id
  FROM price_identities p
  WHERE p.match_text LIKE '%milk%'
     OR p.match_text LIKE '%حليب%'
     OR p.match_text LIKE '%لبن%'
  ORDER BY CASE
    WHEN (' ' || p.match_text || ' ') LIKE '% milk %'
      OR (' ' || p.match_text || ' ') LIKE '% حليب %'
      OR (' ' || p.match_text || ' ') LIKE '% لبن %' THEN 2
    WHEN (' ' || p.match_text) LIKE '% milk%'
      OR (' ' || p.match_text) LIKE '% حليب%'
      OR (' ' || p.match_text) LIKE '% لبن%' THEN 1
    ELSE 0 END DESC,
    p.last_price ASC
  LIMIT 10
);

WITH g0(rowid) AS (
  SELECT rowid
  FROM price_identities_fts
  WHERE price_identities_fts MATCH
    '("mil" AND "ilk") OR ("حلي" AND "ليب") OR ("لبن")'
)
SELECT 'indexed_milk' AS sample, group_concat(id, '|') AS ids
FROM (
  SELECT p.id
  FROM g0 c
  CROSS JOIN price_identities p ON p.rowid = c.rowid
  WHERE p.match_text LIKE '%milk%'
     OR p.match_text LIKE '%حليب%'
     OR p.match_text LIKE '%لبن%'
  ORDER BY CASE
    WHEN (' ' || p.match_text || ' ') LIKE '% milk %'
      OR (' ' || p.match_text || ' ') LIKE '% حليب %'
      OR (' ' || p.match_text || ' ') LIKE '% لبن %' THEN 2
    WHEN (' ' || p.match_text) LIKE '% milk%'
      OR (' ' || p.match_text) LIKE '% حليب%'
      OR (' ' || p.match_text) LIKE '% لبن%' THEN 1
    ELSE 0 END DESC,
    p.last_price ASC
  LIMIT 10
);

SELECT 'legacy_rice' AS sample, group_concat(id, '|') AS ids
FROM (
  SELECT id
  FROM price_identities p
  WHERE p.match_text LIKE '%rice%'
     OR p.match_text LIKE '%رز%'
     OR p.match_text LIKE '%ارز%'
  ORDER BY CASE
    WHEN (' ' || p.match_text || ' ') LIKE '% rice %'
      OR (' ' || p.match_text || ' ') LIKE '% رز %'
      OR (' ' || p.match_text || ' ') LIKE '% ارز %' THEN 2
    WHEN (' ' || p.match_text) LIKE '% rice%'
      OR (' ' || p.match_text) LIKE '% رز%'
      OR (' ' || p.match_text) LIKE '% ارز%' THEN 1
    ELSE 0 END DESC,
    p.last_price ASC
  LIMIT 10
);

WITH g0(rowid) AS (
  SELECT rowid
  FROM price_identities_fts
  WHERE price_identities_fts MATCH
    '("ric" AND "ice") OR ("qxر" AND "xرز" AND "رزx" AND "زxq") OR ("ارز")'
)
SELECT 'indexed_rice' AS sample, group_concat(id, '|') AS ids
FROM (
  SELECT p.id
  FROM g0 c
  CROSS JOIN price_identities p ON p.rowid = c.rowid
  WHERE p.match_text LIKE '%rice%'
     OR p.match_text LIKE '%رز%'
     OR p.match_text LIKE '%ارز%'
  ORDER BY CASE
    WHEN (' ' || p.match_text || ' ') LIKE '% rice %'
      OR (' ' || p.match_text || ' ') LIKE '% رز %'
      OR (' ' || p.match_text || ' ') LIKE '% ارز %' THEN 2
    WHEN (' ' || p.match_text) LIKE '% rice%'
      OR (' ' || p.match_text) LIKE '% رز%'
      OR (' ' || p.match_text) LIKE '% ارز%' THEN 1
    ELSE 0 END DESC,
    p.last_price ASC
  LIMIT 10
);

WITH short_rice(rowid) AS (
  SELECT rowid
  FROM price_identities_fts
  WHERE price_identities_fts MATCH
    '("qxر" AND "xرز" AND "رزx" AND "زxq")'
)
SELECT 'short_rice_sentinel' AS sample, COUNT(*) AS hits
FROM short_rice c
CROSS JOIN price_identities p ON p.rowid = c.rowid
WHERE (' ' || p.match_text || ' ') LIKE '% رز %';

SELECT 'legacy_nova_water' AS sample, group_concat(id, '|') AS ids
FROM (
  SELECT id
  FROM price_identities p
  WHERE (p.match_text LIKE '%nova%' OR p.match_text LIKE '%نوفا%')
    AND (p.match_text LIKE '%water%' OR p.match_text LIKE '%ماء%'
      OR p.match_text LIKE '%مياه%' OR p.match_text LIKE '%مويه%')
  ORDER BY
    (CASE
      WHEN (' ' || p.match_text || ' ') LIKE '% nova %'
        OR (' ' || p.match_text || ' ') LIKE '% نوفا %' THEN 2
      WHEN (' ' || p.match_text) LIKE '% nova%'
        OR (' ' || p.match_text) LIKE '% نوفا%' THEN 1
      ELSE 0 END)
    +
    (CASE
      WHEN (' ' || p.match_text || ' ') LIKE '% water %'
        OR (' ' || p.match_text || ' ') LIKE '% ماء %'
        OR (' ' || p.match_text || ' ') LIKE '% مياه %'
        OR (' ' || p.match_text || ' ') LIKE '% مويه %' THEN 2
      WHEN (' ' || p.match_text) LIKE '% water%'
        OR (' ' || p.match_text) LIKE '% ماء%'
        OR (' ' || p.match_text) LIKE '% مياه%'
        OR (' ' || p.match_text) LIKE '% مويه%' THEN 1
      ELSE 0 END) DESC,
    p.last_price ASC
  LIMIT 10
);

WITH g0(rowid) AS (
  SELECT rowid
  FROM price_identities_fts
  WHERE price_identities_fts MATCH
    '("nov" AND "ova") OR ("نوف" AND "وفا")'
), g1(rowid) AS (
  SELECT rowid
  FROM price_identities_fts
  WHERE price_identities_fts MATCH
    '("wat" AND "ate" AND "ter") OR ("ماء") OR ("ميا" AND "ياه") OR ("موي" AND "ويه")'
), candidates(rowid) AS (
  SELECT rowid FROM g0
  INTERSECT
  SELECT rowid FROM g1
)
SELECT 'indexed_nova_water' AS sample, group_concat(id, '|') AS ids
FROM (
  SELECT p.id
  FROM candidates c
  CROSS JOIN price_identities p ON p.rowid = c.rowid
  WHERE (p.match_text LIKE '%nova%' OR p.match_text LIKE '%نوفا%')
    AND (p.match_text LIKE '%water%' OR p.match_text LIKE '%ماء%'
      OR p.match_text LIKE '%مياه%' OR p.match_text LIKE '%مويه%')
  ORDER BY
    (CASE
      WHEN (' ' || p.match_text || ' ') LIKE '% nova %'
        OR (' ' || p.match_text || ' ') LIKE '% نوفا %' THEN 2
      WHEN (' ' || p.match_text) LIKE '% nova%'
        OR (' ' || p.match_text) LIKE '% نوفا%' THEN 1
      ELSE 0 END)
    +
    (CASE
      WHEN (' ' || p.match_text || ' ') LIKE '% water %'
        OR (' ' || p.match_text || ' ') LIKE '% ماء %'
        OR (' ' || p.match_text || ' ') LIKE '% مياه %'
        OR (' ' || p.match_text || ' ') LIKE '% مويه %' THEN 2
      WHEN (' ' || p.match_text) LIKE '% water%'
        OR (' ' || p.match_text) LIKE '% ماء%'
        OR (' ' || p.match_text) LIKE '% مياه%'
        OR (' ' || p.match_text) LIKE '% مويه%' THEN 1
      ELSE 0 END) DESC,
    p.last_price ASC
  LIMIT 10
);

WITH g0(rowid) AS (
  SELECT rowid FROM price_identities_fts
  WHERE price_identities_fts MATCH
    '("def" AND "efi" AND "fin" AND "ini" AND "nit" AND "ite" AND "tel" AND "ely")'
), g1(rowid) AS (
  SELECT rowid FROM price_identities_fts
  WHERE price_identities_fts MATCH '("not")'
), g2(rowid) AS (
  SELECT rowid FROM price_identities_fts
  WHERE price_identities_fts MATCH
    '("qxi" AND "xin" AND "inx" AND "nxq")'
), g3(rowid) AS (
  SELECT rowid FROM price_identities_fts
  WHERE price_identities_fts MATCH '("thi" AND "his")'
), g4(rowid) AS (
  SELECT rowid FROM price_identities_fts
  WHERE price_identities_fts MATCH
    '("cat" AND "ata" AND "tal" AND "alo" AND "log")'
), candidates(rowid) AS (
  SELECT rowid FROM g0
  INTERSECT SELECT rowid FROM g1
  INTERSECT SELECT rowid FROM g2
  INTERSECT SELECT rowid FROM g3
  INTERSECT SELECT rowid FROM g4
)
SELECT 'genuine_miss' AS sample, COUNT(*) AS hits
FROM candidates c
CROSS JOIN price_identities p ON p.rowid = c.rowid
WHERE p.match_text LIKE '%definitely%'
  AND p.match_text LIKE '%not%'
  AND p.match_text LIKE '%in%'
  AND p.match_text LIKE '%this%'
  AND p.match_text LIKE '%catalog%';

EXPLAIN QUERY PLAN
WITH g0(rowid) AS (
  SELECT rowid FROM price_identities_fts
  WHERE price_identities_fts MATCH '("nov" AND "ova") OR ("نوف" AND "وفا")'
), g1(rowid) AS (
  SELECT rowid FROM price_identities_fts
  WHERE price_identities_fts MATCH
    '("wat" AND "ate" AND "ter") OR ("ماء") OR ("ميا" AND "ياه") OR ("موي" AND "ويه")'
), candidates(rowid) AS (
  SELECT rowid FROM g0 INTERSECT SELECT rowid FROM g1
)
SELECT p.id
FROM candidates c
CROSS JOIN price_identities p ON p.rowid = c.rowid
WHERE (p.match_text LIKE '%nova%' OR p.match_text LIKE '%نوفا%')
  AND (p.match_text LIKE '%water%' OR p.match_text LIKE '%ماء%'
    OR p.match_text LIKE '%مياه%' OR p.match_text LIKE '%مويه%')
ORDER BY p.last_price
LIMIT 10;

EXPLAIN QUERY PLAN
WITH g0(rowid) AS (
  SELECT rowid FROM price_identities_fts
  WHERE price_identities_fts MATCH
    '("def" AND "efi" AND "fin" AND "ini" AND "nit" AND "ite" AND "tel" AND "ely")'
), g1(rowid) AS (
  SELECT rowid FROM price_identities_fts
  WHERE price_identities_fts MATCH '("not")'
), candidates(rowid) AS (
  SELECT rowid FROM g0 INTERSECT SELECT rowid FROM g1
)
SELECT p.id
FROM candidates c
CROSS JOIN price_identities p ON p.rowid = c.rowid
WHERE p.match_text LIKE '%definitely%'
  AND p.match_text LIKE '%not%'
LIMIT 10;
