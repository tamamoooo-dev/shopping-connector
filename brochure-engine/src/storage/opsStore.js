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
//
// Row shape (ops_runs, schema.sql): ts, action, origin ('cron'|'ops'), store
// (single-store runs; null for coordinator/multi rows), stores (target count),
// ok, detected/new/deduped/failed (brochure totals), offers (stored count),
// coverage (post-run avg %, when the run verified), elapsed_ms, error (first
// error message), detail (JSON blob for drill-down).

export function createD1OpsStore(db) {
  return {
    async record(run) {
      await db
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
          run.detail != null ? JSON.stringify(run.detail) : null,
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
  };
}

// D1 keeps `new` as new_count (NEW is an SQL keyword); the interface speaks `new`.
function rowToRun(r) {
  const { new_count, ...rest } = r;
  return { ...rest, new: new_count };
}
