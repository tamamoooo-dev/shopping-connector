-- S5.1 — the Recovery Queue platform (VISION-PIPELINE.md §6 S5, C-8, C-9).
--
-- Two tables, both processor-agnostic. Read C-9 before changing either: the
-- design constraint is that adding "Vision Large Processor" tomorrow must be one
-- new module plus one registry line, touching NO schema and NO migration. Every
-- shape below exists to keep that true.
--
-- WHAT IS NOT HERE, DELIBERATELY:
--   • No CHECK enumerating processor ids. `processor` is opaque TEXT.
--   • No per-processor column (no `ocr_attempts`, no `vision_medium_status`).
--   • No per-processor status value. `offer_ocr_queue.status = 'ocr_pending'`
--     is the anti-pattern this replaces: a queue whose lifecycle vocabulary
--     names its processor cannot outlive that processor.
--   • No admission taxonomy. There is ONE admission rule (C-9) — the offer did
--     not become a servable canonical product — and the cause is metadata.
--
-- PREREQUISITE: migrate-2026-07-26-acceptance-verdicts.sql. Every triage read
-- joins `offer_acceptance_verdicts`, because a queued item must be actionable
-- without re-running the gate (§6 S5). The ORDER of the two migrations does not
-- matter — createRecoveryQueue() probes for all three tables and reports
-- not-ready until they are all present, degrading to pre-S5 behaviour rather
-- than half-working — but recovery cannot be drained until both are applied.
--
-- WHY TWO TABLES AND NOT ONE. They answer different questions and neither is
-- derivable from the other. `offer_recovery_queue` is CURRENT WORK STATE, keyed
-- by offer, one row, upserted. `offer_recovery_attempts` is APPEND-ONLY HISTORY,
-- many rows per offer. Collapsing them would either lose history on the second
-- attempt or make "what is queued right now" a GROUP BY over a growing log.

-- ---------------------------------------------------------------------------
-- The queue. Stores work state. Knows nothing about who will do the work.
CREATE TABLE IF NOT EXISTS offer_recovery_queue (
  offer_id     TEXT PRIMARY KEY,
  -- LIFECYCLE VERBS ONLY. Every value here must remain meaningful when every
  -- processor that exists today has been replaced:
  --   queued     awaiting an operator decision (Manual) or a drain (Auto)
  --   claimed    a processor holds the lease; see claimed_by / claim_until
  --   resolved   the offer became a servable canonical product. ONLY S4 sets
  --              this — a processor never closes its own item (C-9)
  --   exhausted  attempts spent with no armed processor left to try
  --   dismissed  terminal operator rejection (S7). Re-entry is an explicit act
  --              only, mirroring registry `resetVerdicts`
  status       TEXT NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued', 'claimed', 'resolved', 'exhausted', 'dismissed')),
  -- ENQUEUE-TIME SNAPSHOT of why this offer was not a servable canonical
  -- product. Metadata, never admission logic — nothing reads this to decide
  -- whether the row belongs here (C-9). JSON so a future mandatory rule can
  -- record itself without a migration:
  --   {"servable":false,
  --    "acceptance":{"version":"business-acceptance-v1","missing":["comparable_quantity"]},
  --    "qualityGate":["brand_missing_or_invalid"]}
  --
  -- THIS IS NOT A DUPLICATE of offer_acceptance_verdicts, and must not be
  -- "de-duplicated" away. That table holds the CURRENT verdict and is upserted
  -- as the offer is re-judged; this column holds what was true WHEN IT ENTERED
  -- (or last re-entered) and is untouched by recovery. Before/after is the
  -- whole point — with
  -- offer_recovery_attempts.missing_before/after it forms one series showing
  -- which processor actually fixed which condition.
  reasons      TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  -- Lease, same pattern as vision_jobs.lease_until: durable state, not control
  -- flow, so a Worker eviction mid-run cannot strand an item forever. Holds an
  -- opaque processor id — the queue never interprets it.
  claimed_by   TEXT,
  claim_until  TEXT,
  -- FENCING TOKEN. Fresh per successful claim, and the thing every post-claim
  -- write re-asserts ownership against. `claim_until` alone cannot do this: it
  -- says when a lease ends, not whether the worker about to commit is the one
  -- that still holds it. A worker that runs past its lease finds its token
  -- replaced and its whole batch rolls back rather than overwriting the result
  -- of whoever took the item next. See recoveryQueue.js claimFenceStatements.
  claim_token  TEXT,
  next_attempt_at TEXT,
  last_error   TEXT,
  -- QUEUE metadata only: enqueue origin, dispatching operator. Processor-shaped
  -- payloads go to offer_recovery_attempts or offer_extraction_attempts.output.
  -- Stated so this does not become the junk drawer that per-processor columns
  -- were forbidden to be.
  meta         TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  -- EVIDENCE GENERATION. When the item last entered (or re-entered) the queue.
  -- `created_at` cannot serve: it is preserved across re-entry on purpose, so
  -- "how long has this offer been a problem" stays answerable. This moves.
  --
  -- It is what makes attempt history comparable to the CURRENT observation. A
  -- re-extraction resets `attempts` because the evidence changed; without a
  -- matching marker, a processor that ran and found nothing against the OLD
  -- crop would go on excluding itself from the new one forever, and the reset
  -- counter would be the only half of the reset that worked.
  queued_at    TEXT
);

-- The drain read: "what is ready to work, oldest first".
CREATE INDEX IF NOT EXISTS ix_recovery_queue_ready
  ON offer_recovery_queue(status, next_attempt_at, updated_at);

-- ---------------------------------------------------------------------------
-- Attempt history. Append-only. One row per processor run, ever.
CREATE TABLE IF NOT EXISTS offer_recovery_attempts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id       TEXT NOT NULL,
  -- OPAQUE. 'ocr' | 'vision-medium' | 'human' | anything a registry declares.
  -- No CHECK: see the header.
  processor      TEXT NOT NULL,
  attempt_no     INTEGER NOT NULL,
  -- GENERIC VERBS, like status. `no_change` and `declined` are distinct on
  -- purpose: a processor that ran and found nothing is a calibration signal
  -- ("stop paying for this processor on this condition"), while one that
  -- refused to run is not.
  outcome        TEXT NOT NULL
                 CHECK (outcome IN ('recovered', 'no_change', 'failed', 'declined')),
  -- THE PAYOFF METRIC, and the reason this table exists at all. Per-condition
  -- before/after, from S4 both times. It answers the only question that should
  -- drive recovery spend — "which processor actually fixes which condition" —
  -- and it does so without the queue knowing what any processor IS.
  missing_before TEXT,
  missing_after  TEXT,
  -- Processor-reported and OPAQUE to the queue: the queue never reasons about
  -- cost, it only records what it was told so an operator can read it. Keeping
  -- cost logic out of the queue is what lets a processor with a completely
  -- different cost model plug in unchanged.
  cost           TEXT,
  actor          TEXT,              -- human processors (S7): who
  error          TEXT,
  started_at     TEXT NOT NULL,
  finished_at    TEXT
);

CREATE INDEX IF NOT EXISTS ix_recovery_attempts_offer
  ON offer_recovery_attempts(offer_id, id);

-- The calibration read: per-processor effectiveness by outcome.
CREATE INDEX IF NOT EXISTS ix_recovery_attempts_processor
  ON offer_recovery_attempts(processor, outcome);

-- The automatic-selection read: "has this processor already SETTLED this offer,
-- against the evidence it is queued on now". Covers the NOT EXISTS in
-- recoveryQueue.list(), which is evaluated once per candidate row.
CREATE INDEX IF NOT EXISTS ix_recovery_attempts_selection
  ON offer_recovery_attempts(offer_id, processor, outcome, started_at);

-- ---------------------------------------------------------------------------
-- Fold in offer_ocr_queue rather than running two queues (C-9: one queue, one
-- admission rule). Idempotent — DO NOTHING on conflict — so re-applying this
-- migration cannot resurrect an item an operator has since resolved.
--
-- The old table is deliberately LEFT IN PLACE and simply stops being read, so
-- a rollback is a code deploy rather than a data restore. Drop it a release
-- later, once the new queue has been observed working.
--
-- Status mapping: 'ocr_pending' -> 'queued', 'completed' -> 'resolved'.
-- `servable:false` is asserted rather than measured because that is exactly
-- what put a row in offer_ocr_queue: it was written on the Quality-Gate reject
-- branch, which by construction wrote no canonical row.
INSERT INTO offer_recovery_queue
  (offer_id, status, reasons, attempts, next_attempt_at, last_error, meta,
   created_at, updated_at, queued_at)
SELECT
  q.offer_id,
  CASE q.status WHEN 'completed' THEN 'resolved' ELSE 'queued' END,
  json_object(
    'servable', json('false'),
    'qualityGate',
    CASE WHEN json_valid(q.trigger_reasons) THEN json(q.trigger_reasons) ELSE json('[]') END
  ),
  q.attempts,
  q.next_attempt_at,
  q.last_error,
  json_object('migratedFrom', 'offer_ocr_queue'),
  q.created_at,
  q.updated_at,
  -- Generation marker for a row that predates the concept. `created_at` is the
  -- honest answer: the legacy queue had no re-entry, so the row has only ever
  -- been on one generation of evidence, and no recovery attempt exists that
  -- could be older than it.
  q.created_at
FROM offer_ocr_queue q
-- `WHERE true` is REQUIRED, not decoration: in INSERT...SELECT form SQLite
-- cannot tell a trailing ON CONFLICT from a join's ON clause, and rejects the
-- statement without a WHERE to close the SELECT. Do not "tidy" it away.
-- Deliberately not `INSERT OR IGNORE`, which would also silently skip rows that
-- violated the status CHECK — if the mapping above is ever wrong, this
-- migration must fail loudly rather than drop queue items on the floor.
WHERE true
ON CONFLICT(offer_id) DO NOTHING;
