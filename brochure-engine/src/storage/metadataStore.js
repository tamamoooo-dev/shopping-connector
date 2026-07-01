// storage/metadataStore.js — the index & history store behind a narrow
// interface (§5.2). Backed by D1 (SQLite) in production.
//
// Interface:
//   existsByChecksum(checksum)      -> Promise<boolean>   (the dedupe gate)
//   upsert(row)                     -> Promise<void>      (store + flip prior is_current)
//   getCurrent(store, region)       -> Promise<row[]>     (O(1) "latest" read)
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
      // A new edition for a (store, region) supersedes the prior "current" one,
      // but history is retained (rows are never deleted). Do the flip then the
      // insert-or-replace as a batch so a "latest" read never sees two current
      // rows for the same store+region.
      await db.batch([
        db
          .prepare('UPDATE brochures SET is_current = 0 WHERE store = ? AND region = ? AND id <> ?')
          .bind(row.store, row.region, row.id),
        db
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
          ),
      ]);
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
  };
}
