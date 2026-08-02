// storage/enrichStore.js — the vision-enrichment side-car store behind a
// narrow interface, backed by D1 (the same database as the offers rows the
// enrichments describe — see offers/enrich.js for the discipline).
//
// Interface:
//   listDebris({ currentOn, limit, scope }) -> Promise<{id, image_url}[]>
//   listSelected({ ids, currentOn }) -> Promise<{id, image_url}[]>
//   countDebris(currentOn, scope)    -> Promise<number>
//   upsertMany(rows)                 -> Promise<{ stored }>   (idempotent)
//   saveVisionOutcome(...)           -> persist Vision + canonical PASS/queue
//   listPendingOcr(...)              -> queued Quality Gate rejects
//   saveOcrOutcome(...)              -> persist OCR + canonical + complete queue
//   markOcrPending(...)              -> non-blocking retry state
//   getForIds(ids)                   -> Promise<Map<id, row>>
//   pruneOrphans()                   -> Promise<number>
//   listUnresolved({ currentOn, limit }) -> Promise<candidate + context rows>
//   setVerdicts(pairs)               -> Promise<void>  (mint_verdict stamps)
//   resetVerdicts(ids)               -> Promise<void>  (re-enter the feed)
//   listPendingReviews(limit)         -> Promise<unassigned review rows[]>
//   getPendingReview(id)              -> Promise<candidate + offer context|null>
//   reindexMatchText(limit)          -> Promise<number> (heal missing match_text)
//
// SCOPE (pipeline-flag milestone, 2026-07-18): 'debris' is the original gate —
// deriveNames' own verdict (both display names NULL). 'all' widens to EVERY
// current offer with a crop (full-catalog vision coverage for the Vision +
// Registry pipeline; user decision). The LEFT JOIN excludes offers already
// attempted either way — one crop costs exactly one API call ever.
//
// match_text is computed HERE on every write (single write path): the
// normalized bilingual vision haystack the vision-mode /offers SQL prefilter
// matches against, exactly as search_text is for OCR.

import { normalizeText } from '../matching.js';
import { CORROBORATION_FLOOR } from '../offers/enrich.js';
import {
  BUILDER_STATUS,
  BUILDER_SCORE_VERSION,
  buildArabicShadow,
  builtArabicNamesEnabled,
  withArabicBuilderShadow,
} from '../lexicon/arabicRollout.js';
import { COMMERCE_SCORE_VERSION } from '../offers/commerceScore.js';
// The mandatory set is imported, never restated: the calibration query below is
// generated from it so a v2 condition cannot be silently missing from reports.
import {
  MANDATORY_CONDITIONS,
  evaluateBusinessAcceptance,
} from '../offers/businessAcceptance.js';
import { nonGroceryCategories } from '../lexicon/productClass.js';
import { COMPARABLE_QUANTITY_EVIDENCE } from '../lexicon/comparableQuantity.js';
// S5 Recovery Queue (C-9). Only the two batch statements and the readiness
// probe are needed here — the queue's own surface is used by the recovery
// runner, not by the extraction store.
import {
  createRecoveryQueue,
  enqueueStatement,
  resolveStatement,
  releaseStatement,
  attemptStatements,
  claimFenceStatements,
} from './recoveryQueue.js';

export const IDENTITY_CANDIDATE_STORAGE_VERSION = 'identity-candidate-v1';

// --- the ONE canonical-identity gate, SQL side ---------------------------------
// Vision-canonical directive (2026-07-21): every read path — Search, Browse,
// Watches, Price History — consumes the SAME servable gate. These fragments
// are the SQL twin of offers/enrich.js `servable()` (the JS side); both derive
// from CORROBORATION_FLOOR, so there is exactly one definition of "servable".
// All fragments assume `offers o` joined via ENRICH_JOIN.
export const ENRICH_JOIN = 'LEFT JOIN offer_enrichments e ON e.id = o.id';
export const SERVABLE_SQL =
  `((e.name IS NOT NULL OR e.name_ar IS NOT NULL) AND e.corroboration >= ${CORROBORATION_FLOOR})`;
// Canonical display names: the vision reading when servable, OCR otherwise.
export const CANON_NAME_SQL = `(CASE WHEN ${SERVABLE_SQL} THEN e.name ELSE o.name END)`;

// --- S1 Extraction Admission, SQL side (R4) -----------------------------------
// VISION-PIPELINE.md §6 S1 / C-2. The SQL TWIN of offers/commerceScore.js
// `hasUsableCommercePrice`, exactly as SERVABLE_SQL above is the twin of
// `servable()`. It belongs in the WHERE clause and not in JS after selection for
// two reasons: a priceless offer can never be accepted at S4, so a model call on
// it is pure waste; and excluding it from the queue makes the queue depth an
// honest number. Filtering after selection would fix neither.
//
// FAITHFULNESS IS THE WHOLE RISK HERE, so the two divergences SQLite introduces
// are closed deliberately and pinned by a differential test over real SQLite
// (storage/extractionCandidate.test.mjs):
//
//   1. `typeof(price) IN ('integer','real')` — NOT `CAST(price AS REAL) > 0`.
//      SQLite columns are dynamically typed, so a non-numeric string can sit in
//      a REAL column; `CAST('12abc' AS REAL)` is 12.0 while `Number('12abc')` is
//      NaN. CAST would admit a row JS calls priceless. typeof matches
//      `Number.isFinite` because REAL affinity has already converted anything
//      genuinely numeric on write.
//   2. The `TRIM` character set is spelled out, because SQLite's bare `TRIM`
//      strips ASCII SPACE ONLY while JS `String.trim()` strips all Unicode
//      whitespace. Left bare, `'SAR '` would be dropped by SQL and kept by
//      JS — the dangerous direction, silently starving an extractable offer.
//      ±Inf is excluded for the same parity reason (`Number.isFinite(Inf)` is
//      false, but `typeof(Inf)` is 'real'); it is unreachable through the
//      sanity-gated ingest path and asserted anyway so the twin stays exact.
//
// Residual, recorded rather than hidden: the trim set covers ASCII whitespace
// plus NBSP and BOM, not the full Unicode space (U+2000–200A et al). Those
// cannot occur in a currency code from the aggregator payload.
const CURRENCY_WS_SQL =
  `' '||char(9)||char(10)||char(13)||char(11)||char(12)||char(160)||char(65279)`;
export const USABLE_PRICE_SQL =
  `(typeof(o.price) IN ('integer','real') AND o.price > 0` +
  ` AND CAST(o.price AS TEXT) NOT IN ('Inf','-Inf')` +
  ` AND UPPER(TRIM(o.currency, ${CURRENCY_WS_SQL})) GLOB '[A-Z][A-Z][A-Z]')`;

const SHADOW_STATUS_SQL =
  `(CASE WHEN json_valid(e.extraction_json) ` +
  `THEN json_extract(e.extraction_json, '$._arabic_builder.status') ELSE NULL END)`;
const SHADOW_BUILT_ARABIC_SQL =
  `(CASE WHEN json_valid(e.extraction_json) ` +
  `THEN json_extract(e.extraction_json, '$._arabic_builder.built_arabic') ELSE NULL END)`;
const SHADOW_DISPLAY_ARABIC_SQL =
  `(CASE WHEN json_valid(e.extraction_json) ` +
  `THEN json_extract(e.extraction_json, '$._arabic_builder.display_arabic') ELSE NULL END)`;

// The only production switch. When disabled (the default), this is byte-for-
// byte the historical observed-Arabic expression.
//
// When enabled it serves `display_arabic` — the model's OWN Arabic cleaned of
// Latin debris with the brand appended (lexicon/observedArabic.js). It is NOT
// the built name: composing from the lexicon dropped whatever the lexicon did
// not know, and transliterating the remainder to stop that loss read worse than
// either (user, 2026-07-30, after seeing both live). `built_arabic` is still
// computed and persisted for diagnostics and the Builder Score; nothing serves
// it. A row with no display name — cleaning left nothing, or a legacy row
// written before this field existed — falls back to the raw observed text, so
// the switch can never blank a name.
export function enrichmentNameArSql(enabled = false) {
  if (!builtArabicNamesEnabled(enabled)) return 'e.name_ar';
  return `(CASE WHEN ${SHADOW_DISPLAY_ARABIC_SQL} IS NOT NULL ` +
    `THEN ${SHADOW_DISPLAY_ARABIC_SQL} ELSE e.name_ar END)`;
}

export function canonicalNameArSql(enabled = false) {
  return `(CASE WHEN ${SERVABLE_SQL} THEN ${enrichmentNameArSql(enabled)} ELSE o.name_ar END)`;
}

export const CANON_NAME_AR_SQL = canonicalNameArSql(false);
// Canonical match haystack: the vision match_text when servable (legacy rows
// not yet reindexed have match_text NULL and fall back to OCR), else OCR.
export const CANON_HAYSTACK_SQL =
  `(CASE WHEN ${SERVABLE_SQL} AND e.match_text IS NOT NULL THEN e.match_text ELSE o.search_text END)`;
// The enrichment columns a search row must carry so offers/enrich.js
// applyEnrichment() can overlay without a second query.
export function enrichRowCols(enabled = false) {
  return `e.name AS e_name, ${enrichmentNameArSql(enabled)} AS e_name_ar, ` +
    'e.match_text AS e_match_text, e.corroboration AS e_corroboration, ' +
    // The printed size and the extractor's `unit` observation, for the price
    // basis (offers/enrich.js applyUnitPrice). `unit` lives inside
    // extraction_json because it was preserved before anything consumed it;
    // json_extract is cheaper than a migration and keeps the column verbatim.
    "e.size AS e_size, json_extract(e.extraction_json, '$.unit') AS e_unit";
}

// The JS twin of that `json_extract`, for the memory store (storage/local.js).
// Kept in THIS file, beside the SQL it mirrors, so the two cannot drift apart
// unnoticed — the same discipline `enrichRowCols` already documents.
export function readExtractionUnit(extractionJson) {
  if (!extractionJson) return null;
  try {
    const parsed = typeof extractionJson === 'string'
      ? JSON.parse(extractionJson)
      : extractionJson;
    const unit = parsed && typeof parsed === 'object' ? parsed.unit : null;
    return typeof unit === 'string' && unit.trim() ? unit : null;
  } catch {
    return null;
  }
}

export const ENRICH_ROW_COLS = enrichRowCols(false);

const SCOPE_WHERE = {
  debris: 'AND o.name IS NULL AND o.name_ar IS NULL',
  all: '',
};

export function visionMatchText({ name, name_ar, brand }) {
  const t = normalizeText([name, name_ar, brand].filter(Boolean).join(' '));
  return t || null;
}

export function createD1EnrichStore(db) {
  const upsertStmt = `
    INSERT INTO offer_enrichments
      (id, name, name_ar, brand, size, confidence, corroboration, model,
       crop_url, enriched_at, match_text, extraction_json, identity_candidate,
       identity_candidate_version, mint_verdict)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, name_ar=excluded.name_ar, brand=excluded.brand,
      size=excluded.size, confidence=excluded.confidence,
      corroboration=excluded.corroboration, model=excluded.model,
      crop_url=excluded.crop_url, enriched_at=excluded.enriched_at,
      match_text=excluded.match_text,
      extraction_json=excluded.extraction_json,
      identity_candidate=excluded.identity_candidate,
      identity_candidate_version=excluded.identity_candidate_version,
      mint_verdict=NULL`; // a re-enrichment is re-resolved (idempotent: the
                          // sighting PK makes a re-resolve of a sighted offer
                          // a verdict re-stamp and nothing else)

  const attemptStmt = `
    INSERT INTO offer_extraction_attempts
      (offer_id, source, output, validation, confidence, model, crop_url,
       accepted, attempted_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(offer_id, source) DO UPDATE SET
      output=excluded.output, validation=excluded.validation,
      confidence=excluded.confidence, model=excluded.model,
      crop_url=excluded.crop_url, accepted=excluded.accepted,
      attempted_at=excluded.attempted_at`;

  const canonicalStatement = (r) => db
    .prepare(upsertStmt)
    .bind(
      r.id, r.name ?? null, r.name_ar ?? null, r.brand ?? null,
      r.size ?? null, r.confidence ?? null, r.corroboration ?? null,
      r.model ?? null, r.crop_url ?? null, r.enriched_at,
      visionMatchText(r),
      // Expanded JSON observation, price-free (offers/enrich.js
      // preservedObservation). Already an object here; stringify for D1.
      r.extraction_json == null ? null : JSON.stringify(r.extraction_json),
      r.identity_candidate == null ? null : JSON.stringify(r.identity_candidate),
      r.identity_candidate_version ?? (r.identity_candidate == null
        ? null
        : IDENTITY_CANDIDATE_STORAGE_VERSION),
    );

  // S4 verdict persistence (R5, R6). Keyed by offer, upserted: the recovery
  // ladder re-judges the same offer after each rung, and the CURRENT verdict is
  // what calibration reads. `missing` and `mandatory` are both derived from the
  // one verdict object below, so the per-condition record and the summary can
  // never drift apart.
  const acceptanceStmt = `
    INSERT INTO offer_acceptance_verdicts
      (offer_id, version, accepted, missing, mandatory, quantity_status,
       quantity_basis, decided_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(offer_id) DO UPDATE SET
      version=excluded.version, accepted=excluded.accepted,
      missing=excluded.missing, mandatory=excluded.mandatory,
      quantity_status=excluded.quantity_status,
      quantity_basis=excluded.quantity_basis,
      decided_at=excluded.decided_at`;

  const acceptanceStatement = (offerId, verdict, decidedAt) => db
    .prepare(acceptanceStmt)
    .bind(
      offerId,
      verdict.version,
      verdict.accepted ? 1 : 0,
      JSON.stringify([...(verdict.missing || [])]),
      JSON.stringify(verdict.mandatory || {}),
      verdict.comparableQuantity?.status ?? null,
      verdict.comparableQuantity?.evidence ?? null,
      decidedAt,
    );

  // MIGRATION TOLERANCE, memoized per store instance. The verdict is a
  // calibration record, so it must never be able to fail an extraction: if the
  // table is absent the statement is simply not added to the batch. This is
  // probed rather than try/caught because the write rides INSIDE the atomic
  // batch — a failure there would roll back the attempt and the canonical row
  // with it, turning a missing migration into lost extraction work.
  //
  // One `sqlite_master` read per Worker instance, not per offer: D1 queries
  // count against the per-invocation subrequest budget, which this pipeline has
  // already exhausted once (drainResolution, 2026-07-20).
  // Owns only the readiness probe and the batch statements used below; the
  // full queue surface belongs to the recovery runner.
  const recoveryStore = createRecoveryQueue(db);

  let acceptanceReady = null;
  const acceptanceVerdictsReady = async () => {
    if (acceptanceReady !== null) return acceptanceReady;
    try {
      const row = await db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type = 'table' AND name = 'offer_acceptance_verdicts'`,
        )
        .first();
      acceptanceReady = !!row;
    } catch {
      acceptanceReady = false;
    }
    return acceptanceReady;
  };

  const attemptStatement = (attempt) => db
    .prepare(attemptStmt)
    .bind(
      attempt.offerId,
      attempt.source,
      attempt.output == null ? null : JSON.stringify(attempt.output),
      JSON.stringify(attempt.validation),
      attempt.confidence ?? null,
      attempt.model ?? null,
      attempt.cropUrl ?? null,
      attempt.accepted ? 1 : 0,
      attempt.attemptedAt,
    );

  return {
    // ORDERING IS EXPIRY-FIRST, NOT NEWEST-FIRST (2026-07-30).
    //
    // This was `ORDER BY o.detected_at DESC` — a LIFO queue. Vision is an
    // INGESTION step with finite throughput (~5k/day), and the weekly drop is
    // bursty: 2026-07-28 ingested 13,367 offers in one day. Under LIFO every
    // fresh arrival preempts the backlog, so the EARLIEST offers of a burst are
    // served last and can pass their valid_to before Vision ever reads them.
    // Measured the morning after that drop: four whole stores sat at exactly
    // ZERO vision attempts (aljazera 575, cityflower 495, amarket 467, othaim
    // 429) while later-arriving stores were fully drained — and every one of
    // those offers rendered raw OCR debris in Search and the flyer viewer.
    //
    // `valid_to ASC` spends the budget on whatever expires soonest, which is
    // exactly the offer most likely to be lost forever if it waits another
    // cycle; `detected_at ASC` breaks ties in arrival order so a burst drains
    // front-to-back instead of eating itself. The WHERE clause already excludes
    // expired rows, so this never favours something that can no longer be shown.
    async listDebris({ currentOn, limit = 15, scope = 'all' } = {}) {
      const { results } = await db
        .prepare(
          `SELECT o.id, o.image_url, o.name, o.name_ar, o.price, o.currency, o.category
             FROM offers o
             LEFT JOIN offer_enrichments e ON e.id = o.id
             LEFT JOIN offer_extraction_attempts v
               ON v.offer_id = o.id AND v.source = 'vision'
            WHERE e.id IS NULL AND v.offer_id IS NULL ${SCOPE_WHERE[scope] ?? SCOPE_WHERE.all}
              AND o.image_url IS NOT NULL AND o.valid_to >= ?
              AND ${USABLE_PRICE_SQL}
            ORDER BY o.valid_to ASC, o.detected_at ASC LIMIT ?`,
        )
        .bind(currentOn, Math.max(1, Math.min(Number(limit) || 15, 50)))
        .all();
      return results || [];
    },

    // --- derived-field rebuild (offers/rebuild.js) -----------------------------
    // Page the stored enrichments so their PURE derived fields can be recomputed
    // against a newer lexicon. Joined to offers only for the commerce context
    // productKnowledge() takes (price/currency) — exactly what the enrich path
    // passes, so a rebuilt row is byte-identical to a freshly enriched one.
    // Cursor by id: stable, index-ordered, and resumable across invocations.
    async listForRebuild({ after = '', limit = 500 } = {}) {
      const { results } = await db
        .prepare(
          `SELECT e.id, e.name, e.name_ar, e.brand, e.size, e.confidence,
                  e.extraction_json, e.identity_candidate, e.mint_verdict,
                  o.price, o.currency, o.category
             FROM offer_enrichments e
             LEFT JOIN offers o ON o.id = e.id
            WHERE e.id > ?
            ORDER BY e.id ASC
            LIMIT ?`,
        )
        .bind(String(after || ''), Math.max(1, Math.min(Number(limit) || 500, 2000)))
        .all();
      return results || [];
    },

    // Persist rebuilt derived fields. Writes ONLY the two derived columns (plus
    // the candidate's contract version). `mint_verdict` is untouched unless the
    // caller explicitly asks: clearing it hands the row back to the registry
    // drain, which mints and attaches products — a different decision with a
    // different blast radius, so it never rides along silently.
    async applyRebuild(rows, { reresolve = false } = {}) {
      if (!rows?.length) return { updated: 0 };
      const sql = reresolve
        ? `UPDATE offer_enrichments
              SET extraction_json = ?, identity_candidate = ?,
                  identity_candidate_version = ?, mint_verdict = NULL
            WHERE id = ?`
        : `UPDATE offer_enrichments
              SET extraction_json = ?, identity_candidate = ?,
                  identity_candidate_version = ?
            WHERE id = ?`;
      for (let i = 0; i < rows.length; i += 50) {
        await db.batch(
          rows.slice(i, i + 50).map((r) => db
            .prepare(sql)
            .bind(r.extraction_json, r.identity_candidate, r.identity_candidate_version, r.id)),
        );
      }
      return { updated: rows.length };
    },

    // Explicit allowlist used only by staged historical re-enrichment. Unlike
    // listDebris it may return an already-enriched crop, but never widens past
    // the supplied IDs and never mutates Registry state itself.
    async listSelected({ ids, currentOn } = {}) {
      const selected = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 50);
      if (!selected.length) return [];
      const { results } = await db
        .prepare(
          `SELECT id, image_url, name, name_ar, price, currency, category FROM offers
            WHERE id IN (${selected.map(() => '?').join(',')})
              AND image_url IS NOT NULL AND valid_to >= ?
            ORDER BY detected_at DESC`,
        )
        .bind(...selected, currentOn)
        .all();
      return results || [];
    },

    // Ops Vision Progress: the enrichment coverage of the CURRENT vision-
    // eligible catalog, in one query. "Vision-eligible" is the S1 admission
    // predicate, so since R4 it means "holds a crop AND holds a usable
    // commerce price" — the SAME condition listDebris/countDebris apply. The
    // denominator has to move with them: withCrop is what `remaining` is
    // measured against, so leaving priceless offers in it would strand them as
    // permanently-uncovered and cap coverage% below 100 forever. `attempted`
    // counts every offer vision has looked at (incl. declined, NULL-names
    // rows); `enriched` those it read a name from; `servable` those clearing
    // the corroboration floor. `remaining = withCrop - attempted` equals
    // countDebris('all'); coverage% is attempted/withCrop (how far vision has
    // reached), not enriched/withCrop (that would punish honest declines).
    async coverage(currentOn) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS with_crop,
                  SUM(CASE WHEN e.id IS NOT NULL OR v.offer_id IS NOT NULL THEN 1 ELSE 0 END) AS attempted,
                  SUM(CASE WHEN e.name IS NOT NULL OR e.name_ar IS NOT NULL THEN 1 ELSE 0 END) AS enriched,
                  SUM(CASE WHEN (e.name IS NOT NULL OR e.name_ar IS NOT NULL)
                            AND e.corroboration >= ${CORROBORATION_FLOOR} THEN 1 ELSE 0 END) AS servable
             FROM offers o
             LEFT JOIN offer_enrichments e ON e.id = o.id
             LEFT JOIN offer_extraction_attempts v
               ON v.offer_id = o.id AND v.source = 'vision'
            WHERE o.image_url IS NOT NULL AND o.valid_to >= ?
              AND ${USABLE_PRICE_SQL}`,
        )
        .bind(currentOn)
        .first();
      const withCrop = row?.with_crop || 0;
      const attempted = row?.attempted || 0;
      const enriched = row?.enriched || 0;
      return {
        withCrop,
        attempted,
        enriched,
        servable: row?.servable || 0,
        declined: attempted - enriched,
        remaining: withCrop - attempted,
        coverage: withCrop > 0 ? Math.round((attempted / withCrop) * 1000) / 10 : null,
      };
    },

    // The calibration read (R5, R6). Answers the question the mandatory set is
    // tuned against: of the offers S4 has judged, how many were rejected, and
    // BY WHICH CONDITION. Per-condition counts come from the stored `mandatory`
    // object, and the condition list is imported from the gate itself, so this
    // query cannot fall out of step with the version it reports on.
    //
    // Counts are per-condition and therefore OVERLAPPING — one offer missing
    // both a price and a size is counted in both buckets. That is deliberate:
    // aggregating them into "rejected for N reasons" is the exact loss of
    // information R6 forbids. `onlyCondition` is the disjoint view, and it is
    // the actionable one: it isolates offers a single condition is keeping out,
    // which is what would change if that condition were dropped.
    async acceptanceSummary({ version = null } = {}) {
      if (!await acceptanceVerdictsReady()) return null;
      const perCondition = MANDATORY_CONDITIONS.map(
        (c) => `SUM(CASE WHEN json_extract(mandatory, '$.${c}') = 0 THEN 1 ELSE 0 END) AS missing_${c}`,
      ).join(',\n                  ');
      const onlyCondition = MANDATORY_CONDITIONS.map(
        (c) => `SUM(CASE WHEN accepted = 0 AND json_array_length(missing) = 1`
          + ` AND json_extract(missing, '$[0]') = '${c}' THEN 1 ELSE 0 END) AS only_${c}`,
      ).join(',\n                  ');
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS judged,
                  SUM(accepted) AS accepted,
                  ${perCondition},
                  ${onlyCondition}
             FROM offer_acceptance_verdicts
            WHERE (? IS NULL OR version = ?)`,
        )
        .bind(version, version)
        .first();
      const judged = row?.judged || 0;
      const accepted = row?.accepted || 0;
      return {
        version: version ?? 'all',
        judged,
        accepted,
        rejected: judged - accepted,
        acceptanceRate: judged > 0 ? Math.round((accepted / judged) * 1000) / 10 : null,
        missingByCondition: Object.fromEntries(
          MANDATORY_CONDITIONS.map((c) => [c, row?.[`missing_${c}`] || 0]),
        ),
        onlyCondition: Object.fromEntries(
          MANDATORY_CONDITIONS.map((c) => [c, row?.[`only_${c}`] || 0]),
        ),
      };
    },

    /**
     * Re-judge stale Recovery rows after the product-class rule changes.
     *
     * Named/priced non-grocery is accepted AS-IS: no crop fetch and no model
     * call. This method owns the atomic persistence boundary because it already
     * owns both the acceptance verdict statement and Recovery's resolve
     * statement. History is preserved; only the current verdict and queue
     * lifecycle state change.
     */
    async reconcileNonGroceryAcceptance({
      currentOn, limit = 500, now = new Date(),
    } = {}) {
      if (!(await recoveryStore.ready()) || !(await acceptanceVerdictsReady())) {
        return { available: false, scanned: 0, resolved: 0 };
      }
      const categories = nonGroceryCategories();
      const marks = categories.map(() => '?').join(',');
      const { results } = await db
        .prepare(
          `SELECT o.id, o.name, o.name_ar, o.search_text, o.price, o.currency,
                  o.category, o.valid_to
             FROM offer_recovery_queue q
             JOIN offers o ON o.id = q.offer_id
            WHERE q.status IN ('queued', 'claimed')
              AND o.valid_to >= ?
              AND LOWER(TRIM(o.category)) IN (${marks})
              AND (NULLIF(TRIM(o.name), '') IS NOT NULL
                   OR NULLIF(TRIM(o.name_ar), '') IS NOT NULL)
              AND o.price > 0
            ORDER BY q.updated_at, q.offer_id
            LIMIT ?`,
        )
        .bind(
          currentOn,
          ...categories,
          Math.max(1, Math.min(Number(limit) || 500, 1000)),
        )
        .all();
      const candidates = results || [];
      const accepted = candidates
        .map((offer) => ({
          offer,
          verdict: evaluateBusinessAcceptance({
            offer,
            acceptedFields: [],
            observation: { name: offer.name || offer.name_ar || null },
          }),
        }))
        .filter(({ verdict }) => verdict.accepted);
      if (!accepted.length) {
        return { available: true, scanned: candidates.length, resolved: 0 };
      }

      // Most rows share the UNIT basis, but real printed measures are allowed
      // to win. Group identical verdict shapes so thousands of rows still
      // commit in a handful of D1 statements rather than one statement each.
      const groups = new Map();
      for (const entry of accepted) {
        const v = entry.verdict;
        const key = JSON.stringify([
          v.version,
          v.accepted,
          [...v.missing],
          v.mandatory,
          v.comparableQuantity?.status ?? null,
          v.comparableQuantity?.evidence ?? null,
        ]);
        if (!groups.has(key)) groups.set(key, { verdict: v, ids: [] });
        groups.get(key).ids.push(entry.offer.id);
      }
      const decidedAt = now instanceof Date ? now.toISOString() : String(now);
      const statements = [];
      for (const { verdict, ids } of groups.values()) {
        statements.push(db
          .prepare(
            `INSERT INTO offer_acceptance_verdicts
               (offer_id, version, accepted, missing, mandatory, quantity_status,
                quantity_basis, decided_at)
             SELECT o.id, ?, ?, ?, ?, ?, ?, ?
               FROM offers o
              WHERE o.id IN (${ids.map(() => '?').join(',')})
             ON CONFLICT(offer_id) DO UPDATE SET
               version=excluded.version, accepted=excluded.accepted,
               missing=excluded.missing, mandatory=excluded.mandatory,
               quantity_status=excluded.quantity_status,
               quantity_basis=excluded.quantity_basis,
               decided_at=excluded.decided_at`,
          )
          .bind(
            verdict.version,
            verdict.accepted ? 1 : 0,
            JSON.stringify([...verdict.missing]),
            JSON.stringify(verdict.mandatory),
            verdict.comparableQuantity?.status ?? null,
            verdict.comparableQuantity?.evidence ?? null,
            decidedAt,
            ...ids,
          ));
      }
      const ids = accepted.map(({ offer }) => offer.id);
      const idMarks = ids.map(() => '?').join(',');
      statements.push(db
        .prepare(
          `UPDATE offer_recovery_queue
              SET status = 'resolved', claimed_by = NULL, claim_until = NULL,
                  claim_token = NULL, next_attempt_at = NULL, last_error = NULL,
                  updated_at = ?
            WHERE offer_id IN (${idMarks}) AND status <> 'dismissed'`,
        )
        .bind(decidedAt, ...ids));
      // Transitional legacy queue: as-is acceptance must not leave OCR behind
      // to spend on the same durable products.
      statements.push(db
        .prepare(
          `UPDATE offer_ocr_queue SET status = 'completed', updated_at = ?
            WHERE offer_id IN (${idMarks})`,
        )
        .bind(decidedAt, ...ids));
      await db.batch(statements);
      return { available: true, scanned: candidates.length, resolved: ids.length };
    },

    /**
     * Re-judge stale Recovery rows after the PRICE BASIS rule changes (gate v3,
     * 2026-08-02). The sibling of `reconcileNonGroceryAcceptance`, deliberately
     * a separate method rather than a branch inside it: the two rules admit
     * different populations for different reasons, and a shared method would
     * make "why was this offer accepted" answerable only by re-reading both.
     *
     * ZERO COST. A per-kilo price is legible in data we already own — the
     * extractor's `unit` field, the size field it wrote "Per Kg" into, and the
     * retailer's own bilingual text. Nothing here fetches a crop or calls a
     * model; the offers were queued for Recovery precisely because v2 could not
     * see the denominator that was printed on them all along.
     *
     * ANY CATEGORY. Fresh produce is where basis pricing is the norm, but deli,
     * butchery, fish, nuts and loose confectionery price the same way, and a
     * category filter here would rebuild the Fresh-specific fix this work
     * exists to avoid. The SQL prefilter is a cheap text test; the GATE is what
     * decides, exactly as everywhere else.
     */
    async reconcilePriceBasisAcceptance({
      currentOn, limit = 500, now = new Date(),
    } = {}) {
      if (!(await recoveryStore.ready()) || !(await acceptanceVerdictsReady())) {
        return { available: false, scanned: 0, resolved: 0 };
      }
      // A deliberately GENEROUS prefilter: it only has to avoid scanning the
      // whole queue, and every candidate is judged properly below. Anything it
      // lets through that carries no real basis simply fails the gate again.
      // ONE haystack, built from every field the basis reader itself reads.
      // Testing a subset of them is how a fixture like "FRESH VEAL - BONE IN"
      // with `unit: "KILO"` — basis in the unit field and nowhere else — gets
      // silently skipped before the gate ever sees it.
      const hay = "LOWER(COALESCE(e.size,'') || ' ' || COALESCE(e.name,'') || ' '"
        + " || COALESCE(json_extract(e.extraction_json,'$.unit'),''))";
      const arabicHay = "(COALESCE(o.name_ar,'') || ' ' || COALESCE(o.search_text,''))";
      const marker = '('
        + [`${hay} LIKE '%kg%'`, `${hay} LIKE '%kilo%'`, `${hay} LIKE '%/pc%'`,
          `${hay} LIKE '%per pc%'`, `${hay} LIKE '%piece%'`, `${hay} LIKE '%each%'`]
          .join(' OR ')
        + ' OR ' + ["'%للكيلو%'", "'%بالكيلو%'", "'%للحبة%'", "'%للحبه%'"]
          .map((needle) => `${arabicHay} LIKE ${needle}`).join(' OR ')
        + ')';
      const { results } = await db
        .prepare(
          `SELECT o.id, o.name, o.name_ar, o.search_text, o.price, o.currency,
                  o.category, o.valid_to,
                  e.name AS e_name, e.size AS e_size,
                  json_extract(e.extraction_json, '$.unit') AS e_unit
             FROM offer_recovery_queue q
             JOIN offers o ON o.id = q.offer_id
             JOIN offer_enrichments e ON e.id = q.offer_id
            WHERE q.status IN ('queued', 'claimed')
              AND o.valid_to >= ?
              AND o.price > 0
              AND ${marker}
            ORDER BY q.updated_at, q.offer_id
            LIMIT ?`,
        )
        .bind(currentOn, Math.max(1, Math.min(Number(limit) || 500, 1000)))
        .all();
      const candidates = results || [];
      const accepted = candidates
        .map((row) => ({
          offer: row,
          verdict: evaluateBusinessAcceptance({
            // The offer row carries the price, the class and the bilingual text
            // the basis reader needs (C-2: never the model for these).
            offer: row,
            // The name that already cleared S3 — a basis cannot rescue a product
            // with no usable English identity, and must not be able to.
            acceptedFields: row.e_name ? ['name_en'] : [],
            observation: {
              name: row.e_name || row.name || row.name_ar || null,
              size: row.e_size || null,
              unit: row.e_unit || null,
            },
          }),
        }))
        .filter(({ verdict }) => verdict.accepted
          // ONLY a price basis may resolve a row here. A candidate that passes
          // for some other reason is not this rule's business and belongs to
          // whatever pass owns it, so it is left queued rather than quietly
          // retired under the wrong justification.
          && verdict.comparableQuantity?.evidence === COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS);
      if (!accepted.length) {
        return { available: true, scanned: candidates.length, resolved: 0 };
      }

      const groups = new Map();
      for (const entry of accepted) {
        const v = entry.verdict;
        const key = JSON.stringify([
          v.version, v.accepted, [...v.missing], v.mandatory,
          v.comparableQuantity?.status ?? null,
          v.comparableQuantity?.evidence ?? null,
        ]);
        if (!groups.has(key)) groups.set(key, { verdict: v, ids: [] });
        groups.get(key).ids.push(entry.offer.id);
      }
      const decidedAt = now instanceof Date ? now.toISOString() : String(now);
      const statements = [];
      // D1 caps BOUND PARAMETERS PER QUERY at 100, so every `IN (...)` list here
      // is chunked. Found in production, not in test: the local fixtures resolve
      // 3-4 rows and the first live fire had 344 candidates, which built a single
      // statement with 351 binds, threw, and was swallowed by the caller's
      // `.catch()` into a silent `resolved: 0`. Chunk well under the cap.
      const CHUNK = 40;
      const chunked = (ids) => {
        const out = [];
        for (let i = 0; i < ids.length; i += CHUNK) out.push(ids.slice(i, i + CHUNK));
        return out;
      };
      for (const { verdict, ids: groupIds } of groups.values()) {
        for (const part of chunked(groupIds)) {
          statements.push(db
            .prepare(
              `INSERT INTO offer_acceptance_verdicts
                 (offer_id, version, accepted, missing, mandatory, quantity_status,
                  quantity_basis, decided_at)
               SELECT o.id, ?, ?, ?, ?, ?, ?, ?
                 FROM offers o
                WHERE o.id IN (${part.map(() => '?').join(',')})
               ON CONFLICT(offer_id) DO UPDATE SET
                 version=excluded.version, accepted=excluded.accepted,
                 missing=excluded.missing, mandatory=excluded.mandatory,
                 quantity_status=excluded.quantity_status,
                 quantity_basis=excluded.quantity_basis,
                 decided_at=excluded.decided_at`,
            )
            .bind(
              verdict.version,
              verdict.accepted ? 1 : 0,
              JSON.stringify([...verdict.missing]),
              JSON.stringify(verdict.mandatory),
              verdict.comparableQuantity?.status ?? null,
              verdict.comparableQuantity?.evidence ?? null,
              decidedAt,
              ...part,
            ));
        }
      }
      const resolvedIds = accepted.map(({ offer }) => offer.id);
      for (const part of chunked(resolvedIds)) {
        const idMarks = part.map(() => '?').join(',');
        statements.push(db
          .prepare(
            `UPDATE offer_recovery_queue
                SET status = 'resolved', claimed_by = NULL, claim_until = NULL,
                    claim_token = NULL, next_attempt_at = NULL, last_error = NULL,
                    updated_at = ?
              WHERE offer_id IN (${idMarks}) AND status <> 'dismissed'`,
          )
          .bind(decidedAt, ...part));
        statements.push(db
          .prepare(
            `UPDATE offer_ocr_queue SET status = 'completed', updated_at = ?
              WHERE offer_id IN (${idMarks})`,
          )
          .bind(decidedAt, ...part));
      }
      await db.batch(statements);
      return { available: true, scanned: candidates.length, resolved: resolvedIds.length };
    },

    async getAcceptanceVerdict(offerId) {
      if (!await acceptanceVerdictsReady()) return null;
      const row = await db
        .prepare('SELECT * FROM offer_acceptance_verdicts WHERE offer_id = ?')
        .bind(offerId)
        .first();
      if (!row) return null;
      return {
        offerId: row.offer_id,
        version: row.version,
        accepted: row.accepted === 1,
        missing: JSON.parse(row.missing),
        mandatory: JSON.parse(row.mandatory),
        // The COLUMN keeps its name (no migration; the values are unchanged
        // across v3 and v4), but the read shape follows the projection so a
        // caller can compare a stored verdict with a fresh one field by field.
        comparableQuantity: { status: row.quantity_status, evidence: row.quantity_basis },
        decidedAt: row.decided_at,
      };
    },

    async countDebris(currentOn, scope = 'all') {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM offers o
             LEFT JOIN offer_enrichments e ON e.id = o.id
             LEFT JOIN offer_extraction_attempts v
               ON v.offer_id = o.id AND v.source = 'vision'
            WHERE e.id IS NULL AND v.offer_id IS NULL ${SCOPE_WHERE[scope] ?? SCOPE_WHERE.all}
              AND o.image_url IS NOT NULL AND o.valid_to >= ?
              AND ${USABLE_PRICE_SQL}`,
        )
        .bind(currentOn)
        .first();
      return row?.n || 0;
    },

    async upsertMany(rows) {
      for (let i = 0; i < rows.length; i += 40) {
        await db.batch(rows.slice(i, i + 40).map(canonicalStatement));
      }
      return { stored: rows.length };
    },

    // Vision attempt + either canonical PASS or OCR queue REJECT are committed
    // together. A Worker retry therefore cannot lose an escalation or strand a
    // persisted attempt without a canonical result.
    //
    // `acceptance` (R5) joins that same batch: the S4 verdict is committed with
    // the attempt that produced it, so no offer can carry a verdict describing
    // an extraction that was rolled back, nor an extraction with no verdict.
    //
    // `recovery` (S5.3, C-9) joins it for the same reason. It is the ALREADY
    // DECIDED admission — `{ complete, reasons }` from `recoveryAdmission()` in
    // enrich.js — not something re-derived here. The single admission rule needs
    // `servable()` and the S4 verdict, both of which live at the caller; passing
    // the decision in keeps the queue and its store from re-implementing a rule
    // that must have exactly one definition (C-9).
    async saveVisionOutcome({
      attempt, canonicalRow = null, triggerReasons = [], acceptance = null,
      recovery = null,
    }) {
      const statements = [attemptStatement(attempt)];
      const acceptedAsIs = recovery?.complete === true
        && recovery?.reasons?.acceptedAsIs === true;
      if (canonicalRow) {
        statements.push(canonicalStatement(canonicalRow));
        statements.push(db.prepare('DELETE FROM offer_ocr_queue WHERE offer_id = ?').bind(attempt.offerId));
      } else if (acceptedAsIs) {
        // A named/priced durable needs no canonical model row and must not leak
        // into the transitional OCR queue after Recovery correctly closes it.
        statements.push(db.prepare('DELETE FROM offer_ocr_queue WHERE offer_id = ?').bind(attempt.offerId));
      } else {
        statements.push(db
          .prepare(
            `INSERT INTO offer_ocr_queue
               (offer_id, status, trigger_reasons, attempts, next_attempt_at,
                last_error, created_at, updated_at)
             VALUES (?, 'ocr_pending', ?, 0, NULL, NULL, ?, ?)
             ON CONFLICT(offer_id) DO UPDATE SET
               status=CASE WHEN offer_ocr_queue.status = 'completed'
                           THEN 'completed' ELSE 'ocr_pending' END,
               trigger_reasons=excluded.trigger_reasons,
               updated_at=excluded.updated_at`,
          )
          .bind(
            attempt.offerId,
            JSON.stringify(triggerReasons),
            attempt.attemptedAt,
            attempt.attemptedAt,
          ));
      }
      // Rejected verdicts are persisted exactly like accepted ones (R5) — the
      // reject rows ARE the calibration signal, so there is no `if (accepted)`
      // here by design.
      const verdictStored = !!acceptance && await acceptanceVerdictsReady();
      if (verdictStored) {
        statements.push(acceptanceStatement(attempt.offerId, acceptance, attempt.attemptedAt));
      }
      // S5.3 — the Recovery Queue write, on the SAME atomic batch.
      //
      // MIGRATION-TOLERANT, and the fallback matters: when the table is absent
      // the legacy offer_ocr_queue statements above are the only queue write, so
      // a Worker deployed ahead of the migration behaves EXACTLY as it did
      // before S5. A hard dependency here would turn a missing migration into
      // lost escalations — strictly worse than today.
      //
      // ⚠️ TRANSITIONAL DOUBLE-WRITE. Both queues are written until the OCR
      // processor reads the recovery queue (S5.5); that is what makes the
      // cutover reversible by redeploy instead of by data restore. It cannot
      // cause double processing, because the recovery runner is inert until an
      // operator arms it (Manual is the default, C-9). REMOVE the legacy
      // offer_ocr_queue statements once the recovery queue is observed working
      // in production.
      //
      // ROLLBACK IS NOT ONE STEP, and it is worth being exact about why. Both
      // environments ship OCR_FALLBACK_ENABLED="false" (wrangler.toml), so the
      // legacy drain is NOT running alongside this — the legacy rows are being
      // kept warm, not consumed. Reverting the Worker therefore restores the
      // pre-S5 code path but still leaves recovery switched off; restoring the
      // pre-S5 BEHAVIOUR additionally requires setting OCR_FALLBACK_ENABLED to
      // "true" and binding MISTRAL_OCR_API_KEY. Neither step touches data,
      // which is the property this double-write actually buys.
      let recoveryQueued = false;
      if (recovery && await recoveryStore.ready()) {
        if (recovery.complete) {
          statements.push(resolveStatement(db, attempt.offerId, attempt.attemptedAt));
        } else {
          statements.push(enqueueStatement(db, attempt.offerId, {
            reasons: recovery.reasons,
            at: attempt.attemptedAt,
            meta: { origin: 'extraction' },
          }));
          recoveryQueued = true;
        }
      }
      await db.batch(statements);
      return {
        stored: 1,
        queued: canonicalRow || acceptedAsIs ? 0 : 1,
        verdictStored,
        recoveryQueued,
      };
    },

    // S5 · THE RECOVERY COMMIT BOUNDARY. Attempt journal + canonical row + the
    // re-judged S4 verdict + queue closure, in ONE atomic batch.
    //
    // Processor-agnostic on purpose: `attempt.source` is the opaque processor
    // id, and this method neither knows nor asks which processor produced the
    // row. It is the generic twin of `saveOcrOutcome`, which stays in place
    // until the legacy drain is retired.
    //
    // Atomicity matters more here than on the primary path. A recovery write
    // that committed the canonical row but not the verdict would leave an offer
    // that LOOKS servable carrying a stale reject verdict, and the queue would
    // hand it to another processor to be paid for again.
    // `fence` is the lease token from recoveryQueue.claim(). EVERYTHING below
    // rides on it: a worker that ran past its lease must not overwrite the
    // canonical row a successor already wrote from the same crop, nor resolve
    // an item someone else is working, nor spend a newer generation's attempt
    // budget. The fence statements go FIRST and abort the whole batch when the
    // lease is no longer ours (recoveryQueue.claimFenceStatements).
    //
    // `history` and `release` join the same batch for the same reason the
    // verdict does: the attempt journal describes this exact canonical write,
    // and the queue state describes what to do next. Anything committed apart
    // from the others can be lost apart from the others.
    async saveRecoveryOutcome({
      attempt, canonicalRow = null, acceptance = null, resolve = false,
      fence = null, history = null, release = null,
    }) {
      const recoveryReady = await recoveryStore.ready();
      const statements = [];
      if (fence?.token && recoveryReady) {
        statements.push(...claimFenceStatements(db, {
          offerId: fence.offerId ?? attempt.offerId,
          token: fence.token,
          at: fence.at ?? attempt.attemptedAt,
        }));
      }
      statements.push(attemptStatement(attempt));
      if (canonicalRow) statements.push(canonicalStatement(canonicalRow));
      const verdictStored = !!acceptance && await acceptanceVerdictsReady();
      if (verdictStored) {
        statements.push(acceptanceStatement(attempt.offerId, acceptance, attempt.attemptedAt));
      }
      if (recoveryReady) {
        if (history) {
          statements.push(...attemptStatements(db, { ...history, token: fence?.token ?? null }));
        }
        if (resolve) {
          statements.push(resolveStatement(db, attempt.offerId, attempt.attemptedAt));
        } else if (release) {
          statements.push(releaseStatement(db, attempt.offerId, {
            ...release,
            token: fence?.token ?? null,
            at: release.at ?? attempt.attemptedAt,
          }));
        }
      }
      // ⚠️ TRANSITIONAL, remove with the rest of the legacy queue (S5.5): while
      // both queues exist, a recovery that resolved an offer must also close the
      // legacy row, or the old OCR drain will pay to process it again.
      if (resolve) {
        statements.push(db
          .prepare(`UPDATE offer_ocr_queue SET status = 'completed', updated_at = ?
                     WHERE offer_id = ?`)
          .bind(attempt.attemptedAt, attempt.offerId));
      }
      try {
        await db.batch(statements);
      } catch (err) {
        // Distinguish "we lost the lease" from "the database is broken" — the
        // caller must continue on the first and stop on the second. Costs one
        // read, and only on a path that has already failed.
        if (fence?.token && recoveryReady) {
          const row = await db
            .prepare('SELECT claim_token FROM offer_recovery_queue WHERE offer_id = ?')
            .bind(fence.offerId ?? attempt.offerId)
            .first()
            .catch(() => null);
          if (!row || row.claim_token !== fence.token) err.staleClaim = true;
        }
        throw err;
      }
      return { stored: 1, verdictStored, resolved: !!resolve };
    },

    async listPendingOcr({ currentOn, limit = 10 } = {}) {
      const { results } = await db
        .prepare(
          `SELECT o.id, o.image_url, o.price, o.currency, q.attempts, q.trigger_reasons,
                  v.output AS vision_output, v.validation AS vision_validation,
                  v.confidence AS vision_confidence, v.model AS vision_model,
                  v.crop_url AS vision_crop_url, v.attempted_at AS vision_attempted_at
             FROM offer_ocr_queue q
             JOIN offers o ON o.id = q.offer_id
             JOIN offer_extraction_attempts v
               ON v.offer_id = q.offer_id AND v.source = 'vision'
             LEFT JOIN offer_enrichments e ON e.id = q.offer_id
            WHERE q.status = 'ocr_pending' AND e.id IS NULL
              AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
              AND o.image_url IS NOT NULL AND o.valid_to >= ?
            ORDER BY q.updated_at, q.offer_id LIMIT ?`,
        )
        .bind(
          new Date().toISOString(),
          currentOn,
          Math.max(1, Math.min(Number(limit) || 10, 25)),
        )
        .all();
      return (results || []).map((row) => ({
        ...row,
        vision_output: row.vision_output == null ? null : JSON.parse(row.vision_output),
        vision_validation: JSON.parse(row.vision_validation),
        trigger_reasons: JSON.parse(row.trigger_reasons || '[]'),
      }));
    },

    async countPendingOcr(currentOn) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM offer_ocr_queue q
             JOIN offers o ON o.id = q.offer_id
             LEFT JOIN offer_enrichments e ON e.id = q.offer_id
            WHERE q.status = 'ocr_pending' AND e.id IS NULL
              AND o.valid_to >= ?`,
        )
        .bind(currentOn)
        .first();
      return row?.n || 0;
    },

    async saveOcrOutcome({ attempt, canonicalRow }) {
      await db.batch([
        attemptStatement(attempt),
        canonicalStatement(canonicalRow),
        db
          .prepare(
            `UPDATE offer_ocr_queue
                SET status = 'completed', attempts = attempts + 1,
                    next_attempt_at = NULL, last_error = NULL, updated_at = ?
              WHERE offer_id = ?`,
          )
          .bind(attempt.attemptedAt, attempt.offerId),
      ]);
      return { stored: 1 };
    },

    async markOcrPending(offerId, error, { retryAt } = {}) {
      const updatedAt = new Date().toISOString();
      await db
        .prepare(
          `UPDATE offer_ocr_queue
              SET status = 'ocr_pending', attempts = attempts + 1,
                  next_attempt_at = ?, last_error = ?, updated_at = ?
            WHERE offer_id = ?`,
        )
        .bind(retryAt ?? null, String(error || '').slice(0, 500), updatedAt, offerId)
        .run();
    },

    // Batch fetch for the read-path overlay, keyed for O(1) join per row.
    async getForIds(ids) {
      const map = new Map();
      for (let i = 0; i < ids.length; i += 60) {
        const chunk = ids.slice(i, i + 60);
        const { results } = await db
          .prepare(
            `SELECT * FROM offer_enrichments WHERE id IN (${chunk.map(() => '?').join(',')})`,
          )
          .bind(...chunk)
          .all();
        for (const r of results || []) map.set(r.id, r);
      }
      return map;
    },

    // No-schema-migration shadow backfill. Existing production rows already
    // contain every builder input; this fills missing/stale score metadata and
    // never changes observed names, match_text, or serving eligibility.
    async backfillArabicBuilderShadows(limit = 200) {
      const missingShadow = (column = 'extraction_json') =>
        `CASE WHEN ${column} IS NULL THEN 1 ` +
        `WHEN json_valid(${column}) THEN (` +
        `COALESCE(json_extract(${column}, '$._arabic_builder.builder_score_version'), '') ` +
        `!= '${BUILDER_SCORE_VERSION}' OR ` +
        `COALESCE(json_extract(${column}, '$._arabic_builder.commerce_score_version'), '') ` +
        `!= '${COMMERCE_SCORE_VERSION}') ` +
        `ELSE 0 END`;
      const { results } = await db
        .prepare(
          `SELECT e.id, e.name, e.name_ar, e.brand, e.size, e.extraction_json,
                  o.price, o.currency
             FROM offer_enrichments e JOIN offers o ON o.id = e.id
            WHERE ${missingShadow('e.extraction_json')}
            ORDER BY e.enriched_at DESC LIMIT ?`,
        )
        .bind(Math.max(1, Math.min(Number(limit) || 200, 500)))
        .all();
      const rows = results || [];
      if (!rows.length) return 0;
      const statements = rows.map((row) => {
        let observation = {};
        try {
          observation = row.extraction_json ? JSON.parse(row.extraction_json) : {};
        } catch {
          observation = {};
        }
        const { arabicBuilder } = buildArabicShadow({
          ...observation,
          name_en: row.name,
          name_ar: row.name_ar,
          brand: row.brand,
          size: row.size,
          price: row.price,
          currency: row.currency,
        });
        return db
          .prepare(
            `UPDATE offer_enrichments SET extraction_json = ?
              WHERE id = ? AND (${missingShadow()})`,
          )
          .bind(
            JSON.stringify(withArabicBuilderShadow(observation, arabicBuilder)),
            row.id,
          );
      });
      const changes = await db.batch(statements);
      return changes.reduce((sum, result) => sum + (result?.meta?.changes || 0), 0);
    },

    // Offer ids churn weekly (the aggregator re-extracts every flyer), and
    // retention prunes expired offer rows — enrichments follow their offers.
    //
    // THE RECOVERY TABLES ARE PRUNED HERE TOO, and they have to be: neither
    // carries a foreign key, and every operator-facing read of them inner-joins
    // `offers`, so orphans are invisible in the console while still occupying
    // the database. On weekly churn that is unbounded growth nobody can see.
    // The verdict table is in the same position — keyed by offer, joined on
    // read, no FK.
    //
    // Recovery history dies with its offer rather than being kept for
    // effectiveness reporting. It is a deliberate trade: `effectiveness()`
    // aggregates over live history only, which is the honest scope for a
    // database whose offer ids are re-minted every week — an id that no longer
    // exists cannot be traced back to anything an operator can look at.
    async pruneOrphans() {
      const res = await db
        .prepare(
          'DELETE FROM offer_enrichments WHERE id NOT IN (SELECT id FROM offers)',
        )
        .run();
      await db.batch([
        db.prepare('DELETE FROM offer_extraction_attempts WHERE offer_id NOT IN (SELECT id FROM offers)'),
        db.prepare('DELETE FROM offer_ocr_queue WHERE offer_id NOT IN (SELECT id FROM offers)'),
      ]);
      // Separate batch, and tolerant: these tables may not exist yet on a
      // Worker running ahead of its migrations, and retention must not start
      // failing because of it.
      await db.batch([
        db.prepare('DELETE FROM offer_recovery_attempts WHERE offer_id NOT IN (SELECT id FROM offers)'),
        db.prepare('DELETE FROM offer_recovery_queue WHERE offer_id NOT IN (SELECT id FROM offers)'),
        db.prepare('DELETE FROM offer_acceptance_verdicts WHERE offer_id NOT IN (SELECT id FROM offers)'),
      ]).catch(() => {});
      return res?.meta?.changes || 0;
    },

    // Registry resolution feed (registry/drain.js): every UNPROCESSED
    // enrichment (mint_verdict NULL) on a current offer, with the offer fields
    // the resolver/observation need. Non-servable rows are included — the
    // drain stamps their defer verdict so they are scanned exactly once.
    async listUnresolved({ currentOn, limit = 50 } = {}) {
      const { results } = await db
        .prepare(
          `SELECT o.id, o.store, o.region, o.source,
                  o.price, o.old_price, o.valid_from, o.detected_at,
                  e.identity_candidate, e.identity_candidate_version
             FROM offer_enrichments e JOIN offers o ON o.id = e.id
            WHERE e.mint_verdict IS NULL AND o.valid_to >= ?
            ORDER BY o.detected_at DESC LIMIT ?`,
        )
        .bind(currentOn, Math.max(1, Math.min(Number(limit) || 50, 500)))
        .all();
      return results || [];
    },

    // Stamp resolution verdicts (IDENTITY-V2 §3.1: recorded, never silent).
    async setVerdicts(pairs) {
      for (let i = 0; i < pairs.length; i += 60) {
        await db.batch(
          pairs.slice(i, i + 60).map(({ id, verdict }) =>
            db
              .prepare('UPDATE offer_enrichments SET mint_verdict = ? WHERE id = ?')
              .bind(verdict, id),
          ),
        );
      }
    },

    // Review decisions are persisted by the existing mint_verdict journal,
    // not by manufacturing a product_sighting. This keeps them actionable in
    // the operator queue while preserving the core invariant that every
    // product_sighting already has a Registry Product ID.
    async listPendingReviews(limit = 50) {
      const { results } = await db
        .prepare(
          `SELECT o.id AS offer_id, NULL AS product_id, 'review' AS match_band,
                  NULL AS match_score, NULL AS corroboration,
                  o.store, o.region,
                  COALESCE(o.valid_from, substr(o.detected_at, 1, 10)) AS week,
                  o.price, o.old_price, e.enriched_at AS resolved_at,
                  o.image_url AS o_image_url, o.source_url AS o_source_url,
                  o.search_text AS o_search_text,
                  NULL AS p_display_name, NULL AS p_display_name_ar,
                  e.identity_candidate, e.identity_candidate_version,
                  'pending' AS review_state, 0 AS trusted
             FROM offer_enrichments e
             JOIN offers o ON o.id = e.id
             LEFT JOIN product_sightings s ON s.offer_id = e.id
            WHERE e.mint_verdict = 'review' AND s.offer_id IS NULL
            ORDER BY e.enriched_at DESC LIMIT ?`,
        )
        .bind(Math.max(1, Math.min(Number(limit) || 50, 200)))
        .all();
      return results || [];
    },

    async getPendingReview(offerId) {
      return db
        .prepare(
          `SELECT o.id AS offer_id, o.store, o.region, o.source,
                  o.price, o.old_price,
                  COALESCE(o.valid_from, substr(o.detected_at, 1, 10)) AS week,
                  e.identity_candidate, e.identity_candidate_version
             FROM offer_enrichments e
             JOIN offers o ON o.id = e.id
             LEFT JOIN product_sightings s ON s.offer_id = e.id
            WHERE e.id = ? AND e.mint_verdict = 'review'
              AND s.offer_id IS NULL`,
        )
        .bind(offerId)
        .first();
    },

    // Historical rollout primitives. Staging writes only the candidate
    // contract and intentionally leaves mint_verdict untouched. Activation is
    // guarded in SQL so an offer with any existing Registry sighting can never
    // be re-resolved or have its trusted Product ID changed.
    async historicalCandidateRows(ids) {
      const selected = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 200);
      if (!selected.length) return [];
      const { results } = await db
        .prepare(
          `SELECT e.id, e.name, e.name_ar, e.brand, e.size, e.confidence,
                  e.identity_candidate, e.identity_candidate_version,
                  e.mint_verdict,
                  CASE WHEN s.offer_id IS NULL THEN 0 ELSE 1 END AS has_sighting
             FROM offer_enrichments e
             LEFT JOIN product_sightings s ON s.offer_id = e.id
            WHERE e.id IN (${selected.map(() => '?').join(',')})`,
        )
        .bind(...selected)
        .all();
      return results || [];
    },

    async stageHistoricalCandidates(rows) {
      for (let i = 0; i < rows.length; i += 60) {
        await db.batch(rows.slice(i, i + 60).map((row) => db
          .prepare(
            `UPDATE offer_enrichments
                SET identity_candidate = ?, identity_candidate_version = ?
              WHERE id = ?`,
          )
          .bind(
            row.identity_candidate == null ? null : JSON.stringify(row.identity_candidate),
            row.identity_candidate_version ?? IDENTITY_CANDIDATE_STORAGE_VERSION,
            row.id,
          )));
      }
      return { staged: rows.length };
    },

    async activateHistoricalCandidates(ids) {
      let activated = 0;
      for (const id of [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 200)) {
        const result = await db
          .prepare(
            `UPDATE offer_enrichments SET mint_verdict = NULL
              WHERE id = ? AND identity_candidate IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM product_sightings s WHERE s.offer_id = offer_enrichments.id
                )`,
          )
          .bind(id)
          .run();
        activated += result?.meta?.changes || 0;
      }
      return { activated };
    },

    async rollbackHistoricalCandidates(snapshot) {
      let restored = 0;
      for (const row of snapshot || []) {
        const result = await db
          .prepare(
            `UPDATE offer_enrichments
                SET identity_candidate = ?, identity_candidate_version = ?, mint_verdict = ?
              WHERE id = ? AND NOT EXISTS (
                SELECT 1 FROM product_sightings s WHERE s.offer_id = offer_enrichments.id
              )`,
          )
          .bind(
            row.identity_candidate ?? null,
            row.identity_candidate_version ?? null,
            row.mint_verdict ?? null,
            row.id,
          )
          .run();
        restored += result?.meta?.changes || 0;
      }
      return { restored };
    },

    // Un-stamp verdicts (registry/lifecycle.js dangling-sighting healing): a
    // NULL verdict re-enters the §3.1 resolution feed, so the next drain
    // re-resolves these offers cleanly.
    async resetVerdicts(ids) {
      for (let i = 0; i < ids.length; i += 60) {
        const chunk = ids.slice(i, i + 60);
        await db
          .prepare(
            `UPDATE offer_enrichments SET mint_verdict = NULL
              WHERE id IN (${chunk.map(() => '?').join(',')})`,
          )
          .bind(...chunk)
          .run();
      }
    },

    // §3.1 verdict counters for /registry/stats: how every enrichment row
    // fared at resolution. NULL = still unresolved (the drain backlog).
    async verdictCounts() {
      const { results } = await db
        .prepare(
          `SELECT COALESCE(mint_verdict, 'unresolved') AS verdict, COUNT(*) AS n
             FROM offer_enrichments GROUP BY verdict`,
        )
        .all();
      return Object.fromEntries((results || []).map((r) => [r.verdict, r.n]));
    },

    // Heal rows written before match_text existed (e.g. the shadow-corpus
    // upload): recompute the vision haystack in JS. Returns rows healed;
    // 0 = nothing left to do.
    async reindexMatchText(limit = 400) {
      const { results } = await db
        .prepare(
          `SELECT id, name, name_ar, brand FROM offer_enrichments
            WHERE match_text IS NULL AND (name IS NOT NULL OR name_ar IS NOT NULL)
            LIMIT ?`,
        )
        .bind(limit)
        .all();
      const rows = results || [];
      if (!rows.length) return 0;
      await db.batch(
        rows.map((r) =>
          db
            .prepare('UPDATE offer_enrichments SET match_text = ? WHERE id = ?')
            .bind(visionMatchText(r), r.id),
        ),
      );
      return rows.length;
    },
  };
}
