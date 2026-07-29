-- Durable resumable-brochure queue. Page-level progress remains in R2/KV.
CREATE TABLE IF NOT EXISTS brochure_collection_jobs (
  store               TEXT NOT NULL,
  region              TEXT NOT NULL,
  status              TEXT NOT NULL CHECK(status IN ('pending', 'complete')),
  advertised_flyers   INTEGER,
  advertised_pages    INTEGER,
  collected_pages     INTEGER,
  last_error          TEXT,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT,
  PRIMARY KEY (store, region)
);

CREATE INDEX IF NOT EXISTS ix_brochure_collection_pending
  ON brochure_collection_jobs(status, updated_at);

-- One-time production recovery seed: current D4D offer stores become pending.
INSERT INTO brochure_collection_jobs
  (store, region, status, advertised_flyers, advertised_pages,
   collected_pages, last_error, updated_at, completed_at)
SELECT DISTINCT store, region, 'pending', NULL, NULL, NULL, NULL,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL
  FROM offers
 WHERE source = 'd4d'
   AND valid_to >= date('now')
ON CONFLICT(store, region) DO UPDATE SET
  status='pending', last_error=NULL,
  updated_at=excluded.updated_at, completed_at=NULL;
