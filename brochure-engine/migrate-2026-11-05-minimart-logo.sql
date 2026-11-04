-- Mini marts: is a shop's Snapchat picture its own logo? (2026-11-05)
-- The Brochures tile shows the picture only when it is the shop's logo, and
-- the shop's name otherwise (owner: "if you dont have a logo write the name of
-- the shop dont show the snapchat logo"). Decided once per picture by the
-- reader (minimarts.js PICTURE_PROMPT): picture_kind is logo | photo |
-- snapchat, picture_kind_of the picture address it was decided for, so a new
-- picture is looked at again.
--
-- Apply BEFORE deploying the engine that reads these columns:
--   npx wrangler d1 execute brochure-engine --remote --file=migrate-2026-11-05-minimart-logo.sql
ALTER TABLE minimart_shops ADD COLUMN picture_kind TEXT;
ALTER TABLE minimart_shops ADD COLUMN picture_kind_of TEXT;
