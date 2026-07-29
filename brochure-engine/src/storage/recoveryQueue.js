// storage/recoveryQueue.js — S5, the Recovery Queue platform.
//
// VISION-PIPELINE.md §6 S5, C-8, C-9. This module is the PERMANENT half of the
// recovery system. Processors are the replaceable half and live in
// src/recovery/. Read C-9 before changing anything here.
//
// THE ONE RULE THIS FILE MUST OBEY: it may not know what a processor IS.
// Grep it for 'ocr', 'vision', 'medium', 'human' — outside of comments and the
// migration-probe table name there is nothing to find, and a test enforces
// that (recoveryQueue.test.mjs, the C-9 platform test). Processor identity is
// an opaque string that arrives as an argument and is stored as data.
//
// Concretely, that rules out things it would otherwise be natural to add here:
//   • a `supports()` precondition check ("this processor needs a crop") — that
//     is processor knowledge; the runner asks the processor and over-fetches
//     slightly rather than teaching the queue what a crop is for
//   • any notion of cost, ordering between processors, or escalation
//   • any status or outcome value naming a processor
//
// ADMISSION IS NOT HERE EITHER, and that is deliberate. C-9 fixes exactly one
// admission rule — the offer did not become a servable canonical product — and
// it is evaluated at the pipeline's terminal point, inside saveVisionOutcome's
// atomic batch (see enqueueStatement below and enrichStore.js). The queue
// stores what it is handed; it does not re-derive who belongs in it.

// Lifecycle verbs. Every value here must still make sense when every processor
// that exists today has been replaced — which is why none of them names one.
export const RECOVERY_STATUS = Object.freeze({
  QUEUED: 'queued',
  CLAIMED: 'claimed',
  RESOLVED: 'resolved',
  EXHAUSTED: 'exhausted',
  DISMISSED: 'dismissed',
});

// What a processor run did. `no_change` and `declined` are distinct on purpose:
// a processor that ran and found nothing is a calibration signal ("stop paying
// this processor for this condition"), while one that refused to run is not.
export const RECOVERY_OUTCOME = Object.freeze({
  RECOVERED: 'recovered',
  NO_CHANGE: 'no_change',
  FAILED: 'failed',
  DECLINED: 'declined',
});

/**
 * SETTLED vs RETRYABLE — the axis automatic selection turns on, and the reason
 * `excludeProcessor` is not simply "has this processor touched this offer".
 *
 *   SETTLED   the processor reached a conclusion about this observation.
 *             `recovered` fixed it; `no_change` ran and found nothing. Paying
 *             the same processor again for the same evidence buys nothing, so
 *             an automatic pass skips it — that is the calibration signal the
 *             attempt journal exists to produce.
 *   RETRYABLE the processor did NOT reach a conclusion. `failed` threw;
 *             `declined` refused (no credential, nothing to work with). Both
 *             are transient by nature, so excluding them permanently would
 *             strand the item forever — and with a single processor configured,
 *             one 500 from a provider would be enough to do it.
 *
 * Bounding retries is `attempts` + `next_attempt_at`'s job, NOT this set's.
 * Note these are OUTCOME verbs, not processor names: this stays inside C-9.
 */
export const SETTLED_OUTCOMES = Object.freeze([
  RECOVERY_OUTCOME.RECOVERED,
  RECOVERY_OUTCOME.NO_CHANGE,
]);

export const DEFAULT_LEASE_MS = 5 * 60_000;

/**
 * Fixed cool-off after a `declined`, in minutes.
 *
 * A decline consumes no attempt (see recordAttempt), so nothing else bounds how
 * often it is retried. Without this, a processor whose credential is unset
 * declines every item and an armed Auto drain re-declines the same items on
 * every pass forever. A decline makes no provider call by definition, so this
 * is about drain throughput rather than spend.
 */
export const DECLINE_BACKOFF_MINUTES = 60;

// --- statements shared with the extraction batch --------------------------
// enrichStore.saveVisionOutcome commits these INSIDE its existing atomic batch,
// exactly as the S4 verdict rides there (R5). Same reasoning: an offer must not
// be able to hold an extraction with no queue row, or a queue row describing an
// extraction that was rolled back.

/**
 * ADMISSION (C-9). Called only when the offer did NOT become a servable
 * canonical product; the caller owns that test, this owns the row.
 *
 * The upsert preserves `dismissed`. A terminal operator rejection (S7) may only
 * be undone by an explicit operator act, mirroring how registry `resetVerdicts`
 * works — a re-extraction must not quietly resurrect work a human closed.
 *
 * `attempts` RESETS on re-entry, and so does the GENERATION MARKER `queued_at`.
 * A fresh primary extraction is new evidence, so carrying the old count forward
 * would exhaust the item against processors that never saw this observation —
 * and, for the same reason, prior settled attempts must stop excluding their
 * processor from selection (see `list`). Nothing is lost: offer_recovery_attempts
 * is append-only and still holds every prior run; `queued_at` only says which
 * of those runs saw the CURRENT evidence.
 */
export function enqueueStatement(db, offerId, { reasons, at, meta = null }) {
  return db
    .prepare(
      `INSERT INTO offer_recovery_queue
         (offer_id, status, reasons, attempts, claimed_by, claim_until, claim_token,
          next_attempt_at, last_error, meta, created_at, updated_at, queued_at)
       VALUES (?, 'queued', ?, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
       ON CONFLICT(offer_id) DO UPDATE SET
         status = CASE WHEN offer_recovery_queue.status = 'dismissed'
                       THEN 'dismissed' ELSE 'queued' END,
         reasons = excluded.reasons,
         attempts = 0,
         claimed_by = NULL,
         claim_until = NULL,
         -- A re-entry INVALIDATES any lease still outstanding: the observation
         -- the holder is working from has just been superseded, so its write
         -- must not land (see claimFenceStatements).
         claim_token = NULL,
         next_attempt_at = NULL,
         last_error = NULL,
         queued_at = excluded.queued_at,
         updated_at = excluded.updated_at`,
    )
    .bind(
      offerId,
      JSON.stringify(reasons || {}),
      meta == null ? null : JSON.stringify(meta),
      at,
      at,
      at,
    );
}

/**
 * The offer IS a servable canonical product, so it has no business being queued.
 *
 * UPDATE, never upsert: on the primary extraction most offers are complete and
 * were never queued, and inserting a `resolved` row for each of them would turn
 * the queue into a copy of the offers table. A no-op here is the common case.
 *
 * Resolved rows are KEPT rather than deleted — they are the denominator of
 * "which processor actually fixes which condition". `dismissed` is preserved
 * for the same reason `enqueueStatement` preserves it.
 */
export function resolveStatement(db, offerId, at) {
  return db
    .prepare(
      `UPDATE offer_recovery_queue
          SET status = 'resolved', claimed_by = NULL, claim_until = NULL,
              claim_token = NULL, next_attempt_at = NULL, last_error = NULL,
              updated_at = ?
        WHERE offer_id = ? AND status <> 'dismissed'`,
    )
    .bind(at, offerId);
}

/**
 * Return an item to the pool. Statement form, so a caller that must release as
 * part of a larger atomic write does not have to issue a second round trip.
 * `token` fences it; null means unfenced (operator paths).
 */
export function releaseStatement(db, offerId, { error = null, retryAt = null, token = null, at }) {
  return db
    .prepare(
      `UPDATE offer_recovery_queue
          SET status = 'queued', claimed_by = NULL, claim_until = NULL,
              claim_token = NULL, next_attempt_at = ?, last_error = ?,
              updated_at = ?
        WHERE offer_id = ? AND status <> 'dismissed'
          AND (? IS NULL OR claim_token = ?)`,
    )
    .bind(retryAt, error == null ? null : String(error).slice(0, 500), at, offerId, token, token);
}

/**
 * One run of the attempt journal, plus the item's attempt counter.
 *
 * Statement form so the RECOVERY COMMIT can carry the history in the SAME batch
 * as the canonical row it describes (enrichStore.saveRecoveryOutcome). Written
 * separately, an eviction between the two loses the cost and outcome record of
 * work that was actually paid for — permanently, since the canonical row that
 * did land makes the item non-selectable.
 *
 * A `declined` run does NOT consume an attempt. The processor refused to run —
 * no credential bound, nothing to work with — so counting it would let an
 * unconfigured provider walk the entire queue into `exhausted` without a single
 * model call. Exactly the outcome the ladder must not reach silently.
 */
export function attemptStatements(db, {
  offerId, processor, outcome, missingBefore = null, missingAfter = null,
  cost = null, actor = null, error = null, startedAt, finishedAt = null, token = null,
}) {
  const statements = [
    db
      .prepare(
        `INSERT INTO offer_recovery_attempts
           (offer_id, processor, attempt_no, outcome, missing_before,
            missing_after, cost, actor, error, started_at, finished_at)
         VALUES (?, ?,
           (SELECT COALESCE(MAX(attempt_no), 0) + 1
              FROM offer_recovery_attempts WHERE offer_id = ?),
           ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        offerId,
        processor,
        offerId,
        outcome,
        missingBefore == null ? null : JSON.stringify(missingBefore),
        missingAfter == null ? null : JSON.stringify(missingAfter),
        cost == null ? null : JSON.stringify(cost),
        actor,
        error == null ? null : String(error).slice(0, 500),
        startedAt,
        finishedAt,
      ),
  ];
  if (outcome !== RECOVERY_OUTCOME.DECLINED) {
    statements.push(db
      .prepare(
        `UPDATE offer_recovery_queue
            SET attempts = attempts + 1, updated_at = ?
          WHERE offer_id = ?
            AND (? IS NULL OR claim_token = ?)`,
      )
      .bind(finishedAt || startedAt, offerId, token, token));
  }
  return statements;
}

/**
 * THE LEASE FENCE. Two statements that make a whole batch conditional on the
 * caller still holding the lease it claimed.
 *
 * WHY THIS EXISTS. `claim()` alone is not enough. A lease is a TIME window, and
 * a Worker can be evicted, throttled or simply slow past the end of one: it
 * wakes up, finishes its model call, and writes a canonical row over the result
 * a second worker has since produced from the same crop — silently, because an
 * overwritten good field looks exactly like a recovered one (the same failure
 * mode C-7 exists to prevent, arriving by a different route). Everything after
 * the claim therefore has to re-assert ownership, INCLUDING the canonical
 * transaction, and it has to do so inside that transaction rather than before
 * it or the window just gets smaller instead of closing.
 *
 * HOW IT WORKS. D1 runs a batch in one transaction and rolls the whole thing
 * back if any statement fails, so the fence only needs a statement that FAILS
 * when the lease is not ours. Both below fail by writing a status the table's
 * own CHECK constraint rejects:
 *
 *   1. the row exists but `claim_token` no longer matches — someone re-claimed,
 *      reopened, dismissed or re-enqueued it under us;
 *   2. the row is gone entirely (retention, an operator) — there is no lease to
 *      hold, so a write attributable to one must not land either.
 *
 * They are two statements and not one deliberately: an upsert that tried to do
 * both would depend on SQLite's ordering of CHECK evaluation against conflict
 * resolution, which is not a guarantee worth resting correctness on.
 *
 * Callers pass the token from `claim()`; `saveRecoveryOutcome` prepends these
 * to its batch. The sentinel values are never stored — reaching one IS the
 * abort.
 */
export function claimFenceStatements(db, { offerId, token, at }) {
  return [
    db
      .prepare(
        `UPDATE offer_recovery_queue
            SET status = CASE WHEN claim_token IS NOT NULL AND claim_token = ?
                              THEN status ELSE '!stale-claim' END
          WHERE offer_id = ?`,
      )
      .bind(token, offerId),
    db
      .prepare(
        `INSERT INTO offer_recovery_queue
           (offer_id, status, reasons, created_at, updated_at, queued_at)
         SELECT ?, '!missing-claim', '{}', ?, ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM offer_recovery_queue WHERE offer_id = ?)`,
      )
      .bind(offerId, at, at, at, offerId),
  ];
}

/** True when an error thrown out of a fenced batch was the fence firing. */
export function isStaleClaimError(err) {
  return !!err && err.staleClaim === true;
}

// --- the store ------------------------------------------------------------

export function createRecoveryQueue(db) {
  // MIGRATION TOLERANCE, memoized per instance — the same contract as
  // enrichStore's `acceptanceVerdictsReady`, and for a stronger reason. The
  // enqueue rides inside the extraction's atomic batch, so a hard dependency on
  // this table would turn a missing migration into LOST EXTRACTION WORK. When
  // the table is absent the caller keeps its previous behaviour instead
  // (enrichStore falls back to the legacy offer_ocr_queue insert), so a Worker
  // deployed ahead of the migration behaves exactly as it did before S5.
  //
  // One sqlite_master read per Worker instance, not per offer: D1 queries count
  // against the per-invocation subrequest budget, which this pipeline has
  // already exhausted once (drainResolution, 2026-07-20).
  // BOTH tables are probed, not just the queue's own. Every triage read joins
  // `offer_acceptance_verdicts` — a queued item has to be actionable without
  // re-running the gate (§6 S5) — so a queue reporting ready without it would
  // accept writes and then throw on the first drain. Reporting not-ready
  // instead degrades the whole feature to pre-S5 behaviour in one place, which
  // is the only failure mode cheap enough to be safe inside the extraction
  // batch. Applying the two migrations in either order is therefore a non-event.
  let readyMemo = null;
  const ready = async () => {
    if (readyMemo !== null) return readyMemo;
    try {
      const { results } = await db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table'
              AND name IN ('offer_recovery_queue', 'offer_recovery_attempts',
                           'offer_acceptance_verdicts')`,
        )
        .all();
      readyMemo = (results || []).length === 3;
    } catch {
      readyMemo = false;
    }
    return readyMemo;
  };

  const parse = (value, fallback) => {
    if (value == null) return fallback;
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  };

  // The verdict is JOINED, never copied into the queue (C-9). It is keyed by
  // offer and upserted to the CURRENT verdict, so a join always shows an
  // operator the live reason; a copy would show a stale one after a re-judge.
  const ITEM_SELECT = `
    SELECT q.offer_id, q.status, q.reasons, q.attempts, q.claimed_by,
           q.claim_until, q.next_attempt_at, q.last_error, q.meta,
           q.created_at, q.updated_at, q.queued_at,
           o.image_url, o.price, o.currency, o.name, o.name_ar, o.search_text,
           o.valid_to,
           v.version AS verdict_version, v.accepted AS verdict_accepted,
           v.missing AS verdict_missing, v.mandatory AS verdict_mandatory,
           v.quantity_status, v.quantity_basis,
           e.name AS enriched_name, e.name_ar AS enriched_name_ar,
           e.corroboration AS enriched_corroboration
      FROM offer_recovery_queue q
      JOIN offers o ON o.id = q.offer_id
      LEFT JOIN offer_acceptance_verdicts v ON v.offer_id = q.offer_id
      LEFT JOIN offer_enrichments e ON e.id = q.offer_id`;

  const shapeItem = (row) => ({
    offerId: row.offer_id,
    status: row.status,
    reasons: parse(row.reasons, {}),
    attempts: Number(row.attempts) || 0,
    claimedBy: row.claimed_by || null,
    claimUntil: row.claim_until || null,
    nextAttemptAt: row.next_attempt_at || null,
    lastError: row.last_error || null,
    meta: parse(row.meta, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // The evidence generation this item is currently on: attempts older than
    // this were made against a superseded observation (see `list`).
    queuedAt: row.queued_at || null,
    offer: {
      id: row.offer_id,
      image_url: row.image_url,
      price: row.price,
      currency: row.currency,
      name: row.name,
      name_ar: row.name_ar,
      search_text: row.search_text,
      valid_to: row.valid_to,
    },
    // Current enrichment, so a caller can re-test servability without a second
    // query. Shaped as `servable()` expects rather than as the DB row.
    enrichment: row.enriched_name == null && row.enriched_name_ar == null
      ? null
      : {
          name: row.enriched_name,
          name_ar: row.enriched_name_ar,
          corroboration: row.enriched_corroboration,
        },
    verdict: row.verdict_version == null
      ? null
      : {
          version: row.verdict_version,
          accepted: !!row.verdict_accepted,
          missing: parse(row.verdict_missing, []),
          mandatory: parse(row.verdict_mandatory, {}),
          quantityStatus: row.quantity_status ?? null,
          quantityBasis: row.quantity_basis ?? null,
        },
    // Filled by attachAttempts. Keyed by OPAQUE processor id, so a processor
    // reads its predecessors' work without the queue naming anyone.
    attemptsBySource: {},
  });

  // Second query rather than an aggregate join: the attempts join is 1:N and
  // would multiply queue rows. Two D1 reads per drain, not per item.
  const attachAttempts = async (items) => {
    if (!items.length) return items;
    const ids = items.map((i) => i.offerId);
    const { results } = await db
      .prepare(
        `SELECT offer_id, source, output, validation, confidence, model,
                crop_url, accepted, attempted_at
           FROM offer_extraction_attempts
          WHERE offer_id IN (${ids.map(() => '?').join(',')})`,
      )
      .bind(...ids)
      .all();
    const byOffer = new Map(items.map((i) => [i.offerId, i]));
    for (const row of results || []) {
      const item = byOffer.get(row.offer_id);
      if (!item) continue;
      item.attemptsBySource[row.source] = {
        source: row.source,
        output: parse(row.output, null),
        validation: parse(row.validation, {}),
        confidence: row.confidence,
        model: row.model,
        cropUrl: row.crop_url,
        accepted: !!row.accepted,
        attemptedAt: row.attempted_at,
      };
    }
    return items;
  };

  return {
    ready,

    /**
     * Work that is ready to be attempted.
     *
     * `excludeProcessor` filters out offers this processor has already SETTLED —
     * generic, since the id is opaque, and it is what stops an Auto drain from
     * paying the same processor twice for the same crop. It is NOT a
     * `supports()` check: whether a processor CAN handle an item is processor
     * knowledge and stays in the processor (C-9).
     *
     * TWO THINGS NARROW THAT EXCLUSION, and both are load-bearing:
     *
     *   • OUTCOME. Only `recovered`/`no_change` settle an item (SETTLED_OUTCOMES).
     *     A `failed` or `declined` run reached no conclusion and must remain
     *     selectable, or `attempts`, `next_attempt_at` and `maxAttemptsPerItem`
     *     are all dead code — one transient provider error would retire the item
     *     permanently while leaving it sitting in `queued` forever.
     *   • GENERATION. Only attempts made since `queued_at` count. A re-extraction
     *     re-enqueues the offer with new evidence and resets `attempts`; a
     *     processor that settled against the OLD observation has said nothing
     *     about the new one, so it gets to look again.
     */
    async list({ currentOn, limit = 10, excludeProcessor = null, now = new Date() } = {}) {
      if (!(await ready())) return [];
      const nowIso = now instanceof Date ? now.toISOString() : String(now);
      const settled = SETTLED_OUTCOMES.map((o) => `'${o}'`).join(',');
      const exclusion = excludeProcessor
        ? `AND NOT EXISTS (SELECT 1 FROM offer_recovery_attempts a
                            WHERE a.offer_id = q.offer_id AND a.processor = ?
                              AND a.outcome IN (${settled})
                              AND (q.queued_at IS NULL OR a.started_at >= q.queued_at))`
        : '';
      const binds = [nowIso, nowIso];
      if (excludeProcessor) binds.push(excludeProcessor);
      binds.push(currentOn, Math.max(1, Math.min(Number(limit) || 10, 50)));
      const { results } = await db
        .prepare(
          `${ITEM_SELECT}
            WHERE (q.status = 'queued'
                   OR (q.status = 'claimed' AND (q.claim_until IS NULL OR q.claim_until <= ?)))
              AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
              ${exclusion}
              AND o.valid_to >= ?
            ORDER BY q.updated_at, q.offer_id
            LIMIT ?`,
        )
        .bind(...binds)
        .all();
      return attachAttempts((results || []).map(shapeItem));
    },

    async get(offerId) {
      if (!(await ready())) return null;
      const row = await db.prepare(`${ITEM_SELECT} WHERE q.offer_id = ?`).bind(offerId).first();
      if (!row) return null;
      const [item] = await attachAttempts([shapeItem(row)]);
      return item;
    },

    /**
     * Queue depth, per status AND per missing condition.
     *
     * The per-condition breakdown is the number C-8 hands the operator: queue
     * depth alone cannot tell a well-tuned gate from one rejecting everything
     * for a single reason. Buckets OVERLAP (an offer missing two conditions
     * counts in both) — never sum them into a total.
     */
    async depth({ currentOn } = {}) {
      if (!(await ready())) return { ready: false, byStatus: {}, byMissingCondition: {}, total: 0 };
      const { results } = await db
        .prepare(
          `SELECT q.status, COUNT(*) AS n
             FROM offer_recovery_queue q
             JOIN offers o ON o.id = q.offer_id
            WHERE o.valid_to >= ?
            GROUP BY q.status`,
        )
        .bind(currentOn)
        .all();
      const byStatus = {};
      let total = 0;
      for (const row of results || []) {
        byStatus[row.status] = row.n;
        total += row.n;
      }
      // Conditions are read out of the stored verdict rather than restated
      // here, so a `business-acceptance-v2` condition appears in this report
      // with no code change (R6, and the reason `missing` is JSON).
      const { results: conditions } = await db
        .prepare(
          `SELECT j.value AS condition, COUNT(*) AS n
             FROM offer_recovery_queue q
             JOIN offers o ON o.id = q.offer_id
             JOIN offer_acceptance_verdicts v ON v.offer_id = q.offer_id
             JOIN json_each(v.missing) j
            WHERE q.status IN ('queued', 'claimed') AND o.valid_to >= ?
            GROUP BY j.value`,
        )
        .bind(currentOn)
        .all()
        .catch(() => ({ results: [] }));
      const byMissingCondition = {};
      for (const row of conditions || []) byMissingCondition[row.condition] = row.n;
      return { ready: true, byStatus, byMissingCondition, total };
    },

    /**
     * Take the lease. Returns a CLAIM TOKEN when this call won it, else null.
     *
     * The WHERE clause is the concurrency control: two Workers racing the same
     * item both issue this UPDATE, and SQLite serialises them, so exactly one
     * sees changes === 1. Same durable-state-not-control-flow property as
     * vision_jobs.lease_until — an evicted Worker's claim simply expires.
     *
     * A BOOLEAN IS NOT ENOUGH, which is why this returns a token. Winning the
     * claim proves ownership at one instant; every write that follows happens
     * later, potentially after the lease expired and someone else took it. The
     * token is what lets those writes re-assert ownership at the moment they
     * commit — see claimFenceStatements for the full argument. It is generated
     * per call and never reused, so re-claiming an item a slow predecessor still
     * believes it holds invalidates that predecessor's pending writes.
     */
    async claim({ offerId, processor, leaseMs = DEFAULT_LEASE_MS, now = new Date() }) {
      if (!(await ready())) return null;
      const nowIso = now.toISOString();
      const until = new Date(now.getTime() + leaseMs).toISOString();
      const token = crypto.randomUUID();
      const res = await db
        .prepare(
          `UPDATE offer_recovery_queue
              SET status = 'claimed', claimed_by = ?, claim_until = ?,
                  claim_token = ?, updated_at = ?
            WHERE offer_id = ?
              AND status IN ('queued', 'claimed')
              AND (claim_until IS NULL OR claim_until <= ?)`,
        )
        .bind(processor, until, token, nowIso, offerId, nowIso)
        .run();
      return (res?.meta?.changes || 0) > 0 ? token : null;
    },

    /**
     * Back to the pool — the run failed or found nothing.
     *
     * FENCED when a token is supplied: a worker whose lease has since been taken
     * must not drag a resolved (or dismissed, or freshly re-claimed) item back
     * to `queued`. Callers with no token — operator paths — are unfenced by
     * design, because an operator overriding machine state is the point.
     */
    async release(offerId, { error = null, retryAt = null, token = null, now = new Date() } = {}) {
      if (!(await ready())) return false;
      const res = await releaseStatement(db, offerId, {
        error, retryAt, token, at: now.toISOString(),
      }).run();
      return (res?.meta?.changes || 0) > 0;
    },

    /**
     * Append one run to the history and count it against the item.
     *
     * `attempt_no` is derived in SQL from the existing rows rather than passed
     * in, so a caller cannot renumber history by miscounting; the lease already
     * serialises writes for one offer.
     *
     * THE HISTORY INSERT IS UNFENCED, the counter and the release are FENCED.
     * That split is deliberate. History is append-only and describes something
     * that really happened — a stale worker's run is still a run, and its cost
     * belongs in the effectiveness numbers whether or not its result was
     * allowed to land. The counter and the queue state, by contrast, belong to
     * whoever holds the lease NOW; a late writer incrementing them would spend
     * a newer generation's attempt budget on evidence that generation never saw.
     *
     * `releaseAfter` rides the SAME batch rather than being a second call: the
     * history row and the queue state it describes must not be separable by a
     * Worker eviction landing between them.
     */
    async recordAttempt({
      offerId, processor, outcome, missingBefore = null, missingAfter = null,
      cost = null, actor = null, error = null, startedAt, finishedAt = null,
      token = null, releaseAfter = null,
    }) {
      if (!(await ready())) return;
      await db.batch([
        ...attemptStatements(db, {
          offerId, processor, outcome, missingBefore, missingAfter, cost, actor,
          error, startedAt, finishedAt, token,
        }),
        ...(releaseAfter ? [releaseStatement(db, offerId, { ...releaseAfter, token })] : []),
      ]);
    },

    /**
     * Terminal states an operator or the runner sets explicitly.
     *
     * FENCED like release() when a token is supplied — an expired worker must
     * not be able to declare an item exhausted while a live one is working it.
     * Operator closes (dismiss) pass no token and win unconditionally, and they
     * clear `claim_token` on the way out, so any lease outstanding at that
     * moment is invalidated rather than merely overridden.
     */
    async close(offerId, status, { now = new Date(), error = null, token = null } = {}) {
      if (!(await ready())) return false;
      if (![RECOVERY_STATUS.EXHAUSTED, RECOVERY_STATUS.DISMISSED, RECOVERY_STATUS.RESOLVED]
        .includes(status)) {
        throw new Error(`close() refuses non-terminal status '${status}'`);
      }
      const res = await db
        .prepare(
          `UPDATE offer_recovery_queue
              SET status = ?, claimed_by = NULL, claim_until = NULL,
                  claim_token = NULL, last_error = ?, updated_at = ?
            WHERE offer_id = ?
              AND (? IS NULL OR claim_token = ?)`,
        )
        .bind(
          status,
          error == null ? null : String(error).slice(0, 500),
          now.toISOString(),
          offerId,
          token,
          token,
        )
        .run();
      return (res?.meta?.changes || 0) > 0;
    },

    /**
     * Re-entry after a terminal close. An EXPLICIT operator act, never an
     * automatic path (§6 S7: `REJECTED` is terminal and recorded), mirroring
     * registry `resetVerdicts`.
     */
    async reopen(offerIds, { now = new Date() } = {}) {
      if (!(await ready()) || !offerIds?.length) return { reopened: 0 };
      const at = now.toISOString();
      const res = await db
        .prepare(
          `UPDATE offer_recovery_queue
              SET status = 'queued', claimed_by = NULL, claim_until = NULL,
                  claim_token = NULL, next_attempt_at = NULL, last_error = NULL,
                  attempts = 0, queued_at = ?, updated_at = ?
            WHERE offer_id IN (${offerIds.map(() => '?').join(',')})`,
        )
        .bind(at, at, ...offerIds)
        .run();
      return { reopened: res?.meta?.changes || 0 };
    },

    async history(offerId) {
      if (!(await ready())) return [];
      const { results } = await db
        .prepare(
          `SELECT * FROM offer_recovery_attempts WHERE offer_id = ? ORDER BY attempt_no`,
        )
        .bind(offerId)
        .all();
      return (results || []).map((row) => ({
        id: row.id,
        offerId: row.offer_id,
        processor: row.processor,
        attemptNo: row.attempt_no,
        outcome: row.outcome,
        missingBefore: parse(row.missing_before, null),
        missingAfter: parse(row.missing_after, null),
        cost: parse(row.cost, null),
        actor: row.actor,
        error: row.error,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      }));
    },

    /**
     * Per-processor effectiveness. THE number that should drive recovery spend:
     * for each processor, how often it ran and how often it actually moved an
     * offer to servable. Expressed entirely in opaque ids — this report gains a
     * new processor's row the first time that processor runs, with no code
     * change here, which is the C-9 property stated as a query.
     */
    async effectiveness() {
      if (!(await ready())) return {};
      const { results } = await db
        .prepare(
          `SELECT processor, outcome, COUNT(*) AS n
             FROM offer_recovery_attempts
            GROUP BY processor, outcome`,
        )
        .all();
      const out = {};
      for (const row of results || []) {
        out[row.processor] = out[row.processor] || { attempts: 0 };
        out[row.processor][row.outcome] = row.n;
        out[row.processor].attempts += row.n;
      }
      return out;
    },
  };
}
