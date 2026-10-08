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

import { computeStoreRows, visionProgress } from './status.js';
import { latestMistralUsage, mistralPoolInventory } from '../offers/mistralKeys.js';

export const DIGEST_HOUR_UTC = 5; // 08:00 Riyadh, after the 07:00 watch round
const VISION_SERVED_TARGET = 95; // % of current offers with a crop
const USABLE_KEY_STATUSES = new Set(['ready', 'limited', 'unobserved']);

export function isDigestTick(value) {
  const at = new Date(value);
  return Number.isFinite(at.getTime()) && at.getUTCHours() === DIGEST_HOUR_UTC && at.getUTCMinutes() === 0;
}

// inputs: { stores: [{store, status, lastError}], vision: {withCrop, served,
// unread, perHour}, prices: {pending, rejected}, watches: {slot, total,
// completed, incomplete, open}, keys: {usable, retired, statuses} }
export function composeDigest({ stores = [], vision = null, prices = null, watches = null, keys = null } = {}) {
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

  return {
    ok: problems.length === 0,
    problems,
    title: problems.length ? `Super Search: ${problems.length} issue(s)` : 'Super Search: all healthy',
    body: [problems.length ? `Needs attention: ${problems.join(', ')}` : 'Nothing needs attention.', '', ...lines].join('\n'),
  };
}

// The newest watch slot that is at least an hour old has had its main round;
// later minute retries are still counted as "open".
async function latestWatchSlot(db, now) {
  const cutoff = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const slot = await db.prepare(
    'SELECT slot_key FROM watch_runs WHERE scheduled_at <= ? ORDER BY scheduled_at DESC LIMIT 1',
  ).bind(cutoff).first();
  if (!slot?.slot_key) return null;
  const { results } = await db.prepare(
    'SELECT status, COUNT(*) AS n FROM watch_runs WHERE slot_key = ? GROUP BY status',
  ).bind(slot.slot_key).all();
  const count = (status) => Number((results || []).find((r) => r.status === status)?.n || 0);
  const total = (results || []).reduce((n, r) => n + Number(r.n || 0), 0);
  return {
    slot: slot.slot_key,
    total,
    completed: count('completed'),
    incomplete: count('incomplete'),
    open: total - count('completed') - count('incomplete'),
  };
}

async function priceQueue(db, today) {
  const { results } = await db.prepare(
    "SELECT status, COUNT(*) AS n FROM price_pending WHERE valid_to >= ? AND status IN ('pending', 'rejected') GROUP BY status",
  ).bind(today).all();
  const count = (status) => Number((results || []).find((r) => r.status === status)?.n || 0);
  return { pending: count('pending'), rejected: count('rejected') };
}

function keyHealth(ctx, opsRows) {
  // Every Mistral use runs on the ministral14 pool (2026-09-24).
  const pool = mistralPoolInventory(ctx.mistralPools, latestMistralUsage(opsRows))
    .find((entry) => entry.pool === 'ministral14');
  const configured = (pool?.keys || []).filter((key) => key.configured);
  const usable = configured.filter((key) => USABLE_KEY_STATUSES.has(key.status)).length;
  return { usable, retired: configured.length - usable, statuses: configured.map((key) => key.status) };
}

export async function gatherDigestInputs(ctx, { now = new Date() } = {}) {
  const today = now.toISOString().slice(0, 10);
  const settle = (promise) => promise.catch(() => null);
  const [storeRows, progress, prices, watches, opsRows] = await Promise.all([
    settle(computeStoreRows(ctx, { now })),
    settle(visionProgress(ctx, { now })),
    ctx.db ? settle(priceQueue(ctx.db, today)) : null,
    ctx.db ? settle(latestWatchSlot(ctx.db, now)) : null,
    ctx.opsStore?.list ? settle(ctx.opsStore.list({ limit: 120 })) : [],
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
    keys: ctx.mistralPools ? keyHealth(ctx, opsRows || []) : null,
  };
}

export async function buildHealthDigest(ctx, { now = new Date() } = {}) {
  return composeDigest(await gatherDigestInputs(ctx, { now }));
}
