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
import { createAggregatorCollector } from './src/collectors/aggregator.js';
import { createOfficialLinkCollector } from './src/collectors/officialLink.js';
import {
  createFsObjectStore,
  createMemoryMetadataStore,
  createMemoryPriceStore,
} from './src/storage/local.js';
import { recordPrices, getLowestDoc, createHttpSearchClient } from './src/priceHistory.js';
import { products } from './src/products.js';
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
  // Price History uses a local in-memory store; the search connector is reached
  // over HTTP if CONNECTOR_URL is set (e.g. the production connector), else the
  // read API still works and capture is a no-op.
  const priceStore = createMemoryPriceStore();
  const searchClient = process.env.CONNECTOR_URL
    ? createHttpSearchClient(process.env.CONNECTOR_URL)
    : null;
  return {
    registry: Object.fromEntries(PROVIDERS.map((p) => [p.id, p])),
    objectStore,
    metadataStore,
    pipeline: createPipeline({ objectStore, metadataStore }),
    priceStore,
    products,
    searchClient,
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

// M2: AggregatorCollector (D4D adapter) for one store. Proves the image-set path
// end-to-end: detect leaflets -> download page images (main weekly flyer FIRST,
// within the per-run budget) -> dedupe -> store each page -> index -> expose
// (meta.json + page asset). A store may hold SEVERAL concurrent current flyers;
// runs converge on the full set (already-held flyers cost no downloads).
async function selftestM2(ctx, store = 'lulu') {
  console.log(`=== M2: AggregatorCollector / D4D (${store}) ===`);
  console.log('--- run 1: detect -> download page images (main flyer first) -> store -> index ---');
  const r1 = await ingestAll(ctx, { store });
  console.log(JSON.stringify(r1.targets[0]));
  if (r1.totals.new < 1) fail(`expected >=1 new ${store} brochure, got ${r1.totals.new} (errors: ${JSON.stringify(r1.targets[0]?.errors)})`);
  if (r1.totals.failed) fail(`${store} run 1 had failures: ${JSON.stringify(r1.targets[0]?.errors)}`);

  console.log('--- run 2: held flyers must dedupe (no re-download); remaining siblings may land ---');
  const r2 = await ingestAll(ctx, { store });
  console.log(JSON.stringify(r2.totals));
  if (r2.totals.deduped < 1) fail(`${store} run 2 did not dedupe the already-held flyer`);
  if (r2.totals.failed) fail(`${store} run 2 had failures: ${JSON.stringify(r2.targets[0]?.errors)}`);

  // Converge: each run holds what it already has (deduped) and lands what fits
  // its budget. Live aggregator fetches back-to-back can rate-limit, so allow a
  // few paced runs (the real cron fires days apart) before requiring the fixed
  // point: everything detected is held, nothing new.
  let converged = false;
  for (let i = 3; i <= 7 && !converged; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const r = await ingestAll(ctx, { store });
    console.log(`--- run ${i}:`, JSON.stringify(r.totals));
    if (r.totals.failed) fail(`${store} run ${i} had failures: ${JSON.stringify(r.targets[0]?.errors)}`);
    converged = r.totals.new === 0 && r.totals.deduped === r.totals.detected && r.totals.detected > 0;
  }
  if (!converged) fail(`${store} did not converge on the full current flyer set`);

  const read = await readJson(ctx, `/brochures?store=${store}&region=central`);
  if (!read.brochures?.length) fail(`no ${store} brochure returned by read API`);
  console.log(`current brochures held for ${store}: ${read.count}`);
  // The PRIMARY (main weekly) flyer holds the plain weekly edition; concurrent
  // siblings carry a variant suffix. The primary must exist and be the fullest.
  const doc = read.brochures.find((b) => /^\d{4}-W\d{2}$/.test(b.edition)) || read.brochures[0];
  if (doc.sourceType !== 'images') fail(`${store} sourceType is not images`);
  if (!doc.checksum?.startsWith('sha256:')) fail('missing checksum');
  console.log('primary doc:', JSON.stringify({ id: doc.id, title: doc.title, validFrom: doc.validFrom, validTo: doc.validTo, sourceUrl: doc.sourceUrl }));

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

// Price History (Pillar 3). Deterministic + OFFLINE: an injected scripted
// search client (live store prices fluctuate and would make assertions flaky).
// Proves: brochure-edition anchoring, idempotent weekly capture (dedupe), the
// lowest-ever with the correct WHERE (store) + WHEN (edition), that a later
// LOWER price updates the low, and that a later HIGHER price does NOT.
async function selftestPriceHistory() {
  console.log('=== Price History (Pillar 3) ===');
  const metadataStore = createMemoryMetadataStore();
  const priceStore = createMemoryPriceStore();
  const ctx = { metadataStore, priceStore };

  // One tracked product at one store, so assertions are unambiguous.
  const testProducts = [
    { id: 'milk', query: 'milk', stores: [{ brochureStore: 'lulu', region: 'central', searchProvider: 'lulu' }] },
  ];

  // Seed a "current" brochure edition to anchor to (the brochure IS the history
  // backbone — no edition, no price point).
  const seedEdition = (edition) =>
    metadataStore.upsert({
      id: `lulu:central:${edition}`, store: 'lulu', region: 'central', edition,
      title: null, valid_from: null, valid_to: null, detected_at: new Date().toISOString(),
      source_type: 'images', source_url: null, pdf_url: null,
      checksum: `sha256:seed-${edition}`, collector: 'aggregator', storage_key: `x/${edition}`,
    });

  // Scripted connector: mutate `price` between runs to simulate weekly prices.
  const scripted = { price: 10.5 };
  const searchClient = {
    async search(provider) {
      if (provider !== 'lulu') return [];
      return [{ name: 'Fresh Milk 2L', price: scripted.price, currency: 'SAR', link: 'https://lulu/milk' }];
    },
  };
  const run = () => recordPrices(ctx, { products: testProducts, searchClient });

  // Run 1 — week W27 @ 10.50 -> one new point.
  await seedEdition('2026-W27');
  const r1 = await run();
  console.log('run1:', JSON.stringify({ recorded: r1.recorded, deduped: r1.deduped, skipped: r1.skipped }));
  if (r1.recorded !== 1) fail(`expected 1 recorded, got ${r1.recorded} (errors ${JSON.stringify(r1.errors)})`);

  // Run 2 — same week, must dedupe (idempotent capture).
  const r2 = await run();
  console.log('run2 (same edition):', JSON.stringify({ recorded: r2.recorded, deduped: r2.deduped }));
  if (r2.deduped !== 1 || r2.recorded !== 0) fail('same-week capture did not dedupe');

  let low = await getLowestDoc(priceStore, 'milk');
  console.log('lowest after W27:', JSON.stringify(low));
  if (low.price !== 10.5 || low.store !== 'lulu' || low.edition !== '2026-W27') fail('wrong initial low (price/where/when)');

  // Week W28 — a LOWER price 8.75 -> low updates to W28.
  await seedEdition('2026-W28');
  scripted.price = 8.75;
  const r3 = await run();
  if (r3.recorded !== 1) fail(`W28 not recorded (${JSON.stringify(r3.errors)})`);
  low = await getLowestDoc(priceStore, 'milk');
  console.log('lowest after W28:', JSON.stringify(low));
  if (low.price !== 8.75 || low.edition !== '2026-W28') fail('low did not drop to the cheaper week');

  // Week W29 — a HIGHER price 12.00 -> low must STAY at W28's 8.75.
  await seedEdition('2026-W29');
  scripted.price = 12.0;
  const r4 = await run();
  if (r4.recorded !== 1) fail(`W29 not recorded (${JSON.stringify(r4.errors)})`);
  low = await getLowestDoc(priceStore, 'milk');
  console.log('lowest after W29:', JSON.stringify(low));
  if (low.price !== 8.75 || low.edition !== '2026-W28') fail('low changed on a higher price');

  // A store with no brochure edition is skipped (history is brochure-anchored).
  const noBrochure = await recordPrices(
    { metadataStore, priceStore },
    { products: [{ id: 'x', query: 'x', stores: [{ brochureStore: 'ghost', region: 'central', searchProvider: 'lulu' }] }], searchClient },
  );
  if (noBrochure.skipped !== 1 || noBrochure.recorded !== 0) fail('store without a brochure was not skipped');

  console.log('✅ Price History verified: brochure-anchored capture, dedupe, lowest (price/where/when), lows only drop.\n');
}

// Fallback (Brochure Source Migration): when the aggregator (D4D) has no CURRENT
// brochure — expired or unavailable — the provider's best-first strategies must
// fall through to the officialLink collector, exposing the store's OFFICIAL
// offers page (NEVER another aggregator). Offline + deterministic: no network.
// Proves (a) the aggregator's currency gate rejects an expired flyer, and
// (b) the link brochure is ingested (row indexed, sourceType "link", sourceUrl
// set, NO pages and NO object bytes) and dedupes on re-run.
async function selftestFallback() {
  console.log('=== Fallback: officialLink (aggregator expired / unavailable) ===');

  // (a) currency gate: an EXPIRED aggregator brochure yields nothing so that
  // best-first can fall through (the "expired" half of the rule).
  const expiredAdapter = {
    name: 'd4d',
    async listBrochures() {
      return [
        {
          id: 1, slug: 'old', title: 'Old Flyer',
          validFrom: '2020-01-01', validTo: '2020-01-07',
          pages: ['https://cdn.example/old-1.webp'], sourceUrl: 'https://agg/old',
        },
      ];
    },
  };
  const gated = createAggregatorCollector({ name: 'd4d', adapter: expiredAdapter });
  const cands = await gated.collect({ store: 'x', region: 'central', regionConfig: { store: 'x' } });
  if (cands.length !== 0) fail('currency gate did not reject an expired aggregator brochure');
  console.log('currency gate: expired flyer rejected ✅');

  // (b) end-to-end fallback: an EMPTY aggregator (unavailable) -> officialLink.
  const objectStore = createFsObjectStore(DATA_DIR);
  const metadataStore = createMemoryMetadataStore();
  const pipeline = createPipeline({ objectStore, metadataStore });
  const emptyAggregator = { name: 'd4d', async collect() { return []; } };
  const OFFICIAL_URL = 'https://official-store.example/offers';
  const provider = {
    id: 'teststore', label: 'Test Store',
    regions: { central: { store: 'x', city: 'riyadh', officialUrl: OFFICIAL_URL } },
    strategies: [emptyAggregator, createOfficialLinkCollector()],
  };
  const ctx = { registry: { teststore: provider }, pipeline, metadataStore, objectStore };

  const r1 = await ingestAll(ctx, { store: 'teststore' });
  console.log('run1:', JSON.stringify(r1.totals));
  if (r1.totals.new !== 1) fail(`expected 1 new link brochure, got ${r1.totals.new} (${JSON.stringify(r1.targets[0]?.errors)})`);

  const r2 = await ingestAll(ctx, { store: 'teststore' });
  console.log('run2 (same URL):', JSON.stringify(r2.totals));
  if (r2.totals.deduped !== 1 || r2.totals.new !== 0) fail('link fallback did not dedupe on re-run');

  const read = await readJson(ctx, '/brochures?store=teststore&region=central');
  const doc = read.brochures?.[0];
  if (!doc) fail('no fallback brochure returned by read API');
  if (doc.sourceType !== 'link') fail(`fallback sourceType is '${doc.sourceType}', not 'link'`);
  if (doc.sourceUrl !== OFFICIAL_URL) fail(`fallback sourceUrl is '${doc.sourceUrl}'`);
  if (doc.pages.length) fail('a link brochure must have no pages');
  // A link brochure writes NO object bytes — its storage prefix must be empty.
  const asset = await handleRequest(new Request('http://local/asset/brochures/' + doc.storageKey + '/meta.json'), ctx);
  if (asset.status !== 404) fail('a link brochure must not write object bytes (meta.json)');
  console.log('fallback doc:', JSON.stringify({ id: doc.id, sourceType: doc.sourceType, sourceUrl: doc.sourceUrl }));
  console.log('✅ Fallback verified: currency gate + aggregator-empty -> officialLink link brochure (no bytes), deduped.\n');
}

async function selftest() {
  const ctx = buildContext();
  const store = process.argv[3]; // optional: `node dev.mjs selftest <aggregator-store>`
  await selftestM1(ctx);
  await selftestM2(ctx, store || 'lulu');
  await selftestFallback();
  await selftestPriceHistory();
  console.log('✅ ALL VERIFIED — M1 (PDF), M2 (D4D images), fallback (officialLink), Price History (Pillar 3) end-to-end.');
}

if (process.argv[2] === 'selftest') {
  selftest();
} else if (process.argv[2] === 'pricetest') {
  // Just the offline Price History proof (no live network).
  selftestPriceHistory().then(() => console.log('✅ pricetest OK'));
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
