-- Additive migration for asynchronous Vision-first enrichment.
-- Safe to apply before deploying the Worker; it does not rewrite existing
-- canonical enrichments, Registry rows, Product IDs, or production offers.

CREATE TABLE IF NOT EXISTS offer_extraction_attempts (
  offer_id       TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('vision', 'ocr')),
  output         TEXT,
  validation     TEXT NOT NULL,
  confidence     REAL,
  model          TEXT,
  crop_url       TEXT,
  accepted       INTEGER NOT NULL DEFAULT 0,
  attempted_at   TEXT NOT NULL,
  PRIMARY KEY (offer_id, source)
);

CREATE TABLE IF NOT EXISTS offer_ocr_queue (
  offer_id        TEXT PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'ocr_pending'
                  CHECK (status IN ('ocr_pending', 'completed')),
  trigger_reasons TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_offer_ocr_queue_pending
  ON offer_ocr_queue(status, next_attempt_at, updated_at);
