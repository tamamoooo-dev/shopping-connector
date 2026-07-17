-- migrate-2026-07-profiles.sql — one-time delta for the LIVE D1 database:
-- Price Watches become PROFILE-SCOPED (Local Profile milestone). Adds the
-- owning-profile column to watches; existing rows stay NULL and are claimed
-- by the first profile to call GET /watches (adoptOrphans — this personal
-- tool's single pre-profile user). Purely additive; the canonical schema for
-- fresh installs is schema.sql (kept in sync).
--
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-profiles.sql

ALTER TABLE watches ADD COLUMN profile_id TEXT;

-- Profile-scoped reads and the per-profile cap gate.
CREATE INDEX IF NOT EXISTS ix_watches_profile ON watches(profile_id, active);
