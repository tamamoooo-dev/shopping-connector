-- Mini marts: the owner's name for a shop, in Arabic and English (2026-11-14).
-- The owner: "the mini mart name in arabic is كيو in english is Q" (Q's
-- Snapchat profile name is "محمد عمر / كيو🛒").
--   minimart_shops.name_ar / name_en: shown instead of `title`, the profile
--     name, which every story check refreshes. NULL = the profile name.
--
-- Additive only. Apply BEFORE deploying the engine that reads these columns:
--   npx wrangler d1 execute brochure-engine --remote --file=migrate-2026-11-14-minimart-shop-names.sql --yes
ALTER TABLE minimart_shops ADD COLUMN name_ar TEXT;
ALTER TABLE minimart_shops ADD COLUMN name_en TEXT;
