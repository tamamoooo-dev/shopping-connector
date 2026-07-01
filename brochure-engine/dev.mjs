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

const DATA_DIR = fileURLToPath(new URL('./.data', import.meta.url));

function buildContext() {
  const objectStore = createFsObjectStore(DATA_DIR);
  const metadataStore = createMemoryMetadataStore();
  return {
    registry: { [othaimProvider.id]: othaimProvider },
    objectStore,
    metadataStore,
    pipeline: createPipeline({ objectStore, metadataStore }),
    ingestSecret: 'dev',
  };
}

async function selftest() {
  const ctx = buildContext();
  const fail = (msg) => {
    console.error('❌ ' + msg);
    process.exit(1);
  };

  console.log('--- run 1: detect -> download -> store -> index ---');
  const r1 = await ingestAll(ctx);
  console.log(JSON.stringify(r1, null, 2));
  if (r1.totals.new !== 1) fail(`expected 1 new brochure, got ${r1.totals.new}`);

  console.log('\n--- run 2: same week -> must dedupe (no re-store) ---');
  const r2 = await ingestAll(ctx);
  console.log(JSON.stringify(r2.totals));
  if (r2.totals.deduped !== 1 || r2.totals.new !== 0) fail('run 2 did not dedupe');

  console.log('\n--- read: GET /brochures?store=othaim&region=central ---');
  const readRes = await handleRequest(
    new Request('http://local/brochures?store=othaim&region=central'),
    ctx,
  );
  const read = await readRes.json();
  console.log(JSON.stringify(read, null, 2));
  const doc = read.brochures?.[0];
  if (!doc) fail('no brochure returned by read API');
  if (doc.store !== 'othaim' || doc.region !== 'central') fail('wrong store/region');
  if (!doc.pdfUrl?.includes('/api/pdfOffers/')) fail('pdfUrl not resolved from index');
  if (!doc.checksum?.startsWith('sha256:')) fail('missing checksum');

  console.log('\n--- asset: GET /asset/brochures/.../original.pdf ---');
  const assetRes = await handleRequest(
    new Request('http://local/asset/brochures/' + doc.storageKey + '/original.pdf'),
    ctx,
  );
  const buf = new Uint8Array(await assetRes.arrayBuffer());
  const magic = new TextDecoder().decode(buf.slice(0, 5));
  console.log('status', assetRes.status, 'content-type', assetRes.headers.get('content-type'),
    'bytes', buf.length, 'magic', JSON.stringify(magic));
  if (assetRes.status !== 200 || magic !== '%PDF-') fail('stored asset is not a served PDF');

  console.log('\n✅ M1 end-to-end verified: detect, download, dedupe, store, index, expose.');
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
