-- Registry / Identity Builder integration (apply once to an existing D1).
-- Additive only: no existing Product Registry row, Product ID, or downstream
-- table changes. This task does not execute the migration or touch production.

ALTER TABLE offer_enrichments ADD COLUMN identity_candidate TEXT;
ALTER TABLE offer_enrichments ADD COLUMN identity_candidate_version TEXT;
