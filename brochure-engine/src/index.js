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
} from './scheduler.js';
import { createD1MetadataStore } from './storage/metadataStore.js';
import { createR2ObjectStore, createKvObjectStore } from './storage/objectStore.js';
import { createD1HistoryStore } from './storage/historyStore.js';
import { createD1OfferStore } from './storage/offerStore.js';
import { createD1WatchStore } from './storage/watchStore.js';
import { createD1OpsStore } from './storage/opsStore.js';
import { createNtfyNotifier, CHECK_BATCH } from './monitor.js';
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
  watches: '45 5 * * *', // daily Price Monitoring check
};

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
  return {
    registry,
    objectStore,
    metadataStore,
    pipeline,
    historyStore,
    offerStore,
    offersSource,
    watchStore,
    notifier,
    searchClient,
    ingestSecret: env.INGEST_SECRET,
    opsStore,
    opsToken: env.OPS_TOKEN,
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
    // TWO schedules share this handler (wrangler.toml [triggers]):
    //   • "45 5 * * *"  — DAILY Price Monitoring: check every active watch.
    //     Fanned out in batches via SELF (each batch gets its own subrequest
    //     budget); kept OUT of the weekly fire so the two never compound
    //     against the per-event invocation caps.
    //   • "0 6 * * 2,3" — the WEEKLY brochure/offers pipeline (fan-out ->
    //     price capture -> retention), unchanged below.
    if (event.cron === '45 5 * * *') {
      ctx.waitUntil(
        (async () => {
          const context = buildContext(env);
          const t0 = Date.now();
          const watches = await context.watchStore.list({ activeOnly: true });
          if (!watches.length) return;
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
