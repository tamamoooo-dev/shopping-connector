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
import { handleOps } from './ops/console.js';
import {
  runFanOut,
  createServiceBindingDispatcher,
  runWatchFanOut,
  createWatchCheckDispatcher,
  runEnrichDrain,
  createEnrichDispatcher,
} from './scheduler.js';
import { createD1MetadataStore } from './storage/metadataStore.js';
import { createR2ObjectStore, createKvObjectStore } from './storage/objectStore.js';
import { createD1HistoryStore } from './storage/historyStore.js';
import { createD1OfferStore } from './storage/offerStore.js';
import { createD1BrowseStore } from './storage/browseStore.js';
import { createD1WatchStore } from './storage/watchStore.js';
import { createD1OpsStore } from './storage/opsStore.js';
import { createD1EnrichStore } from './storage/enrichStore.js';
import { createD1VisionJobStore } from './storage/visionJobStore.js';
import { createD1RegistryStore } from './storage/registryStore.js';
import { createNtfyNotifier, CHECK_BATCH } from './monitor.js';
import { runMaintenance } from './registry/lifecycle.js';
import { drainResolution } from './registry/drain.js';
import { createPipeline } from './pipeline.js';
import { createServiceBindingSearchClient } from './searchClient.js';
import { createD4dOffersSource } from './offers/d4dOffers.js';
import { pruneStoredBytes } from './retention.js';
import { othaimProvider } from './providers/othaim.js';
import { hyperpandaProvider } from './providers/hyperpanda.js';
import { carrefourProvider } from './providers/carrefour.js';
import { luluProvider } from './providers/lulu.js';
import { danubeProvider } from './providers/danube.js';
import { tamimiProvider } from './providers/tamimi.js';
import { nestoProvider } from './providers/nesto.js';
import { d4dStoreProviders } from './providers/d4dStores.js';

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
  watches: '45 5 * * *', // daily Price Monitoring check (+ Monday registry maintenance)
  enrich: '10,30,50 * * * *', // steady-state vision drain (yields to a background job)
  visionDrain: '* * * * *', // Background Manual Vision: near-continuous drain while a job runs
};

// --- Background Manual Vision (continuous cron-driven drain) --------------------
// The 1-minute `visionDrain` cron drains an operator-started job to empty, paced
// only by Mistral. THROUGHPUT KNOB: children dispatched per fire (each is one
// /enrich?limit=15 ⇒ 15 offers). Production demonstrated ~67 offers/min
// sustained (~8k in 2h), so 4×15 = 60/fire targets that; the children self-throttle
// on Mistral 429s (offers/mistralKeys.js), so this is a ceiling, not a floor.
// Tune this single number if production measurement suggests a better value.
const VISION_DRAIN_BATCHES = 4;
// Single-writer lease held while a fire is draining. It MUST exceed a fire's
// worst-case wall time, else it expires mid-drain and a second fire could write
// concurrently. A K=4 fire is 4 × /enrich?limit=15 (measured ~30–75s each with
// resolution + failover) ⇒ up to ~300s; the active 2-key failover keeps a lone
// 429 from stalling on Retry-After. Keep this comfortably above
// VISION_DRAIN_BATCHES × ~75s if K is raised. A normal fire RELEASES the lease
// on completion (the next tick continues at once); the lease only bounds a
// crashed/stalled fire (≤5-min recovery). Tune alongside VISION_DRAIN_BATCHES.
const VISION_LEASE_MS = 300000;
// Resolution is DECOUPLED from the /enrich children (2026-07-20): each cron
// coordinator runs ONE drainResolution pass after its enrich children finish,
// so the CPU-heavy registry scoring never competes with enrichment in the same
// invocation. 100 is the measured per-invocation ceiling headroom (HISTORY §40).
const RESOLVE_LIMIT = 100;

function buildContext(env) {
  const objectStore = env.BROCHURES
    ? createR2ObjectStore(env.BROCHURES)
    : env.BROCHURES_KV
      ? createKvObjectStore(env.BROCHURES_KV)
      : (() => {
          throw new Error('No object store binding (BROCHURES R2 or BROCHURES_KV).');
        })();
  const metadataStore = createD1MetadataStore(env.DB);
  const pipeline = createPipeline({ objectStore, metadataStore });
  // Price History (Pillar 3) shares this Worker's D1 database. It is harvested
  // from the structured-offers ingest (priceHistory.js) — catalog-wide, no
  // watchlist. The CONNECTOR search client only serves Price Monitoring now.
  const historyStore = createD1HistoryStore(env.DB);
  const searchClient = env.CONNECTOR
    ? createServiceBindingSearchClient({ connector: env.CONNECTOR })
    : null;
  // Structured offers (the price-comparison substrate) share the same D1.
  const offerStore = createD1OfferStore(env.DB);
  const offersSource = createD4dOffersSource();
  // Browse (product discovery, BROWSE-DESIGN.md): a read-only VIEW over the
  // offers + price-history tables — no tables of its own.
  const browseStore = createD1BrowseStore(env.DB);
  // Price Monitoring (watches + alerts) shares the same D1 too. Push delivery
  // is optional: set the NTFY_TOPIC secret to a private ntfy.sh topic and the
  // monitor pushes each alert to the user's phone; absent, alerts are in-app.
  const watchStore = createD1WatchStore(env.DB);
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
  // Background Manual Vision job (Vision Milestone 2 §2): one durable 'active'
  // row the 1-minute `visionDrain` cron updates each fire, so a manual drain
  // runs to empty server-side and its progress survives the browser closing.
  // Shares D1; inert until an operator starts a job.
  const visionJobStore = createD1VisionJobStore(env.DB);
  // Product Registry (REGISTRY-DESIGN.md): products + sightings, shared D1.
  const registryStore = createD1RegistryStore(env.DB);
  return {
    registry,
    objectStore,
    metadataStore,
    pipeline,
    historyStore,
    offerStore,
    offersSource,
    browseStore,
    watchStore,
    notifier,
    searchClient,
    ingestSecret: env.INGEST_SECRET,
    opsStore,
    opsToken: env.OPS_TOKEN,
    enrichStore,
    visionJobStore,
    mistralKey: env.MISTRAL_API_KEY,
    // Optional cold-standby key (offers/mistralKeys.js): when set, the drain
    // fails over to it if the primary becomes unusable (auth/persistent quota).
    // Unset ⇒ single-key chain ⇒ today's exact behavior. Never parallel quota.
    mistralKeyBackup: env.MISTRAL_API_KEY_BACKUP,
    registryStore,
    self: env.SELF,
    crons: CRONS,
  };
}

export default {
  async fetch(request, env) {
    const ctx = buildContext(env);
    // The Operations Console — a hidden, OPS_TOKEN-guarded admin subsystem
    // mounted at /__ops (ops/console.js). Returns null for any other path.
    return (await handleOps(request, ctx)) ?? handleRequest(request, ctx);
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
    // FOUR schedules share this handler (wrangler.toml [triggers]):
    //   • "* * * * *"    — Background Manual Vision continuous drain (below);
    //     a single cheap D1 read unless an operator has a job running.
    //   • "10,30,50 * * * *" — the steady-state vision-enrichment drain (below).
    //   • "45 5 * * *"  — DAILY Price Monitoring: check every active watch.
    //     Fanned out in batches via SELF (each batch gets its own subrequest
    //     budget); kept OUT of the weekly fire so the two never compound
    //     against the per-event invocation caps. Mondays it also runs
    //     registry maintenance.
    //   • "0 6 * * 2,3,5" — the WEEKLY brochure/offers pipeline (fan-out ->
    //     price capture -> retention), unchanged below.
    // Background Manual Vision — the near-continuous drain (1-minute cron). When
    // an operator has a job running, drain a bounded chunk each fire, paced only
    // by Mistral; otherwise this is a single cheap D1 read and out. A D1 LEASE
    // makes it the SOLE active resolution writer: no two fires overlap, and the
    // steady 10/30/50 drain + Monday maintenance both yield to a running job.
    if (event.cron === '* * * * *') {
      ctx.waitUntil(
        (async () => {
          if (!env.MISTRAL_API_KEY) return;
          const context = buildContext(env);
          const job = await context.visionJobStore.get().catch(() => null);
          if (!job || job.status !== 'running') return; // idle: one D1 read, done
          // Single-writer: only one fire drains at a time (atomic CAS lease).
          if (!(await context.visionJobStore.tryLease({ nowMs: Date.now(), leaseMs: VISION_LEASE_MS }).catch(() => false))) return;
          const te = Date.now();
          const today = new Date().toISOString().slice(0, 10);
          const pending = await context.enrichStore.countDebris(today).catch(() => 0);
          if (pending <= 0) {
            await context.visionJobStore
              .update({ status: 'done', remaining: 0, finished_at: new Date().toISOString(), lease_until: null })
              .catch(() => {});
            return;
          }
          const drain = await runEnrichDrain(
            createEnrichDispatcher({ self: env.SELF, ingestSecret: env.INGEST_SECRET, tag: 'ops' }),
            { pending, batchSize: 15, maxBatches: VISION_DRAIN_BATCHES },
          );
          // Decoupled resolution: one D1-only pass in THIS coordinator after the
          // enrichment children (single-writer via the lease we already hold).
          if (context.registryStore) {
            await drainResolution(
              { enrichStore: context.enrichStore, registryStore: context.registryStore },
              { limit: RESOLVE_LIMIT, currentOn: today },
            ).catch(() => {});
          }
          const remaining = await context.enrichStore.countDebris(today).catch(() => null);
          const done = remaining != null && remaining <= 0;
          await context.visionJobStore
            .update({
              status: done ? 'done' : 'running',
              // total was the queue depth at start; cleared = total − remaining.
              processed: remaining == null ? job.processed : Math.max(0, (job.total || 0) - remaining),
              enriched: (job.enriched || 0) + drain.enriched,
              remaining: remaining == null ? job.remaining : remaining,
              hops: (job.hops || 0) + drain.batches,
              last_error: drain.lines?.find((l) => !l.ok)?.error || null,
              finished_at: done ? new Date().toISOString() : null,
              lease_until: null, // release so the next 1-min tick continues at once
            })
            .catch(() => {});
          await context.opsStore
            .record({
              ts: drain.startedAt,
              action: 'enrich',
              origin: 'ops',
              ok: drain.failed === 0,
              failed: drain.failed,
              elapsed_ms: Date.now() - te,
              error: drain.lines?.find((l) => !l.ok)?.error || null,
              detail: { job: 'vision', batches: drain.batches, enriched: drain.enriched, remaining },
            })
            .catch(() => {});
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
      ctx.waitUntil(
        (async () => {
          if (!env.MISTRAL_API_KEY) return;
          const context = buildContext(env);
          // Yield to an active Background Vision job — it owns the drain via the
          // 1-minute cron above; running both would double the resolution writer.
          const bgJob = await context.visionJobStore.get().catch(() => null);
          if (bgJob && bgJob.status === 'running') return;
          const te = Date.now();
          const today = new Date().toISOString().slice(0, 10);
          const pending = await context.enrichStore.countDebris(today).catch(() => 0);
          if (pending <= 0) return;
          const drain = await runEnrichDrain(
            createEnrichDispatcher({ self: env.SELF, ingestSecret: env.INGEST_SECRET }),
            // Vision Milestone 2 §3 — modest steady-state throughput bump (4→6
            // sequential children ≈ 90 offers/fire, ×3 fires/hour ⇒ ~6.5k/day
            // ceiling). Each child is still its own fresh 50-subrequest budget
            // (batchSize 15 = ~30 subrequests), so this stays inside the Free
            // plan; large backlogs use the Background Manual Vision job instead.
            { pending, batchSize: 15, maxBatches: 6 },
          );
          // Decoupled resolution: one D1-only pass here after the enrichment
          // children (children are now enrichment-only). Steady-state stays a
          // single resolution writer — this fire only runs when no Background
          // Vision job is active (yield above).
          if (context.registryStore) {
            await drainResolution(
              { enrichStore: context.enrichStore, registryStore: context.registryStore },
              { limit: RESOLVE_LIMIT, currentOn: today },
            ).catch(() => {});
          }
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
              ok: drain.failed === 0,
              failed: drain.failed,
              elapsed_ms: Date.now() - te,
              error: drain.lines?.find((l) => !l.ok)?.error || null,
              detail: { pending: drain.pending, batches: drain.batches, enriched: drain.enriched },
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
          const t0 = Date.now();
          const watches = await context.watchStore.list({ activeOnly: true });
          if (watches.length) {
            const dispatchBatch = createWatchCheckDispatcher({
              self: env.SELF,
              ingestSecret: env.INGEST_SECRET,
            });
            const report = await runWatchFanOut(
              watches.map((w) => w.id),
              dispatchBatch,
              { batchSize: CHECK_BATCH },
            );
            console.log(
              'brochure-engine watch check',
              JSON.stringify({
                watches: report.watches,
                batches: report.batches,
                ok: report.ok,
                failed: report.failed,
                alerted: report.alerted,
              }),
            );
            // Ops Console audit + scheduler heartbeat (best-effort).
            await context.opsStore
              .record({
                ts: report.startedAt,
                action: 'cron:watches',
                origin: 'cron',
                ok: report.failed === 0,
                elapsed_ms: Date.now() - t0,
                error: report.lines?.find((l) => !l.ok)?.error || null,
                detail: { watches: report.watches, batches: report.batches, alerted: report.alerted },
              })
              .catch(() => {});
          }

          // Registry maintenance (registry/lifecycle.js): §5.1 dormancy sweep,
          // §5.4 conservative consolidation, dangling-sighting healing. WEEKLY
          // (Mondays — the quiet day between the Tue/Wed/Fri pipeline fires),
          // riding the daily fire's tail: pure D1 work, zero subrequests, no
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

        // Retention (see retention.js): metadata is forever, BYTES are a
        // rolling window. Runs in the coordinator (KV/D1 ops don't consume the
        // fetch-subrequest budget); capped per run so the KV daily delete
        // budget is never at risk and a backlog drains across fires.
        const pruneReport = await pruneStoredBytes(ctx);
        console.log(
          'brochure-engine retention',
          JSON.stringify({
            pruned: pruneReport.pruned,
            deletes: pruneReport.deletes,
            offersPruned: pruneReport.offersPruned,
            errors: pruneReport.errors.length,
          }),
        );

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
            detail: { pruned: pruneReport.pruned, offersPruned: pruneReport.offersPruned },
          })
          .catch(() => {});
      })(),
    );
  },
};
