// ops/status.js — the Operations Console's read-only status engine.
//
// Pure orchestration over the engine's OWN interfaces (metadataStore,
// offerStore, historyStore, watchStore, objectStore, opsStore, registry):
// nothing here fetches externally, nothing writes engine data, and no store
// name is ever known — everything reasons over the registry, exactly like the
// Core. All numbers are derived from the same rows production serves, so the
// console can never disagree with reality.
//
// Exposes:
//   computeStoreRows(ctx)   — per-store operational snapshot (the coverage table)
//   subsystemChecks(ctx)    — PASS/FAIL per subsystem (the health grid)
//   systemConfidence(...)   — the weighted "can I trust production?" score
//   schedulerInfo(ctx)      — cron specs, next fires, last heartbeat
//   selfTest(ctx)           — the deep probe run (live round-trips)
//   cronNext(expr)          — 5-field cron "next fire" (UTC)

import { flyerRefFromUrl } from '../hotspots.js';

// Operational thresholds. COVERAGE_THRESHOLD: an image flyer whose tap targets
// resolve below this % is unhealthy (a D4D markup break or an offers/geometry
// mismatch). SCHEDULER_MAX_GAP_H: the daily watch cron means a healthy engine
// never goes a full day+ without a cron row.
export const COVERAGE_THRESHOLD = 70;
export const SCHEDULER_MAX_GAP_H = 30;

// System Confidence weights (renormalized over the components that apply).
export const CONFIDENCE_WEIGHTS = {
  freshness: 30, // stores holding a current, unexpired flyer
  coverage: 25, // tap targets that resolve to a real offer row
  offers: 15, // stores with current structured offers
  scheduler: 15, // cron heartbeat recency
  subsystems: 15, // PASS share of the health grid
};

const todayISO = (now) => (now || new Date()).toISOString().slice(0, 10);
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

// --- per-store operational snapshot ------------------------------------------
// One row per registered provider: current flyers (edition, flyer id, validity),
// hotspot/clickable/offers counts, coverage %, last ingest outcomes (from the
// ops_runs audit), and a single STATUS the UI can color by. `stores` narrows
// the sweep (the Store Inspector and post-operation verification).
export async function computeStoreRows(ctx, { now = new Date(), stores = null } = {}) {
  const today = todayISO(now);
  const current = await ctx.metadataStore.listCurrent();
  const offersByStore =
    ctx.offerStore && ctx.offerStore.countsByStore ? await ctx.offerStore.countsByStore(today) : {};
  const runs = ctx.opsStore ? await ctx.opsStore.list({ limit: 300 }) : [];

  // Latest per-store ingest outcomes from the audit rows the /ingest children
  // write (newest first, so first sighting per store+kind wins).
  const lastRun = new Map(); // store -> { ok: row|null, fail: row|null }
  for (const r of runs) {
    if (!r.store) continue;
    const slot = lastRun.get(r.store) || { ok: null, fail: null };
    if (r.ok && !slot.ok) slot.ok = r;
    if (!r.ok && !slot.fail) slot.fail = r;
    lastRun.set(r.store, slot);
  }

  const wanted = stores ? new Set(stores) : null;
  const rows = [];
  for (const provider of Object.values(ctx.registry)) {
    if (wanted && !wanted.has(provider.id)) continue;
    const cur = current.filter((r) => r.store === provider.id);
    const flyers = [];
    let hotspots = 0;
    let clickable = 0;
    for (const row of cur) {
      const flyerRef = flyerRefFromUrl(row.source_url);
      let spots = 0;
      let linked = 0;
      // Tap-geometry snapshots exist only for image-set flyers; reading them is
      // a KV/R2 get + one D1 query — zero external subrequests.
      if (row.source_type === 'images' && ctx.objectStore) {
        const snap = await ctx.objectStore.get(`brochures/${row.storage_key}/hotspots.json`);
        if (snap) {
          let pages = [];
          try {
            pages = JSON.parse(new TextDecoder().decode(snap.bytes)).pages || [];
          } catch {
            pages = []; // corrupt snapshot reads as zero spots, never throws
          }
          const spotIds = [];
          for (const p of pages) for (const s of p.spots || []) spotIds.push(String(s.offerId));
          spots = spotIds.length;
          if (spots && flyerRef && ctx.offerStore && ctx.offerStore.byFlyer) {
            const offerRows = await ctx.offerStore.byFlyer(provider.id, row.region, flyerRef);
            const held = new Set(offerRows.map((o) => String(o.offer_id)));
            linked = spotIds.filter((id) => held.has(id)).length;
          }
        }
      }
      hotspots += spots;
      clickable += linked;
      flyers.push({
        id: row.id,
        edition: row.edition,
        flyerRef,
        sourceType: row.source_type,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        detectedAt: row.detected_at,
        hotspots: spots,
        clickable: linked,
      });
    }

    const fresh = cur.some((r) => !r.valid_to || r.valid_to >= today);
    const coverage = hotspots ? pct(clickable, hotspots) : null;
    const slot = lastRun.get(provider.id) || { ok: null, fail: null };
    const failIsLatest = slot.fail && (!slot.ok || slot.fail.id > slot.ok.id);

    // Status precedence: a failing ingest outranks everything; then no flyer at
    // all; then a held-but-expired set; then weak tap coverage; else OK.
    const status = failIsLatest
      ? 'FAIL'
      : !cur.length
        ? 'NO_FLYER'
        : !fresh
          ? 'STALE'
          : coverage != null && coverage < COVERAGE_THRESHOLD
            ? 'LOW_COVERAGE'
            : 'OK';

    rows.push({
      store: provider.id,
      label: provider.label || provider.id,
      status,
      healthy: status === 'OK',
      flyers,
      currentFlyers: cur.length,
      fresh,
      hotspots,
      clickable,
      offers: offersByStore[provider.id] || 0,
      coverage,
      lastDetectedAt: cur.reduce((m, r) => (r.detected_at > m ? r.detected_at : m), '') || null,
      lastOkAt: slot.ok ? slot.ok.ts : null,
      lastOkMs: slot.ok ? slot.ok.elapsed_ms : null,
      lastFailAt: slot.fail ? slot.fail.ts : null,
      lastError: slot.fail ? slot.fail.error : null,
    });
  }
  // Unhealthy stores first — they must stand out on a phone screen.
  const rank = { FAIL: 0, NO_FLYER: 1, STALE: 2, LOW_COVERAGE: 3, OK: 4 };
  rows.sort((a, b) => rank[a.status] - rank[b.status] || a.store.localeCompare(b.store));
  return rows;
}

// The stores an automated repair should target (the console's Repair Unhealthy
// and Retry Failed operations both resolve their target list here).
export function unhealthyStores(rows) {
  return rows.filter((r) => !r.healthy).map((r) => r.store);
}

export function failedStores(rows) {
  return rows.filter((r) => r.status === 'FAIL' || r.status === 'NO_FLYER').map((r) => r.store);
}

// --- subsystem health grid -----------------------------------------------------
// status: 'PASS' | 'FAIL' | 'UNCONFIGURED' (not bound — excluded from scores)
//         | 'UNKNOWN' (no signal yet — excluded from scores)
export async function subsystemChecks(ctx, { storeRows, now = new Date() } = {}) {
  const today = todayISO(now);
  const rows = storeRows || (await computeStoreRows(ctx, { now }));
  const checks = [];
  const timed = async (name, fn) => {
    const t0 = Date.now();
    try {
      const c = await fn();
      checks.push({ name, status: 'PASS', ms: Date.now() - t0, ...c });
    } catch (err) {
      checks.push({ name, status: 'FAIL', ms: Date.now() - t0, detail: String(err.message || err) });
    }
  };

  await timed('D1', async () => {
    await ctx.metadataStore.existsByChecksum('sha256:ops-probe'); // cheap indexed read
    return { detail: 'metadata index readable' };
  });

  await timed('KV', async () => {
    // A get of a never-written key must resolve null without throwing.
    if (!ctx.objectStore) throw new Error('no object store bound');
    await ctx.objectStore.get('ops/never-written-probe');
    return { detail: 'object store readable' };
  });

  const freshCount = rows.filter((r) => r.fresh).length;
  const totalCurrent = rows.reduce((n, r) => n + r.currentFlyers, 0);
  checks.push({
    name: 'Brochure Engine',
    status: totalCurrent > 0 ? 'PASS' : 'FAIL',
    detail: `${totalCurrent} current flyers · ${freshCount}/${rows.length} stores fresh`,
  });

  await timed('Offers Engine', async () => {
    if (!ctx.offerStore) throw new Error('no offer store bound');
    const c = await ctx.offerStore.counts(today);
    if (!c.current) throw new Error('no current offers held');
    return { detail: `${c.current} current offers across ${c.stores} stores` };
  });

  const totalSpots = rows.reduce((n, r) => n + r.hotspots, 0);
  const totalClickable = rows.reduce((n, r) => n + r.clickable, 0);
  checks.push({
    name: 'Hotspots',
    status: totalSpots > 0 ? 'PASS' : 'FAIL',
    detail: `${totalClickable}/${totalSpots} spots clickable`,
  });

  checks.push(
    ctx.searchClient
      ? { name: 'Search', status: 'PASS', detail: 'connector bound' }
      : { name: 'Search', status: 'UNCONFIGURED', detail: 'CONNECTOR binding missing' },
  );

  await timed('Price History', async () => {
    if (!ctx.historyStore) throw new Error('no history store bound');
    const c = await ctx.historyStore.counts();
    return { detail: `${c.identities} identities · ${c.points} points` };
  });

  await timed('Watch System', async () => {
    if (!ctx.watchStore) throw new Error('no watch store bound');
    const active = await ctx.watchStore.count();
    const unseen = await ctx.watchStore.countUnseen();
    return { detail: `${active} active watches · ${unseen} unseen alerts` };
  });

  checks.push(
    ctx.notifier
      ? { name: 'Notifier', status: 'PASS', detail: 'ntfy configured' }
      : { name: 'Notifier', status: 'UNCONFIGURED', detail: 'NTFY_TOPIC not set' },
  );

  checks.push(await schedulerCheck(ctx, { now }));
  return checks;
}

async function schedulerCheck(ctx, { now = new Date() } = {}) {
  if (!ctx.opsStore) return { name: 'Scheduler', status: 'UNKNOWN', detail: 'no audit store' };
  const cronRuns = await ctx.opsStore.list({ origin: 'cron', limit: 1 });
  if (!cronRuns.length) {
    return { name: 'Scheduler', status: 'UNKNOWN', detail: 'no cron run recorded yet' };
  }
  const ageH = (now.getTime() - Date.parse(cronRuns[0].ts)) / 3600000;
  return {
    name: 'Scheduler',
    status: ageH <= SCHEDULER_MAX_GAP_H ? 'PASS' : 'FAIL',
    detail: `last cron run ${ageH.toFixed(1)}h ago (${cronRuns[0].action})`,
  };
}

export function healthPct(checks) {
  const scored = checks.filter((c) => c.status === 'PASS' || c.status === 'FAIL');
  if (!scored.length) return 0;
  return Math.round((scored.filter((c) => c.status === 'PASS').length / scored.length) * 100);
}

// --- System Confidence -----------------------------------------------------------
// One number answering "can I trust production data right now?". Weighted blend;
// a component with no signal (e.g. no image flyers yet -> no coverage) is
// EXCLUDED and the remaining weights renormalized, so a fresh deployment isn't
// punished for what it can't measure yet.
export function systemConfidence({ storeRows, checks }) {
  const total = storeRows.length || 1;
  const withCoverage = storeRows.filter((r) => r.coverage != null);
  const scheduler = checks.find((c) => c.name === 'Scheduler');

  const components = [
    {
      key: 'freshness',
      label: 'Store freshness',
      score: pct(storeRows.filter((r) => r.fresh).length, total),
      detail: `${storeRows.filter((r) => r.fresh).length}/${total} stores hold a current flyer`,
    },
    {
      key: 'coverage',
      label: 'Hotspot coverage',
      score: withCoverage.length
        ? Math.round((withCoverage.reduce((s, r) => s + r.coverage, 0) / withCoverage.length) * 10) / 10
        : null,
      detail: withCoverage.length
        ? `avg over ${withCoverage.length} stores with tap targets`
        : 'no tap-geometry snapshots held',
    },
    {
      key: 'offers',
      label: 'Offers availability',
      score: pct(storeRows.filter((r) => r.offers > 0).length, total),
      detail: `${storeRows.filter((r) => r.offers > 0).length}/${total} stores have current offers`,
    },
    {
      key: 'scheduler',
      label: 'Scheduler heartbeat',
      score: !scheduler || scheduler.status === 'UNKNOWN' ? null : scheduler.status === 'PASS' ? 100 : 0,
      detail: scheduler ? scheduler.detail : 'no signal',
    },
    {
      key: 'subsystems',
      label: 'Subsystem health',
      score: healthPct(checks),
      detail: `${checks.filter((c) => c.status === 'PASS').length} passing / ${
        checks.filter((c) => c.status === 'FAIL').length
      } failing`,
    },
  ].map((c) => ({ ...c, weight: CONFIDENCE_WEIGHTS[c.key] }));

  const applicable = components.filter((c) => c.score != null);
  const weightSum = applicable.reduce((s, c) => s + c.weight, 0) || 1;
  const score = Math.round(applicable.reduce((s, c) => s + c.score * c.weight, 0) / weightSum);
  return { score, components };
}

// --- scheduler info ---------------------------------------------------------------
export async function schedulerInfo(ctx, { now = new Date() } = {}) {
  const crons = Object.entries(ctx.crons || {}).map(([name, expr]) => {
    const next = cronNext(expr, now);
    return { name, cron: expr, nextRun: next ? next.toISOString() : null };
  });
  const last = ctx.opsStore ? await ctx.opsStore.list({ origin: 'cron', limit: 5 }) : [];
  const check = await schedulerCheck(ctx, { now });
  return { crons, lastRuns: last, healthy: check.status === 'PASS' ? true : check.status === 'FAIL' ? false : null, detail: check.detail };
}

// Minimal 5-field cron "next fire" (UTC, minute resolution, 28-day scan cap —
// plenty for weekly schedules; null for anything it can't parse).
export function cronNext(expr, from = new Date()) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const parse = (f, min, max) => {
    const set = new Set();
    for (const part of f.split(',')) {
      const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!m) return null;
      const step = m[2] ? Number(m[2]) : 1;
      let lo = min;
      let hi = max;
      if (m[1] !== '*') {
        const [a, b] = m[1].split('-').map(Number);
        lo = a;
        hi = b === undefined ? a : b;
      }
      for (let v = lo; v <= hi; v += step) set.add(v);
    }
    return set;
  };
  const mi = parse(fields[0], 0, 59);
  const ho = parse(fields[1], 0, 23);
  const dom = parse(fields[2], 1, 31);
  const mo = parse(fields[3], 1, 12);
  const dow = parse(fields[4], 0, 6);
  if (!mi || !ho || !dom || !mo || !dow) return null;
  const d = new Date(from);
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const domAll = fields[2] === '*';
  const dowAll = fields[4] === '*';
  for (let i = 0; i < 40320; i++) {
    // standard cron OR-semantics when both day fields are restricted
    const dayOk =
      domAll && dowAll
        ? true
        : domAll
          ? dow.has(d.getUTCDay())
          : dowAll
            ? dom.has(d.getUTCDate())
            : dom.has(d.getUTCDate()) || dow.has(d.getUTCDay());
    if (mo.has(d.getUTCMonth() + 1) && dayOk && ho.has(d.getUTCHours()) && mi.has(d.getUTCMinutes())) return d;
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  return null;
}

// --- self test -------------------------------------------------------------------
// The deep probe run (the console's Run Self Test button): everything the
// health grid checks PLUS live round-trips — an object-store write/read/delete
// and, when the connector is bound, one real search call.
export async function selfTest(ctx, { now = new Date() } = {}) {
  const t0 = Date.now();
  const storeRows = await computeStoreRows(ctx, { now });
  const checks = await subsystemChecks(ctx, { storeRows, now });

  // Object-store round-trip under the console's own prefix.
  const probe = async () => {
    const key = 'ops/selftest-probe';
    const payload = new TextEncoder().encode(String(t0));
    await ctx.objectStore.put(key, payload, { contentType: 'text/plain' });
    const back = await ctx.objectStore.get(key);
    await ctx.objectStore.delete?.(key);
    if (!back || new TextDecoder().decode(back.bytes) !== String(t0)) {
      throw new Error('round-trip mismatch');
    }
  };
  const kvIdx = checks.findIndex((c) => c.name === 'KV');
  const rt0 = Date.now();
  try {
    await probe();
    checks[kvIdx] = { name: 'KV', status: 'PASS', ms: Date.now() - rt0, detail: 'write/read/delete round-trip' };
  } catch (err) {
    checks[kvIdx] = { name: 'KV', status: 'FAIL', ms: Date.now() - rt0, detail: String(err.message || err) };
  }

  // Live search probe (one connector subrequest) — only in the explicit self
  // test, never on dashboard loads.
  if (ctx.searchClient) {
    const sIdx = checks.findIndex((c) => c.name === 'Search');
    const st0 = Date.now();
    try {
      await ctx.searchClient.search('panda', 'milk');
      checks[sIdx] = { name: 'Search', status: 'PASS', ms: Date.now() - st0, detail: 'live query ok' };
    } catch (err) {
      checks[sIdx] = { name: 'Search', status: 'FAIL', ms: Date.now() - st0, detail: String(err.message || err) };
    }
  }

  return {
    checks,
    healthPct: healthPct(checks),
    storeRows,
    confidence: systemConfidence({ storeRows, checks }),
    elapsedMs: Date.now() - t0,
  };
}

// --- Operations Center reads (Ops plan §1,§4–§7) --------------------------------
// The same discipline as everything above: pure orchestration over the store
// interfaces, zero writes, zero external fetches. The audit-timeline `detail`
// column comes back as a JSON string (opsStore serializes it); parse defensively.

function parseDetail(row) {
  if (!row || row.detail == null) return {};
  if (typeof row.detail === 'object') return row.detail;
  try {
    return JSON.parse(row.detail) || {};
  } catch {
    return {};
  }
}

// The audit actions that carry enrichment work, across every origin.
const ENRICH_ACTIONS = new Set(['enrich', 'cron:enrich', 'ops:enrich']);

// Average offers/hour vision has enriched over a trailing window, from the
// audit rows' own `detail.enriched` counters. null when nothing ran in-window
// (so ETA reads "n/a" rather than dividing by zero).
export async function enrichRate(ctx, { now = new Date(), windowHours = 24 } = {}) {
  if (!ctx.opsStore) return { perHour: null, enriched: 0, windowHours };
  const rows = await ctx.opsStore.list({ limit: 200 }).catch(() => []);
  const since = now.getTime() - windowHours * 3600 * 1000;
  let enriched = 0;
  for (const r of rows) {
    if (!ENRICH_ACTIONS.has(r.action)) continue;
    if (Date.parse(r.ts) < since) continue;
    enriched += Number(parseDetail(r).enriched) || 0;
  }
  return {
    perHour: enriched > 0 ? Math.round((enriched / windowHours) * 10) / 10 : null,
    enriched,
    windowHours,
  };
}

// §1 Vision Progress: the live enrichment dashboard in one read.
export async function visionProgress(ctx, { now = new Date() } = {}) {
  const today = todayISO(now);
  const [offers, cov, products, sightings, rate, cronRows] = await Promise.all([
    ctx.offerStore ? ctx.offerStore.counts(today) : Promise.resolve({ total: 0, current: 0, stores: 0 }),
    ctx.enrichStore ? ctx.enrichStore.coverage(today) : Promise.resolve(null),
    ctx.registryStore ? ctx.registryStore.productCount() : Promise.resolve(0),
    ctx.registryStore ? ctx.registryStore.sightingsCount() : Promise.resolve(0),
    enrichRate(ctx, { now }),
    ctx.opsStore ? ctx.opsStore.list({ origin: 'cron', limit: 30 }).catch(() => []) : Promise.resolve([]),
  ]);
  const lastCronEnrich = cronRows.find((r) => r.action === 'cron:enrich') || null;
  const nextEnrich = cronNext(ctx.crons?.enrich, now);

  // Worker status heuristic: an enrich audit row younger than 2 minutes means a
  // drain is (or just was) in flight. The console's own client-driven drain
  // sets its state locally; this catches the cron path too.
  let recentEnrich = null;
  let recentRows = [];
  if (ctx.opsStore) {
    recentRows = await ctx.opsStore.list({ limit: 30 }).catch(() => []);
    recentEnrich = recentRows.find((r) => ENRICH_ACTIONS.has(r.action)) || null;
  }
  const running = recentEnrich && now.getTime() - Date.parse(recentEnrich.ts) < 120000;

  // Provider rate-limit surface (Vision Milestone 2 §3). The free-tier quota is
  // ACCOUNT-SPECIFIC and unpublished, so the only ground truth is what Mistral
  // returned at runtime (a 429 + its headers). Surface the most recent one — the
  // active job row first (freshest), else the newest enrich audit detail — with
  // a computed resume time, so the console shows the real limit/remaining/reset
  // and expected resume instead of a silent stall. The account's CONFIGURED
  // quota lives in Mistral's Admin Console → Limits (a static note in the UI).
  const job = ctx.visionJobStore ? await ctx.visionJobStore.get().catch(() => null) : null;
  let providerLimit = job?.provider_limit || null;
  if (!providerLimit) {
    for (const r of recentRows) {
      const d = parseDetail(r);
      if (d && d.providerLimit) { providerLimit = d.providerLimit; break; }
    }
  }
  let resumeAt = null;
  if (providerLimit && providerLimit.retryAfter != null && providerLimit.observedAt) {
    resumeAt = new Date(Date.parse(providerLimit.observedAt) + providerLimit.retryAfter * 1000).toISOString();
  }

  const remaining = cov ? cov.remaining : 0;
  return {
    offers: { current: offers.current, total: offers.total, stores: offers.stores },
    withCrop: cov ? cov.withCrop : 0,
    attempted: cov ? cov.attempted : 0,
    enriched: cov ? cov.enriched : 0,
    servable: cov ? cov.servable : 0,
    declined: cov ? cov.declined : 0,
    remaining,
    coverage: cov ? cov.coverage : null,
    registryProducts: products,
    sightings,
    queueDepth: remaining,
    rate: rate.perHour,
    etaHours: rate.perHour && remaining > 0 ? Math.round((remaining / rate.perHour) * 10) / 10 : null,
    lastCron: lastCronEnrich
      ? { ts: lastCronEnrich.ts, ok: !!lastCronEnrich.ok, elapsedMs: lastCronEnrich.elapsed_ms, detail: parseDetail(lastCronEnrich) }
      : null,
    nextCron: nextEnrich ? nextEnrich.toISOString() : null,
    worker: running ? 'running' : 'idle',
    // Background Manual Vision job snapshot (§2) + provider rate-limit surface (§3).
    job: job || null,
    providerLimit: providerLimit || null,
    resumeAt,
    generatedAt: now.toISOString(),
  };
}

// §4 Queue Monitor: the vision backlog + the resolution verdict breakdown.
export async function queueSnapshot(ctx, { now = new Date() } = {}) {
  const today = todayISO(now);
  const [debris, verdicts, rstats] = await Promise.all([
    ctx.enrichStore ? ctx.enrichStore.countDebris(today) : Promise.resolve(0),
    ctx.enrichStore ? ctx.enrichStore.verdictCounts().catch(() => ({})) : Promise.resolve({}),
    ctx.registryStore ? ctx.registryStore.stats().catch(() => ({ bands: {} })) : Promise.resolve({ bands: {} }),
  ]);
  const v = (k) => Number(verdicts[k]) || 0;
  const deferred = v('declined') + v('low_corroboration') + v('too_few_tokens') + v('or_deal');
  return {
    vision: { queued: debris },
    resolution: {
      unresolved: v('unresolved'),
      minted: v('minted'),
      declined: v('declined'),
      low_corroboration: v('low_corroboration'),
      too_few_tokens: v('too_few_tokens'),
      or_deal: v('or_deal'),
      deferred,
    },
    bands: rstats.bands || {},
    generatedAt: now.toISOString(),
  };
}

// §5 Cron Monitor: every scheduled task with its last run, next fire, and a
// short execution log — all from the cron-origin audit rows + the cron specs.
const CRON_ACTION = { pipeline: 'cron:fanout', watches: 'cron:watches', enrich: 'cron:enrich' };

export async function cronMonitor(ctx, { now = new Date() } = {}) {
  const rows = ctx.opsStore ? await ctx.opsStore.list({ origin: 'cron', limit: 200 }).catch(() => []) : [];
  const crons = Object.entries(ctx.crons || {}).map(([name, expr]) => {
    const action = CRON_ACTION[name] || `cron:${name}`;
    const mine = rows.filter((r) => r.action === action);
    const last = mine[0] || null;
    const next = cronNext(expr, now);
    return {
      name,
      cron: expr,
      action,
      nextRun: next ? next.toISOString() : null,
      last: last
        ? {
            ts: last.ts,
            ok: !!last.ok,
            elapsedMs: last.elapsed_ms,
            failed: last.failed,
            error: last.error,
            detail: parseDetail(last),
          }
        : null,
      runs: mine.slice(0, 8).map((r) => ({
        ts: r.ts,
        ok: !!r.ok,
        elapsedMs: r.elapsed_ms,
        error: r.error,
        detail: parseDetail(r),
      })),
    };
  });
  return { crons, generatedAt: now.toISOString() };
}

// Map a subsystem PASS/FAIL/UNCONFIGURED/UNKNOWN to a pipeline stage verdict.
function stageStatus(check) {
  if (!check) return 'warn';
  if (check.status === 'PASS') return 'healthy';
  if (check.status === 'FAIL') return 'fail';
  return 'warn'; // UNCONFIGURED / UNKNOWN
}

// §6 Pipeline Health: the seven stages, each healthy|warn|fail with throughput
// and last execution. Reuses the existing health grid rather than re-deriving.
export async function pipelineHealth(ctx, { now = new Date() } = {}) {
  const today = todayISO(now);
  const storeRows = await computeStoreRows(ctx, { now });
  const checks = await subsystemChecks(ctx, { storeRows, now });
  const byName = (n) => checks.find((c) => c.name === n);
  const [offers, cov, verdicts, rstats, hist, cronRows] = await Promise.all([
    ctx.offerStore ? ctx.offerStore.counts(today) : Promise.resolve({ current: 0 }),
    ctx.enrichStore ? ctx.enrichStore.coverage(today) : Promise.resolve(null),
    ctx.enrichStore ? ctx.enrichStore.verdictCounts().catch(() => ({})) : Promise.resolve({}),
    ctx.registryStore ? ctx.registryStore.stats().catch(() => null) : Promise.resolve(null),
    ctx.historyStore ? ctx.historyStore.counts().catch(() => null) : Promise.resolve(null),
    ctx.opsStore ? ctx.opsStore.list({ origin: 'cron', limit: 50 }).catch(() => []) : Promise.resolve([]),
  ]);
  const lastOf = (action) => {
    const r = cronRows.find((x) => x.action === action);
    return r ? r.ts : null;
  };
  const v = (k) => Number(verdicts[k]) || 0;
  const totalSightings = rstats ? Object.values(rstats.bands || {}).reduce((s, n) => s + n, 0) : 0;

  // Vision-stage verdict from coverage: fail if eligible offers exist but none
  // attempted; warn while a backlog remains; healthy once caught up.
  const visionStatus = !cov || cov.withCrop === 0
    ? 'warn'
    : cov.attempted === 0
      ? 'fail'
      : cov.remaining > 0
        ? 'warn'
        : 'healthy';

  const stages = [
    {
      name: 'OCR',
      status: stageStatus(byName('Offers Engine')),
      throughput: `${offers.current} current offers`,
      lastAt: lastOf('cron:fanout'),
      detail: byName('Offers Engine')?.detail || '',
    },
    {
      name: 'Vision',
      status: visionStatus,
      throughput: cov ? `${cov.attempted}/${cov.withCrop} read · ${cov.remaining} queued` : 'no eligible offers',
      lastAt: lastOf('cron:enrich'),
      detail: cov && cov.coverage != null ? `${cov.coverage}% coverage · ${cov.servable} servable` : '',
    },
    {
      name: 'Resolve',
      status: v('unresolved') > 0 ? 'warn' : 'healthy',
      throughput: `${v('minted')} minted · ${v('unresolved')} unresolved`,
      lastAt: lastOf('cron:enrich'),
      detail: `deferred ${v('declined') + v('low_corroboration') + v('too_few_tokens') + v('or_deal')}`,
    },
    {
      name: 'Registry',
      status: rstats ? (rstats.products.flagged > 0 ? 'warn' : 'healthy') : 'warn',
      throughput: rstats ? `${rstats.products.active} active products` : 'unavailable',
      lastAt: lastOf('cron:enrich'),
      detail: rstats ? `${rstats.products.dormant} dormant · ${rstats.products.flagged} flagged` : '',
    },
    {
      name: 'Sightings',
      status: rstats && (rstats.bands.review || 0) > (totalSightings * 0.25) ? 'warn' : 'healthy',
      throughput: `${totalSightings} sightings`,
      lastAt: lastOf('cron:enrich'),
      detail: rstats
        ? `auto ${rstats.bands.auto || 0} · review ${rstats.bands.review || 0} · created ${rstats.bands.created || 0}`
        : '',
    },
    {
      name: 'Price History',
      status: stageStatus(byName('Price History')),
      throughput: hist ? `${hist.identities} identities · ${hist.points} points` : 'unavailable',
      lastAt: lastOf('cron:fanout'),
      detail: byName('Price History')?.detail || '',
    },
    {
      name: 'Search',
      status: stageStatus(byName('Search')),
      throughput: byName('Search')?.detail || '',
      lastAt: null,
      detail: byName('Search')?.detail || '',
    },
  ];
  return { stages, generatedAt: now.toISOString() };
}

// §7 Diagnostics: the latencies a Worker CAN measure — probe round-trips + the
// audit log's own elapsed_ms by stage + how long the oldest offer has waited in
// the vision queue. Metrics with no Worker runtime API are named, not faked.
const LATENCY_GROUPS = {
  ingest: (a) => a === 'ingest' || a === 'ingest:offers' || a === 'ingest:brochures' || a === 'cron:fanout',
  vision: (a) => ENRICH_ACTIONS.has(a),
  resolve: (a) => a === 'resolve',
  watches: (a) => a === 'cron:watches' || a === 'ops:watches',
};

export async function latencyStats(ctx, { now = new Date() } = {}) {
  const today = todayISO(now);
  const checks = await subsystemChecks(ctx, { now });
  const rows = ctx.opsStore ? await ctx.opsStore.list({ limit: 200 }).catch(() => []) : [];
  const avg = (pred) => {
    const ms = rows.filter((r) => pred(r.action) && r.elapsed_ms != null).map((r) => r.elapsed_ms);
    return ms.length ? Math.round(ms.reduce((s, x) => s + x, 0) / ms.length) : null;
  };
  const probe = (n) => byNameMs(checks, n);
  const oldest = ctx.offerStore ? await ctx.offerStore.oldestUnenrichedAge(today).catch(() => null) : null;
  return {
    probes: { d1: probe('D1'), kv: probe('KV') },
    latency: {
      ingest: avg(LATENCY_GROUPS.ingest),
      vision: avg(LATENCY_GROUPS.vision),
      resolve: avg(LATENCY_GROUPS.resolve),
      watches: avg(LATENCY_GROUPS.watches),
    },
    queueAgeMs: oldest ? Math.max(0, now.getTime() - Date.parse(oldest)) : null,
    notInstrumented: ['Worker CPU usage', 'Cache hit rate', 'KV quota usage'],
    generatedAt: now.toISOString(),
  };
}

function byNameMs(checks, name) {
  const c = checks.find((x) => x.name === name);
  return c && typeof c.ms === 'number' ? c.ms : null;
}
