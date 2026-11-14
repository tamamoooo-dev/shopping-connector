-- Mini marts: a shop whose offers a person presents in videos (2026-11-14).
-- The owner replaced عروض البركة (closed) with Q (كيو, m7.omar1): "q is not
-- mini market but their marketing style is similar to them", and "since there
-- is a person grabbing the products .. i want you to find a solution for it
-- either you eliminate him from the photo or find another way".
--   minimart_shops.style = 'presenter': one product a video, its price the
--     LAST one the video shows (earlier ones are other shops' prices or the
--     price still drawing in), and the card shows a crop of the product
--     (src/minimartCrop.js). NULL = as before.
--   minimart_offers.crop_key: R2 key of the offer's product crop (NULL = none);
--   minimart_offers.crop_of: the image_key the crop was made from (so a new
--     picture is cropped again). crop_of = image_key with crop_key NULL: no
--     crop stood (the card shows no picture).
--
-- Additive only. Apply BEFORE deploying the engine that reads these columns:
--   npx wrangler d1 execute brochure-engine --remote --file=migrate-2026-11-14-minimart-presenter.sql --yes
ALTER TABLE minimart_shops ADD COLUMN style TEXT;
ALTER TABLE minimart_offers ADD COLUMN crop_key TEXT;
ALTER TABLE minimart_offers ADD COLUMN crop_of TEXT;
