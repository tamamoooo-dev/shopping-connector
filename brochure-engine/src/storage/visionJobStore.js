// storage/visionJobStore.js — the Background Manual Vision job store behind a
// narrow interface, backed by D1 (the SAME database as offers/enrichments — the
// job is a subsystem of the engine, not a separate service). Vision Milestone 2
// §2 (cron-driven redesign 2026-07-20): an operator launches a "Run Vision" job
// from the Operations Center; the 1-minute `visionDrain` cron (index.js) drains
// the queue to empty server-side — paced by Mistral, single-writer via the
// tryLease CAS below — updating THIS row each fire so live progress survives the
// browser closing.
//
// SINGLE LIVE JOB: id 'active' is the one running/most-recent job, upserted in
// place. That is all the UI needs (start / poll / stop); a full job history is
// deliberately out of scope — the ops_runs audit already records each hop.
//
// Interface:
//   start({ scope, total, origin }) -> Promise<row>   (arms a fresh 'active' job)
//   get()                           -> Promise<row|null>  (provider_limit parsed)
//   update(patch)                   -> Promise<row|null>  (whitelisted columns)
//   stop()                          -> Promise<row|null>  (status 'stopped')

const ACTIVE = 'active';

// Only these columns may be patched — a typo can never write a phantom column.
const PATCHABLE = new Set([
  'status', 'scope', 'total', 'processed', 'enriched', 'declined', 'failed',
  'remaining', 'hops', 'updated_at', 'finished_at', 'last_error', 'provider_limit',
  'lease_until',
]);

function rowOut(r) {
  if (!r) return null;
  let providerLimit = null;
  if (r.provider_limit) {
    try { providerLimit = JSON.parse(r.provider_limit); } catch { providerLimit = null; }
  }
  return { ...r, provider_limit: providerLimit };
}

export function createD1VisionJobStore(db) {
  return {
    async start({ scope = 'all', total = 0, origin = 'ops' } = {}) {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT OR REPLACE INTO vision_jobs
             (id, status, scope, total, processed, enriched, declined, failed,
              remaining, hops, started_at, updated_at, finished_at, last_error,
              provider_limit, origin, lease_until)
           VALUES (?, 'running', ?, ?, 0, 0, 0, 0, ?, 0, ?, ?, NULL, NULL, NULL, ?, NULL)`,
        )
        .bind(ACTIVE, scope, total, total, now, now, origin)
        .run();
      return this.get();
    },

    // Single-writer lease (Background Manual Vision continuous drain). Atomic
    // compare-and-set: claim the lease only if the job is running AND no live
    // lease is held. Returns true when THIS caller now owns the drain, false
    // when another 1-minute fire already holds it (so this fire skips). One SQL
    // statement ⇒ the CAS is race-free across concurrent fires.
    async tryLease({ nowMs = Date.now(), leaseMs = 120000 } = {}) {
      const now = new Date(nowMs).toISOString();
      const until = new Date(nowMs + leaseMs).toISOString();
      const res = await db
        .prepare(
          `UPDATE vision_jobs SET lease_until = ?
             WHERE id = ? AND status = 'running'
               AND (lease_until IS NULL OR lease_until < ?)`,
        )
        .bind(until, ACTIVE, now)
        .run();
      return (res?.meta?.changes || 0) > 0;
    },

    async get() {
      const row = await db
        .prepare('SELECT * FROM vision_jobs WHERE id = ?')
        .bind(ACTIVE)
        .first();
      return rowOut(row);
    },

    async update(patch = {}) {
      const cols = [];
      const binds = [];
      for (const [k, v] of Object.entries(patch)) {
        if (!PATCHABLE.has(k)) continue;
        cols.push(`${k} = ?`);
        // provider_limit is stored as a JSON string; everything else as-is.
        binds.push(k === 'provider_limit' && v != null && typeof v !== 'string'
          ? JSON.stringify(v)
          : v);
      }
      if (!cols.includes('updated_at = ?')) {
        cols.push('updated_at = ?');
        binds.push(new Date().toISOString());
      }
      if (!cols.length) return this.get();
      binds.push(ACTIVE);
      await db
        .prepare(`UPDATE vision_jobs SET ${cols.join(', ')} WHERE id = ?`)
        .bind(...binds)
        .run();
      return this.get();
    },

    async stop() {
      const now = new Date().toISOString();
      await db
        .prepare(
          `UPDATE vision_jobs SET status = 'stopped', updated_at = ?, finished_at = ?
             WHERE id = ? AND status = 'running'`,
        )
        .bind(now, now, ACTIVE)
        .run();
      return this.get();
    },
  };
}
