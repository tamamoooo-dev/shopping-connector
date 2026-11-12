// ops/digest.js — the DAILY HEALTH DIGEST (2026-10-08).
//
// The system's failures were all silent: watches stuck "incomplete" for 17
// days, 5,919 offers unread by Vision, stores without a current flyer, keys
// retired for budget. Each was visible on /__ops to anyone who looked, and
// nobody looks every day. One push a day to the same ntfy topic as the price
// alerts (NTFY_TOPIC) puts the answer in front of the operator instead.
//
// composeDigest is pure (tested); gatherDigestInputs reads production state
// through the same functions /__ops renders, so the digest and the console
// can never disagree about what "unhealthy" means.

import { computeStoreRows, schedulerCheck, visionProgress, watchSlots } from './status.js';
import { marketDate } from '../marketDate.js';
import { mistralPoolInventory } from '../offers/mistralKeys.js';
import { currentKeyUsage } from '../offers/mistralKeyHealth.js';

export const DIGEST_HOUR_UTC = 5; // 08:00 Riyadh, after the 07:00 watch round
const VISION_SERVED_TARGET = 95; // % of current offers with a crop
const USABLE_KEY_STATUSES = new Set(['ready', 'limited', 'unobserved']);
// Retention runs daily: two days without a run is a missed one. The export
// runs weekly and finishes the day it starts.
const RETENTION_MAX_AGE_H = 49;
const BACKUP_MAX_AGE_DAYS = 8;
const BACKUP_ACTIVE_KEY = 'backups/d1/active.json';
const DAY_MS = 86400000;

export function isDigestTick(value) {
  const at = new Date(value);
  return Number.isFinite(at.getTime()) && at.getUTCHours() === DIGEST_HOUR_UTC && at.getUTCMinutes() === 0;
}

// inputs: { stores: [{store, status, lastError}], vision: {withCrop, served,
// unread, perHour}, prices: {pending, rejected}, watches: {slot, total,
// completed, incomplete, open}, keys: {usable, retired, statuses},
// scheduler: {status, detail}, retention: {ok, ageH, error, deleted},
// backup: {id, done, ageDays} }
export function composeDigest({
  stores = [], vision = null, prices = null, watches = null, keys = null,
  scheduler = null, retention = null, backup = null,
} = {}) {
  const problems = [];
  const lines = [];

  const bad = stores.filter((row) => row.status !== 'OK' && row.status !== 'PUBLISHING');
  if (bad.length) {
    problems.push(`${bad.length} store(s)`);
    lines.push(`Stores: ${bad.length} need attention`);
    for (const row of bad) lines.push(`  ${row.store}: ${row.status}${row.lastError ? ` (${String(row.lastError).slice(0, 80)})` : ''}`);
  } else {
    lines.push(`Stores: all ${stores.length} OK`);
  }

  if (vision && vision.withCrop > 0) {
    const pct = Math.round((vision.served / vision.withCrop) * 1000) / 10;
    const eta = vision.perHour > 0 && vision.unread > 0 ? `, ~${Math.ceil(vision.unread / vision.perHour)} h to clear` : '';
    if (pct < VISION_SERVED_TARGET) problems.push(`Vision ${pct}%`);
    lines.push(`Vision: ${pct}% served (${vision.served}/${vision.withCrop}), ${vision.unread} unread${eta}`);
  }

  if (prices) {
    lines.push(`Unpriced flyer items: ${prices.pending} waiting, ${prices.rejected} refused (current)`);
  }

  if (watches && watches.total > 0) {
    if (watches.incomplete > 0) problems.push(`${watches.incomplete} watch(es) incomplete`);
    lines.push(`Watches ${watches.slot}: ${watches.completed}/${watches.total} completed`
      + `${watches.incomplete ? `, ${watches.incomplete} incomplete` : ''}${watches.open ? `, ${watches.open} still retrying` : ''}`);
  }

  if (keys) {
    if (keys.usable < 2) problems.push(`${keys.usable} usable Mistral key(s)`);
    lines.push(`Mistral keys: ${keys.usable} usable${keys.retired ? `, ${keys.retired} retired` : ''}`);
  }

  if (scheduler && scheduler.status === 'FAIL') {
    problems.push('scheduler');
    lines.push(`Scheduler: ${scheduler.detail}`);
  }

  // No retention row at all is not judged: the audit log itself is new on a
  // fresh deployment, and a tick that never fires fails the Scheduler check.
  if (retention) {
    const stale = retention.ageH > RETENTION_MAX_AGE_H;
    if (!retention.ok) problems.push('retention failed');
    else if (stale) problems.push('retention not running');
    lines.push(!retention.ok
      ? `Retention: failed${retention.error ? ` (${String(retention.error).slice(0, 80)})` : ''}`
      : `Retention: ran ${Math.round(retention.ageH)} h ago${stale ? ' (due daily)' : ''}`);
  }

  if (backup) {
    const days = Math.floor(backup.ageDays);
    if (backup.done) {
      if (backup.ageDays > BACKUP_MAX_AGE_DAYS) problems.push('backup overdue');
      lines.push(`Backup: last complete ${backup.id} (${days} d ago)`);
    } else {
      if (backup.ageDays > 1) problems.push('backup stuck');
      lines.push(`Backup: ${backup.id} still exporting${backup.ageDays > 1 ? ` after ${days} d` : ''}`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    title: problems.length ? `Super Search: ${problems.length} issue(s)` : 'Super Search: all healthy',
    body: [problems.length ? `Needs attention: ${problems.join(', ')}` : 'Nothing needs attention.', '', ...lines].join('\n'),
  };
}

// The newest watch slot that is at least an hour old has had its main round;
// later minute retries are still counted as "open". Same read as the Cron
// Monitor's watches row (status.js watchSlots).
async function latestWatchSlot(db, now) {
  const [slot] = await watchSlots(db, { now, minAgeMs: 60 * 60 * 1000, limit: 1 });
  if (!slot) return null;
  return {
    slot: slot.slot,
    total: slot.total,
    completed: slot.completed,
    incomplete: slot.incomplete,
    open: slot.open,
  };
}

async function priceQueue(db, today) {
  const { results } = await db.prepare(
    "SELECT status, COUNT(*) AS n FROM price_pending WHERE valid_to >= ? AND status IN ('pending', 'rejected') GROUP BY status",
  ).bind(today).all();
  const count = (status) => Number((results || []).find((r) => r.status === status)?.n || 0);
  return { pending: count('pending'), rejected: count('rejected') };
}

// The newest retention run (index.js records one `cron:retention` row a day).
async function latestRetention(opsStore, now) {
  const [row] = (await opsStore.list({ origin: 'cron', action: 'cron:retention', limit: 1 }))
    .filter((entry) => entry.action === 'cron:retention');
  if (!row) return null;
  return { ok: !!row.ok, error: row.error || null, ageH: (now.getTime() - Date.parse(row.ts)) / 3600000 };
}

// The weekly export's own state object (backup.js): the set it is on, and
// whether that set is finished. A set is named by the UTC date it started.
async function backupState(objectStore, now) {
  const stored = await objectStore.get(BACKUP_ACTIVE_KEY);
  if (!stored) return null;
  const active = JSON.parse(new TextDecoder().decode(stored.bytes));
  const startedMs = Date.parse(`${active?.id}T00:00:00Z`);
  if (!Number.isFinite(startedMs)) return null;
  return { id: active.id, done: !!active.done, ageDays: (now.getTime() - startedMs) / DAY_MS };
}

function keyHealth(ctx, usage) {
  // Every Mistral use runs on the ministral14 pool (2026-09-24).
  const pool = mistralPoolInventory(ctx.mistralPools, usage)
    .find((entry) => entry.pool === 'ministral14');
  const configured = (pool?.keys || []).filter((key) => key.configured);
  const usable = configured.filter((key) => USABLE_KEY_STATUSES.has(key.status)).length;
  return { usable, retired: configured.length - usable, statuses: configured.map((key) => key.status) };
}

export async function gatherDigestInputs(ctx, { now = new Date() } = {}) {
  // The market's date (Riyadh), like every other "current offer" read: the UTC
  // date is yesterday's for the three hours after Riyadh midnight, which
  // counted offers that had already expired as still waiting.
  const today = marketDate(now);
  const settle = (promise) => promise.catch(() => null);
  const [storeRows, progress, prices, watches, keyUsage, scheduler, retention, backup] = await Promise.all([
    settle(computeStoreRows(ctx, { now })),
    settle(visionProgress(ctx, { now })),
    ctx.db ? settle(priceQueue(ctx.db, today)) : null,
    ctx.db ? settle(latestWatchSlot(ctx.db, now)) : null,
    ctx.mistralPools ? settle(currentKeyUsage(ctx)) : null,
    ctx.opsStore?.list ? settle(schedulerCheck(ctx, { now })) : null,
    ctx.opsStore?.list ? settle(latestRetention(ctx.opsStore, now)) : null,
    ctx.objectStore?.get ? settle(backupState(ctx.objectStore, now)) : null,
  ]);
  return {
    stores: (storeRows || []).map((row) => ({ store: row.store, status: row.status, lastError: row.lastError })),
    vision: progress
      ? {
          withCrop: progress.withCrop,
          served: progress.servable,
          unread: progress.remaining,
          perHour: progress.rate,
        }
      : null,
    prices,
    watches,
    keys: ctx.mistralPools ? keyHealth(ctx, keyUsage || {}) : null,
    scheduler: scheduler ? { status: scheduler.status, detail: scheduler.detail } : null,
    retention,
    backup,
  };
}

export async function buildHealthDigest(ctx, { now = new Date() } = {}) {
  return composeDigest(await gatherDigestInputs(ctx, { now }));
}

// The daily run (2026-10-09). The digest is RECORDED every day as a
// `cron:digest` ops row — the console history is its durable home — and pushed
// only when a notifier exists (push can be off: NTFY_PUSH, monitor.js). `ok`
// is whether the job did its work; the system's health is `detail.healthy`.
export async function runDailyDigest(ctx, { now = new Date() } = {}) {
  const t0 = Date.now();
  const digest = await buildHealthDigest(ctx, { now });
  const push = ctx.pushDisabled ? 'disabled' : ctx.notifier ? 'ntfy' : 'unconfigured';
  let pushed = false;
  let pushError = null;
  if (ctx.notifier) {
    try {
      await ctx.notifier.send({
        title: digest.title,
        body: digest.body,
        tags: digest.ok ? 'white_check_mark' : 'warning',
      });
      pushed = true;
    } catch (err) {
      pushError = String(err?.message || err).slice(0, 200);
    }
  }
  await ctx.opsStore?.record?.({
    ts: now.toISOString(),
    action: 'cron:digest',
    origin: 'cron',
    ok: !pushError,
    failed: digest.problems.length,
    elapsed_ms: Date.now() - t0,
    error: pushError ? `push: ${pushError}` : null,
    detail: {
      healthy: digest.ok,
      title: digest.title,
      body: digest.body,
      problems: digest.problems,
      push,
      pushed,
    },
  }).catch(() => {});
  return { ...digest, push, pushed, pushError };
}
