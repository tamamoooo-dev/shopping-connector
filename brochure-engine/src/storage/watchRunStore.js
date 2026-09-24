// storage/watchRunStore.js — durable twice-daily watch rounds and minute retry leases.

const RETRY_MS = 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;
const newId = () => `wr_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;

export function rowToWatchRun(row) {
  if (!row) return null;
  let result = null;
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { /* diagnostics only */ }
  return {
    id: row.id, watchId: row.watch_id, slotKey: row.slot_key,
    slotPeriod: row.slot_period, scheduledAt: row.scheduled_at, status: row.status,
    attempts: Number(row.attempts) || 0, nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at, completedAt: row.completed_at,
    leaseToken: row.lease_token, leaseUntil: row.lease_until,
    lastResolution: row.last_resolution, lastError: row.last_error, result,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function createD1WatchRunStore(db) {
  return {
    setBasedSlotCreation: true,
    async ensureForSlot(watches, slot, nowMs = Date.now()) {
      const now = new Date(nowMs).toISOString();
      if (await db.prepare('SELECT id FROM watch_runs WHERE slot_key = ? LIMIT 1').bind(slot.key).first()) {
        return 0;
      }
      // Two set-based statements regardless of watch count. The minute cron
      // must not turn N watches into 2N D1 writes on every tick.
      await db.prepare(
        `UPDATE watch_runs
            SET status = 'incomplete', updated_at = ?, lease_token = NULL, lease_until = NULL
          WHERE slot_key <> ? AND status IN ('pending','running','retrying')`,
      ).bind(now, slot.key).run();
      const res = await db.prepare(
        `INSERT OR IGNORE INTO watch_runs
           (id, watch_id, slot_key, slot_period, scheduled_at, status, attempts,
            next_attempt_at, created_at, updated_at)
         SELECT 'wr_' || lower(hex(randomblob(8))), id, ?, ?, ?, 'pending', 0, ?, ?, ?
           FROM watches
          WHERE active = 1 AND (created_at IS NULL OR created_at <= ?)`,
      ).bind(slot.key, slot.period, slot.scheduledAt, slot.scheduledAt,
        now, now, slot.scheduledAt).run();
      return res?.meta?.changes || 0;
    },

    async get(id) {
      return rowToWatchRun(await db.prepare('SELECT * FROM watch_runs WHERE id = ?').bind(id).first());
    },

    async latestForWatchIds(ids = []) {
      const unique = [...new Set(ids.filter(Boolean))];
      if (!unique.length) return new Map();
      const placeholders = unique.map(() => '?').join(',');
      const { results } = await db.prepare(
        `SELECT * FROM (
           SELECT r.*, ROW_NUMBER() OVER (
             PARTITION BY watch_id ORDER BY scheduled_at DESC, created_at DESC
           ) AS rn
             FROM watch_runs r WHERE watch_id IN (${placeholders})
         ) WHERE rn = 1`,
      ).bind(...unique).all();
      return new Map((results || []).map((row) => [row.watch_id, rowToWatchRun(row)]));
    },

    async claimDue(nowMs = Date.now(), limit = 3) {
      const now = new Date(nowMs).toISOString();
      const leaseUntil = new Date(nowMs + LEASE_MS).toISOString();
      const { results } = await db.prepare(
        `SELECT id FROM watch_runs
          WHERE next_attempt_at <= ?
            AND (status IN ('pending','retrying')
              OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?)))
          ORDER BY scheduled_at, next_attempt_at LIMIT ?`,
      ).bind(now, now, Math.max(1, Math.min(Number(limit) || 3, 12))).all();
      const claimed = [];
      for (const row of results || []) {
        const token = crypto.randomUUID();
        const res = await db.prepare(
          `UPDATE watch_runs
              SET status = 'running', attempts = attempts + 1,
                  last_attempt_at = ?, lease_token = ?, lease_until = ?, updated_at = ?
            WHERE id = ? AND next_attempt_at <= ?
              AND (status IN ('pending','retrying')
                OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?)))`,
        ).bind(now, token, leaseUntil, now, row.id, now, now).run();
        if ((res?.meta?.changes || 0) > 0) claimed.push(await this.get(row.id));
      }
      return claimed;
    },

    async finish(id, leaseToken, line, { retryable = false, nowMs = Date.now() } = {}) {
      const now = new Date(nowMs).toISOString();
      const next = new Date(nowMs + RETRY_MS).toISOString();
      const status = retryable ? 'retrying' : 'completed';
      const error = retryable
        ? (line?.notes?.join('; ') || line?.resolution || 'source unavailable')
        : null;
      const res = await db.prepare(
        `UPDATE watch_runs
            SET status = ?, next_attempt_at = ?, completed_at = ?,
                lease_token = NULL, lease_until = NULL, last_resolution = ?,
                last_error = ?, result_json = ?, updated_at = ?
          WHERE id = ? AND lease_token = ?`,
      ).bind(status, retryable ? next : now, retryable ? null : now,
        line?.resolution ?? null, error, JSON.stringify(line || null), now, id, leaseToken).run();
      return (res?.meta?.changes || 0) > 0;
    },
  };
}

export function createMemoryWatchRunStore() {
  const runs = new Map();
  return {
    setBasedSlotCreation: false,
    _runs: runs,
    async ensureForSlot(watches, slot, nowMs = Date.now()) {
      const now = new Date(nowMs).toISOString();
      let created = 0;
      for (const watch of watches || []) {
        if (!watch?.active || Date.parse(watch.createdAt || '') > slot.scheduledMs) continue;
        for (const run of runs.values()) {
          if (run.watchId === watch.id && run.slotKey !== slot.key &&
              ['pending', 'running', 'retrying'].includes(run.status)) {
            run.status = 'incomplete';
            run.updatedAt = now;
          }
        }
        if ([...runs.values()].some((run) => run.watchId === watch.id && run.slotKey === slot.key)) continue;
        const id = newId();
        runs.set(id, {
          id, watchId: watch.id, slotKey: slot.key, slotPeriod: slot.period,
          scheduledAt: slot.scheduledAt, status: 'pending', attempts: 0,
          nextAttemptAt: slot.scheduledAt, lastAttemptAt: null, completedAt: null,
          leaseToken: null, leaseUntil: null, lastResolution: null, lastError: null,
          result: null, createdAt: now, updatedAt: now,
        });
        created += 1;
      }
      return created;
    },
    async get(id) { return runs.has(id) ? { ...runs.get(id) } : null; },
    async latestForWatchIds(ids = []) {
      const out = new Map();
      for (const id of ids) {
        const latest = [...runs.values()].filter((run) => run.watchId === id)
          .sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))[0];
        if (latest) out.set(id, { ...latest });
      }
      return out;
    },
    async claimDue(nowMs = Date.now(), limit = 3) {
      const now = new Date(nowMs).toISOString();
      const due = [...runs.values()].filter((run) => run.nextAttemptAt <= now && (
        ['pending', 'retrying'].includes(run.status) ||
        (run.status === 'running' && (!run.leaseUntil || run.leaseUntil <= now))
      )).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).slice(0, limit);
      return due.map((run) => {
        run.status = 'running'; run.attempts += 1; run.lastAttemptAt = now;
        run.leaseToken = crypto.randomUUID();
        run.leaseUntil = new Date(nowMs + LEASE_MS).toISOString(); run.updatedAt = now;
        return { ...run };
      });
    },
    async finish(id, leaseToken, line, { retryable = false, nowMs = Date.now() } = {}) {
      const run = runs.get(id);
      if (!run || run.leaseToken !== leaseToken) return false;
      const now = new Date(nowMs).toISOString();
      run.status = retryable ? 'retrying' : 'completed';
      run.nextAttemptAt = retryable ? new Date(nowMs + RETRY_MS).toISOString() : now;
      run.completedAt = retryable ? null : now; run.leaseToken = null; run.leaseUntil = null;
      run.lastResolution = line?.resolution ?? null;
      run.lastError = retryable ? (line?.notes?.join('; ') || line?.resolution) : null;
      run.result = line || null; run.updatedAt = now;
      return true;
    },
  };
}
