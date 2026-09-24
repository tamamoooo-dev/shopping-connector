-- Optional schema rollback AFTER the prior Worker build is restored.
-- Deletes derived search/index structures only. It does not update/delete
-- price_identities, price_history, offers, enrichments, or any user data.

DROP TRIGGER IF EXISTS price_identities_fts_ai;
DROP TRIGGER IF EXISTS price_identities_fts_ad;
DROP TRIGGER IF EXISTS price_identities_fts_au;
DROP TABLE IF EXISTS price_identities_fts;

DROP INDEX IF EXISTS ix_offer_enrichments_arabic_shadow_missing;
DROP INDEX IF EXISTS ix_offer_enrichments_match_text_missing;
