// dev.mjs — local development + end-to-end verification harness.
// NOT part of the deployed Worker.
//
// The Brochure Engine runs on Web APIs (fetch/Request/Response/URL/crypto), all
// global in Node 18+. This adapter injects the LOCAL storage backends (fs +
// in-memory) that implement the same interfaces as R2/D1, so the WHOLE pipeline
// — detect -> download -> dedupe -> store -> index -> expose — runs end-to-end
// against the real Othaim site with zero cloud provisioning.
//
//   node dev.mjs            -> HTTP server on :8787 (local storage)
//   node dev.mjs selftest   -> run the full M1 workflow twice (proves dedupe),
//                              read it back, print a report, exit non-zero on fail

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { handleRequest, ingestAll } from './src/engine.js';
import { createPipeline } from './src/pipeline.js';
import { createFsObjectStore, createMemoryMetadataStore } from './src/storage/local.js';
import { othaimProvider } from './src/providers/othaim.js';
import { hyperpandaProvider } from './src/providers/hyperpanda.js';
import { carrefourProvider } from './src/providers/carrefour.js';
import { luluProvider } from './src/providers/lulu.js';
import { danubeProvider } from './src/providers/danube.js';
import { tamimiProvider } from './src/providers/tamimi.js';
import { manuelProvider } from './src/providers/manuel.js';
import { nestoProvider } from './src/providers/nesto.js';

const DATA_DIR = fileURLToPath(new URL('./.data', import.meta.url));

const PROVIDERS = [
  othaimProvider,
  hyperpandaProvider,
  carrefourProvider,
  luluProvider,
  danubeProvider,
  tamimiProvider,
  manuelProvider,
  nestoProvider,
];

function buildContext() {
  const objectStore = createFsObjectStore(DATA_DIR);
  const metadataStore = createMemoryMetadataStore();
  return {
    registry: Object.fromEntries(PROVIDERS.map((p) => [p.id, p])),
    objectStore,
    metadataStore,
    pipeline: createPipeline({ objectStore, metadataStore }),
    ingestSecret: 'dev',
  };
}

const fail = (msg) => {
  console.error('❌ ' + msg);
  process.exit(1);
};

const readJson = async (ctx, path) => (await handleRequest(new Request('http://local' + path), ctx)).json();

// M1: PdfIndexCollector (Othaim). Proves detect -> download -> dedupe -> store
// -> index -> expose for a PDF source. Scoped to Othaim so it stays a stable
// regression check independent of the M2 aggregator stores.
async function selftestM1(ctx) {
  console.log('=== M1: PdfIndexCollector (Othaim) ===');
  console.log('--- run 1: detect -> download -> store -> index ---');
  const r1 = await ingestAll(ctx, { store: 'othaim' });
  console.log(JSON.stringify(r1.totals));
  if (r1.totals.new !== 1) fail(`expected 1 new Othaim brochure, got ${r1.totals.new}`);

  console.log('--- run 2: same week -> must dedupe (no re-store) ---');
  const r2 = await ingestAll(ctx, { store: 'othaim' });
  console.log(JSON.stringify(r2.totals));
  if (r2.totals.deduped !== 1 || r2.totals.new !== 0) fail('Othaim run 2 did not dedupe');

  const read = await readJson(ctx, '/brochures?store=othaim&region=central');
  const doc = read.brochures?.[0];
  if (!doc) fail('no Othaim brochure returned by read API');
  if (doc.store !== 'othaim' || doc.region !== 'central') fail('wrong store/region');
  if (doc.sourceType !== 'pdf') fail('Othaim sourceType is not pdf');
  if (!doc.pdfUrl?.includes('/api/pdfOffers/')) fail('pdfUrl not resolved from index');
  if (!doc.checksum?.startsWith('sha256:')) fail('missing checksum');

  const assetRes = await handleRequest(
    new Request('http://local/asset/brochures/' + doc.storageKey + '/original.pdf'),
    ctx,
  );
  const buf = new Uint8Array(await assetRes.arrayBuffer());
  const magic = new TextDecoder().decode(buf.slice(0, 5));
  console.log('asset:', assetRes.status, assetRes.headers.get('content-type'), buf.length, 'bytes', JSON.stringify(magic));
  if (assetRes.status !== 200 || magic !== '%PDF-') fail('stored Othaim asset is not a served PDF');
  console.log('✅ M1 verified: detect, download, dedupe, store, index, expose (PDF).\n');
}

// M2: AggregatorCollector (OffersInMe) for one store. Proves the image-set path
// end-to-end: detect leaflet -> download page images -> dedupe -> store each
// page -> index -> expose (meta.json + page asset).
async function selftestM2(ctx, store = 'lulu') {
  console.log(`=== M2: AggregatorCollector (${store}) ===`);
  console.log('--- run 1: detect -> download page images -> store -> index ---');
  const r1 = await ingestAll(ctx, { store });
  console.log(JSON.stringify(r1.targets[0]));
  if (r1.totals.new !== 1) fail(`expected 1 new ${store} brochure, got ${r1.totals.new} (errors: ${JSON.stringify(r1.targets[0]?.errors)})`);

  console.log('--- run 2: same leaflet -> must dedupe (no re-store) ---');
  const r2 = await ingestAll(ctx, { store });
  console.log(JSON.stringify(r2.totals));
  if (r2.totals.deduped !== 1 || r2.totals.new !== 0) fail(`${store} run 2 did not dedupe`);

  const read = await readJson(ctx, `/brochures?store=${store}&region=central`);
  const doc = read.brochures?.[0];
  if (!doc) fail(`no ${store} brochure returned by read API`);
  if (doc.sourceType !== 'images') fail(`${store} sourceType is not images`);
  if (!doc.checksum?.startsWith('sha256:')) fail('missing checksum');
  console.log('doc:', JSON.stringify({ id: doc.id, title: doc.title, validFrom: doc.validFrom, validTo: doc.validTo, sourceUrl: doc.sourceUrl }));

  // pages[] are persisted in the meta.json snapshot (the D1 row projection omits
  // them); read it back and stream the first page image to prove exposure.
  const meta = JSON.parse(
    new TextDecoder().decode(
      new Uint8Array(
        await (await handleRequest(new Request('http://local/asset/brochures/' + doc.storageKey + '/meta.json'), ctx)).arrayBuffer(),
      ),
    ),
  );
  console.log('pages in meta:', meta.pages.length, '| first key:', meta.pages[0]?.imageUrl);
  if (!meta.pages.length) fail(`${store} meta.json has no pages[]`);

  const pageRes = await handleRequest(new Request('http://local/asset/' + meta.pages[0].imageUrl), ctx);
  const pbuf = new Uint8Array(await pageRes.arrayBuffer());
  const ct = pageRes.headers.get('content-type') || '';
  console.log('page0 asset:', pageRes.status, ct, pbuf.length, 'bytes');
  if (pageRes.status !== 200 || !ct.startsWith('image/') || pbuf.length === 0) fail(`${store} page image not served`);
  console.log(`✅ M2 verified: detect, download, dedupe, store, index, expose (images) for ${store}.\n`);
}

async function selftest() {
  const ctx = buildContext();
  const store = process.argv[3]; // optional: `node dev.mjs selftest <aggregator-store>`
  await selftestM1(ctx);
  await selftestM2(ctx, store || 'lulu');
  console.log('✅ ALL VERIFIED — M1 (PDF) and M2 (aggregator images) end-to-end.');
}

if (process.argv[2] === 'selftest') {
  selftest();
} else {
  const ctx = buildContext();
  const PORT = process.env.PORT || 8787;
  http
    .createServer(async (req, res) => {
      const request = new Request(`http://localhost:${PORT}${req.url}`, {
        method: req.method,
        headers: req.headers,
      });
      try {
        const response = await handleRequest(request, ctx);
        const body = Buffer.from(await response.arrayBuffer());
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(body);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    })
    .listen(PORT, () => {
      console.log(`brochure-engine (node dev) -> http://localhost:${PORT}`);
      console.log(`  ingest:  curl -X POST -H "X-Ingest-Secret: dev" http://localhost:${PORT}/ingest`);
      console.log(`  read:    curl "http://localhost:${PORT}/brochures?store=othaim&region=central"`);
    });
}
