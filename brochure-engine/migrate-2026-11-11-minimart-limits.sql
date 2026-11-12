-- Mini marts, after the first week (2026-11-11). Additive only. Apply BEFORE
-- deploying the engine:
--   npx wrangler d1 execute brochure-engine --remote --file=migrate-2026-11-11-minimart-limits.sql
--
-- minimart_reader.limited_until: the PC reader said every Claude account it
--   has (the owner's main one, then the backup) is at its limit until then.
--   Mistral reads at once when that is more than 2 h away; otherwise the
--   snaps wait for the reader. limit_note: JSON, each account's reset time.
-- minimart_checks: every story check (status, snaps seen, snaps new), so a
--   block that cleared by itself still shows. Kept 90 days.
ALTER TABLE minimart_reader ADD COLUMN limited_until TEXT;
ALTER TABLE minimart_reader ADD COLUMN limit_note TEXT;

CREATE TABLE IF NOT EXISTS minimart_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  status     TEXT NOT NULL,                         -- ok | blocked | not_public | not_found | error
  error      TEXT,
  snaps      INTEGER NOT NULL DEFAULT 0,            -- snaps on the story
  added      INTEGER NOT NULL DEFAULT 0             -- of them, new
);

CREATE INDEX IF NOT EXISTS ix_minimart_checks_at
  ON minimart_checks(checked_at);
