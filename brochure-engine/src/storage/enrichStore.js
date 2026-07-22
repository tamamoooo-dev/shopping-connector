// storage/enrichStore.js — the vision-enrichment side-car store behind a
// narrow interface, backed by D1 (the same database as the offers rows the
// enrichments describe — see offers/enrich.js for the discipline).
//
// Interface:
//   listDebris({ currentOn, limit, scope }) -> Promise<{id, image_url}[]>
//   listSelected({ ids, currentOn }) -> Promise<{id, image_url}[]>
//   countDebris(currentOn, scope)    -> Promise<number>
//   upsertMany(rows)                 -> Promise<{ stored }>   (idempotent)
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
export const CANON_NAME_AR_SQL = `(CASE WHEN ${SERVABLE_SQL} THEN e.name_ar ELSE o.name_ar END)`;
// Canonical match haystack: the vision match_text when servable (legacy rows
// not yet reindexed have match_text NULL and fall back to OCR), else OCR.
export const CANON_HAYSTACK_SQL =
  `(CASE WHEN ${SERVABLE_SQL} AND e.match_text IS NOT NULL THEN e.match_text ELSE o.search_text END)`;
// The enrichment columns a search row must carry so offers/enrich.js
// applyEnrichment() can overlay without a second query.
export const ENRICH_ROW_COLS =
  'e.name AS e_name, e.name_ar AS e_name_ar, e.match_text AS e_match_text, e.corroboration AS e_corroboration';

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
       crop_url, enriched_at, match_text, identity_candidate,
       identity_candidate_version, mint_verdict)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, name_ar=excluded.name_ar, brand=excluded.brand,
      size=excluded.size, confidence=excluded.confidence,
      corroboration=excluded.corroboration, model=excluded.model,
      crop_url=excluded.crop_url, enriched_at=excluded.enriched_at,
      match_text=excluded.match_text,
      identity_candidate=excluded.identity_candidate,
      identity_candidate_version=excluded.identity_candidate_version,
      mint_verdict=NULL`; // a re-enrichment is re-resolved (idempotent: the
                          // sighting PK makes a re-resolve of a sighted offer
                          // a verdict re-stamp and nothing else)

  return {
    async listDebris({ currentOn, limit = 15, scope = 'all' } = {}) {
      const { results } = await db
        .prepare(
          `SELECT o.id, o.image_url
             FROM offers o LEFT JOIN offer_enrichments e ON e.id = o.id
            WHERE e.id IS NULL ${SCOPE_WHERE[scope] ?? SCOPE_WHERE.all}
              AND o.image_url IS NOT NULL AND o.valid_to >= ?
            ORDER BY o.detected_at DESC LIMIT ?`,
        )
        .bind(currentOn, Math.max(1, Math.min(Number(limit) || 15, 50)))
        .all();
      return results || [];
    },

    // Explicit allowlist used only by staged historical re-enrichment. Unlike
    // listDebris it may return an already-enriched crop, but never widens past
    // the supplied IDs and never mutates Registry state itself.
    async listSelected({ ids, currentOn } = {}) {
      const selected = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 50);
      if (!selected.length) return [];
      const { results } = await db
        .prepare(
          `SELECT id, image_url FROM offers
            WHERE id IN (${selected.map(() => '?').join(',')})
              AND image_url IS NOT NULL AND valid_to >= ?
            ORDER BY detected_at DESC`,
        )
        .bind(...selected, currentOn)
        .all();
      return results || [];
    },

    // Ops Vision Progress: the enrichment coverage of the CURRENT vision-
    // eligible catalog (offers holding a crop), in one query. `attempted`
    // counts every offer vision has looked at (incl. declined, NULL-names
    // rows); `enriched` those it read a name from; `servable` those clearing
    // the corroboration floor. `remaining = withCrop - attempted` equals
    // countDebris('all'); coverage% is attempted/withCrop (how far vision has
    // reached), not enriched/withCrop (that would punish honest declines).
    async coverage(currentOn) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS with_crop,
                  SUM(CASE WHEN e.id IS NOT NULL THEN 1 ELSE 0 END) AS attempted,
                  SUM(CASE WHEN e.name IS NOT NULL OR e.name_ar IS NOT NULL THEN 1 ELSE 0 END) AS enriched,
                  SUM(CASE WHEN (e.name IS NOT NULL OR e.name_ar IS NOT NULL)
                            AND e.corroboration >= ${CORROBORATION_FLOOR} THEN 1 ELSE 0 END) AS servable
             FROM offers o LEFT JOIN offer_enrichments e ON e.id = o.id
            WHERE o.image_url IS NOT NULL AND o.valid_to >= ?`,
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

    async countDebris(currentOn, scope = 'all') {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM offers o LEFT JOIN offer_enrichments e ON e.id = o.id
            WHERE e.id IS NULL ${SCOPE_WHERE[scope] ?? SCOPE_WHERE.all}
              AND o.image_url IS NOT NULL AND o.valid_to >= ?`,
        )
        .bind(currentOn)
        .first();
      return row?.n || 0;
    },

    async upsertMany(rows) {
      for (let i = 0; i < rows.length; i += 40) {
        await db.batch(
          rows.slice(i, i + 40).map((r) =>
            db
              .prepare(upsertStmt)
              .bind(
                r.id, r.name ?? null, r.name_ar ?? null, r.brand ?? null,
                r.size ?? null, r.confidence ?? null, r.corroboration ?? null,
                r.model ?? null, r.crop_url ?? null, r.enriched_at,
                visionMatchText(r),
                r.identity_candidate == null ? null : JSON.stringify(r.identity_candidate),
                r.identity_candidate_version ?? (r.identity_candidate == null
                  ? null
                  : IDENTITY_CANDIDATE_STORAGE_VERSION),
              ),
          ),
        );
      }
      return { stored: rows.length };
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

    // Offer ids churn weekly (the aggregator re-extracts every flyer), and
    // retention prunes expired offer rows — enrichments follow their offers.
    async pruneOrphans() {
      const res = await db
        .prepare(
          'DELETE FROM offer_enrichments WHERE id NOT IN (SELECT id FROM offers)',
        )
        .run();
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
