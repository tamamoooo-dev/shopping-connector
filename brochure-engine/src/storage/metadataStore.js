// storage/metadataStore.js — the index & history store behind a narrow
// interface (§5.2). Backed by D1 (SQLite) in production.
//
// Interface:
//   existsByChecksum(checksum)      -> Promise<boolean>   (the dedupe gate)
//   upsert(row)                     -> Promise<void>      (store/refresh one row as current)
//   setCurrent(store, region, checksums, { supersedeOthers }) -> Promise<void>
//       marks exactly the given checksums current for a store+region (a store
//       may hold several concurrent flyers); with supersedeOthers, everything
//       else for that store+region is flipped to history
//   getBySourceUrl(store, region, url) -> Promise<row|null> (already-held lookup)
//   getCurrent(store, region)       -> Promise<row[]>     (current set read)
//   listCurrent()                   -> Promise<row[]>     (all current, for health)
//   getHistory(store, region)       -> Promise<row[]>     (prior editions; Pillar 3 substrate)
//
// The `ux_checksum` unique index (schema.sql) enforces dedupe at the DB layer;
// `existsByChecksum` is the cheap pre-check so we never even store bytes twice.

import { PROCESSING_JOINS_SQL, SETTLED_OFFER_SQL } from './brochureProcessing.js';

export function createD1MetadataStore(db) {
  return {
    async existsByChecksum(checksum) {
      const row = await db
        .prepare('SELECT 1 FROM brochures WHERE checksum = ? LIMIT 1')
        .bind(checksum)
        .first();
      return !!row;
    },

    async upsert(row) {
      // Insert-or-refresh one row as current. History is retained (rows are
      // never deleted). Superseding prior rows is the INGEST RUN's job, not the
      // row's: a store may legitimately hold several concurrent current flyers,
      // so the run calls setCurrent() with the full confirmed set afterwards.
      await db
        .prepare(
          `INSERT INTO brochures
             (id, store, region, edition, title, valid_from, valid_to, detected_at,
              source_type, source_url, pdf_url, checksum, collector, storage_key, is_current)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
           ON CONFLICT(id) DO UPDATE SET
             edition=excluded.edition, title=excluded.title,
             valid_from=excluded.valid_from, valid_to=excluded.valid_to,
             detected_at=excluded.detected_at, source_type=excluded.source_type,
             source_url=excluded.source_url, pdf_url=excluded.pdf_url,
             checksum=excluded.checksum, collector=excluded.collector,
             storage_key=excluded.storage_key, is_current=1`,
        )
        .bind(
          row.id, row.store, row.region, row.edition, row.title, row.valid_from,
          row.valid_to, row.detected_at, row.source_type, row.source_url, row.pdf_url,
          row.checksum, row.collector, row.storage_key,
        )
        .run();
    },

    async setCurrent(store, region, checksums, { supersedeOthers = true } = {}) {
      if (!checksums || !checksums.length) return;
      const marks = checksums.map((c) => '?').join(',');
      const stmts = [
        db
          .prepare(
            `UPDATE brochures SET is_current = 1 WHERE store = ? AND region = ? AND checksum IN (${marks})`,
          )
          .bind(store, region, ...checksums),
      ];
      if (supersedeOthers) {
        stmts.push(
          db
            .prepare(
              `UPDATE brochures SET is_current = 0 WHERE store = ? AND region = ? AND checksum NOT IN (${marks})`,
            )
            .bind(store, region, ...checksums),
        );
      }
      await db.batch(stmts);
    },

    async getById(id) {
      if (!id) return null;
      const row = await db.prepare('SELECT * FROM brochures WHERE id = ? LIMIT 1').bind(id).first();
      return row || null;
    },

    async getBySourceUrl(store, region, sourceUrl) {
      if (!sourceUrl) return null;
      const row = await db
        .prepare(
          `SELECT * FROM brochures
            WHERE store = ? AND region = ? AND source_url = ?
            ORDER BY detected_at DESC LIMIT 1`,
        )
        .bind(store, region, sourceUrl)
        .first();
      return row || null;
    },

    async getCurrent(store, region) {
      const { results } = await db
        .prepare('SELECT * FROM brochures WHERE store = ? AND region = ? AND is_current = 1')
        .bind(store, region)
        .all();
      return results || [];
    },

    async listCurrent() {
      const { results } = await db
        .prepare('SELECT * FROM brochures WHERE is_current = 1 ORDER BY store, region')
        .all();
      return results || [];
    },

    async getHistory(store, region) {
      const { results } = await db
        .prepare('SELECT * FROM brochures WHERE store = ? AND region = ? ORDER BY edition DESC')
        .bind(store, region)
        .all();
      return results || [];
    },

    // --- retention (see retention.js): metadata is forever, bytes are a window.
    // Prunable = no longer current, expired before the cutoff, bytes not yet
    // pruned. Oldest first so a backlog drains deterministically.
    async listPrunable(cutoffISO, limit = 12) {
      const { results } = await db
        .prepare(
          `SELECT b.* FROM brochures b
            WHERE b.is_current = 0 AND b.pruned_at IS NULL
              AND b.valid_to IS NOT NULL AND b.valid_to < ?
              AND b.source_type = 'images'
              AND EXISTS (SELECT 1 FROM offers o WHERE o.brochure_id = b.id)
              AND NOT EXISTS (
                SELECT 1 FROM offers o ${PROCESSING_JOINS_SQL}
                WHERE o.brochure_id = b.id AND NOT ${SETTLED_OFFER_SQL})
            ORDER BY b.valid_to ASC LIMIT ?`,
        )
        .bind(cutoffISO, limit)
        .all();
      return results || [];
    },

    async getProcessingSnapshot(row) {
      const flyerRef = /\/(\d+)\/[a-z0-9-]+(?:\?.*)?$/i.exec(row.source_url || '')?.[1];
      if (!flyerRef) return null;
      const [offers, pending] = await Promise.all([
        db.prepare(`SELECT o.*, e.name AS extracted_name, e.name_ar AS extracted_name_ar,
          e.brand AS extracted_brand, e.size AS extracted_size,
          e.extraction_json, e.identity_candidate, e.mint_verdict,
          e.enriched_at, e.crop_url AS extracted_crop_url, e.corroboration,
          v.version AS acceptance_version, v.accepted, v.missing, v.mandatory,
          q.status AS verification_status, q.initial_outcome, q.verified_at,
          q.attempts AS verification_attempts,
          s.product_id, s.match_band, s.week AS history_week,
          ${SETTLED_OFFER_SQL} AS processing_complete
          FROM offers o ${PROCESSING_JOINS_SQL}
          WHERE o.brochure_id = ? ORDER BY o.id LIMIT 5001`)
          .bind(row.id).all(),
        db.prepare(`SELECT * FROM price_pending
          WHERE store = ? AND region = ? AND flyer_ref = ? ORDER BY id LIMIT 5001`)
          .bind(row.store, row.region, flyerRef).all(),
      ]);
      if (offers.results.length > 5000 || pending.results.length > 5000) return null;
      return { offers: offers.results, pending: pending.results };
    },

    async markPruned(id) {
      await db
        .prepare('UPDATE brochures SET pruned_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), id)
        .run();
    },
  };
}
