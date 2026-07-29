-- Price Watch v2 — additive and backward compatible.
-- Existing rows receive strict matching defaults and retain their target state.

ALTER TABLE watches ADD COLUMN size_source TEXT;
ALTER TABLE watches ADD COLUMN identity_query TEXT;
ALTER TABLE watches ADD COLUMN identity_family TEXT;
ALTER TABLE watches ADD COLUMN identity_type TEXT;
ALTER TABLE watches ADD COLUMN brand_id TEXT;
ALTER TABLE watches ADD COLUMN variant_key TEXT;
ALTER TABLE watches ADD COLUMN match_brand INTEGER NOT NULL DEFAULT 1;
ALTER TABLE watches ADD COLUMN match_size INTEGER NOT NULL DEFAULT 1;
ALTER TABLE watches ADD COLUMN match_variant INTEGER NOT NULL DEFAULT 1;
ALTER TABLE watches ADD COLUMN target_unit_price REAL;
ALTER TABLE watches ADD COLUMN unit_label TEXT;
ALTER TABLE watches ADD COLUMN close_threshold REAL;
ALTER TABLE watches ADD COLUMN is_close INTEGER NOT NULL DEFAULT 0;
ALTER TABLE watches ADD COLUMN last_purchase_price REAL;
ALTER TABLE watches ADD COLUMN last_unit_label TEXT;

ALTER TABLE alerts ADD COLUMN purchase_price REAL;
ALTER TABLE alerts ADD COLUMN unit_label TEXT;
ALTER TABLE alerts ADD COLUMN alert_type TEXT NOT NULL DEFAULT 'target';
