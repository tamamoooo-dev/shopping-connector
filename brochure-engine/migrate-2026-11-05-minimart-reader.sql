-- Mini marts: the PC reader (Claude Haiku 5.5 on the owner's PC, pc-reader/).
-- While it is on, the */2 tick prepares new snaps (pictures in R2) and the
-- reader claims them; Mistral reads whatever it leaves. reread = 1: a read
-- snap queued to be read again by the reader (the owner's one-time re-read).
ALTER TABLE minimart_snaps ADD COLUMN pictures TEXT;
ALTER TABLE minimart_snaps ADD COLUMN prepared_at TEXT;
ALTER TABLE minimart_snaps ADD COLUMN reader TEXT;
ALTER TABLE minimart_snaps ADD COLUMN claimed_at TEXT;
ALTER TABLE minimart_snaps ADD COLUMN reread INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS minimart_reader (
  name        TEXT PRIMARY KEY,
  seen_at     TEXT,
  last_run_at TEXT,
  last_run    TEXT
);
