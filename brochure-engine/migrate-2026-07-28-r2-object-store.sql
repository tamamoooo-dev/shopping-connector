-- R2 is now the primary brochure object store. The temporary KV daily-write
-- reservation table is no longer read or written by the Worker.
DROP TABLE IF EXISTS brochure_collection_write_quota;
