-- Policy B navigation provenance.
--
-- Existing local links were created by the pre-Policy-B dual-evidence gate, so
-- they are safely backfilled as `dual`. New ingestion may additionally stamp
-- `hotspot_unique` only when one page contains the exact offer hotspot and the
-- navigation trust circuit is closed.

ALTER TABLE offers ADD COLUMN navigation_provenance TEXT
  CHECK(navigation_provenance IS NULL
    OR navigation_provenance IN ('dual', 'hotspot_unique'));

UPDATE offers
   SET navigation_provenance = 'dual'
 WHERE brochure_id IS NOT NULL
   AND page_index IS NOT NULL
   AND navigation_provenance IS NULL;

CREATE INDEX IF NOT EXISTS ix_offers_navigation_provenance
  ON offers(navigation_provenance, valid_to);
