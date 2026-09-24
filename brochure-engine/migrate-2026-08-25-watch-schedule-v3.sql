-- Price Monitoring v3: explicit Amazon-vs-market tracks and durable twice-daily runs.
-- Additive and rollback-safe: legacy watch columns and alerts stay untouched.

ALTER TABLE watches ADD COLUMN watch_track TEXT;
ALTER TABLE watches ADD COLUMN system_search_query TEXT;
ALTER TABLE watches ADD COLUMN custom_search_query TEXT;

UPDATE watches
   SET watch_track = CASE
     WHEN kind = 'product' AND provider = 'amazon' AND length(product_id) = 10
       AND upper(substr(product_id, 1, 1)) = 'B'
       AND product_id NOT GLOB '*[^A-Za-z0-9]*'
       THEN 'amazon_exact'
     ELSE 'market_general'
   END
 WHERE watch_track IS NULL;

UPDATE watches
   SET system_search_query = query
 WHERE system_search_query IS NULL;

CREATE TABLE IF NOT EXISTS watch_runs (
  id                  TEXT PRIMARY KEY,
  watch_id            TEXT NOT NULL,
  slot_key            TEXT NOT NULL,
  slot_period         TEXT NOT NULL CHECK (slot_period IN ('AM', 'PM')),
  scheduled_at        TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'running', 'retrying', 'completed', 'incomplete')),
  attempts            INTEGER NOT NULL DEFAULT 0,
  next_attempt_at     TEXT NOT NULL,
  last_attempt_at     TEXT,
  completed_at        TEXT,
  lease_token         TEXT,
  lease_until         TEXT,
  last_resolution     TEXT,
  last_error          TEXT,
  result_json         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (watch_id, slot_key)
);

CREATE INDEX IF NOT EXISTS ix_watch_runs_due
  ON watch_runs(status, next_attempt_at, lease_until);
CREATE INDEX IF NOT EXISTS ix_watch_runs_watch
  ON watch_runs(watch_id, scheduled_at DESC);
