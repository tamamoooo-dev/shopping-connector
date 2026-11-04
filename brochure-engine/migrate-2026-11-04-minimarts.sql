-- Mini marts (2026-11-04): offers small shops post on their PUBLIC Snapchat
-- story (minimarts.js). Additive only. Apply BEFORE deploying the engine:
--   npx wrangler d1 execute brochure-engine --remote --file=migrate-2026-11-04-minimarts.sql
--
-- minimart_shops: the shops the owner follows (a Snapchat username each).
-- minimart_snaps: every story snap seen, read once (status new -> read/failed).
-- minimart_offers: the prices read from those snaps, shown until expires_at.
--   A deal the shop posts again — the next day or weeks later — stays ONE
--   offer: reposts + last_posted_at grow and expires_at moves on; created_at
--   (first seen, the "new" badge) never changes.

CREATE TABLE IF NOT EXISTS minimart_shops (
  username        TEXT PRIMARY KEY,                 -- Snapchat username, lower case
  title           TEXT,                             -- the profile's display name
  address         TEXT,
  picture         TEXT,                             -- profile picture URL
  active          INTEGER NOT NULL DEFAULT 1,       -- 0 = the owner stopped following
  added_at        TEXT NOT NULL,
  next_check_at   TEXT,                             -- next story check (every 2 h)
  last_checked_at TEXT,
  last_status     TEXT,                             -- ok | blocked | not_public | not_found | error
  last_error      TEXT,
  last_post_at    TEXT                              -- newest snap seen
);

CREATE INDEX IF NOT EXISTS ix_minimart_shops_due
  ON minimart_shops(active, next_check_at);

CREATE TABLE IF NOT EXISTS minimart_snaps (
  snap_id     TEXT PRIMARY KEY,
  username    TEXT NOT NULL,
  posted_at   TEXT,
  media_type  TEXT NOT NULL,                        -- image | video
  media_url   TEXT NOT NULL,
  preview_url TEXT,
  status      TEXT NOT NULL DEFAULT 'new',          -- new | read | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  frames      INTEGER NOT NULL DEFAULT 0,           -- video frames cut (Media Transformations)
  readings    INTEGER NOT NULL DEFAULT 0,           -- model calls
  offers      INTEGER NOT NULL DEFAULT 0,
  media_hash  TEXT,                                 -- SHA-256 of the file read
  repeat_of   TEXT,                                 -- the earlier snap this one re-posts (same file)
  offer_ids   TEXT,                                 -- JSON: the offers this snap showed (new or re-posted)
  error       TEXT,
  seen_at     TEXT NOT NULL,
  read_at     TEXT
);

CREATE INDEX IF NOT EXISTS ix_minimart_snaps_status
  ON minimart_snaps(status, seen_at);

CREATE INDEX IF NOT EXISTS ix_minimart_snaps_hash
  ON minimart_snaps(username, media_hash);

CREATE TABLE IF NOT EXISTS minimart_offers (
  id             TEXT PRIMARY KEY,                  -- <snap_id>:<n>
  username       TEXT NOT NULL,
  snap_id        TEXT NOT NULL,                     -- the snap it was first read from
  name           TEXT,
  brand          TEXT,
  size           TEXT,                              -- size of ONE unit, as printed
  count          INTEGER NOT NULL DEFAULT 1,        -- units the price buys ("4 حبات بـ 11.5")
  unit           TEXT,                              -- حبة | كرتون | علبة | …, as printed
  price          REAL NOT NULL,
  was_price      REAL,
  image_key      TEXT,                              -- R2 key of the picture it was read from
  posted_at      TEXT,                              -- first posted
  last_posted_at TEXT,                              -- latest time the shop posted it
  reposts        INTEGER NOT NULL DEFAULT 0,        -- times posted again after the first
  expires_at     TEXT NOT NULL,
  votes          INTEGER NOT NULL DEFAULT 0,        -- readings that agreed on the price
  created_at     TEXT NOT NULL                      -- first seen (the "new" badge)
);

CREATE INDEX IF NOT EXISTS ix_minimart_offers_live
  ON minimart_offers(expires_at);
