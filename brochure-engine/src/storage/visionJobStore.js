// storage/visionJobStore.js — the Background Manual Vision job store behind a
// narrow interface, backed by D1 (the SAME database as offers/enrichments — the
// job is a subsystem of the engine, not a separate service). Vision Milestone 2
// §2 (cron-driven redesign 2026-07-20): an operator launches a "Run Vision" job
// from the Operations Center; the 1-minute `visionDrain` cron (index.js) drains
// the queue to empty server-side — paced by Mistral, single-writer via the
// tryLease CAS below — updating THIS row each fire so live progress survives the
// browser closing.
//
// NAMED LIVE JOB: id defaults to 'active' for the UI-visible Vision job.
// Recovery uses id 'recovery' only as its cron coordinator lease. A full job
// history is deliberately out of scope — ops_runs already records each hop.
//
// Interface:
//   start({ scope, total, origin }) -> Promise<row>   (arms a fresh 'active' job)
//   get()                           -> Promise<row|null>  (provider_limit parsed)
//   update(patch)                   -> Promise<row|null>  (whitelisted columns)
//   stop()                          -> Promise<row|null>  (status 'stopped')
//   tryLease({ nowMs, leaseMs })    -> Promise<boolean>   (claim the drain)
//   renewLease({ nowMs, leaseMs })  -> Promise<boolean>   (extend OUR lease)

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

export function createD1VisionJobStore(db, { id = 'active' } = {}) {
  const jobId = String(id || 'active');
  // The lease_until value THIS store instance last wrote (tryLease or
  // renewLease). renewLease only extends a lease still holding that exact
  // value, so a fire whose lease expired and was taken over can never
  // extend the new holder's lease.
  let held = null;
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
        .bind(jobId, scope, total, total, now, now, origin)
        .run();
      return this.get();
    },

    // Idempotently arm a lease row without resetting a running job's progress
    // or lease. Recovery uses id='recovery' in this same generic table, avoiding
    // a second migration solely for a coordinator mutex.
    async ensureRunning({ scope = 'all', origin = 'cron' } = {}) {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO vision_jobs
             (id, status, scope, total, processed, enriched, declined, failed,
              remaining, hops, started_at, updated_at, origin, lease_until)
           VALUES (?, 'running', ?, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?, NULL)
           ON CONFLICT(id) DO UPDATE SET
             status = CASE WHEN vision_jobs.status = 'running'
                           THEN vision_jobs.status ELSE 'running' END,
             scope = excluded.scope,
             updated_at = excluded.updated_at,
             finished_at = CASE WHEN vision_jobs.status = 'running'
                                THEN vision_jobs.finished_at ELSE NULL END,
             origin = excluded.origin,
             lease_until = CASE WHEN vision_jobs.status = 'running'
                                THEN vision_jobs.lease_until ELSE NULL END`,
        )
        .bind(jobId, scope, now, now, origin)
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
        .bind(until, jobId, now)
        .run();
      const ok = (res?.meta?.changes || 0) > 0;
      if (ok) held = until;
      return ok;
    },

    // Heartbeat (2026-11-19, scheduler.js startLeaseHeartbeat). A fire takes
    // a SHORT lease and extends it while it is alive, so a fire that dies
    // stops blocking the drain within minutes instead of a fixed 15-minute
    // lease. Compare-and-set on the value this instance wrote: true while
    // this fire still owns the lease, false once it was released or taken.
    async renewLease({ nowMs = Date.now(), leaseMs = 120000 } = {}) {
      if (!held) return false;
      const until = new Date(nowMs + leaseMs).toISOString();
      const res = await db
        .prepare('UPDATE vision_jobs SET lease_until = ? WHERE id = ? AND lease_until = ?')
        .bind(until, jobId, held)
        .run();
      const ok = (res?.meta?.changes || 0) > 0;
      held = ok ? until : null;
      return ok;
    },

    async get() {
      const row = await db
        .prepare('SELECT * FROM vision_jobs WHERE id = ?')
        .bind(jobId)
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
      binds.push(jobId);
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
        .bind(now, now, jobId)
        .run();
      return this.get();
    },
  };
}
