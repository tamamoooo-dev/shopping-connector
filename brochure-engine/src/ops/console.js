// ops/console.js — the Operations Console: a hidden, admin-only maintenance &
// diagnostics subsystem of the Brochure Engine, mounted at /__ops inside the
// SAME Worker (index.js). Mobile-first: built to run the engine from a phone.
//
// PRINCIPLES
//   • No duplicated logic: reads go through ops/status.js (which reasons over
//     the engine's own storage interfaces + registry); writes ONLY orchestrate
//     the engine's production pipelines.
//   • The production execution path: multi-store operations reuse the cron's
//     Architecture-C SELF fan-out (runFanOut + createServiceBindingDispatcher),
//     so a manual run and a scheduled run execute IDENTICAL code with identical
//     per-child subrequest budgets. When SELF is bound, even single-store runs
//     dispatch through it — one code path, and each child writes its own audit
//     row via engine.js /ingest. Only when SELF is absent (dev.mjs) does an
//     in-process dispatcher call the same ingestAll/ingestOffers functions
//     directly.
//   • Auth: the dedicated OPS_TOKEN Worker secret (human operators only —
//     INGEST_SECRET stays machine-only). Digest comparison, HMAC-signed
//     HttpOnly/Secure/SameSite=Strict session cookie scoped to /__ops, Bearer
//     fallback for scripting, per-IP login rate limiting. URL obscurity is
//     treated as zero security.
//   • Safety: every mutating route requires explicit confirmation (confirm:true;
//     Emergency Heal requires the typed string "HEAL"); every operation ends
//     with a verification summary and an ops_runs audit row; read routes never
//     write engine data.

import { ingestAll } from '../engine.js';
import { ingestOffers } from '../offers/ingest.js';
import { runFanOut, createServiceBindingDispatcher } from '../scheduler.js';
import {
  computeStoreRows,
  subsystemChecks,
  systemConfidence,
  schedulerInfo,
  selfTest,
  healthPct,
  unhealthyStores,
  failedStores,
} from './status.js';
import { CONSOLE_HTML } from './ui.js';

export const OPS_PATH = '/__ops';

const SESSION_HOURS = 12;
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const RATE_KEY = (ip) => `ops/ratelimit/${ip}`;

class OpsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Ops responses: strictly same-origin (no CORS — deliberately unlike the
// engine's public read API), never cached, never indexed.
function opsJson(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      ...extra,
    },
  });
}

/* --- authentication ---------------------------------------------------------- */

const enc = new TextEncoder();

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Hashing both sides makes comparison time independent of matching prefixes.
async function tokenMatches(ctx, supplied) {
  if (!ctx.opsToken || typeof supplied !== 'string' || !supplied) return false;
  return (await sha256Hex(supplied)) === (await sha256Hex(ctx.opsToken));
}

async function hmacKey(ctx) {
  const secret = await sha256Hex(ctx.opsToken + '|ops-session-v1');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

async function signExpiry(ctx, exp) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(ctx), enc.encode(String(exp)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeSessionCookie(ctx) {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const value = `${exp}.${await signExpiry(ctx, exp)}`;
  return `ops_session=${value}; Path=${OPS_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`;
}

const clearSessionCookie = () =>
  `ops_session=; Path=${OPS_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

async function isAuthed(request, ctx) {
  if (!ctx.opsToken) return false; // no token configured -> console locked
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ') && (await tokenMatches(ctx, auth.slice(7).trim()))) return true;
  const m = /(?:^|;\s*)ops_session=([^;]+)/.exec(request.headers.get('Cookie') || '');
  if (!m) return false;
  const [expStr, sig] = m[1].split('.');
  const exp = Number(expStr);
  if (!exp || exp < Date.now() || !sig) return false;
  const expected = await signExpiry(ctx, exp);
  return (await sha256Hex(sig)) === (await sha256Hex(expected));
}

// Login rate limiting, stored through the engine's own object store (a JSON
// counter under the console's ops/ prefix; no TTL needed — the window is in
// the value). 5 failures locks the IP for 10 minutes.
async function rateState(ctx, ip) {
  const rec = await ctx.objectStore.get(RATE_KEY(ip)).catch(() => null);
  if (!rec) return { fails: 0, firstAt: 0 };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(rec.bytes));
    if (Date.now() - parsed.firstAt > LOGIN_WINDOW_MS) return { fails: 0, firstAt: 0 };
    return parsed;
  } catch {
    return { fails: 0, firstAt: 0 };
  }
}

async function rateBump(ctx, ip, state) {
  const next = { fails: state.fails + 1, firstAt: state.firstAt || Date.now() };
  await ctx.objectStore
    .put(RATE_KEY(ip), enc.encode(JSON.stringify(next)), { contentType: 'application/json' })
    .catch(() => {});
}

/* --- operations ---------------------------------------------------------------- */

const OPS = new Set(['all', 'selected', 'store', 'retry-failed', 'repair', 'offers', 'brochures']);
const MODE_FOR_OP = { offers: 'offers', brochures: 'brochures' };

function requireConfirm(body, expected) {
  if (body?.confirm !== expected) {
    throw new OpsError(
      expected === true
        ? 'confirmation required: send confirm:true'
        : `confirmation required: send confirm:"${expected}"`,
      428,
    );
  }
}

function validStores(ctx, requested) {
  const ids = [...new Set((requested || []).map(String))];
  const unknown = ids.filter((id) => !ctx.registry[id]);
  if (unknown.length) throw new OpsError(`Unknown store(s): ${unknown.join(', ')}`, 404);
  return ids;
}

// Resolve which stores an operation targets. Detection-driven operations
// (retry-failed / repair) resolve from the live status rows so the console
// never keeps its own idea of what is broken.
async function resolveTargets(ctx, op, requested) {
  const all = Object.keys(ctx.registry);
  switch (op) {
    case 'all':
      return all;
    case 'offers':
    case 'brochures':
      return requested?.length ? validStores(ctx, requested) : all;
    case 'store':
    case 'selected': {
      const ids = validStores(ctx, requested);
      if (!ids.length) throw new OpsError('no stores selected');
      return ids;
    }
    case 'retry-failed': {
      const rows = await computeStoreRows(ctx);
      return failedStores(rows);
    }
    case 'repair': {
      const rows = await computeStoreRows(ctx);
      return unhealthyStores(rows);
    }
    default:
      throw new OpsError(`unknown op '${op}'`);
  }
}

// Local-dev fallback ONLY (no SELF binding): the same functions in the same
// order as the production child (engine.js /ingest), executed in-process,
// with the same audit row the child would have written.
function createInProcessDispatcher(ctx, mode) {
  return async function dispatchStore(store) {
    const t0 = Date.now();
    const report =
      mode === 'offers'
        ? { startedAt: new Date().toISOString(), targets: [], totals: { detected: 0, new: 0, deduped: 0, failed: 0 } }
        : await ingestAll(ctx, { store });
    if (mode !== 'brochures' && ctx.offerStore && ctx.offersSource) {
      report.offers = await ingestOffers(ctx, { store });
    }
    if (ctx.opsStore) {
      const bt = report.totals;
      const ot = report.offers?.totals;
      const errors = [
        ...report.targets.flatMap((t) => t.errors || []),
        ...(report.offers?.targets || []).flatMap((t) => t.errors || []),
      ];
      await ctx.opsStore
        .record({
          ts: report.startedAt,
          action: 'ingest' + (mode ? ':' + mode : ''),
          origin: 'ops',
          store,
          stores: 1,
          ok: bt.failed === 0 && !(ot && ot.failed > 0),
          detected: bt.detected,
          new: bt.new,
          deduped: bt.deduped,
          failed: bt.failed,
          offers: ot ? ot.stored : null,
          elapsed_ms: Date.now() - t0,
          error: errors[0] || null,
        })
        .catch(() => {});
    }
    return report.totals;
  };
}

// Dispatch an ingest across the target stores through the PRODUCTION path:
// the cron's SELF service-binding fan-out — one child invocation per store,
// each with its own subrequest budget, each writing its own audit row.
async function dispatchIngest(ctx, targets, mode = '') {
  const subRegistry = Object.fromEntries(targets.map((id) => [id, ctx.registry[id]]));
  const dispatch = ctx.self
    ? createServiceBindingDispatcher({ self: ctx.self, ingestSecret: ctx.ingestSecret, mode, tag: 'ops' })
    : createInProcessDispatcher(ctx, mode);
  return runFanOut(subRegistry, dispatch);
}

// Post-operation verification: re-read the targeted stores through the same
// status engine the dashboard uses and summarize PASS/FAIL per store.
async function verifyTargets(ctx, targets) {
  const rows = await computeStoreRows(ctx, { stores: targets });
  const lines = rows.map((r) => ({
    store: r.store,
    label: r.label,
    status: r.status,
    hotspots: r.hotspots,
    clickable: r.clickable,
    offers: r.offers,
    coverage: r.coverage,
    pass: r.healthy,
  }));
  const covered = lines.filter((l) => l.coverage != null);
  return {
    lines,
    coverage: covered.length
      ? Math.round((covered.reduce((s, l) => s + l.coverage, 0) / covered.length) * 10) / 10
      : null,
    failures: lines.filter((l) => !l.pass).map((l) => l.store),
    pass: lines.length > 0 && lines.every((l) => l.pass),
  };
}

async function notifyReport(ctx, title, lines) {
  if (!ctx.notifier) return false;
  try {
    await ctx.notifier.send({ title, body: lines.join('\n'), link: null });
    return true;
  } catch {
    return false;
  }
}

async function auditOp(ctx, row) {
  if (ctx.opsStore) await ctx.opsStore.record({ origin: 'ops', ...row }).catch(() => {});
}

// A manual operation, end to end: resolve targets -> production fan-out ->
// verification -> audit -> optional notification.
async function runOperation(ctx, body) {
  const op = String(body.op || '');
  if (!OPS.has(op)) throw new OpsError(`unknown op '${op}'`);
  const t0 = Date.now();
  const targets = await resolveTargets(ctx, op, body.stores);

  if (!targets.length) {
    // Detection-driven op found nothing to do — that IS the result, not an error.
    return {
      action: `ops:${op}`,
      targets: [],
      ok: true,
      nothingToDo: true,
      message: op === 'repair' ? 'All stores healthy — nothing to repair.' : 'No failed stores — nothing to retry.',
      elapsedMs: Date.now() - t0,
    };
  }

  const fanout = await dispatchIngest(ctx, targets, MODE_FOR_OP[op] || '');
  const verification = await verifyTargets(ctx, targets);
  const ok = fanout.failed === 0 && verification.pass;
  const report = {
    action: `ops:${op}`,
    targets,
    dispatched: fanout.dispatched,
    fanout: fanout.stores,
    verification,
    ok,
    elapsedMs: Date.now() - t0,
  };
  await auditOp(ctx, {
    ts: new Date(t0).toISOString(),
    action: `ops:${op}`,
    stores: targets.length,
    ok,
    failed: fanout.failed + verification.failures.length,
    coverage: verification.coverage,
    elapsed_ms: report.elapsedMs,
    error: fanout.stores.find((s) => !s.ok)?.error || (verification.failures.length ? `unhealthy after run: ${verification.failures.join(', ')}` : null),
    detail: { targets, failures: verification.failures },
  });
  if (body.notify) {
    report.notified = await notifyReport(ctx, `Ops ${op}: ${ok ? 'OK' : 'FAILED'}`, [
      `stores: ${targets.length}`,
      `failures: ${verification.failures.join(', ') || 'none'}`,
      `coverage: ${verification.coverage ?? 'n/a'}%`,
      `elapsed: ${report.elapsedMs}ms`,
    ]);
  }
  return report;
}

// Emergency Heal — the complete production repair pipeline, one button:
// pre-heal verification -> full ingest fan-out (brochures then offers inside
// each store's child, exactly like the cron) -> coverage validation ->
// hotspot validation -> notification -> final verification. Typed "HEAL"
// confirmation is enforced by the route.
async function runHeal(ctx, body) {
  const t0 = Date.now();
  const targets = Object.keys(ctx.registry);
  const steps = [];
  const step = async (name, fn) => {
    const s0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, ok: true, elapsedMs: Date.now() - s0, detail: detail ?? null });
    } catch (err) {
      steps.push({ name, ok: false, elapsedMs: Date.now() - s0, detail: String(err.message || err) });
    }
  };

  let before = null;
  await step('Pre-heal verification', async () => {
    before = await verifyTargets(ctx, targets);
    return { unhealthy: before.failures, coverage: before.coverage };
  });

  let fanout = null;
  await step('Ingest fan-out (brochures → offers per store)', async () => {
    fanout = await dispatchIngest(ctx, targets, '');
    if (fanout.failed) throw new Error(`${fanout.failed}/${fanout.dispatched} store dispatches failed`);
    return { dispatched: fanout.dispatched, ok: fanout.ok };
  });

  let verification = null;
  await step('Coverage validation', async () => {
    verification = await verifyTargets(ctx, targets);
    return { coverage: verification.coverage, failures: verification.failures };
  });

  await step('Hotspot validation', async () => {
    const rows = await computeStoreRows(ctx);
    // An image-set store whose current flyers carry ZERO tap targets is the
    // signature of a D4D markup break — surface it loudly.
    const suspect = rows
      .filter((r) => r.flyers.some((f) => f.sourceType === 'images') && r.hotspots === 0)
      .map((r) => r.store);
    if (suspect.length) throw new Error(`no tap geometry for: ${suspect.join(', ')}`);
    return {
      spots: rows.reduce((n, r) => n + r.hotspots, 0),
      clickable: rows.reduce((n, r) => n + r.clickable, 0),
    };
  });

  await step('Notification', async () => {
    if (body.notify === false) return 'skipped (disabled)';
    const sent = await notifyReport(ctx, 'Ops EMERGENCY HEAL', [
      `stores: ${targets.length}`,
      `failures: ${verification?.failures.join(', ') || 'none'}`,
      `coverage: ${verification?.coverage ?? 'n/a'}%`,
    ]);
    return sent ? 'sent' : 'no notifier configured';
  });

  let health = null;
  await step('Final verification', async () => {
    const storeRows = await computeStoreRows(ctx);
    const checks = await subsystemChecks(ctx, { storeRows });
    health = { healthPct: healthPct(checks), confidence: systemConfidence({ storeRows, checks }).score };
    return health;
  });

  const ok = steps.every((s) => s.ok) && !!verification?.pass;
  const report = {
    action: 'ops:heal',
    targets,
    steps,
    before,
    verification,
    health,
    ok,
    elapsedMs: Date.now() - t0,
  };
  await auditOp(ctx, {
    ts: new Date(t0).toISOString(),
    action: 'ops:heal',
    stores: targets.length,
    ok,
    coverage: verification?.coverage ?? null,
    elapsed_ms: report.elapsedMs,
    error: steps.find((s) => !s.ok)?.detail || null,
    detail: { steps: steps.map((s) => ({ name: s.name, ok: s.ok })), failures: verification?.failures || [] },
  });
  return report;
}

/* --- routes -------------------------------------------------------------------- */

async function apiRoute(request, ctx, url, sub) {
  const method = request.method;
  const body = method === 'POST' ? await request.json().catch(() => ({})) : {};

  // Login is the only unauthenticated route — and it is rate limited.
  if (sub === 'login' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const state = await rateState(ctx, ip);
    if (state.fails >= LOGIN_MAX_FAILS) {
      throw new OpsError('too many failed attempts — locked for 10 minutes', 429);
    }
    if (!(await tokenMatches(ctx, body.token))) {
      await rateBump(ctx, ip, state);
      throw new OpsError('invalid token', 401);
    }
    await ctx.objectStore.delete?.(RATE_KEY(ip)).catch?.(() => {});
    return opsJson({ ok: true }, 200, { 'Set-Cookie': await makeSessionCookie(ctx) });
  }

  if (!(await isAuthed(request, ctx))) throw new OpsError('unauthorized', 401);

  if (sub === 'logout' && method === 'POST') {
    return opsJson({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
  }

  if (method === 'GET') {
    switch (sub) {
      // The dashboard in ONE read: confidence, health grid, scheduler,
      // per-store table. Everything else is drill-down.
      case 'overview': {
        const t0 = Date.now();
        const storeRows = await computeStoreRows(ctx);
        const checks = await subsystemChecks(ctx, { storeRows });
        return opsJson({
          confidence: systemConfidence({ storeRows, checks }),
          healthPct: healthPct(checks),
          checks,
          scheduler: await schedulerInfo(ctx),
          stores: storeRows,
          generatedAt: new Date().toISOString(),
          elapsedMs: Date.now() - t0,
        });
      }
      case 'store': {
        const id = (url.searchParams.get('id') || '').trim();
        if (!id || !ctx.registry[id]) throw new OpsError(`Unknown store '${id}'.`, 404);
        const [row] = await computeStoreRows(ctx, { stores: [id] });
        const provider = ctx.registry[id];
        const region = Object.keys(provider.regions)[0];
        const history = (await ctx.metadataStore.getHistory(id, region)).slice(0, 6);
        const runs = ctx.opsStore ? await ctx.opsStore.list({ store: id, limit: 12 }) : [];
        return opsJson({
          ...row,
          regions: Object.keys(provider.regions),
          history: history.map((h) => ({
            edition: h.edition,
            detectedAt: h.detected_at,
            validTo: h.valid_to,
            current: !!h.is_current,
            pruned: !!h.pruned_at,
          })),
          runs,
        });
      }
      case 'audit': {
        const limit = Number(url.searchParams.get('limit')) || 50;
        const store = (url.searchParams.get('store') || '').trim();
        return opsJson({ runs: ctx.opsStore ? await ctx.opsStore.list({ limit, store }) : [] });
      }
      case 'diagnostics': {
        const t0 = Date.now();
        const errors = ctx.opsStore ? await ctx.opsStore.list({ failedOnly: true, limit: 2 }) : [];
        const recent = ctx.opsStore ? await ctx.opsStore.list({ limit: 20 }) : [];
        const today = new Date().toISOString().slice(0, 10);
        const offers = ctx.offerStore ? await ctx.offerStore.counts(today) : null;
        const history = ctx.historyStore ? await ctx.historyStore.counts() : null;
        const held = (await ctx.metadataStore.listCurrent()).length;
        return opsJson({
          latestError: errors[0] || null,
          previousError: errors[1] || null,
          recent,
          counts: { currentFlyers: held, offers, priceHistory: history },
          elapsedMs: Date.now() - t0,
        });
      }
    }
  }

  if (method === 'POST') {
    switch (sub) {
      case 'run': {
        requireConfirm(body, true);
        return opsJson(await runOperation(ctx, body));
      }
      case 'heal': {
        requireConfirm(body, 'HEAL');
        return opsJson(await runHeal(ctx, body));
      }
      case 'verify': {
        // Read-only: verification without any ingest (no confirmation needed).
        const t0 = Date.now();
        const targets = body.stores?.length ? validStores(ctx, body.stores) : Object.keys(ctx.registry);
        const verification = await verifyTargets(ctx, targets);
        const report = { action: 'ops:verify', targets, verification, ok: verification.pass, elapsedMs: Date.now() - t0 };
        await auditOp(ctx, {
          ts: new Date(t0).toISOString(),
          action: 'ops:verify',
          stores: targets.length,
          ok: verification.pass,
          coverage: verification.coverage,
          elapsed_ms: report.elapsedMs,
          error: verification.failures.length ? `unhealthy: ${verification.failures.join(', ')}` : null,
        });
        return opsJson(report);
      }
      case 'selftest': {
        const result = await selfTest(ctx);
        await auditOp(ctx, {
          action: 'ops:selftest',
          ok: result.checks.every((c) => c.status !== 'FAIL'),
          elapsed_ms: result.elapsedMs,
          error: result.checks.find((c) => c.status === 'FAIL')?.detail || null,
        });
        return opsJson(result);
      }
    }
  }

  throw new OpsError('not found', 404);
}

/* --- entry point ----------------------------------------------------------------- */

// Returns a Response for anything under /__ops, null otherwise (index.js
// falls through to the engine router on null).
export async function handleOps(request, ctx) {
  const url = new URL(request.url);
  if (url.pathname !== OPS_PATH && !url.pathname.startsWith(OPS_PATH + '/')) return null;
  const sub = url.pathname.slice(OPS_PATH.length).replace(/^\/+/, '');

  try {
    if (sub.startsWith('api/')) return await apiRoute(request, ctx, url, sub.slice(4));

    if (sub === '' && request.method === 'GET') {
      if (!ctx.opsToken) {
        return new Response('Operations Console is locked: set the OPS_TOKEN secret first.', {
          status: 503,
          headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
        });
      }
      return new Response(CONSOLE_HTML, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
          'Referrer-Policy': 'no-referrer',
          'Content-Security-Policy':
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
        },
      });
    }
    throw new OpsError('not found', 404);
  } catch (err) {
    const status = err instanceof OpsError ? err.status : 500;
    return opsJson({ error: String(err.message || err) }, status);
  }
}
