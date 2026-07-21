-- migrate-2026-07-vision-jobs.sql — adds the Background Manual Vision job table
-- (Vision Milestone 2 §2) to an ALREADY-DEPLOYED database (new deployments get
-- it from schema.sql). Apply once:
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-vision-jobs.sql
--
-- One durable row per manual "Run Vision" job (id 'active' = the single running
-- job). The self-continuing /enrich/step chain updates it after every batch so
-- the Operations Center can show live progress even after the browser closes.

CREATE TABLE IF NOT EXISTS vision_jobs (
  id             TEXT PRIMARY KEY,   -- 'active' (single live job); history rows keep their id
  status         TEXT NOT NULL,      -- 'running' | 'done' | 'stopped' | 'error'
  scope          TEXT,               -- 'all' | 'debris'
  total          INTEGER,            -- queue depth captured at start (for % + ETA)
  processed      INTEGER,            -- offers scanned so far
  enriched       INTEGER,            -- offers a name was read from
  declined       INTEGER,            -- offers the model declined (NULL-names rows)
  failed         INTEGER,            -- offers skipped on an isolated error
  remaining      INTEGER,            -- countDebris after the latest hop
  hops           INTEGER,            -- batches run so far (runaway guard)
  started_at     TEXT NOT NULL,
  updated_at     TEXT,
  finished_at    TEXT,
  last_error     TEXT,               -- most recent batch error, if any
  provider_limit TEXT,               -- JSON: last observed 429 rate-limit signal
  origin         TEXT                -- 'ops' (operator) — matches ops_runs.origin
);
