-- Additive migration for S4 Business Acceptance verdict persistence (R5, R6).
--
-- VISION-PIPELINE.md §6 S4, §9 R5/R6. Creates ONE new table and touches nothing
-- else: no existing table is altered, no row is rewritten, no index on a hot
-- path is changed. Safe to apply before OR after the Worker deploy — the store
-- probes for this table and skips the write when it is absent, so the two
-- orderings are both non-events (see enrichStore.js `acceptanceVerdictsReady`).
--
-- WHY A TABLE AND NOT COLUMNS ON offer_extraction_attempts. The verdict is a
-- property of the OFFER, not of one extraction attempt: S4 judges the merged
-- product, and the recovery ladder (S5) re-judges the same offer after each
-- rung. `offer_extraction_attempts` is keyed (offer_id, source) — one row PER
-- RUNG — so a verdict stored there would either duplicate per rung or need an
-- arbitrary "which rung owns the verdict" rule. Keyed by offer_id, the current
-- verdict is unambiguous and a re-judgement is an idempotent upsert.
--
-- WHY REJECTIONS ARE STORED TOO (R5). A stored reject with its `missing` list is
-- the ONLY way the mandatory set gets calibrated against real traffic; without
-- it the sole measurable signal is queue depth, which cannot distinguish "the
-- gate is well-tuned" from "the gate rejects everything for one reason".

CREATE TABLE IF NOT EXISTS offer_acceptance_verdicts (
  offer_id        TEXT PRIMARY KEY,
  -- The gate version that produced this verdict. Stored, never assumed: the
  -- gate is immutable and any change to the mandatory set is a NEW version
  -- (R3), so verdicts from v1 and v2 must remain distinguishable forever.
  -- Without this column a re-tuned gate would silently invalidate history.
  version         TEXT NOT NULL,
  accepted        INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  -- Per-condition, NEVER aggregated (R6). `missing` is the JSON array of failed
  -- condition names and `mandatory` the full {condition: bool} object. Both are
  -- written from one verdict object in one place, so they cannot disagree; both
  -- are kept because `missing` answers "why did this fail" while `mandatory`
  -- stays readable when a later version adds a condition. JSON rather than a
  -- column per condition for exactly that reason: a v2 condition must not need
  -- a schema migration to be recorded.
  missing         TEXT NOT NULL,
  mandatory       TEXT NOT NULL,
  -- Comparable Quantity outcome (§4.3) kept alongside the verdict because it is
  -- the condition most likely to need calibration, and `missing` alone cannot
  -- distinguish "no size at all" from "a size that resolved on the container
  -- basis". `basis` is deliberately NOT a correctness signal: a container-basis
  -- product legitimately passes S4 while scoring 0 on Commerce Score's
  -- package_size (R8).
  quantity_status TEXT,
  quantity_basis  TEXT,
  decided_at      TEXT NOT NULL
);

-- The calibration read: "show me current rejects, worst condition first".
CREATE INDEX IF NOT EXISTS ix_offer_acceptance_accepted
  ON offer_acceptance_verdicts(accepted, decided_at);

-- Version-scoped aggregation, so a v2 rollout can be compared against v1 rather
-- than averaged with it.
CREATE INDEX IF NOT EXISTS ix_offer_acceptance_version
  ON offer_acceptance_verdicts(version, accepted);
