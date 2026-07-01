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

import { handleRequest, ingestAll } from './engine.js';
import { createD1MetadataStore } from './storage/metadataStore.js';
import { createR2ObjectStore, createKvObjectStore } from './storage/objectStore.js';
import { createPipeline } from './pipeline.js';
import { othaimProvider } from './providers/othaim.js';

const registry = {
  [othaimProvider.id]: othaimProvider,
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
  return { registry, objectStore, metadataStore, pipeline, ingestSecret: env.INGEST_SECRET };
}

export default {
  fetch(request, env) {
    return handleRequest(request, buildContext(env));
  },

  // Weekly Cron trigger (§6.3): poll every provider/region, dedupe, keep history.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      ingestAll(buildContext(env)).then((report) =>
        console.log('brochure-engine cron ingest', JSON.stringify(report.totals)),
      ),
    );
  },
};
