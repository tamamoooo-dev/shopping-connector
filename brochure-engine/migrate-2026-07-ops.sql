-- migrate-2026-07-ops.sql — adds the Operations Console audit table to an
-- ALREADY-DEPLOYED database (new deployments get it from schema.sql).
-- Apply once:
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-ops.sql

CREATE TABLE IF NOT EXISTS ops_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  action     TEXT NOT NULL,
  origin     TEXT NOT NULL,
  store      TEXT,
  stores     INTEGER,
  ok         INTEGER NOT NULL,
  detected   INTEGER,
  new_count  INTEGER,
  deduped    INTEGER,
  failed     INTEGER,
  offers     INTEGER,
  coverage   REAL,
  elapsed_ms INTEGER,
  error      TEXT,
  detail     TEXT
);

CREATE INDEX IF NOT EXISTS ix_ops_runs_store ON ops_runs(store, id);
CREATE INDEX IF NOT EXISTS ix_ops_runs_origin ON ops_runs(origin, id);
