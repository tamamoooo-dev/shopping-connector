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
import { runFanOut, createServiceBindingDispatcher } from './scheduler.js';
import { createD1MetadataStore } from './storage/metadataStore.js';
import { createR2ObjectStore, createKvObjectStore } from './storage/objectStore.js';
import { createPipeline } from './pipeline.js';
import { othaimProvider } from './providers/othaim.js';
import { hyperpandaProvider } from './providers/hyperpanda.js';
import { carrefourProvider } from './providers/carrefour.js';
import { luluProvider } from './providers/lulu.js';
import { danubeProvider } from './providers/danube.js';
import { tamimiProvider } from './providers/tamimi.js';
import { manuelProvider } from './providers/manuel.js';
import { nestoProvider } from './providers/nesto.js';

// M1: Othaim via the official PdfIndexCollector. M2: the other stores via the
// reusable AggregatorCollector (OffersInMe). Adding a store = one import + one
// line; the Core, collectors, adapter, pipeline and storage never change.
const registry = Object.fromEntries(
  [
    othaimProvider,
    hyperpandaProvider,
    carrefourProvider,
    luluProvider,
    danubeProvider,
    tamimiProvider,
    manuelProvider,
    nestoProvider,
  ].map((p) => [p.id, p]),
);

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
  return { registry, objectStore, metadataStore, pipeline, ingestSecret: env.INGEST_SECRET };
}

export default {
  fetch(request, env) {
    return handleRequest(request, buildContext(env));
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
    ctx.waitUntil(
      (async () => {
        const dispatchStore = createServiceBindingDispatcher({
          self: env.SELF,
          ingestSecret: env.INGEST_SECRET,
        });
        const report = await runFanOut(registry, dispatchStore);
        console.log(
          'brochure-engine cron fan-out',
          JSON.stringify({ dispatched: report.dispatched, ok: report.ok, failed: report.failed }),
        );
      })(),
    );
  },
};
