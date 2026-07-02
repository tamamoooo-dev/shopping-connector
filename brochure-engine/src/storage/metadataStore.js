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
          `SELECT * FROM brochures
            WHERE is_current = 0 AND pruned_at IS NULL
              AND valid_to IS NOT NULL AND valid_to < ?
            ORDER BY valid_to ASC LIMIT ?`,
        )
        .bind(cutoffISO, limit)
        .all();
      return results || [];
    },

    async markPruned(id) {
      await db
        .prepare('UPDATE brochures SET pruned_at = ? WHERE id = ?')
        .bind(new Date().toISOString(), id)
        .run();
    },
  };
}
