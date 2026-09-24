// watchSchedule.js — durable 07:00/19:00 Asia/Riyadh rounds.
//
// The one-minute Worker cron only creates/claims durable D1 work. Network
// evaluation runs in a SELF child so each small batch gets a fresh subrequest
// budget. A failed source lookup is retried at the next minute tick; any
// trustworthy answer completes and freezes the round until the next slot.

import { checkWatch, RESOLUTION } from './monitor.js';
import { latestRiyadhSlot, WATCH_TRACK, watchTrack } from './watchPlan.js';

export const WATCH_RUN_CLAIM_LIMIT = 3;

export async function claimScheduledWatchRuns(ctx, {
  nowMs = Date.now(),
  limit = WATCH_RUN_CLAIM_LIMIT,
} = {}) {
  if (!ctx.watchStore || !ctx.watchRunStore) return { slot: null, created: 0, runs: [] };
  const slot = latestRiyadhSlot(nowMs);
  const watches = ctx.watchRunStore.setBasedSlotCreation
    ? []
    : await ctx.watchStore.list({ activeOnly: true });
  const created = await ctx.watchRunStore.ensureForSlot(watches, slot, nowMs);
  const runs = await ctx.watchRunStore.claimDue(nowMs, limit);
  return { slot, created, runs };
}

export async function processWatchRuns(ctx, { ids = [], nowMs = Date.now() } = {}) {
  const report = {
    startedAt: new Date(nowMs).toISOString(),
    processed: 0,
    completed: 0,
    retrying: 0,
    alerted: 0,
    lines: [],
  };
  for (const id of [...new Set(ids.filter(Boolean))]) {
    const run = await ctx.watchRunStore?.get(id);
    if (!run || run.status !== 'running' || !run.leaseToken) continue;
    const watch = await ctx.watchStore?.get(run.watchId);
    let line;
    let retryable = false;
    try {
      if (!watch || !watch.active) {
        line = {
          id: run.watchId,
          status: 'inactive',
          resolution: RESOLUTION.UNRESOLVABLE,
          notes: ['watch is missing or inactive'],
          alerted: false,
        };
      } else {
        line = await checkWatch(ctx, watch, {
          // The selected Amazon ASIN must never drift to a similar product.
          allowIdentityRebind: watchTrack(watch) !== WATCH_TRACK.AMAZON_EXACT,
        });
        retryable = line.resolution === RESOLUTION.PROVIDER_ERROR;
      }
    } catch (err) {
      retryable = true;
      line = {
        id: run.watchId,
        status: 'error',
        resolution: RESOLUTION.PROVIDER_ERROR,
        notes: [err?.message || String(err)],
        alerted: false,
      };
    }
    await ctx.watchRunStore.finish(run.id, run.leaseToken, line, { retryable, nowMs });
    report.processed += 1;
    report.alerted += line.alerted ? 1 : 0;
    if (retryable) report.retrying += 1;
    else report.completed += 1;
    report.lines.push({ runId: run.id, watchId: run.watchId, retryable, ...line });
  }
  report.finishedAt = new Date().toISOString();
  return report;
}
