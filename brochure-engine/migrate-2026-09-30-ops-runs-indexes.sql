-- 2026-09-30 — Ops Console reads the audit table per store and per action.
--
-- The console used to read a newest-N window of ops_runs (300 rows for store
-- status, 200 for the Cron Monitor). The Ministral price drain writes three
-- store-less rows a minute, so within ~2 hours every store's last OK run, a
-- failed store's FAIL (what Retry Failed targets) and the weekly pipeline run
-- fell out of that window. The console now asks for exactly those rows
-- (opsStore.latestByStore, opsStore.list({ action })); these indexes make each
-- of them a single index lookup. Additive and idempotent: the code works
-- without them, only with more rows read.
--
-- Apply:
--   wrangler d1 execute brochure-engine --remote --file=migrate-2026-09-30-ops-runs-indexes.sql

CREATE INDEX IF NOT EXISTS ix_ops_runs_store_ok ON ops_runs(store, ok, id);
CREATE INDEX IF NOT EXISTS ix_ops_runs_action ON ops_runs(action, id);
