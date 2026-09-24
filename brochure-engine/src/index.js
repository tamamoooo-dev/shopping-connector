// index.js — Cloudflare Worker entry point for the Brochure Engine.
//
// Wires the provider registry and the storage backends into the Core. To add a
// PDF-index store later, import its provider and add one registry line — nothing
// else changes (the collector, pipeline and Core are store-agnostic).
//
// Bindings (wrangler.toml):
//   DB           D1 database    -> MetadataStore (index + history + dedupe)
//   BROCHURES    R2 bucket      -> ObjectStore (preferred, if bound)
//   BROCHURES_KV KV namespace   -> ObjectStore (fallback when R2 is unavailable)
//   SELF         Service binding (this Worker) -> cron fan-out (Architecture C)
//   INGEST_SECRET  Worker secret guarding POST /ingest
//
// Storage lives behind narrow interfaces (§5), so which object backend is bound
// is invisible to everything above it.

import { handleRequest } from './engine.js';
import { enqueueBackground, consumeBackground } from './backgroundContinuation.js';
import { handleOps } from './ops/console.js';
import { handleIdentityBuilderDebug } from './offers/identityDebug.js';
import { handleArabicBuilderDebug } from './offers/arabicBuilderDebug.js';
import { handleRegistryCandidateDebug } from './registry/debug.js';
import {
  runFanOut,
  createServiceBindingDispatcher,
  createWatchRunDispatcher,
  runEnrichDrain,
  createEnrichDispatcher,
  CPU_SAFE_BACKGROUND_DRAIN,
  isDailyEmptyResolutionTick,
  runVisionVerificationDrain,
  createVisionVerificationDispatcher,
  createResolutionDispatcher,
  createOcrEnrichDispatcher,
  createPriceFallbackDispatcher,
} from './scheduler.js';
import { createD1MetadataStore } from './storage/metadataStore.js';
import {
  createR2ObjectStore,
  createKvObjectStore,
  createTieredObjectStore,
} from './storage/objectStore.js';
import { createD1CollectionStore } from './storage/collectionStore.js';
import { createD1HistoryStore } from './storage/historyStore.js';
import { createD1OfferStore } from './storage/offerStore.js';
import { createD1BrowseStore } from './storage/browseStore.js';
import { createD1WatchStore } from './storage/watchStore.js';
import { createD1WatchRunStore } from './storage/watchRunStore.js';
import { createD1OpsStore } from './storage/opsStore.js';
import { createD1EnrichStore } from './storage/enrichStore.js';
import { createD1VisionVerificationStore } from './storage/visionVerificationStore.js';
import { createR2VisionVerificationHistoryStore } from './storage/visionVerificationHistoryStore.js';
import { createRecoveryQueue } from './storage/recoveryQueue.js';
import { recoveryRegistry } from './recovery/processors/index.js';
import { createD1VisionJobStore } from './storage/visionJobStore.js';
import { createD1RegistryStore } from './storage/registryStore.js';
import { builtArabicNamesEnabled } from './lexicon/arabicRollout.js';
import { createNtfyNotifier } from './monitor.js';
import { claimScheduledWatchRuns } from './watchSchedule.js';
import { runMaintenance } from './registry/lifecycle.js';
import { createPipeline } from './pipeline.js';
import { createServiceBindingSearchClient } from './searchClient.js';
import { createD4dOffersSource } from './offers/d4dOffers.js';
import { isD1RetentionTick, pruneStoredBytes } from './retention.js';
import { othaimProvider } from './providers/othaim.js';
import { hyperpandaProvider } from './providers/hyperpanda.js';
import { carrefourProvider } from './providers/carrefour.js';
import { luluProvider } from './providers/lulu.js';
import { danubeProvider } from './providers/danube.js';
import { tamimiProvider } from './providers/tamimi.js';
import { nestoProvider } from './providers/nesto.js';
import { d4dStoreProviders } from './providers/d4dStores.js';
import { buildMistralPools, isTerminalMistralLimit, MISTRAL_POOL_DEFINITIONS } from './offers/mistralKeys.js';
import { PRICE_FALLBACK_DEFAULTS } from './offers/priceFallback.js';

// M1: Othaim via the official PdfIndexCollector. The other stores via the
// reusable AggregatorCollector (D4D adapter) with an official-offers-page
// fallback; d4dStoreProviders carries the Coverage Expansion stores (one
// config line each). Adding a store = one import + one line; the Core,
// collectors, adapter, pipeline and storage never change.
const registry = Object.fromEntries(
  [
    othaimProvider,
    hyperpandaProvider,
    carrefourProvider,
    luluProvider,
    danubeProvider,
    tamimiProvider,
    nestoProvider,
    ...d4dStoreProviders,
  ].map((p) => [p.id, p]),
);

// The deployed cron schedules — MUST mirror wrangler.toml [triggers] (the
// runtime can't read its own config, and the Ops Console shows next-run times
// computed from these).
const CRONS = {
  pipeline: '0 6 * * 2,3,5', // weekly brochure/offers fan-out
  watches: '* * * * *', // durable 07:00/19:00 Riyadh rounds + minute retries
  maintenance: '45 5 * * *', // Monday registry maintenance
  enrich: '10,30,50 * * * *', // steady-state vision drain (yields to a background job)
  // Logical schedule serviced by the shared one-minute trigger below.
  verification: '5,25,45 * * * *', // stage-two repeated Vision verification
  visionDrain: '* * * * *', // Background Manual Vision: near-continuous drain while a job runs
  brochureResume: '*/2 * * * *', // one safe page batch per pending D4D store
};

// --- Background Manual Vision (continuous cron-driven drain) --------------------
// The one-minute tick drains an operator-started job to empty. Every SELF child
// handles one crop/model/commit unit (CPU_SAFE_BACKGROUND_DRAIN), preventing
// fifteen CPU-heavy base64/normalization operations from sharing one limit.
// Single-writer lease held while a fire is draining. It MUST exceed a fire's
// worst-case wall time, else it expires mid-drain and a second fire could write
// concurrently. Keep it comfortably above the configured child ceiling and
// provider retry window. A normal fire RELEASES the lease
// on completion (the next tick continues at once); the lease only bounds a
// crashed/stalled fire (≤5-min recovery).
const VISION_LEASE_MS = 900000;
// Resolution has its own SELF invocation and a deliberately small unit of work.
const RESOLVE_LIMIT = 25;

function terminalProviderFailure(drain) {
  const category = drain?.providerLimit?.category || drain?.providerError?.category || null;
  return isTerminalMistralLimit(category);
}

// Keep the CPU-heavy Registry scorer outside the cron coordinator. This is a
// sibling SELF invocation, not post-processing inside the Vision invocation.
async function runDetachedResolution(env, { tag = '' } = {}) {
  // Vision and Verification may now run concurrently; Registry remains a
  // single writer across both coordinators.
  const lease = createD1VisionJobStore(env.DB, { id: 'background-resolution' });
  await lease.ensureRunning({ scope: 'all', total: 0, origin: 'ops' });
  if (!(await lease.tryLease({ nowMs: Date.now(), leaseMs: VISION_LEASE_MS }))) {
    return { ok: true, skipped: 'resolution-already-running' };
  }
  try {
    const result = await createResolutionDispatcher({
      self: env.SELF,
      ingestSecret: env.INGEST_SECRET,
      tag,
    })(RESOLVE_LIMIT);
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    await lease.update({ lease_until: null });
  }
}

// PRICE_FALLBACK_MODEL (default: the ministral14 pool's pinned model),
// PRICE_FALLBACK_MAX_READINGS (2..10), PRICE_FALLBACK_TEMPERATURE (0..1],
// PRICE_FALLBACK_BATCHES (children per cron fire, 0 disables, max 6).
function priceFallbackConfig(env) {
  const num = (v, lo, hi, dflt) => {
    const n = Number(v);
    return v != null && v !== '' && Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  return {
    model: String(env.PRICE_FALLBACK_MODEL || MISTRAL_POOL_DEFINITIONS.ministral14.model).trim(),
    maxReadings: Math.floor(num(env.PRICE_FALLBACK_MAX_READINGS, 2, 10, PRICE_FALLBACK_DEFAULTS.maxReadings)),
    temperature: num(env.PRICE_FALLBACK_TEMPERATURE, 0.01, 1, PRICE_FALLBACK_DEFAULTS.temperature),
    batches: Math.floor(num(env.PRICE_FALLBACK_BATCHES, 0, 6, 3)),
  };
}

function buildContext(env) {
  const useBuiltArabicNames = builtArabicNamesEnabled(env.BUILT_ARABIC_NAMES_ENABLED);
  const r2Store = env.BROCHURES ? createR2ObjectStore(env.BROCHURES) : null;
  const kvStore = env.BROCHURES_KV ? createKvObjectStore(env.BROCHURES_KV) : null;
  const objectStore =
    r2Store && kvStore
      ? createTieredObjectStore(r2Store, kvStore)
      : r2Store || kvStore || (() => {
          throw new Error('No object store binding (BROCHURES R2 or BROCHURES_KV).');
        })();
  const metadataStore = createD1MetadataStore(env.DB);
  const collectionStore = createD1CollectionStore(env.DB);
  const pipeline = createPipeline({ objectStore, metadataStore });
  // Price History (Pillar 3) shares this Worker's D1 database. It is harvested
  // from the structured-offers ingest (priceHistory.js) — catalog-wide, no
  // watchlist. The CONNECTOR search client only serves Price Monitoring now.
  const historyStore = createD1HistoryStore(env.DB);
  const searchClient = env.CONNECTOR
    ? createServiceBindingSearchClient({ connector: env.CONNECTOR })
    : null;
  // Structured offers (the price-comparison substrate) share the same D1.
  const offerStore = createD1OfferStore(env.DB, {
    builtArabicNamesEnabled: useBuiltArabicNames,
  });
  const offersSource = createD4dOffersSource();
  // Browse (product discovery, BROWSE-DESIGN.md): a read-only VIEW over the
  // offers + price-history tables — no tables of its own.
  const browseStore = createD1BrowseStore(env.DB, {
    builtArabicNamesEnabled: useBuiltArabicNames,
  });
  // Price Monitoring (watches + alerts) shares the same D1 too. Push delivery
  // is optional: set the NTFY_TOPIC secret to a private ntfy.sh topic and the
  // monitor pushes each alert to the user's phone; absent, alerts are in-app.
  const watchStore = createD1WatchStore(env.DB);
  const watchRunStore = createD1WatchRunStore(env.DB);
  const notifier = env.NTFY_TOPIC
    ? createNtfyNotifier({ topic: env.NTFY_TOPIC, server: env.NTFY_SERVER || 'https://ntfy.sh' })
    : null;
  // The Operations Console (ops/ subsystem): its audit store shares D1, its
  // auth uses the dedicated OPS_TOKEN secret (human operators only —
  // INGEST_SECRET stays machine-only), and its multi-store operations reuse
  // the SELF fan-out, so it needs the binding in context.
  const opsStore = createD1OpsStore(env.DB);
  // Vision enrichment (offers/enrich.js): the debris-name side-car. The store
  // shares D1; the drain runs only when the MISTRAL_API_KEY secret is set —
  // absent, the whole feature is inert (route 503s, cron skips, reads overlay
  // nothing) with zero behavior change elsewhere.
  const enrichStore = createD1EnrichStore(env.DB);
  const visionVerificationStore = createD1VisionVerificationStore(env.DB);
  const visionVerificationHistoryStore = createR2VisionVerificationHistoryStore(env.BROCHURES);
  // Legacy Recovery storage remains bound for rollback/audit compatibility,
  // but no cron or visible Operations path drains it. Stage 2 below is the
  // active replacement.
  const recoveryQueue = createRecoveryQueue(env.DB);
  // Background Manual Vision job (Vision Milestone 2 §2): one durable 'active'
  // row the 1-minute `visionDrain` cron updates each fire, so a manual drain
  // runs to empty server-side and its progress survives the browser closing.
  // Shares D1; inert until an operator starts a job.
  const visionJobStore = createD1VisionJobStore(env.DB);
  // The retired Recovery coordinator row is retained for backward-compatible
  // operator API reads. Stage 2 owns the active verification row.
  const recoveryJobStore = createD1VisionJobStore(env.DB, { id: 'recovery' });
  const visionVerificationJobStore = createD1VisionJobStore(env.DB, { id: 'verification' });
  // Product Registry (REGISTRY-DESIGN.md): products + sightings, shared D1.
  const registryStore = createD1RegistryStore(env.DB);
  // Model-scoped Mistral credentials. Dedicated bindings isolate Small, OCR,
  // and Medium quota. Legacy MISTRAL_API_KEY[_BACKUP] remain fallback aliases
  // until all dedicated secrets have been rotated into production.
  const mistralPools = buildMistralPools(env);
  const mediumKeys = mistralPools.medium.filter((slot) => slot.key);
  const smallKeys = mistralPools.small.filter((slot) => slot.key);
  const ocrKeys = mistralPools.ocr.filter((slot) => slot.key);
  return {
    registry,
    objectStore,
    metadataStore,
    collectionStore,
    pipeline,
    historyStore,
    offerStore,
    offersSource,
    browseStore,
    watchStore,
    watchRunStore,
    notifier,
    searchClient,
    ingestSecret: env.INGEST_SECRET,
    opsStore,
    opsToken: env.OPS_TOKEN,
    enrichStore,
    visionVerificationStore,
    visionVerificationHistoryStore,
    recoveryQueue,
    recoveryRegistry,
    visionJobStore,
    backgroundDrainQueue: env.BACKGROUND_DRAINS,
    recoveryJobStore,
    visionVerificationJobStore,
    mistralPools,
    // Compatibility fields for older local/tests/callers. Production routing
    // consumes mistralPools directly and can therefore use all three Medium
    // slots rather than truncating the pool to primary + backup.
    mistralKey: mediumKeys[0]?.key || null,
    mistralKeyBackup: mediumKeys[1]?.key || null,
    mistralSmallKey: smallKeys[0]?.key || null,
    mistralOcrKey: ocrKeys[0]?.key || null,
    mistralOcrKeyBackup: ocrKeys[1]?.key || null,
    ocrFallbackEnabled: String(env.OCR_FALLBACK_ENABLED ?? 'true').trim().toLowerCase() !== 'false',
    // Vision price fallback (offers/priceFallback.js). Vars override the
    // measured defaults; out-of-range values fall back to them.
    priceFallback: priceFallbackConfig(env),
    // Runtime extraction policy; normalized inside offers/enrich.js. Unset or
    // invalid values safely retain the validated Vision First default.
    extractionStrategy: env.EXTRACTION_STRATEGY,
    // Identity Builder policy is independent from extraction strategy. It is
    // pure normalization and defaults to strict when this variable is absent.
    identityNormalizationMode: env.IDENTITY_NORMALIZATION_MODE,
    // Policy B navigation circuit breakers. Rates are fractions in [0,1].
    // Defaults are zero: the first ambiguous source id or corroboration
    // disagreement suppresses every hotspot-only fallback for that target,
    // while existing dual links retain their original contract.
    navigationPolicy: {
      ambiguityRateThreshold: env.NAVIGATION_AMBIGUITY_RATE_THRESHOLD,
      disagreementRateThreshold: env.NAVIGATION_DISAGREEMENT_RATE_THRESHOLD,
    },
    builtArabicNamesEnabled: useBuiltArabicNames,
    isDevelopment: env.ENVIRONMENT === 'development',
    registryStore,
    self: env.SELF,
    crons: CRONS,
  };
}

const worker = {
  async queue(batch, env) {
    await consumeBackground(batch, env, worker.scheduled);
  },
  async fetch(request, env) {
    const ctx = buildContext(env);
    // The Operations Console — a hidden, OPS_TOKEN-guarded admin subsystem
    // mounted at /__ops (ops/console.js). Returns null for any other path.
    return (await handleIdentityBuilderDebug(request, ctx))
      ?? (await handleArabicBuilderDebug(request, ctx))
      ?? (await handleRegistryCandidateDebug(request, ctx))
      ?? (await handleOps(request, ctx))
      ?? handleRequest(request, ctx);
  },

  // Cron trigger (§6.3) — Architecture C: Self Service-Binding Fan-out.
  // On each fire the coordinator fans out to EVERY registered store CONCURRENTLY
  // via the SELF service binding (see scheduler.js). Each store is ingested in
  // its OWN child invocation (POST /ingest?store=<id>), which carries its own
  // fresh 50-subrequest budget — so all stores refresh together, in the same
  // minute, on the Workers Free plan (the coordinator itself makes only N
  // service-binding calls and touches no storage). This replaces M2's one-store-
  // per-day rotation, which spread the refresh across ~8 days — unacceptable
  // because Saudi brochures drop on a single publication day (Tue/Wed). The
  // pipeline's checksum dedupe keeps the Tue+Wed double-fire free of extra writes.
  // The fan-out mechanism is isolated behind dispatchStore() so it can be swapped
  // (e.g. for a Queue producer) without touching collectors, pipeline or storage.
  async scheduled(event, env, ctx) {
    // Resumable brochure recovery: D1 is the durable queue and each child
    // advances one D4D store by one <=20-page batch. At most 20 SELF calls stay
    // below the scheduled-event invocation cap; each child has its own external
    // subrequest budget. Failed/interrupted jobs remain pending automatically.
    if (event.cron === '*/2 * * * *') {
      ctx.waitUntil(
        (async () => {
          const context = buildContext(env);
          const pending = await context.collectionStore.listPending(20);
          if (!pending.length) return;
          const pendingRegistry = Object.fromEntries(
            pending
              .filter((job) => registry[job.store])
              .map((job) => [job.store, registry[job.store]]),
          );
          if (!Object.keys(pendingRegistry).length) return;
          const dispatchStore = createServiceBindingDispatcher({
            self: env.SELF,
            ingestSecret: env.INGEST_SECRET,
            mode: 'brochures',
          });
          const report = await runFanOut(pendingRegistry, dispatchStore);
          console.log(
            'brochure-engine resumable collection',
            JSON.stringify({
              dispatched: report.dispatched,
              ok: report.ok,
              failed: report.failed,
            }),
          );
        })(),
      );
      return;
    }

    // FOUR schedules share this handler (wrangler.toml [triggers]):
    //   • "* * * * *"    — shared background tick: Manual Vision when its job
    //     is running; otherwise armed Recovery, plus free non-grocery cleanup.
    //   • "10,30,50 * * * *" — the steady-state vision-enrichment drain (below).
    //   • "* * * * *" — durable Price Monitoring rounds at 07:00/19:00
    //     Riyadh, with a failed lookup retried on subsequent minute ticks.
    //   • "45 5 * * *" — Monday registry maintenance.
    //   • "0 6 * * 2,3,5" — the WEEKLY brochure/offers pipeline (fan-out ->
    //     price capture -> retention), unchanged below.
    // Shared one-minute background tick. Manual Vision has first priority while
    // its job runs. Otherwise armed Recovery drains through fresh SELF children.
    // Both paths hold their own D1 lease so cron fires cannot overlap.
    if (event.cron === '* * * * *') {
      // Price monitoring shares this minute trigger but has an independent
      // durable D1 queue. At 07:00/19:00 Riyadh a round is created once; failed
      // retrievals become due again one minute later, while completed results
      // stay frozen until the following slot.
      if (!event.backgroundStage) ctx.waitUntil(
        (async () => {
          const context = buildContext(env);
          const claimed = await claimScheduledWatchRuns(context, {
            nowMs: event.scheduledTime || Date.now(),
          });
          if (!claimed.runs.length) return;
          const dispatch = createWatchRunDispatcher({
            self: env.SELF,
            ingestSecret: env.INGEST_SECRET,
          });
          let result;
          try {
            result = await dispatch(claimed.runs.map((run) => run.id));
          } catch (err) {
            // If the SELF child itself was unreachable, release the durable
            // claims onto the same +60-second retry cadence. CAS lease tokens
            // make this harmless if the child actually completed first.
            await Promise.all(claimed.runs.map((run) => context.watchRunStore.finish(
              run.id,
              run.leaseToken,
              { resolution: 'provider-error', notes: [`dispatch: ${err?.message || String(err)}`] },
              { retryable: true, nowMs: event.scheduledTime || Date.now() },
            )));
            throw err;
          }
          console.log('brochure-engine scheduled watch round', JSON.stringify({
            slot: claimed.slot.key,
            created: claimed.created,
            claimed: claimed.runs.length,
            completed: result.completed,
            retrying: result.retrying,
            alerted: result.alerted,
          }));
        })().catch((err) => {
          console.error('brochure-engine watch round dispatch', err?.message || String(err));
        }),
      );
      ctx.waitUntil(
        (async () => {
          const context = buildContext(env);
          // Capacity safety outranks background model work for one minute per
          // day. A long-running/stuck manual job must never be able to starve
          // retention indefinitely; it resumes on the next minute tick.
          const scheduledAt = event.scheduledTime || Date.now();
          if (!event.backgroundStage && isD1RetentionTick(scheduledAt)) {
            const pruneReport = await pruneStoredBytes(context);
            console.log('brochure-engine daily D1 retention', JSON.stringify({
              ops: pruneReport.ops?.deleted || 0,
              offers: pruneReport.offersPruned || 0,
              sidecars: pruneReport.offerSidecarsPruned || 0,
              evidence: pruneReport.evidenceCompacted || 0,
              errors: pruneReport.errors,
            }));
            return;
          }
          const today = new Date().toISOString().slice(0, 10);
          // Cron is a recovery watchdog; queue messages drive normal progress.
          if (!event.backgroundStage && env.BACKGROUND_DRAINS) {
            let running = false;
            for (const [stage, store] of [
              ['vision', context.visionJobStore],
              ['verification', context.visionVerificationJobStore],
            ]) {
              const active = await store.get();
              if (active?.status !== 'running') continue;
              running = true;
              if (!active.lease_until || Date.parse(active.lease_until) <= Date.now()) {
                await enqueueBackground(env.BACKGROUND_DRAINS, store, stage);
              }
            }
            if (running) return;
          }
          const job = event.backgroundStage === 'verification'
            ? null : await context.visionJobStore.get();
          if (event.backgroundStage === 'vision' && job?.status !== 'running') return;
          if (!job || job.status !== 'running') {
            const verificationJob = await context.visionVerificationJobStore.get().catch(() => null);
            if (event.backgroundStage && verificationJob?.status !== 'running') return;
            if (!verificationJob || verificationJob.status !== 'running') {
              // The Free plan permits five account cron triggers. The shared
              // one-minute tick services the logical 5/25/45 Stage 2 schedule
              // while preserving Stage 1's independent 10/30/50 trigger.
              const minute = new Date(scheduledAt).getUTCMinutes();
              if (![5, 25, 45].includes(minute)) return;
              if (!context.mistralPools.medium.some((slot) => slot.key)) return;
              const candidates = await context.visionVerificationStore.listPending({
                currentOn: today,
                limit: CPU_SAFE_BACKGROUND_DRAIN.batchSize * CPU_SAFE_BACKGROUND_DRAIN.maxBatches,
              }).catch(() => []);
              if (!candidates.length) return;
              const pending = candidates.length;
              const t0 = Date.now();
              const drain = await runVisionVerificationDrain(
                createVisionVerificationDispatcher({
                  self: env.SELF,
                  ingestSecret: env.INGEST_SECRET,
                }),
                {
                  pending,
                  candidateIds: candidates.map((item) => item.offerId),
                  ...CPU_SAFE_BACKGROUND_DRAIN,
                },
              );
              const resolution = await runDetachedResolution(env);
              console.log('brochure-engine vision verification drain', JSON.stringify({
                pending: drain.pending,
                batches: drain.batches,
                ok: drain.ok,
                failed: drain.failed,
                verified: drain.verified,
                unmatched: drain.unmatched,
              }));
              await context.opsStore.record({
                ts: drain.startedAt,
                action: 'cron:vision-verification',
                origin: 'cron',
                ok: drain.failed === 0 && resolution.ok,
                failed: drain.failed + (resolution.ok ? 0 : 1),
                elapsed_ms: Date.now() - t0,
                error: drain.lines?.find((line) => !line.ok)?.error || resolution.error || null,
                detail: {
                  pending: drain.pending,
                  batches: drain.batches,
                  verified: drain.verified,
                  unmatched: drain.unmatched,
                  providerLimit: drain.providerLimit,
                  providerError: drain.providerError,
                  resolution,
                },
              }).catch(() => {});
              return;
            }
            if (!(await context.visionVerificationJobStore
              .tryLease({ nowMs: Date.now(), leaseMs: VISION_LEASE_MS })
              .catch(() => false))) return;
            const tr = Date.now();
            let verificationCompleted = false;
            try {
              const candidates = await context.visionVerificationStore.listPending({
                currentOn: today,
                limit: CPU_SAFE_BACKGROUND_DRAIN.batchSize * CPU_SAFE_BACKGROUND_DRAIN.maxBatches,
              }).catch(() => []);
              if (!candidates.length) {
                await context.visionVerificationJobStore.update({
                  status: 'done', remaining: 0,
                  finished_at: new Date().toISOString(), lease_until: null,
                }).catch(() => {});
                return;
              }
              const pending = candidates.length;
              const drain = await runVisionVerificationDrain(
                createVisionVerificationDispatcher({
                  self: env.SELF,
                  ingestSecret: env.INGEST_SECRET,
                  tag: 'ops',
                }),
                {
                  pending,
                  candidateIds: candidates.map((item) => item.offerId),
                  ...CPU_SAFE_BACKGROUND_DRAIN,
                  shouldContinue: async () => (await context.visionVerificationJobStore.get())?.status === 'running',
                },
              );
              const resolution = await runDetachedResolution(env, { tag: 'ops' });
              const remaining = await context.visionVerificationStore.countPending(today).catch(() => null);
              const done = remaining != null && remaining <= 0;
              const terminal = terminalProviderFailure(drain);
              // Re-read after the drain: an operator may have stopped the job
              // while this fire was in flight. Never overwrite that stop with
              // the stale `verificationJob` snapshot captured above.
              const currentJob = await context.visionVerificationJobStore.get().catch(() => null);
              if (currentJob?.status === 'running') {
                await context.visionVerificationJobStore.update({
                  status: done ? 'done' : terminal ? 'error' : 'running',
                  processed: remaining == null
                    ? currentJob.processed
                    : Math.max(0, (currentJob.total || 0) - remaining),
                  // Physical column names come from the generic legacy job
                  // schema. The Verification API maps these to `verified` and
                  // `continuingAttempts`; unmatched attempts are never declines.
                  enriched: (currentJob.enriched || 0) + drain.verified,
                  declined: (currentJob.declined || 0) + drain.unmatched,
                  failed: (currentJob.failed || 0) + drain.failed,
                  remaining: remaining == null ? currentJob.remaining : remaining,
                  hops: (currentJob.hops || 0) + drain.batches,
                  last_error: drain.lines?.find((line) => !line.ok)?.error || resolution.error || null,
                  provider_limit: drain.providerLimit || currentJob.provider_limit || null,
                  finished_at: done || terminal ? new Date().toISOString() : null,
                  lease_until: null,
                }).catch(() => {});
              }
              await context.opsStore
                .record({
                  ts: drain.startedAt,
                  action: 'vision-verification',
                  origin: 'ops',
                  ok: drain.failed === 0 && resolution.ok,
                  failed: drain.failed + (resolution.ok ? 0 : 1),
                  elapsed_ms: Date.now() - tr,
                  error: drain.lines?.find((line) => !line.ok)?.error || resolution.error || null,
                  detail: {
                    batches: drain.batches,
                    verified: drain.verified,
                    unmatched: drain.unmatched,
                    remaining,
                    providerLimit: drain.providerLimit,
                    providerError: drain.providerError,
                    resolution,
                  },
                })
                .catch(() => {});
              verificationCompleted = true;
            } finally {
              await context.visionVerificationJobStore.update({ lease_until: null });
              if (verificationCompleted) await enqueueBackground(env.BACKGROUND_DRAINS, context.visionVerificationJobStore, 'verification');
            }
            return;
          }
          if (!context.mistralPools.medium.some((slot) => slot.key)) return;
          // Single-writer: only one fire drains at a time (atomic CAS lease).
          if (!(await context.visionJobStore.tryLease({ nowMs: Date.now(), leaseMs: VISION_LEASE_MS }).catch(() => false))) return;
          const te = Date.now();
          let visionCompleted = false;
          try {
            const candidates = await context.enrichStore.listDebris({
              currentOn: today,
              limit: CPU_SAFE_BACKGROUND_DRAIN.batchSize * CPU_SAFE_BACKGROUND_DRAIN.maxBatches,
            }).catch(() => []);
            if (!candidates.length) {
              await context.visionJobStore
                .update({ status: 'done', remaining: 0, finished_at: new Date().toISOString(), lease_until: null })
                .catch(() => {});
              return;
            }
            const pending = candidates.length;
            const drain = await runEnrichDrain(
              createEnrichDispatcher({ self: env.SELF, ingestSecret: env.INGEST_SECRET, tag: 'ops' }),
              {
                pending,
                candidateIds: candidates.map((offer) => offer.id),
                ...CPU_SAFE_BACKGROUND_DRAIN,
                shouldContinue: async () => (await context.visionJobStore.get())?.status === 'running',
              },
            );
            // Resolution runs in its own SELF child so its CPU is isolated too.
            const resolution = await runDetachedResolution(env, { tag: 'ops' });
            const remaining = await context.enrichStore.countDebris(today).catch(() => null);
            const done = remaining != null && remaining <= 0;
            const terminal = terminalProviderFailure(drain);
            const currentJob = await context.visionJobStore.get().catch(() => null);
            if (currentJob?.status === 'running') {
              await context.visionJobStore
                .update({
                  status: done ? 'done' : terminal ? 'error' : 'running',
                  // total was the queue depth at start; cleared = total − remaining.
                  processed: remaining == null
                    ? currentJob.processed
                    : Math.max(0, (currentJob.total || 0) - remaining),
                  enriched: (currentJob.enriched || 0) + drain.enriched,
                  failed: (currentJob.failed || 0) + drain.failed,
                  remaining: remaining == null ? currentJob.remaining : remaining,
                  hops: (currentJob.hops || 0) + drain.batches,
                  last_error: drain.lines?.find((l) => !l.ok)?.error || resolution.error || null,
                  provider_limit: drain.providerLimit || currentJob.provider_limit || null,
                  finished_at: done || terminal ? new Date().toISOString() : null,
                  lease_until: null,
                })
                .catch(() => {});
            }
            await context.opsStore
              .record({
                ts: drain.startedAt,
                action: 'enrich',
                origin: 'ops',
                ok: drain.failed === 0 && resolution.ok,
                failed: drain.failed + (resolution.ok ? 0 : 1),
                elapsed_ms: Date.now() - te,
                error: drain.lines?.find((l) => !l.ok)?.error || resolution.error || null,
                detail: {
                  job: 'vision',
                  batches: drain.batches,
                  enriched: drain.enriched,
                  remaining,
                  providerLimit: drain.providerLimit,
                  providerError: drain.providerError,
                  resolution,
                },
              })
              .catch(() => {});
            visionCompleted = true;
          } finally {
            await context.visionJobStore.update({ lease_until: null });
            if (visionCompleted) await enqueueBackground(env.BACKGROUND_DRAINS, context.visionJobStore, 'vision');
          }
        })(),
      );
      return;
    }

    // Steady-state vision-enrichment drain (its OWN schedule, 2026-07-19). Vision
    // is an INGESTION step: every new offer passes through it exactly once, then
    // everything downstream (registry, search, history) reads the stored
    // enrichment — no reuse gates in front of Vision (user directive). Each fire
    // is its own invocation/subrequest budget (6 sequential children × 15 ≈ 90
    // offers), 3 fires/hour. Self-limiting (empty queue = one D1 count; newest-
    // first; expired offers leave the queue). Resolution rides each child's
    // /enrich post-step; with the 05:45 Monday maintenance this is the registry-
    // writing set — and it YIELDS to a running Background Vision job (below) so
    // there is never more than one resolution writer (§2 single-writer discipline).
    if (event.cron === '10,30,50 * * * *') {
      // Shadow-mode rollout backfill: bounded, D1-only, and idempotent. It
      // populates the existing extraction_json carrier without a schema
      // migration. The conditional UPDATE cannot overwrite a concurrent fresh
      // enrichment that already wrote rollout metadata.
      ctx.waitUntil(
        (async () => {
          const context = buildContext(env);
          const backfilled = await context.enrichStore.backfillArabicBuilderShadows(200);
          if (backfilled) {
            console.log('brochure-engine Arabic Builder shadow backfill', JSON.stringify({ backfilled }));
          }
        })().catch((err) => {
          console.error('brochure-engine Arabic Builder shadow backfill unavailable', err?.message || String(err));
        }),
      );
      // Vision price fallback: its own waitUntil task and its own key pool, so
      // a Ministral outage can never delay the Vision drain or OCR below.
      // Sequential SELF children (each its own subrequest budget); a child that
      // finds nothing to do, is skipped, or stops ends the fire early.
      ctx.waitUntil(
        (async () => {
          const context = buildContext(env);
          const cfg = context.priceFallback;
          if (!cfg.batches || !context.mistralPools.ministral14.some((slot) => slot.key)) return;
          const dispatch = createPriceFallbackDispatcher({ self: env.SELF, ingestSecret: env.INGEST_SECRET });
          const lines = [];
          for (let i = 0; i < cfg.batches; i += 1) {
            const r = await dispatch(10);
            lines.push({ scanned: r.scanned, accepted: r.accepted, rejected: r.rejected, stopped: r.stopped || null });
            if (r.skipped || r.stopped || !r.scanned) break;
          }
          console.log('brochure-engine price fallback drain', JSON.stringify({ batches: lines.length, lines }));
        })().catch((err) => {
          console.error('brochure-engine price fallback unavailable', err?.message || String(err));
        }),
      );
      // OCR escalation is a separate waitUntil task. Its provider, quota, or
      // authentication failure cannot reject or delay the Vision drain below.
      ctx.waitUntil(
        (async () => {
          const context = buildContext(env);
          if (!context.ocrFallbackEnabled || !context.mistralOcrKey) return;
          const today = new Date().toISOString().slice(0, 10);
          const pending = await context.enrichStore.countPendingOcr(today).catch(() => 0);
          if (pending <= 0) return;
          const drain = await runEnrichDrain(
            createOcrEnrichDispatcher({ self: env.SELF, ingestSecret: env.INGEST_SECRET }),
            { pending, batchSize: 5, maxBatches: 1 },
          );
          console.log('brochure-engine OCR escalation drain', JSON.stringify({
            pending: drain.pending,
            batches: drain.batches,
            ok: drain.ok,
            failed: drain.failed,
          }));
        })().catch((err) => {
          console.error('brochure-engine OCR escalation unavailable', err?.message || String(err));
        }),
      );
      ctx.waitUntil(
        (async () => {
          const context = buildContext(env);
          if (!context.mistralPools.medium.some((slot) => slot.key)) return;
          // Yield to an active Background Vision job — it owns the drain via the
          // 1-minute cron above; running both would double the resolution writer.
          const bgJob = await context.visionJobStore.get().catch(() => null);
          if (bgJob && bgJob.status === 'running') return;
          const te = Date.now();
          const today = new Date().toISOString().slice(0, 10);
          const candidates = await context.enrichStore.listDebris({
            currentOn: today,
            limit: CPU_SAFE_BACKGROUND_DRAIN.batchSize * CPU_SAFE_BACKGROUND_DRAIN.maxBatches,
          }).catch(() => []);
          if (!candidates.length) {
            // Empty vision queue does NOT mean an empty RESOLUTION queue: a
            // data repair / re-opened verdicts can leave unresolved
            // enrichments with nothing left to enrich (2026-07-21 — the
            // brand-veto repair sat undrained because this fire returned here).
            // One daily D1-only safety pass preserves that repair path without
            // paying the current-offer join on all 72 empty Stage 1 fires.
            if (isDailyEmptyResolutionTick(event.scheduledTime || Date.now())) {
              await runDetachedResolution(env);
            }
            return;
          }
          const pending = candidates.length;
          const drain = await runEnrichDrain(
            createEnrichDispatcher({ self: env.SELF, ingestSecret: env.INGEST_SECRET }),
            // The unattended path uses one offer per child. The client-driven
            // live drain remains batch-sized because every click is a separate
            // top-level request and can be stopped by the operator.
            {
              pending,
              candidateIds: candidates.map((offer) => offer.id),
              ...CPU_SAFE_BACKGROUND_DRAIN,
            },
          );
          // This fire only runs when no Background Vision job is active.
          const resolution = await runDetachedResolution(env);
          console.log(
            'brochure-engine enrich drain',
            JSON.stringify({
              pending: drain.pending,
              batches: drain.batches,
              ok: drain.ok,
              failed: drain.failed,
              enriched: drain.enriched,
            }),
          );
          await context.opsStore
            .record({
              ts: drain.startedAt,
              action: 'cron:enrich',
              origin: 'cron',
              ok: drain.failed === 0 && resolution.ok,
              failed: drain.failed + (resolution.ok ? 0 : 1),
              elapsed_ms: Date.now() - te,
              error: drain.lines?.find((l) => !l.ok)?.error || resolution.error || null,
              detail: {
                pending: drain.pending,
                batches: drain.batches,
                enriched: drain.enriched,
                providerLimit: drain.providerLimit,
                providerError: drain.providerError,
                resolution,
              },
            })
            .catch(() => {});
        })(),
      );
      return;
    }

    if (event.cron === '45 5 * * *') {
      ctx.waitUntil(
        (async () => {
          const context = buildContext(env);
          // Registry maintenance (registry/lifecycle.js): §5.1 dormancy sweep,
          // §5.4 conservative consolidation, dangling-sighting healing. WEEKLY
          // (Mondays — the quiet day between the Tue/Wed/Fri pipeline fires),
          // riding this existing fire: pure D1 work, zero subrequests, no
          // new schedule. runMaintenance writes its own ops audit row.
          // Yield to an active Background Vision job (single-writer): a running
          // drain is writing the registry; defer this week's maintenance rather
          // than write concurrently (weekly + non-urgent, so a one-week slip is fine).
          const bgJobM = await context.visionJobStore.get().catch(() => null);
          const bgActive = bgJobM && bgJobM.status === 'running';
          if (new Date().getUTCDay() === 1 && context.registryStore && !bgActive) {
            const maint = await runMaintenance(context).catch((err) => ({ error: err.message }));
            console.log('brochure-engine registry maintain', JSON.stringify({
              dormant: maint.dormant,
              merges: maint.consolidation?.merges,
              healed: maint.healed,
              error: maint.error,
            }));
          }
        })(),
      );
      return;
    }

    ctx.waitUntil(
      (async () => {
        const t0 = Date.now();
        const dispatchStore = createServiceBindingDispatcher({
          self: env.SELF,
          ingestSecret: env.INGEST_SECRET,
        });
        const report = await runFanOut(registry, dispatchStore);
        console.log(
          'brochure-engine cron fan-out',
          JSON.stringify({ dispatched: report.dispatched, ok: report.ok, failed: report.failed }),
        );

        // Price History (Pillar 3) is captured INSIDE each store's ingest
        // child (offers/ingest.js -> recordOfferHistory) — every flyer offer
        // is a price observation, so no separate capture step runs here.
        const ctx = buildContext(env);

        // Watch results are intentionally not re-evaluated during ingest. A
        // completed 07:00/19:00 round is immutable until the next slot.

        // Retention has one permanent owner: the shared 03:00 UTC tick above.
        // Pipeline fan-out used to run the same D1/KV sweep again, making
        // cleanup frequency depend on ingest days and duplicating row reads.

        // Ops Console audit + scheduler heartbeat: the coordinator's summary
        // row (each store's child wrote its own row via /ingest). Best-effort.
        await ctx.opsStore
          .record({
            ts: report.startedAt,
            action: 'cron:fanout',
            origin: 'cron',
            stores: report.dispatched,
            ok: report.failed === 0,
            failed: report.failed,
            elapsed_ms: Date.now() - t0,
            error: report.stores?.find((s) => !s.ok)?.error || null,
            detail: { retention: 'daily-03:00-utc' },
          })
          .catch(() => {});
      })(),
    );
  },
};
export default worker;
