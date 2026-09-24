-- D1 row-read audit, 2026-08-25.
--
-- Normal enrichment writes always populate match_text, so this partial index
-- contains only legacy/anomalous rows that the resolution drain must heal.
-- It has near-zero steady-state storage and write amplification.
CREATE INDEX IF NOT EXISTS ix_offer_enrichments_match_text_missing
  ON offer_enrichments(id)
  WHERE match_text IS NULL AND (name IS NOT NULL OR name_ar IS NOT NULL);

-- Normal enrichment writes also carry both current Arabic Builder shadow
-- versions. This partial index is empty on the production export and turns
-- the 72/day repair check into an empty exceptional-row probe.
CREATE INDEX IF NOT EXISTS ix_offer_enrichments_arabic_shadow_missing
  ON offer_enrichments(enriched_at DESC, id)
  WHERE CASE WHEN extraction_json IS NULL THEN 1
    WHEN json_valid(extraction_json) THEN (
      COALESCE(json_extract(extraction_json, '$._arabic_builder.builder_score_version'), '')
        != 'builder-score-v1' OR
      COALESCE(json_extract(extraction_json, '$._arabic_builder.commerce_score_version'), '')
        != 'commerce-score-v1')
    ELSE 0 END;
