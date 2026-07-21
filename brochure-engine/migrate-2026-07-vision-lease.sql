-- migrate-2026-07-vision-lease.sql — adds the single-writer lease column to the
-- Background Manual Vision job table (continuous cron-driven drain). Apply once:
--   npx wrangler d1 execute brochure-engine --remote --file=./migrate-2026-07-vision-lease.sql
--
-- lease_until is an ISO timestamp: while a 1-minute `visionDrain` fire is draining
-- it holds a short lease; other fires (and the steady 10/30/50 drain) see the
-- live lease / running status and skip, so there is never more than one active
-- resolution writer. A crashed fire's lease simply expires and the next tick resumes.

ALTER TABLE vision_jobs ADD COLUMN lease_until TEXT;
