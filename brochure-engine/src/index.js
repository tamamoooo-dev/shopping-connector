// index.js — Cloudflare Worker entry point for the Brochure Engine.
//
// Wires the provider registry and the storage backends into the Core. To add a
// PDF-index store later, import its provider and add one registry line — nothing
// else changes (the collector, pipeline and Core are store-agnostic).
//
// Bindings (wrangler.toml):
//   DB           D1 database   -> MetadataStore (index + history + dedupe)
//   BROCHURES    R2 bucket     -> ObjectStore (preferred, if bound)
//   BROCHURES_KV KV namespace  -> ObjectStore (fallback when R2 is unavailable)
//   INGEST_SECRET  Worker secret guarding POST /ingest
//
// Storage lives behind narrow interfaces (§5), so which object backend is bound
// is invisible to everything above it.

import { handleRequest, ingestAll, pickStalestStore } from './engine.js';
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

  // Cron trigger (§6.3). Runs daily and refreshes ONE store per fire — the
  // stalest (or not-yet-held) one — so each invocation stays within a Worker's
  // 50-subrequest budget (an image-set store downloads up to ~45 subrequests;
  // ingesting all 8 stores at once overflows it). Rotating stale-first means
  // every store is refreshed roughly weekly, which matches brochure cadence,
  // while the pipeline's checksum dedupe keeps re-fetches free of extra writes.
  // Manual `POST /ingest?store=<id>` remains the way to refresh a specific store
  // on demand; `POST /ingest` (all) is best-effort and only fits a paid plan.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const context = buildContext(env);
        const current = await context.metadataStore.listCurrent();
        const store = pickStalestStore(context.registry, current);
        const report = await ingestAll(context, { store });
        console.log('brochure-engine cron ingest', store, JSON.stringify(report.totals));
      })(),
    );
  },
};
