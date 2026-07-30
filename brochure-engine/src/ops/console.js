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

import { ingestAll, handleRequest } from '../engine.js';
import { ingestOffers } from '../offers/ingest.js';
import {
  runFanOut, runStoreToPublication, createServiceBindingDispatcher,
  runEnrichDrain, createEnrichDispatcher,
} from '../scheduler.js';
import {
  computeStoreRows,
  subsystemChecks,
  systemConfidence,
  schedulerInfo,
  selfTest,
  healthPct,
  unhealthyStores,
  failedStores,
  visionProgress,
  queueSnapshot,
  recoverySnapshot,
  cronMonitor,
  pipelineHealth,
  latencyStats,
} from './status.js';
// S5.7 — the Recovery Queue's operator surface. The console imports the RUNNER
// and the REGISTRY, never a processor: which processors exist is the registry's
// answer, and it changes without this file changing (C-9).
import { runRecovery, drainRecovery } from '../recovery/runner.js';
// The review VERBS are part of the processor contract, not of any processor, so
// they come from the registry module alongside RECOVERY_KIND — importing them
// here does not import a processor and does not name one.
import { REVIEW_DECISION } from '../recovery/registry.js';
import { RECOVERY_STATUS, RECOVERY_OUTCOME } from '../storage/recoveryQueue.js';
import {
  RECOVERY_MODES,
  readRecoveryPolicy,
  writeRecoveryPolicy,
} from '../recovery/policy.js';
import { createKeyChain } from '../offers/mistralKeys.js';
import { drainResolution } from '../registry/drain.js';
import { runMaintenance, writeMergeSetting, readMergeSetting } from '../registry/lifecycle.js';
import { resolveLegacyWatches } from '../monitor.js';
import { deriveIdentity } from '../priceHistory.js';
import { servable, DEFAULT_MODEL } from '../offers/enrich.js';
import {
  readVisionModelSetting,
  writeVisionModelSetting,
  VISION_MODEL_OPTIONS,
  VISION_MODEL_TIERS,
} from '../offers/visionModel.js';
import { CONSOLE_HTML } from './ui.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

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
async function dispatchIngest(ctx, targets, mode = '', { completePublication = false } = {}) {
  const subRegistry = Object.fromEntries(targets.map((id) => [id, ctx.registry[id]]));
  const dispatch = ctx.self
    ? createServiceBindingDispatcher({
        self: ctx.self,
        ingestSecret: ctx.ingestSecret,
        mode,
        tag: 'ops',
        returnReport: completePublication,
      })
    : createInProcessDispatcher(ctx, mode);
  if (completePublication && ctx.self) {
    // A manual operation is synchronous from the operator's perspective even
    // when it targets several unhealthy stores. Give every target the same
    // publication loop used by the single-store button instead of verifying
    // after one 20-page batch. Divide the coordinator's 48-call safety budget
    // across targets so a broad repair cannot exceed the Worker subrequest
    // ceiling. After the first full child seeds each durable job, continuation
    // children advance brochures only; the final child refreshes exact offer
    // linkage immediately before atomic publish (engine.js).
    const resume = createServiceBindingDispatcher({
      self: ctx.self,
      ingestSecret: ctx.ingestSecret,
      mode: 'brochures',
      tag: 'ops',
      returnReport: true,
    });
    const maxInvocations = Math.max(1, Math.floor(48 / targets.length));
    return runFanOut(
      subRegistry,
      (store) => runStoreToPublication(store, dispatch, resume, { maxInvocations }),
    );
  }
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
    // Detection-driven op found nothing to do — that IS the result, not an
    // error, and it is still an operator action the audit timeline records.
    const report = {
      action: `ops:${op}`,
      targets: [],
      ok: true,
      nothingToDo: true,
      message: op === 'repair' ? 'All stores healthy — nothing to repair.' : 'No failed stores — nothing to retry.',
      elapsedMs: Date.now() - t0,
    };
    await auditOp(ctx, {
      ts: new Date(t0).toISOString(),
      action: `ops:${op}`,
      stores: 0,
      ok: true,
      elapsed_ms: report.elapsedMs,
      detail: { nothingToDo: true },
    });
    return report;
  }

  const fanout = await dispatchIngest(
    ctx,
    targets,
    MODE_FOR_OP[op] || '',
    {
      // Brochure operations promise an end-to-end run. Before the resumable
      // redesign one child fulfilled that promise; now the Ops coordinator
      // must explicitly drain every target's page batches before verification.
      completePublication: op !== 'offers',
    },
  );
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

// Manual enrichment drain — a DEVELOPER convenience, not an operations duty:
// normal coverage is fully autonomous via the `10,30,50 * * * *` cron; this
// button exists for development, testing, and exceptional situations (e.g.
// verifying a fresh deploy without waiting for the next fire). It executes
// the EXACT cron path — runEnrichDrain over /enrich children (SELF fan-out,
// per-child budgets, resolution post-step included) — so a manual run and a
// scheduled run are indistinguishable except for the `ops` origin on their
// audit rows. `batches` is clamped to the cron's own per-fire shape ×2.
async function runEnrichOperation(ctx, body) {
  if (!ctx.enrichStore || !ctx.mistralKey) {
    throw new OpsError('Enrichment unavailable (MISTRAL_API_KEY not set).', 503);
  }
  const t0 = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const pending = await ctx.enrichStore.countDebris(today).catch(() => 0);
  if (pending <= 0) {
    const report = { action: 'ops:enrich', pending: 0, ok: true, nothingToDo: true, message: 'Enrichment queue is empty.', elapsedMs: Date.now() - t0 };
    await auditOp(ctx, {
      ts: new Date(t0).toISOString(), action: 'ops:enrich', ok: true,
      elapsed_ms: report.elapsedMs, detail: { nothingToDo: true },
    });
    return report;
  }
  const batches = Math.max(1, Math.min(Number(body.batches) || 4, 8));
  // Production path: SELF children. Local dev (no SELF): the same /enrich
  // route in-process — identical code, in-process transport.
  const dispatchBatch = ctx.self
    ? createEnrichDispatcher({ self: ctx.self, ingestSecret: ctx.ingestSecret, tag: 'ops' })
    : async (limit) => {
        const res = await handleRequest(
          new Request(`https://brochure-engine.internal/enrich?limit=${limit}`, {
            method: 'POST',
            headers: { 'X-Ingest-Secret': ctx.ingestSecret || '', 'X-Ops-Origin': 'ops' },
          }),
          ctx,
        );
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`enrich drain -> HTTP ${res.status}`);
        return out;
      };
  const drain = await runEnrichDrain(dispatchBatch, { pending, batchSize: 15, maxBatches: batches });
  const report = {
    action: 'ops:enrich',
    pending: drain.pending,
    batches: drain.batches,
    ok: drain.failed === 0,
    failed: drain.failed,
    enriched: drain.enriched,
    remaining: await ctx.enrichStore.countDebris(today).catch(() => null),
    elapsedMs: Date.now() - t0,
  };
  await auditOp(ctx, {
    ts: new Date(t0).toISOString(),
    action: 'ops:enrich',
    ok: report.ok,
    failed: drain.failed,
    elapsed_ms: report.elapsedMs,
    error: drain.lines?.find((l) => !l.ok)?.error || null,
    detail: { pending: drain.pending, batches: drain.batches, enriched: drain.enriched, remaining: report.remaining },
  });
  return report;
}

// Background Manual Vision — start (Vision Milestone 2 §2; cron-driven redesign
// 2026-07-20). Unlike the manual Vision Drain (a bounded burst inside ONE
// request), this ARMS a durable job: the 1-minute `visionDrain` cron (index.js)
// then drains it to EMPTY server-side, paced by Mistral, as the sole resolution
// writer (lease-guarded). The operator can close the page and the run keeps
// going. Primary use: historical backfills, maintenance, recovery. Starting the
// job IS the whole action; the UI polls GET vision/job for progress.
async function runVisionStart(ctx, body) {
  if (!ctx.enrichStore || !ctx.mistralKey || !ctx.visionJobStore) {
    throw new OpsError('Vision unavailable (MISTRAL_API_KEY not set).', 503);
  }
  const scope = body.scope === 'debris' ? 'debris' : 'all';
  const today = todayISO();
  const total = await ctx.enrichStore.countDebris(today, scope).catch(() => 0);
  if (total <= 0) {
    const job = await ctx.visionJobStore.get().catch(() => null);
    return { action: 'ops:vision-start', nothingToDo: true, message: 'Vision queue is empty.', job };
  }
  // Refuse to launch a second job over a live one (single-writer chain).
  const existing = await ctx.visionJobStore.get().catch(() => null);
  if (existing && existing.status === 'running') {
    return { action: 'ops:vision-start', alreadyRunning: true, message: 'A Vision job is already running.', job: existing };
  }
  const job = await ctx.visionJobStore.start({ scope, total, origin: 'ops' });
  await auditOp(ctx, {
    action: 'ops:vision-start', ok: true, elapsed_ms: 0,
    detail: { scope, total },
  });
  // No chain to kick: the 1-minute `visionDrain` cron (index.js) picks up any
  // running job within a minute and drains it to empty, paced by Mistral, as the
  // sole resolution writer (lease-guarded). Starting the job IS the whole action.
  return { action: 'ops:vision-start', ok: true, job };
}

// Developer Tool — Vision Model selection (offers/visionModel.js). The ONLY
// thing in the system that moves this setting: models are never switched
// automatically, by policy. Medium is production; Small is a manual fallback for
// API-limit or budget pressure. Takes effect on the next drain — running work
// finishes on the model it started with, and every row records its own model.
async function runVisionModelSelect(ctx, body) {
  const requested = String(body?.tier == null ? '' : body.tier).trim().toLowerCase();
  if (!VISION_MODEL_TIERS[requested]) {
    throw new OpsError(`Unknown vision model tier '${requested}'.`);
  }
  const setting = await writeVisionModelSetting(ctx.objectStore, requested, { by: 'ops' });
  await auditOp(ctx, {
    action: 'ops:vision-model',
    ok: true,
    elapsed_ms: 0,
    detail: { tier: setting.tier, model: setting.model, budgetMode: setting.budget },
  });
  // Same shape the GET returns, so the console renders a selection response and
  // a poll response through one code path. Once armed, active === selected.
  return { action: 'ops:vision-model', ok: true, setting, defaultModel: DEFAULT_MODEL, activeModel: setting.model };
}

// Background Manual Vision — stop. Flips the job to 'stopped'; the running chain
// halts at its next hop's status check (it never clobbers a stop back to
// running). D1-only, no vision calls — safe anytime.
async function runVisionStop(ctx) {
  if (!ctx.visionJobStore) throw new OpsError('Vision unavailable.', 503);
  const job = await ctx.visionJobStore.stop();
  await auditOp(ctx, { action: 'ops:vision-stop', ok: true, elapsed_ms: 0 });
  return { action: 'ops:vision-stop', ok: true, job };
}

/* --- S5.7 · Recovery Queue operations (C-8, C-9) --------------------------------- */

// Subrequest budget, not policy. A processor costs a crop fetch plus at least
// one model call per item, and this route runs inside one Worker invocation —
// the same constraint that caps /enrich at 16. An operator wanting more presses
// the button again; a cap that silently truncates is safer than an invocation
// that dies halfway through a paid batch.
const MAX_RECOVERY_DISPATCH = 10;

// Processors declare WHICH credential they need (`credential` on the
// descriptor); the console resolves that name to a key chain. This is the one
// place a new provider costs a line of console code — a processor reusing an
// existing credential costs nothing, which is the C-9 property holding as far
// as it can. The alternative, passing every key to every processor, would put
// credential selection inside processors where it cannot be audited.
function credentialChains(ctx) {
  return {
    ocr: createKeyChain([ctx.mistralOcrKey, ctx.mistralOcrKeyBackup]),
    vision: createKeyChain([ctx.mistralKey, ctx.mistralKeyBackup]),
  };
}

async function processorContext(ctx, processor) {
  const chains = credentialChains(ctx);
  const visionModel = await readVisionModelSetting(ctx.objectStore).catch(() => null);
  return {
    // A processor that declares no credential gets none — the human rung, for
    // one, needs no provider at all.
    keyChain: processor.credential ? chains[processor.credential] || null : null,
    fetchImpl: fetch,
    // Same INERT-until-armed rule the extraction drain follows: with no stored
    // selection we pass nothing and enrich.js's own default applies.
    ...(visionModel?.armed ? { model: visionModel.model } : {}),
    identityNormalizationMode: ctx.identityNormalizationMode,
  };
}

function requireRecovery(ctx) {
  if (!ctx.recoveryQueue || !ctx.recoveryRegistry) {
    throw new OpsError('Recovery Queue unavailable.', 503);
  }
}

function requireProcessor(ctx, id) {
  const processor = ctx.recoveryRegistry.get(String(id || '').trim());
  if (!processor) {
    throw new OpsError(
      `Unknown recovery processor '${id}'. Available: ${ctx.recoveryRegistry.ids().join(', ') || 'none'}.`,
      404,
    );
  }
  return processor;
}

// MANUAL DISPATCH — the operator chooses a processor and presses the button.
// That choice IS the authorisation (C-8): Manual dispatch deliberately does NOT
// consult the execution policy, which governs only whether the queue drains
// ITSELF. Refusing an explicit operator instruction because Auto is off would
// be the tool second-guessing the person it exists to serve.
async function runRecoveryDispatch(ctx, body) {
  requireRecovery(ctx);
  const processor = requireProcessor(ctx, body?.processor);
  // An EXPLICIT but empty selection is a mistake, not an instruction to process
  // whatever is ready. Refused here rather than passed down, because the two
  // requests differ by one character in the body and by an unbounded amount of
  // paid model work in effect. (The runner refuses it independently — this is
  // the message an operator gets to read.)
  const explicit = Array.isArray(body?.offerIds);
  const offerIds = explicit
    ? [...new Set(body.offerIds.map(String).filter(Boolean))].slice(0, MAX_RECOVERY_DISPATCH)
    : null;
  if (explicit && !offerIds.length) {
    throw new OpsError('No offers selected. Omit offerIds to process the ready queue.');
  }
  const limit = Math.max(1, Math.min(Number(body?.limit) || 5, MAX_RECOVERY_DISPATCH));
  const t0 = Date.now();
  const report = await runRecovery(
    {
      queue: ctx.recoveryQueue,
      processor,
      enrichStore: ctx.enrichStore,
      ctx: await processorContext(ctx, processor),
    },
    {
      currentOn: todayISO(),
      limit,
      offerIds,
      maxAttemptsPerItem: Number(body?.maxAttemptsPerItem) || 2,
    },
  );
  await auditOp(ctx, {
    action: 'ops:recovery-dispatch',
    ok: report.failed === 0,
    failed: report.failed,
    elapsed_ms: Date.now() - t0,
    error: report.errors?.[0] || null,
    // Audited per run so recovery spend is always traceable to the operator
    // action that authorised it, and to the processor that was paid for.
    detail: {
      processor: processor.id,
      explicit: !!offerIds,
      scanned: report.scanned,
      attempted: report.attempted,
      recovered: report.recovered,
      noChange: report.noChange,
      declined: report.declined,
      blockedByImmutability: report.blockedByImmutability,
      // Non-zero means two drains overlapped and the lease fence discarded the
      // loser's work. Not an error, but it IS paid work thrown away, so it is
      // audited rather than left to be inferred from a gap in the numbers.
      staleClaims: report.staleClaims,
    },
  });
  return { action: 'ops:recovery-dispatch', ok: true, report };
}

// AUTO drain, run on demand. Same runner, and it DOES consult the policy — an
// unattended drain is exactly what the policy governs, so a disarmed policy
// makes no provider call and says why.
async function runRecoveryDrain(ctx) {
  requireRecovery(ctx);
  const policy = await readRecoveryPolicy(ctx.objectStore, { registry: ctx.recoveryRegistry });
  const t0 = Date.now();
  const report = await drainRecovery(
    {
      queue: ctx.recoveryQueue,
      registry: ctx.recoveryRegistry,
      enrichStore: ctx.enrichStore,
      policy,
      // PER PROCESSOR, not once for the run. Each descriptor declares which
      // credential it needs; building the context once for the first armed
      // processor would hand the second one the first one's key chain.
      contextFor: (processor) => processorContext(ctx, processor),
    },
    { currentOn: todayISO() },
  );
  if (!report.skipped) {
    await auditOp(ctx, {
      action: 'ops:recovery-drain',
      ok: true,
      elapsed_ms: Date.now() - t0,
      detail: { processors: policy.processors, runs: report.runs.length },
    });
  }
  return { action: 'ops:recovery-drain', ok: true, report, policy };
}

// Arm or disarm the execution policy. This is the spend decision (C-8), so it
// is confirm-gated like every console mutation and audited with what it armed.
async function runRecoveryPolicyUpdate(ctx, body) {
  requireRecovery(ctx);
  if (!ctx.objectStore) throw new OpsError('Recovery policy unavailable (no object store).', 503);
  const mode = body?.mode === RECOVERY_MODES.AUTO ? RECOVERY_MODES.AUTO : RECOVERY_MODES.MANUAL;
  const processors = Array.isArray(body?.processors) ? body.processors.map(String) : [];
  let policy;
  try {
    policy = await writeRecoveryPolicy(
      ctx.objectStore,
      { ...body, mode, processors },
      { by: 'ops', registry: ctx.recoveryRegistry },
    );
  } catch (err) {
    // writeRecoveryPolicy rejects unknown ids on purpose — arming something
    // that does not exist is worth failing loudly at the moment it is asked for.
    throw new OpsError(err.message, 400);
  }
  await auditOp(ctx, {
    action: 'ops:recovery-policy',
    ok: true,
    elapsed_ms: 0,
    detail: {
      mode: policy.mode,
      armed: policy.armed,
      processors: [...policy.processors],
      maxItemsPerRun: policy.maxItemsPerRun,
    },
  });
  return { action: 'ops:recovery-policy', ok: true, policy };
}

// TERMINAL operator rejection (§6 S7). Typed confirmation, like Emergency Heal:
// a dismissed item is never re-queued by any automatic path, and re-entry is an
// explicit act — so this is not a button to press by accident.
async function runRecoveryDismiss(ctx, body) {
  requireRecovery(ctx);
  const ids = [...new Set((body?.offerIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new OpsError('No offers selected.');
  for (const id of ids) {
    await ctx.recoveryQueue.close(id, RECOVERY_STATUS.DISMISSED, {
      error: body?.reason ? String(body.reason).slice(0, 200) : null,
    });
  }
  await auditOp(ctx, {
    action: 'ops:recovery-dismiss', ok: true, elapsed_ms: 0,
    detail: { count: ids.length, reason: body?.reason || null },
  });
  return { action: 'ops:recovery-dismiss', ok: true, dismissed: ids.length };
}

// --- S7 · HUMAN REVIEW -------------------------------------------------------
// The review surface is the human processor's UI, but this file still never
// imports it: it asks the REGISTRY for a processor and reads the optional
// `reviewPlan` capability the descriptor declares (C-9). A second interactive
// processor would render here with no change to this function.
function requireReviewable(ctx, id) {
  // No id supplied: fall back to the only interactive processor there is. Asked
  // of the registry rather than hardcoded, so this stays correct whether that is
  // `human` today or something else later — and refuses honestly if two exist
  // rather than silently picking one.
  if (!String(id || '').trim()) {
    const interactive = ctx.recoveryRegistry.list().filter((p) => !!p.reviewPlan);
    if (interactive.length !== 1) {
      throw new OpsError(
        interactive.length
          ? `Several processors have a review surface (${interactive.map((p) => p.id).join(', ')}); name one.`
          : 'No processor has a review surface.',
        400,
      );
    }
    return interactive[0];
  }
  const processor = requireProcessor(ctx, id);
  if (!processor.reviewPlan) {
    throw new OpsError(`Processor '${processor.id}' has no review surface.`, 400);
  }
  return processor;
}

/**
 * APPROVE / REJECT / SEND BACK.
 *
 * Only APPROVE goes through the runner, and that asymmetry is the architecture
 * rather than an oversight. Approving produces a canonical row, so it must pass
 * the commit boundary and be re-judged by S4 like any other processor's output —
 * a reviewer does not get to declare an item resolved (C-9). Rejecting and
 * sending back produce no extraction at all; they are queue transitions, and
 * both already existed as `close(DISMISSED)` and `release()`.
 */
async function runRecoveryReview(ctx, body) {
  requireRecovery(ctx);
  const processor = requireReviewable(ctx, body?.processor);
  const offerId = String(body?.offerId || '').trim();
  if (!offerId) throw new OpsError("Missing required parameter 'offerId'.");
  const decision = String(body?.decision || '').trim();
  const actor = body?.actor ? String(body.actor).slice(0, 120) : null;
  const note = body?.note ? String(body.note).slice(0, 500) : null;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const item = await ctx.recoveryQueue.get(offerId);
  if (!item) throw new OpsError(`Offer '${offerId}' is not in the Recovery Queue.`, 404);
  const missingBefore = item.verdict?.missing ?? null;

  if (decision === REVIEW_DECISION.APPROVE) {
    // Straight through the ordinary Manual dispatch path, with the reviewer's
    // decision as processor context. S4 re-judges and closes the item only if it
    // genuinely became servable — so an approval that does not clear the gate
    // leaves the item queued and says so, rather than flattering the reviewer.
    const report = await runRecovery(
      {
        queue: ctx.recoveryQueue,
        processor,
        enrichStore: ctx.enrichStore,
        ctx: {
          ...(await processorContext(ctx, processor)),
          review: { decision, fields: body?.fields || {}, actor, note },
        },
      },
      { currentOn: todayISO(), offerIds: [offerId], maxAttemptsPerItem: Number.MAX_SAFE_INTEGER },
    );
    await auditOp(ctx, {
      action: 'ops:recovery-review', ok: report.failed === 0, failed: report.failed,
      elapsed_ms: Date.now() - t0, error: report.errors?.[0] || null,
      detail: { decision, offerId, actor, processor: processor.id, recovered: report.recovered },
    });
    const after = await ctx.recoveryQueue.get(offerId);
    return {
      action: 'ops:recovery-review',
      ok: true,
      decision,
      report,
      // The honest answer to "did my edit work", read back from the queue rather
      // than inferred from the report.
      resolved: report.recovered > 0,
      status: after?.status ?? null,
      stillMissing: after?.verdict?.missing ?? [],
    };
  }

  if (decision === REVIEW_DECISION.REJECT) {
    // TERMINAL. Recorded as an attempt first so the trail shows WHO rejected it
    // and against which conditions — a dismissal with no history is unauditable.
    // `no_change` is the honest outcome: nothing was recovered. The REJECTION
    // itself lives in the queue status, which is what `dismissed` means (S7).
    await ctx.recoveryQueue.recordAttempt({
      offerId,
      processor: processor.id,
      outcome: RECOVERY_OUTCOME.NO_CHANGE,
      missingBefore,
      missingAfter: missingBefore,
      actor,
      error: note ? `human rejected: ${note}` : 'human rejected',
      startedAt,
      finishedAt: new Date().toISOString(),
      cost: { requests: 0, tier: 'human' },
    });
    await ctx.recoveryQueue.close(offerId, RECOVERY_STATUS.DISMISSED, {
      error: note ? `Human rejected: ${note}` : 'Human rejected',
    });
    await auditOp(ctx, {
      action: 'ops:recovery-review', ok: true, elapsed_ms: Date.now() - t0,
      detail: { decision, offerId, actor, processor: processor.id, note },
    });
    return { action: 'ops:recovery-review', ok: true, decision, status: RECOVERY_STATUS.DISMISSED };
  }

  if (decision === REVIEW_DECISION.SEND_BACK) {
    // DECLINED, not `no_change`, and the distinction does real work: a decline
    // consumes no attempt and does not settle the item, so sending back neither
    // spends the item's budget nor hides it from this reviewer later. Releasing
    // returns it to the pool for any processor — including this one.
    await ctx.recoveryQueue.recordAttempt({
      offerId,
      processor: processor.id,
      outcome: RECOVERY_OUTCOME.DECLINED,
      missingBefore,
      actor,
      error: note ? `sent back: ${note}` : 'sent back to the queue',
      startedAt,
      finishedAt: new Date().toISOString(),
      releaseAfter: { at: new Date().toISOString(), error: null, retryAt: null },
    });
    await auditOp(ctx, {
      action: 'ops:recovery-review', ok: true, elapsed_ms: Date.now() - t0,
      detail: { decision, offerId, actor, processor: processor.id, note },
    });
    return { action: 'ops:recovery-review', ok: true, decision, status: RECOVERY_STATUS.QUEUED };
  }

  throw new OpsError(
    `Unknown review decision '${decision}'. Expected approve, reject or sendback.`,
  );
}

// The explicit act that undoes a terminal close, mirroring registry
// `resetVerdicts`. Nothing automatic can reach this.
async function runRecoveryReopen(ctx, body) {
  requireRecovery(ctx);
  const ids = [...new Set((body?.offerIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new OpsError('No offers selected.');
  const out = await ctx.recoveryQueue.reopen(ids);
  await auditOp(ctx, {
    action: 'ops:recovery-reopen', ok: true, elapsed_ms: 0,
    detail: { count: out.reopened },
  });
  return { action: 'ops:recovery-reopen', ok: true, ...out };
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

// --- Vision Inspector (§2): compose the full record for ONE offer from the
// existing store reads — offer row + vision enrichment + registry sighting +
// its product — plus the two derived identity keys (the price-history join
// keys) so the UI can show what OCR read vs what Vision read, side by side.
async function inspectOffer(ctx, id) {
  if (!ctx.offerStore) throw new OpsError('Offers unavailable.', 503);
  const offer = await ctx.offerStore.getById(id);
  if (!offer) throw new OpsError(`Unknown offer '${id}'.`, 404);
  const enr = ctx.enrichStore ? (await ctx.enrichStore.getForIds([id])).get(id) || null : null;
  const sighting = ctx.registryStore ? await ctx.registryStore.getSighting(id) : null;
  const product =
    sighting && ctx.registryStore
      ? (await ctx.registryStore.getProducts([sighting.product_id]))[0] || null
      : null;
  const identOf = (name, nameAr) => {
    const d = deriveIdentity({ name, nameAr, store: offer.store, region: offer.region });
    return d ? { id: d.id, matchText: d.matchText, sizeUnit: d.sizeUnit, sizeTotal: d.sizeTotal, sizePack: d.sizePack } : null;
  };
  return {
    offer: {
      id: offer.id, store: offer.store, region: offer.region, category: offer.category,
      price: offer.price, oldPrice: offer.old_price, currency: offer.currency,
      imageUrl: offer.image_url, sourceUrl: offer.source_url, validTo: offer.valid_to,
      detectedAt: offer.detected_at, searchText: offer.search_text,
    },
    ocr: {
      name: offer.name, nameAr: offer.name_ar,
      identity: offer.name || offer.name_ar ? identOf(offer.name, offer.name_ar) : null,
    },
    vision: enr
      ? {
          name: enr.name, nameAr: enr.name_ar, brand: enr.brand, size: enr.size,
          confidence: enr.confidence, corroboration: enr.corroboration, model: enr.model,
          cropUrl: enr.crop_url, enrichedAt: enr.enriched_at, mintVerdict: enr.mint_verdict,
          servable: servable(enr),
          identity: enr.name || enr.name_ar ? identOf(enr.name, enr.name_ar) : null,
        }
      : null,
    sighting: sighting
      ? {
          productId: sighting.product_id, matchBand: sighting.match_band,
          matchScore: sighting.match_score, corroboration: sighting.corroboration,
          week: sighting.week, price: sighting.price, resolvedAt: sighting.resolved_at,
        }
      : null,
    product: product
      ? {
          id: product.id, status: product.status, kind: product.kind,
          displayName: product.display_name, displayNameAr: product.display_name_ar,
          brandText: product.brand_text, brandSlug: product.brand_slug,
          family: product.family, category: product.category,
          sizeUnit: product.size_unit, sizeTotal: product.size_total, sizePack: product.size_pack,
          sightings: product.sightings, reviewFlag: product.review_flag,
        }
      : null,
  };
}

// --- Registry Inspector (§3): a product with all its evidence — every
// sighting (folding in any merged-loser products' sightings), each linked
// offer, and the vision enrichment behind each sighting (the enrichment +
// resolution/match history). Composed from existing store reads.
async function productDetail(ctx, id) {
  if (!ctx.registryStore) throw new OpsError('Registry unavailable.', 503);
  const product = (await ctx.registryStore.getProducts([id]))[0];
  if (!product) throw new OpsError(`Unknown product '${id}'.`, 404);
  const losers = await ctx.registryStore.mergedLoserIds([id]);
  const ids = [id, ...losers.keys()];
  const sightings = await ctx.registryStore.sightingsForProducts(ids);
  const offerIds = sightings.map((s) => s.offer_id);
  const enrichMap =
    ctx.enrichStore && offerIds.length
      ? await ctx.enrichStore.getForIds(offerIds).catch(() => new Map())
      : new Map();
  sightings.sort((a, b) => String(b.resolved_at).localeCompare(String(a.resolved_at)));
  return {
    product,
    mergedLosers: [...losers.keys()],
    sightings: sightings.map((s) => {
      const e = enrichMap.get(s.offer_id) || null;
      return {
        offerId: s.offer_id, productId: s.product_id, matchBand: s.match_band,
        matchScore: s.match_score, corroboration: s.corroboration, store: s.store,
        region: s.region, week: s.week, price: s.price, oldPrice: s.old_price,
        resolvedAt: s.resolved_at, algoVersion: s.algo_version,
        offerImageUrl: s.o_image_url, offerSourceUrl: s.o_source_url, offerValidTo: s.o_valid_to,
        enrichment: e
          ? { name: e.name, nameAr: e.name_ar, brand: e.brand, size: e.size,
              corroboration: e.corroboration, mintVerdict: e.mint_verdict, servable: servable(e) }
          : null,
      };
    }),
  };
}

// --- Resolve Queue (§8): drain the resolution backlog (D1-only, no vision
// calls) — the manual twin of the enrich cron's resolution post-step.
async function runResolveOperation(ctx, body) {
  if (!ctx.registryStore || !ctx.enrichStore) throw new OpsError('Registry unavailable.', 503);
  const t0 = Date.now();
  const limit = Math.max(1, Math.min(Number(body.limit) || 200, 500));
  const report = await drainResolution(
    { enrichStore: ctx.enrichStore, registryStore: ctx.registryStore },
    { limit, currentOn: todayISO() },
  );
  const ok = report.errors.length === 0;
  await auditOp(ctx, {
    ts: new Date(t0).toISOString(), action: 'ops:resolve', ok, failed: report.errors.length,
    elapsed_ms: Date.now() - t0, error: report.errors[0] || null,
    detail: { scanned: report.scanned, attached: report.attached, reviewed: report.reviewed,
      created: report.created, deferred: report.deferred, verdicts: report.verdicts },
  });
  return { action: 'ops:resolve', ...report, ok, elapsedMs: Date.now() - t0 };
}

// --- Repair Registry (§8): the §5.1 dormancy sweep, §5.4 consolidation, and
// dangling-sighting healing — runMaintenance writes its own audit row.
async function runMaintainOperation(ctx) {
  if (!ctx.registryStore) throw new OpsError('Registry unavailable.', 503);
  const report = await runMaintenance(ctx, { today: todayISO() });
  return { action: 'ops:maintain', ...report, ok: !report.error };
}

// --- Re-open deferred (§4): un-stamp the resolution verdict on the SELECTED
// offers so the drain re-resolves them, then resolve immediately.
async function runReopenOperation(ctx, body) {
  if (!ctx.enrichStore || !ctx.registryStore) throw new OpsError('Registry unavailable.', 503);
  const ids = [...new Set((body.ids || []).map(String))].filter(Boolean);
  if (!ids.length) throw new OpsError('no offers selected to re-open');
  const t0 = Date.now();
  await ctx.enrichStore.resetVerdicts(ids);
  const resolution = await drainResolution(
    { enrichStore: ctx.enrichStore, registryStore: ctx.registryStore },
    { limit: Math.max(ids.length, 50), currentOn: todayISO() },
  );
  const ok = resolution.errors.length === 0;
  await auditOp(ctx, {
    ts: new Date(t0).toISOString(), action: 'ops:reopen', ok, elapsed_ms: Date.now() - t0,
    error: resolution.errors[0] || null, detail: { reopened: ids.length },
  });
  return { action: 'ops:reopen', reopened: ids.length, resolution, ok, elapsedMs: Date.now() - t0 };
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

      // --- Operations Center reads (Ops plan §1–§7) — all read-only ---------
      case 'progress': // §1 Vision Progress (auto-polled)
        return opsJson(await visionProgress(ctx));
      case 'vision/job': // Background Manual Vision job snapshot (polled)
        return opsJson({ job: ctx.visionJobStore ? await ctx.visionJobStore.get() : null });
      case 'vision/model': { // Developer Tool — active model + the tiers on offer
        // `defaultModel` is what extraction runs on while the selector is INERT
        // (no operator selection stored). The console must show the model that
        // is really running, not the tier the selector proposes — otherwise an
        // unarmed card would claim Medium while production is still on the
        // engine default.
        const setting = await readVisionModelSetting(ctx.objectStore);
        return opsJson({
          setting,
          defaultModel: DEFAULT_MODEL,
          activeModel: setting.armed ? setting.model : DEFAULT_MODEL,
          options: VISION_MODEL_OPTIONS,
        });
      }
      case 'queue': // §4 Queue Monitor
        return opsJson(await queueSnapshot(ctx));
      // --- S5.7 Recovery Queue (C-8, C-9) ----------------------------------
      case 'recovery': { // panel state in ONE read
        const snapshot = await recoverySnapshot(ctx);
        const policy = ctx.recoveryRegistry
          ? await readRecoveryPolicy(ctx.objectStore, { registry: ctx.recoveryRegistry })
          : null;
        return opsJson({
          ...snapshot,
          policy,
          // Straight from the registry, so a processor added tomorrow appears
          // in the console with no change here (C-9). `describe()` omits
          // run()/supports() — this crosses to a browser.
          processors: ctx.recoveryRegistry ? ctx.recoveryRegistry.describe() : [],
          maxDispatch: MAX_RECOVERY_DISPATCH,
        });
      }
      case 'recovery/items': { // triage list
        requireRecovery(ctx);
        const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 25, 50));
        const processorId = (url.searchParams.get('processor') || '').trim();
        // Filtering by processor shows what THAT processor would actually pick
        // up — the queue's own exclusion plus the processor's `supports()`. The
        // two are asked separately on purpose: the queue does not know what a
        // processor needs, and must not learn.
        const items = await ctx.recoveryQueue.list({
          currentOn: todayISO(),
          limit,
          excludeProcessor: processorId || null,
        });
        const processor = processorId ? ctx.recoveryRegistry.get(processorId) : null;
        return opsJson({
          count: items.length,
          processor: processorId || null,
          items: items.map((item) => ({
            offerId: item.offerId,
            status: item.status,
            attempts: item.attempts,
            reasons: item.reasons,
            missing: item.verdict?.missing || [],
            verdictVersion: item.verdict?.version || null,
            quantityStatus: item.verdict?.quantityStatus || null,
            name: item.offer.name,
            nameAr: item.offer.name_ar,
            price: item.offer.price,
            currency: item.offer.currency,
            imageUrl: item.offer.image_url,
            validTo: item.offer.valid_to,
            lastError: item.lastError,
            nextAttemptAt: item.nextAttemptAt,
            updatedAt: item.updatedAt,
            attemptedBy: Object.keys(item.attemptsBySource),
            supported: processor ? !!processor.supports(item) : null,
          })),
        });
      }
      case 'recovery/review': { // S7 — everything one review needs, in ONE read
        requireRecovery(ctx);
        const processor = requireReviewable(ctx, url.searchParams.get('processor'));
        const id = (url.searchParams.get('id') || '').trim();
        if (!id) throw new OpsError("Missing required parameter 'id'.");
        const item = await ctx.recoveryQueue.get(id);
        if (!item) throw new OpsError(`Offer '${id}' is not in the Recovery Queue.`, 404);
        // The plan comes from the PROCESSOR (its declared capability), not from
        // this file: what blocks servability is extraction knowledge, and the
        // ops layer must not acquire a second copy of it.
        return opsJson({
          processor: processor.id,
          status: item.status,
          plan: processor.reviewPlan(item),
          // The trail, so a reviewer can see what has already been tried and
          // does not repeat a machine rung's failed guess by hand.
          history: await ctx.recoveryQueue.history(id),
        });
      }
      case 'recovery/history': { // per-offer attempt trail
        requireRecovery(ctx);
        const id = (url.searchParams.get('id') || '').trim();
        if (!id) throw new OpsError("Missing required parameter 'id'.");
        return opsJson({
          offerId: id,
          item: await ctx.recoveryQueue.get(id),
          history: await ctx.recoveryQueue.history(id),
        });
      }
      case 'crons': // §5 Cron Monitor
        return opsJson(await cronMonitor(ctx));
      case 'pipeline': // §6 Pipeline Health
        return opsJson(await pipelineHealth(ctx));
      case 'diagnostics2': // §7 Diagnostics (latency + not-instrumented)
        return opsJson(await latencyStats(ctx));
      case 'inspector': { // §2 Vision Inspector list
        const filter = (url.searchParams.get('filter') || 'all').trim();
        const q = (url.searchParams.get('q') || '').trim();
        const limit = Number(url.searchParams.get('limit')) || 40;
        if (!ctx.offerStore) throw new OpsError('Offers unavailable.', 503);
        const items = await ctx.offerStore.inspectorFeed({ q, filter, currentOn: todayISO(), limit });
        return opsJson({ filter, q, count: items.length, items });
      }
      case 'inspect': { // §2 Vision Inspector single offer
        const id = (url.searchParams.get('id') || '').trim();
        if (!id) throw new OpsError("Missing required parameter 'id'.");
        return opsJson(await inspectOffer(ctx, id));
      }
      case 'productsearch': { // §3 Registry Inspector search
        if (!ctx.registryStore) throw new OpsError('Registry unavailable.', 503);
        const q = (url.searchParams.get('q') || '').trim();
        const limit = Number(url.searchParams.get('limit')) || 30;
        const products = await ctx.registryStore.searchProducts({ q, limit });
        return opsJson({ q, count: products.length, products });
      }
      case 'product': { // §3 Registry Inspector detail
        const id = (url.searchParams.get('id') || '').trim();
        if (!id) throw new OpsError("Missing required parameter 'id'.");
        return opsJson(await productDetail(ctx, id));
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
      case 'enrich': {
        // Developer convenience only — steady state is the enrich cron.
        requireConfirm(body, true);
        return opsJson(await runEnrichOperation(ctx, body));
      }
      case 'vision/start': {
        // Background Manual Vision (§2): arm a durable job + kick the
        // self-continuing chain that drains to empty without the browser open.
        requireConfirm(body, true);
        return opsJson(await runVisionStart(ctx, body));
      }
      case 'vision/stop': {
        // Halt the running Vision job (D1-only, no vision calls).
        return opsJson(await runVisionStop(ctx));
      }
      case 'vision/model': {
        // Developer Tool: switch the extraction model. Confirm-gated like every
        // console mutation — this one changes the quality of every product
        // record written from here on.
        requireConfirm(body, true);
        return opsJson(await runVisionModelSelect(ctx, body));
      }
      case 'registry/merge': {
        // Freeze or re-arm the AUTOMATED registry merge. Merge is the one
        // registry operation that is irreversible in practice (undoing one is
        // N per-sighting splits, each needing that sighting's Identity
        // Candidate to still exist) AND it runs unattended on the weekly cron.
        // That is a fine trade against a stable corpus and a bad one while the
        // input distribution is changing — which is what a migration does.
        requireConfirm(body, true);
        const enabled = body.enabled !== false;
        const setting = await writeMergeSetting(ctx.objectStore, enabled, {
          reason: body.reason || null,
        });
        await auditOp(ctx, {
          action: 'ops:registry-merge', ok: true, elapsed_ms: 0,
          detail: { enabled: setting.enabled, reason: setting.reason },
        });
        return opsJson({ action: 'ops:registry-merge', ok: true, setting });
      }
      case 'watches/resolve-legacy': {
        // The ONE-TIME product-anchor backfill. `dryRun` writes nothing and
        // reports exactly what would happen — including every registry product
        // it would MINT, which survives an engine rollback. Confirmation is
        // required only for the real run; a dry run changes nothing.
        if (!ctx.registryStore) throw new OpsError('Registry unavailable.');
        const dryRun = body.dryRun === true;
        if (!dryRun) requireConfirm(body, true);
        const t0 = Date.now();
        const report = await resolveLegacyWatches(ctx, {
          limit: Math.max(1, Math.min(Number(body.limit) || 100, 500)),
          dryRun,
        });
        if (!dryRun) {
          await auditOp(ctx, {
            action: 'ops:watches-resolve-legacy', ok: report.stillPending === 0,
            elapsed_ms: Date.now() - t0,
            detail: {
              scanned: report.scanned, anchored: report.anchored, specced: report.specced,
              needsConfirmation: report.needsConfirmation, unresolvable: report.unresolvable,
              minted: report.minted.map((m) => m.productId), stillPending: report.stillPending,
            },
          });
        }
        return opsJson({ action: 'ops:watches-resolve-legacy', ok: true, report });
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
      case 'resolve': {
        // Drain the resolution backlog (D1-only). Confirm-gated like every
        // console mutation, even though it writes only the registry.
        requireConfirm(body, true);
        return opsJson(await runResolveOperation(ctx, body));
      }
      case 'maintain': {
        requireConfirm(body, true);
        return opsJson(await runMaintainOperation(ctx));
      }
      // --- S5.7 Recovery Queue writes --------------------------------------
      case 'recovery/dispatch': {
        // MANUAL: the operator picked a processor. This SPENDS, so it is
        // confirm-gated like every console mutation.
        requireConfirm(body, true);
        return opsJson(await runRecoveryDispatch(ctx, body));
      }
      case 'recovery/drain': {
        // AUTO on demand. No-op unless the policy is armed.
        requireConfirm(body, true);
        return opsJson(await runRecoveryDrain(ctx));
      }
      case 'recovery/policy': {
        // The spend decision itself (C-8).
        requireConfirm(body, true);
        return opsJson(await runRecoveryPolicyUpdate(ctx, body));
      }
      case 'recovery/review': {
        // A PER-ITEM act taken with the crop on screen, so a boolean confirm is
        // the right bar — the review itself is the deliberation. Bulk
        // `recovery/dismiss` keeps its typed "DISMISS" because it closes items
        // sight-unseen, which is the thing worth slowing down.
        requireConfirm(body, true);
        return opsJson(await runRecoveryReview(ctx, body));
      }
      case 'recovery/dismiss': {
        // TERMINAL, so a typed confirmation — the same bar as Emergency Heal.
        requireConfirm(body, 'DISMISS');
        return opsJson(await runRecoveryDismiss(ctx, body));
      }
      case 'recovery/reopen': {
        requireConfirm(body, true);
        return opsJson(await runRecoveryReopen(ctx, body));
      }
      case 'reopen': {
        requireConfirm(body, true);
        return opsJson(await runReopenOperation(ctx, body));
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
          // img-src allows the Vision Inspector to render flyer crops: engine
          // /asset images ('self') and the aggregator's external crop CDNs
          // (https:) — an admin-only, noindex, single-operator console. Every
          // other directive stays locked; connect-src is still 'self'.
          'Content-Security-Policy':
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https:",
        },
      });
    }
    throw new OpsError('not found', 404);
  } catch (err) {
    const status = err instanceof OpsError ? err.status : 500;
    return opsJson({ error: String(err.message || err) }, status);
  }
}
