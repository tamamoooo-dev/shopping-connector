-- Replace the runtime Recovery path with repeated Vision verification.

CREATE TABLE IF NOT EXISTS offer_vision_verification_queue (
  offer_id            TEXT PRIMARY KEY,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'claimed', 'verified')),
  attempts            INTEGER NOT NULL DEFAULT 1,
  claimed_by          TEXT,
  claim_until         TEXT,
  claim_token         TEXT,
  last_error          TEXT,
  initial_outcome     TEXT NOT NULL
                      CHECK (initial_outcome IN ('accepted', 'rejected')),
  matched_fingerprint TEXT,
  match_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  verified_at         TEXT
);

CREATE INDEX IF NOT EXISTS ix_vision_verification_ready
  ON offer_vision_verification_queue(status, claim_until, updated_at);

INSERT INTO offer_vision_verification_queue
  (offer_id, status, attempts, initial_outcome, matched_fingerprint,
   match_count, created_at, updated_at)
SELECT v.offer_id, 'queued', 1,
       CASE WHEN v.accepted=1 THEN 'accepted' ELSE 'rejected' END,
       '[]', 0, v.attempted_at, v.attempted_at
  FROM offer_extraction_attempts v
 JOIN offers o ON o.id=v.offer_id
 WHERE v.source='vision'
   AND o.valid_to>=date('now')
   AND o.image_url IS NOT NULL
ON CONFLICT(offer_id) DO NOTHING;

UPDATE offer_enrichments
   SET corroboration=NULL, mint_verdict=NULL
 WHERE id IN (SELECT offer_id FROM offer_vision_verification_queue)
   AND id NOT IN (
     SELECT offer_id FROM offer_vision_verification_queue WHERE status='verified'
   );
