-- S5.0 — open `offer_extraction_attempts.source` so processor ids are DATA.
--
-- VISION-PIPELINE.md C-9. The table already is what C-9 asks for: one row per
-- (offer, processor) holding that processor's latest output. 'vision' and 'ocr'
-- are processor ids in everything but name. The ONLY thing making it a closed
-- set is the CHECK constraint, and a CHECK enumerating processors is precisely
-- the coupling C-9 forbids — it makes "add a processor" a schema change.
--
-- WHY THIS IS A REMOVAL AND NOT A WIDENING. §12 previously scoped this (as S6)
-- as "a one-line additive CHECK-constraint change". It is not: SQLite's
-- ALTER TABLE cannot modify a CHECK at all, so the 12-step rebuild below is
-- required whether the constraint gains one value or loses all of them.
-- Widening to three values therefore pays the full cost of a rebuild and STILL
-- leaves an enumeration of processors in the schema, forcing another rebuild
-- for the next processor. Rebuild once; let the registry (src/recovery/
-- registry.js) be the authority on what may run.
--
-- WHAT IS DELIBERATELY UNCHANGED. The PRIMARY KEY stays (offer_id, source):
-- one LATEST row per processor is exactly right, and append-only attempt
-- history belongs to offer_recovery_attempts, not here. No column is added,
-- renamed, retyped or dropped. A row copied by this migration is byte-identical
-- to the row it replaces.
--
-- ⚠️ OPERATIONAL NOTE — RUN THIS WITH THE ENRICH CRONS PAUSED IF YOU CAN.
-- SQLite cannot rebuild a table in place, so there is a window between the
-- INSERT...SELECT and the RENAME in which a concurrent write goes to the old
-- table and is dropped with it. THE BLAST RADIUS IS BOUNDED AND SELF-HEALING,
-- and is stated here so nobody has to guess: a lost attempt row makes that offer
-- look un-attempted to S1, so it is re-admitted and re-extracted on the next
-- drain. The cost is up to a handful of extra model calls, not lost data — the
-- offers row and the canonical enrichment are in different tables and are not
-- touched. Pausing the 1-minute visionDrain fire removes even that.

CREATE TABLE offer_extraction_attempts_rebuilt (
  offer_id       TEXT NOT NULL,
  -- OPAQUE PROCESSOR ID. No CHECK, by decision (C-9): the set of processors is
  -- operational, not structural, and must never require a migration to extend.
  -- Today: 'vision' (primary), 'ocr'. Tomorrow whatever the registry declares.
  source         TEXT NOT NULL,
  output         TEXT,               -- JSON observation (Vision object/OCR text)
  validation     TEXT NOT NULL,      -- JSON deterministic validation result
  confidence     REAL,
  model          TEXT,
  crop_url       TEXT,
  accepted       INTEGER NOT NULL DEFAULT 0,
  attempted_at   TEXT NOT NULL,
  PRIMARY KEY (offer_id, source)
);

INSERT INTO offer_extraction_attempts_rebuilt
  (offer_id, source, output, validation, confidence, model, crop_url, accepted, attempted_at)
SELECT
  offer_id, source, output, validation, confidence, model, crop_url, accepted, attempted_at
FROM offer_extraction_attempts;

DROP TABLE offer_extraction_attempts;

ALTER TABLE offer_extraction_attempts_rebuilt RENAME TO offer_extraction_attempts;
