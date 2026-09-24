// storage/opsStore.js — the Operations Console's audit-timeline store behind a
// narrow interface, backed by D1 (the SAME database as the other stores — the
// console is a subsystem of the Brochure Engine, not a separate service).
//
// This is the ONLY thing the console ever writes: one row per operation run
// (cron fan-out children, cron coordinator summaries, and manual console
// operations all record here). Engine data stays read-only to the console.
//
// Interface:
//   record(run)                    -> Promise<void>   (best-effort; see engine.js)
//   list({ limit, store, origin, failedOnly }) -> Promise<row[]>  (newest first)
//   listArchiveBefore(cutoff, limit) -> Promise<row[]> (oldest first)
//   deleteArchived(ids)            -> Promise<number>
//
// Row shape (ops_runs, schema.sql): ts, action, origin ('cron'|'ops'), store
// (single-store runs; null for coordinator/multi rows), stores (target count),
// ok, detected/new/deduped/failed (brochure totals), offers (stored count),
// coverage (post-run avg %, when the run verified), elapsed_ms, error (first
// error message), detail (JSON blob for drill-down).

export function createD1OpsStore(db) {
  return {
    async record(run) {
      const serializedDetail = compactDetail(run.detail);
      return db
        .prepare(
          `INSERT INTO ops_runs
             (ts, action, origin, store, stores, ok, detected, new_count, deduped,
              failed, offers, coverage, elapsed_ms, error, detail)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          run.ts || new Date().toISOString(),
          run.action,
          run.origin || 'ops',
          run.store ?? null,
          run.stores ?? null,
          run.ok ? 1 : 0,
          run.detected ?? null,
          run.new ?? null,
          run.deduped ?? null,
          run.failed ?? null,
          run.offers ?? null,
          run.coverage ?? null,
          run.elapsed_ms ?? null,
          run.error ?? null,
          serializedDetail,
        )
        .run();
    },

    async list({ limit = 50, store = '', origin = '', failedOnly = false } = {}) {
      const where = [];
      const binds = [];
      if (store) {
        where.push('store = ?');
        binds.push(store);
      }
      if (origin) {
        where.push('origin = ?');
        binds.push(origin);
      }
      if (failedOnly) where.push('ok = 0');
      const sql = `SELECT * FROM ops_runs
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY id DESC LIMIT ?`;
      binds.push(Math.max(1, Math.min(Number(limit) || 50, 400)));
      const { results } = await db.prepare(sql).bind(...binds).all();
      return (results || []).map(rowToRun);
    },

    async listArchiveBefore(cutoffISO, limit = 3000) {
      const { results } = await db
        .prepare('SELECT * FROM ops_runs WHERE ts < ? ORDER BY id LIMIT ?')
        .bind(cutoffISO, Math.max(1, Math.min(Number(limit) || 3000, 5000)))
        .all();
      return results || [];
    },

    async deleteArchived(ids) {
      const selected = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
      let deleted = 0;
      // Stay below D1's 100-bound-parameter ceiling.
      for (let i = 0; i < selected.length; i += 80) {
        const part = selected.slice(i, i + 80);
        const result = await db
          .prepare(`DELETE FROM ops_runs WHERE id IN (${part.map(() => '?').join(',')})`)
          .bind(...part)
          .run();
        deleted += result?.meta?.changes || 0;
      }
      return deleted;
    },
  };
}

const MAX_DETAIL_CHARS = 16000;

// Audit rows are an operational index, not the evidence archive. Cap any
// accidental giant payload at the write boundary; full model evidence belongs
// in R2 and callers still get a useful preview plus the original size.
function compactDetail(value) {
  if (value == null) return null;
  const serialized = JSON.stringify(value);
  if (serialized.length <= MAX_DETAIL_CHARS) return serialized;
  return JSON.stringify({
    _truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, Math.floor(MAX_DETAIL_CHARS / 2)),
  });
}

// D1 keeps `new` as new_count (NEW is an SQL keyword); the interface speaks `new`.
function rowToRun(r) {
  const { new_count, ...rest } = r;
  return { ...rest, new: new_count };
}
