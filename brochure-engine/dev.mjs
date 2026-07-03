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
  createMemoryOfferStore,
  createMemoryWatchStore,
} from './src/storage/local.js';
import { recordPrices, getLowestDoc, createHttpSearchClient, groupVariants } from './src/priceHistory.js';
import { createD4dOffersSource } from './src/offers/d4dOffers.js';
import { ingestOffers } from './src/offers/ingest.js';
import {
  buildOffer,
  deriveNames,
  normalizeText,
  offerRelevance,
  queryTokens,
  relevanceScore,
  isNameMatch,
} from './src/offers/contract.js';
import {
  nameRelevance,
  isRelevantName,
  parseSize as parseSizeM,
  sizeComparable as sizeComparableM,
  productFamily,
  queryFamily,
  categoryFamily,
  offerFamily,
  productType,
  queryType,
} from './src/matching.js';
import { buildWatch, checkWatch, MAX_WATCHES } from './src/monitor.js';
import { pruneStoredBytes } from './src/retention.js';
import { products } from './src/products.js';
import { othaimProvider } from './src/providers/othaim.js';
import { hyperpandaProvider } from './src/providers/hyperpanda.js';
import { carrefourProvider } from './src/providers/carrefour.js';
import { luluProvider } from './src/providers/lulu.js';
import { danubeProvider } from './src/providers/danube.js';
import { tamimiProvider } from './src/providers/tamimi.js';
import { nestoProvider } from './src/providers/nesto.js';
import { d4dStoreProviders } from './src/providers/d4dStores.js';

const DATA_DIR = fileURLToPath(new URL('./.data', import.meta.url));

const PROVIDERS = [
  othaimProvider,
  hyperpandaProvider,
  carrefourProvider,
  luluProvider,
  danubeProvider,
  tamimiProvider,
  nestoProvider,
  ...d4dStoreProviders,
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
    offerStore: createMemoryOfferStore(),
    offersSource: createD4dOffersSource(),
    watchStore: createMemoryWatchStore(),
    notifier: null,
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

  // Page-id capture (flyer-offer deep-link target): D4D tags flyer pages with a
  // data-page-id an offer references via its pageRef. At least some pages must
  // carry it so a tapped offer can open the in-app viewer on ITS page.
  const withPageIds = meta.pages.filter((p) => p.pageId).length;
  console.log('pages carrying a deep-link pageId:', withPageIds, '/', meta.pages.length);
  if (withPageIds === 0) fail(`${store} meta.json pages carry no pageId — flyer-offer deep-links can't jump to the right page`);

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

  // Per-size/variant history: each parsed size keeps its OWN lowest-ever record,
  // so a product-wide MIN can never mix a small pack's low into a big pack's
  // record. Points with no parseable size fall into the 'unsized' bucket.
  const varHistory = [
    { store: 'lulu', edition: '2026-W20', price: 30, name: 'Philadelphia Cream Cheese 500g', observedAt: '2026-03-10' },
    { store: 'panda', edition: '2026-W19', price: 34, name: 'Philadelphia Cream Cheese 500g', observedAt: '2026-02-24' },
    { store: 'lulu', edition: '2026-W10', price: 13, name: 'Philadelphia Cream Cheese 180g', observedAt: '2026-01-05' },
    { store: 'danube', edition: '2026-W15', price: 19, name: 'Philadelphia Cream Cheese 280g', observedAt: '2026-02-08' },
    { store: 'tamimi', edition: '2026-W12', price: 11, name: 'Philadelphia Spreadable', observedAt: '2026-01-20' }, // unsized
  ];
  const variants = groupVariants(varHistory);
  const byLabel = Object.fromEntries(variants.filter((v) => v.label).map((v) => [v.label, v]));
  if (!byLabel['180 g'] || byLabel['180 g'].lowest.price !== 13) fail('variant: 180g record wrong');
  if (!byLabel['280 g'] || byLabel['280 g'].lowest.price !== 19) fail('variant: 280g record wrong');
  if (!byLabel['500 g'] || byLabel['500 g'].lowest.price !== 30 || byLabel['500 g'].lowest.store !== 'lulu') {
    fail('variant: 500g record wrong (should be 30 @ lulu, not the panda 34)');
  }
  const unsized = variants.find((v) => v.key === 'unsized');
  if (!unsized || unsized.lowest.price !== 11) fail('variant: unsized bucket wrong');
  if (variants[variants.length - 1].key !== 'unsized') fail('variant: unsized bucket must sort last');
  console.log('variants:', JSON.stringify(variants.map((v) => ({ label: v.label, low: v.lowest.price }))));

  console.log('✅ Price History verified: brochure-anchored capture, dedupe, lowest (price/where/when), lows only drop, per-variant records.\n');
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

// Structured Offers — OFFLINE + deterministic. Proves the pure contract layer
// (name derivation, price sanity gates, normalization, relevance) and the full
// ingest with a scripted offers source: normalize -> gate -> link-to-held-
// edition -> store -> idempotent re-ingest -> read via /offers.
async function selftestOffers() {
  console.log('=== Structured Offers (contract + ingest + read) ===');

  // (a) pure contract: name derivation from a realistic OCR block.
  const desc =
    '\nlulu hypermarket\nلولو هايبرماركتactivia\nbillions of\nnatural probiotics\nkefir\nأكتيفيا مشروب ألبان\nالكفير ٨٥٠ مل\nactivia kefir probiotic\n850ml\n15.00\n#13.50\n\n';
  const { name, nameAr } = deriveNames(desc, ['LULU Hypermarket', 'لولو هايبرماركت']);
  console.log('derived names:', JSON.stringify({ name, nameAr }));
  if (!name || !name.includes('activia')) fail(`EN name not derived (got '${name}')`);
  if (!nameAr || !/[؀-ۿ]/.test(nameAr)) fail(`AR name not derived (got '${nameAr}')`);
  // A lone short OCR fragment must not become the display name (the "casc"
  // class of debris) — null lets the other language's name carry the card.
  const debris = deriveNames('casc\nفاين مناديل للجيب ١٠ حبات\n2.50', []);
  if (debris.name !== null) fail(`OCR debris kept as EN name (got '${debris.name}')`);
  if (!debris.nameAr) fail('AR name lost alongside the debris guard');

  // (b) gates: no price -> dropped; was<=price -> old_price nulled; Arabic-
  // Indic digits fold in normalization.
  const base = { offerId: '1', description: 'almarai milk 2l\n7.00', validFrom: '2026-06-30', validTo: '2026-07-07' };
  const meta = { store: 's', region: 'central', source: 'test' };
  if (buildOffer({ ...base, price: '0' }, meta) !== null) fail('zero price passed the gate');
  if (buildOffer({ ...base, price: 'abc' }, meta) !== null) fail('non-numeric price passed the gate');
  const flat = buildOffer({ ...base, price: '9.50', wasPrice: '9.50' }, meta);
  if (flat.oldPrice !== null) fail('was==price kept as a strike-through');
  const real = buildOffer({ ...base, price: '9.50', wasPrice: '12.00' }, meta);
  if (real.oldPrice !== 12) fail('real strike-through lost');
  if (normalizeText('٨٥٠ مل') !== '850 مل') fail('Arabic-Indic digits not folded');
  if (relevanceScore(offerRelevance(real, queryTokens('milk'), real.searchText)) <= 0) fail('relevance miss on own text');
  if (relevanceScore(offerRelevance(real, queryTokens('coffee'), real.searchText)) !== 0) fail('irrelevant query matched');
  console.log('contract gates + normalization + relevance ✅');

  // (c) ingest end-to-end with a scripted source (offline).
  const metadataStore = createMemoryMetadataStore();
  const offerStore = createMemoryOfferStore();
  // A held current brochure the offer should LINK to (flyer id 738954).
  await metadataStore.upsert({
    id: 'teststore:central:2026-W27', store: 'teststore', region: 'central', edition: '2026-W27',
    title: 'Weekly', valid_from: '2026-06-30', valid_to: '2026-07-07',
    detected_at: new Date().toISOString(), source_type: 'images',
    source_url: 'https://agg.example/offers/teststore-9/738954/weekly-flyer',
    pdf_url: null, checksum: 'sha256:t', collector: 'd4d', storage_key: 'teststore/central/2026-W27',
  });
  const scriptedSource = {
    name: 'test',
    async listOffers() {
      return [
        { offerId: '101', flyerRef: '738954', price: '13.50', wasPrice: '15.00', description: 'activia kefir 850ml\n15.00', validFrom: '2026-06-30', validTo: '2026-07-07' },
        { offerId: '102', flyerRef: '999999', price: '5.25', description: 'nadec laban 1l', validFrom: '2026-06-30', validTo: '2026-07-07' },
        { offerId: '103', price: '0', description: 'broken row' }, // must be gated out
      ];
    },
  };
  const provider = { id: 'teststore', label: 'Test', regions: { central: { store: 'teststore-9', city: 'riyadh' } } };
  const ictx = { registry: { teststore: provider }, metadataStore, offerStore, offersSource: scriptedSource };
  const r1 = await ingestOffers(ictx, { store: 'teststore' });
  console.log('ingest run1:', JSON.stringify(r1.totals));
  if (r1.totals.fetched !== 3 || r1.totals.stored !== 2 || r1.totals.dropped !== 1) fail('offers ingest counts wrong');
  if (r1.totals.linked !== 1) fail('offer was not linked to the held brochure edition');
  const r2 = await ingestOffers(ictx, { store: 'teststore' });
  if (r2.totals.stored !== 2) fail('offers re-ingest not idempotent (upsert)');

  // (d) read path via the engine router (search + currency filter).
  const rctx = { registry: { teststore: provider }, metadataStore, offerStore, objectStore: createFsObjectStore(DATA_DIR) };
  const read = await readJson(rctx, '/offers?q=kefir');
  console.log('read /offers?q=kefir:', JSON.stringify({ count: read.count, first: read.offers?.[0]?.name, price: read.offers?.[0]?.price }));
  if (read.count !== 1 || read.offers[0].price !== 13.5) fail('offers read/search wrong');
  if (read.offers[0].edition !== '2026-W27') fail('linked edition not exposed');
  if (!read.note) fail('offers read missing the extraction disclaimer');
  const none = await readJson(rctx, '/offers?q=zzznope');
  if (none.count !== 0) fail('nonsense query returned offers');
  console.log('✅ Structured Offers verified: gates, names, linking, idempotence, search, disclaimer.\n');
}

// Retention — OFFLINE + deterministic: metadata is forever, bytes are a rolling
// window. Seeds an old superseded image brochure with stored bytes, prunes,
// and proves: bytes gone, row kept + marked, current brochures untouched,
// re-prune is a no-op, expired offers rows dropped.
async function selftestRetention() {
  console.log('=== Retention (bytes window, metadata forever) ===');
  const objects = new Map();
  const objectStore = {
    async put(key, bytes, { contentType } = {}) { objects.set(key, { bytes, contentType }); },
    async get(key) { return objects.get(key) || null; },
    async delete(key) { objects.delete(key); },
  };
  const metadataStore = createMemoryMetadataStore();
  const offerStore = createMemoryOfferStore();
  const enc = new TextEncoder();

  // An OLD, superseded image brochure (expired far beyond the window)…
  const oldBase = 'brochures/s/central/2026-W01';
  objects.set(`${oldBase}/page00.webp`, { bytes: enc.encode('img0'), contentType: 'image/webp' });
  objects.set(`${oldBase}/meta.json`, {
    bytes: enc.encode(JSON.stringify({ pages: [{ index: 0, imageUrl: `${oldBase}/page00.webp` }] })),
    contentType: 'application/json',
  });
  await metadataStore.upsert({
    id: 's:central:2026-W01', store: 's', region: 'central', edition: '2026-W01', title: null,
    valid_from: '2026-01-01', valid_to: '2026-01-07', detected_at: '2026-01-01T00:00:00Z',
    source_type: 'images', source_url: 'https://agg/old', pdf_url: null,
    checksum: 'sha256:old', collector: 'd4d', storage_key: 's/central/2026-W01',
  });
  // …and a CURRENT one that must be untouched.
  const curBase = 'brochures/s/central/2026-W27';
  objects.set(`${curBase}/page00.webp`, { bytes: enc.encode('cur'), contentType: 'image/webp' });
  await metadataStore.upsert({
    id: 's:central:2026-W27', store: 's', region: 'central', edition: '2026-W27', title: null,
    valid_from: '2026-06-30', valid_to: '2026-07-07', detected_at: new Date().toISOString(),
    source_type: 'images', source_url: 'https://agg/new', pdf_url: null,
    checksum: 'sha256:new', collector: 'd4d', storage_key: 's/central/2026-W27',
  });
  await metadataStore.setCurrent('s', 'central', ['sha256:new'], { supersedeOthers: true });
  // An offers row expired beyond the offers horizon.
  await offerStore.upsertMany([{ id: 'x', store: 's', region: 'central', source: 't', offer_id: '1', price: 1, valid_to: '2025-01-01', detected_at: 'x', search_text: 'old' }]);

  const ctx = { metadataStore, objectStore, offerStore };
  const r1 = await pruneStoredBytes(ctx, { keepDays: 28 });
  console.log('prune run1:', JSON.stringify({ pruned: r1.pruned, deletes: r1.deletes, offersPruned: r1.offersPruned }));
  if (r1.pruned !== 1 || r1.deletes !== 2) fail(`expected 1 row / 2 deletes, got ${r1.pruned}/${r1.deletes}`);
  if (objects.has(`${oldBase}/page00.webp`) || objects.has(`${oldBase}/meta.json`)) fail('old bytes not deleted');
  if (!objects.has(`${curBase}/page00.webp`)) fail('current bytes were deleted');
  const rows = await metadataStore.getHistory('s', 'central');
  const oldRow = rows.find((r) => r.id === 's:central:2026-W01');
  if (!oldRow) fail('pruned ROW was deleted (metadata must be forever)');
  if (!oldRow.pruned_at) fail('pruned row not marked');
  if (r1.offersPruned !== 1) fail('expired offers row not pruned');
  const r2 = await pruneStoredBytes(ctx, { keepDays: 28 });
  if (r2.pruned !== 0 || r2.deletes !== 0) fail('re-prune was not a no-op');
  console.log('✅ Retention verified: bytes pruned, metadata kept+marked, current untouched, idempotent.\n');
}

// LIVE offers leg (part of `selftest`): pull real structured offers for one
// store from D4D, through the SAME ingest the production child invocation
// runs, and read them back through /offers.
async function selftestOffersLive(ctx, store = 'lulu') {
  console.log(`=== Structured Offers LIVE (${store} via D4D) ===`);
  const r = await ingestOffers(ctx, { store });
  const line = r.targets[0];
  console.log('live offers ingest:', JSON.stringify(line ? { fetched: line.fetched, stored: line.stored, dropped: line.dropped, linked: line.linked, errors: line.errors } : r.totals));
  if (!line || line.errors.length) fail(`live offers ingest failed: ${JSON.stringify(line?.errors)}`);
  if (line.stored < 50) fail(`expected a real offer volume, got ${line.stored}`);
  const read = await readJson(ctx, `/offers?store=${store}&region=central&limit=5`);
  if (read.count < 1) fail('live offers not readable back');
  const milk = await readJson(ctx, '/offers?q=milk');
  console.log(`live read: store query -> ${read.count}, q=milk -> ${milk.count}, cheapest match:`, JSON.stringify(milk.offers?.[0] ? { name: milk.offers[0].name, price: milk.offers[0].price, store: milk.offers[0].store } : null));
  console.log(`✅ Structured Offers LIVE verified for ${store}.\n`);
}

// Matching — OFFLINE: the word-boundary + bilingual-synonym relevance that
// fixes the "irrelevant brochure offers" class of bug (e.g. the Arabic query
// "بيض" (eggs) substring-matching "بيضاء" (white) under the old matcher).
async function selftestMatching() {
  console.log('=== Matching (word boundaries, synonyms, size gate) ===');
  // Word-boundary honesty: eggs must NOT match "white" words.
  if (nameRelevance('بصل ابيض طازج', 'بيض') !== 0) fail('بيض matched ابيض (white) — substring bug is back');
  if (nameRelevance('بيض ابيض ٣٠ حبه', 'بيض') <= 0) fail('real eggs name not matched');
  // Bilingual synonym bridge, both directions.
  if (nameRelevance('حليب المراعي طازج 2 لتر', 'milk') <= 0) fail('EN query missed AR milk name');
  if (nameRelevance('Almarai Fresh Milk 2L', 'حليب') <= 0) fail('AR query missed EN milk name');
  // Coverage-milestone additions: colloquial water, household staples, brands.
  if (nameRelevance('مياه نوفا 330 مل', 'مويه') <= 0) fail('مويه missed مياه (colloquial water)');
  if (nameRelevance('Nova Water 40x330ml', 'مويه') <= 0) fail('مويه missed English water');
  if (nameRelevance('فاين مناديل للجيب', 'tissue') <= 0) fail('tissue missed مناديل');
  if (nameRelevance('Pantene Shampoo 400ml', 'شامبو') <= 0) fail('شامبو missed shampoo');
  if (nameRelevance('Tide Detergent 5kg', 'تايد') <= 0) fail('تايد missed Tide (brand transliteration)');
  if (nameRelevance('بيبسي كولا 320 مل', 'pepsi') <= 0) fail('pepsi missed بيبسي');
  // Compound look-alike demoted below the monitor floor, plain product above.
  if (isRelevantName('Milk Chocolate Biscuit 90g', 'milk', 50)) fail('milk chocolate passed the alert gate');
  if (!isRelevantName('Nadec Fresh Milk 2 L', 'milk', 50)) fail('plain milk failed the alert gate');
  // Size parsing + comparability (the grocery alert size gate).
  const two = parseSizeM('Almarai Milk 2 L');
  if (two.unit !== 'ml' || two.total !== 2000) fail('2 L did not parse');
  if (parseSizeM('حليب ٢ لتر').total !== 2000) fail('Arabic-Indic 2 لتر did not parse');
  if (!sizeComparableM(two, parseSizeM('Nadec Milk 1.9 LTR'))) fail('1.9 L not comparable to 2 L');
  if (sizeComparableM(two, parseSizeM('Milk 200 ml'))) fail('200 ml wrongly comparable to 2 L');
  // Offer relevance tiers: name matches rank above text-only matches.
  const t = queryTokens('milk');
  const nameHit = offerRelevance({ name: 'nadec milk 2l', nameAr: null }, t, 'nadec milk 2l fresh');
  const textHit = offerRelevance({ name: 'weekly deal', nameAr: null }, t, 'banner text milk somewhere');
  if (!isNameMatch(nameHit) || isNameMatch(textHit)) fail('name/text tiering broken');
  if (relevanceScore(nameHit) <= relevanceScore(textHit)) fail('name hit does not outrank text hit');
  // Product families (mirrors frontend match.js): derived products belong to
  // the derived family, never the ingredient's; ingredient markers (بال) and
  // the definite article (ال) are handled; brand-only queries have no family.
  if (productFamily('حليب نادك منزوع الدسم 1 لتر') !== 'milk') fail('milk name did not classify as milk');
  if (productFamily('زبادي نادك منزوع الدسم') !== 'yogurt') fail('yogurt name did not classify as yogurt');
  if (productFamily('egg spring roll pastry 550g') !== 'pastry') fail('egg pastry did not classify as pastry');
  if (productFamily('Milk Chocolate Bar 90g') !== 'chocolate') fail('milk chocolate did not classify as chocolate');
  if (productFamily('الحليب الطازج') !== 'milk') fail('definite article not stripped for family');
  if (productFamily('رقايق بالبيض') === 'eggs') fail('ingredient marker بال wrongly classified as eggs');
  if (queryFamily('كيري مربعات') !== null) fail('brand-only query wrongly got a family');
  if (queryFamily('بيض') !== 'eggs') fail('eggs query did not get the eggs family');
  // Category-as-family (retailer-taxonomy signal): a name keyword always wins;
  // the aggregator category is a FALLBACK that recovers a debris-named offer,
  // and only unambiguous categories are mapped.
  if (categoryFamily('eggs') !== 'eggs') fail('eggs category did not map to eggs family');
  if (categoryFamily('chocolates-candies') !== 'chocolate') fail('chocolates category did not map to chocolate');
  if (categoryFamily('milk-laban') !== null) fail('ambiguous milk-laban category should be unmapped');
  if (categoryFamily(null) !== null) fail('null category should be null');
  // offerFamily: name wins over category, category fills a name gap.
  if (offerFamily({ name: 'Milk Chocolate Bar', category: 'chocolates-candies' }) !== 'chocolate') fail('offerFamily name/category disagreement mishandled');
  if (offerFamily({ name: 'casc 18 200ml', category: 'eggs' }) !== 'eggs') fail('offerFamily did not recover debris name via category');
  if (offerFamily({ name: 'random promo', category: 'tea-coffee' }) !== null) fail('offerFamily used an ambiguous category');
  // Product TYPE (the form attribute, mirrors frontend match.js): same family,
  // different form -> different product. A form-less name has a null type.
  if (productType('Herfy Chicken Nuggets 750g') !== 'nuggets') fail('nuggets form not classified');
  if (productType('Herfy Minced Chicken Roll') !== 'mince') fail('minced-roll form not classified');
  if (productType('Fresh Whole Chicken 1kg') !== null) fail('plain chicken wrongly got a form');
  if (queryType('chicken nuggets') !== 'nuggets') fail('query form not read');
  if (queryType('chicken') !== null) fail('bare family query wrongly got a form');
  console.log('✅ Matching verified: boundaries, synonyms, compound gate, size gate, tiering, families, category signal, forms.\n');
}

// Price Monitoring — OFFLINE + deterministic. Proves validation, the relevance
// + size trust gates, cross-source evaluation (online + flyer), crossing
// semantics (one drop -> one alert, re-arm on recovery), product-id matching,
// and the watch API routes end-to-end through the engine router.
async function selftestWatches() {
  console.log('=== Price Monitoring (watches + alerts) ===');

  // (a) validation.
  if (!buildWatch({ kind: 'nope' }).error) fail('bad kind passed validation');
  if (!buildWatch({ kind: 'grocery', query: 'x', targetPrice: 5 }).error) fail('1-char query passed');
  if (!buildWatch({ kind: 'grocery', query: 'milk', targetPrice: -1 }).error) fail('negative target passed');
  if (!buildWatch({ kind: 'product', query: 'iphone', targetPrice: 100 }).error) fail('product watch without provider/id passed');
  const g = buildWatch({ kind: 'grocery', query: 'milk', targetPrice: 9, label: 'Almarai Milk 2 L', sizeText: 'Almarai Milk 2 L' });
  if (g.error) fail(`good grocery watch rejected: ${g.error}`);
  if (g.watch.sizeUnit !== 'ml' || g.watch.sizeTotal !== 2000) fail('reference size not captured');
  console.log('validation ✅');

  // (b) the trust gates + cross-source evaluation + crossing semantics.
  const watchStore = createMemoryWatchStore();
  const offerStore = createMemoryOfferStore();
  const today = new Date().toISOString().slice(0, 10);
  const inWeek = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
  // Current flyer offers: a genuine 2 L milk at 8, a tiny 200 ml at 1 (size
  // gate), and an eggs-vs-white trap row that must never surface for بيض.
  await offerStore.upsertMany([
    { id: 'f1', store: 'othaim', region: 'central', source: 't', offer_id: '1', name: 'nadec fresh milk 2l', name_ar: null, price: 8, currency: 'SAR', valid_from: today, valid_to: inWeek, detected_at: 'x', search_text: 'nadec fresh milk 2l', source_url: 'https://agg/flyer/1' },
    { id: 'f2', store: 'othaim', region: 'central', source: 't', offer_id: '2', name: 'nadec milk 200 ml', name_ar: null, price: 1, currency: 'SAR', valid_from: today, valid_to: inWeek, detected_at: 'x', search_text: 'nadec milk 200 ml' },
    { id: 'f3', store: 'ramez', region: 'central', source: 't', offer_id: '3', name: null, name_ar: 'بصل ابيض', price: 2, currency: 'SAR', valid_from: today, valid_to: inWeek, detected_at: 'x', search_text: 'بصل ابيض طازج' },
  ]);
  // Scripted online results: one relevant 2 L milk at 12, one compound
  // look-alike at 3 (relevance gate), one 200 ml at 1 (size gate), and a 2 L
  // laban at 2 — it passes relevance (لبن is a milk synonym) AND the size gate;
  // only the FAMILY gate can keep a milk watch from alerting on laban.
  let onlineMilkPrice = 12;
  const searchClient = {
    async search(provider, query) {
      if (provider === 'panda' && /milk/.test(query)) {
        return [
          { id: 'p1', name: 'Milk Chocolate Biscuit', price: 3, currency: 'SAR' },
          { id: 'p2', name: 'Almarai Fresh Milk 2 L', price: onlineMilkPrice, currency: 'SAR', link: 'https://panda/milk' },
          { id: 'p3', name: 'Almarai Fresh Milk 200 ml', price: 1, currency: 'SAR' },
          { id: 'p4', name: 'لبن نادك 2 لتر', price: 2, currency: 'SAR' },
        ];
      }
      if (provider === 'amazon' && /echo/.test(query)) {
        return [
          { id: 'B0OTHER', name: 'Echo Dot case', price: 49, currency: 'SAR', link: 'https://amazon.sa/dp/B0OTHER' },
          { id: 'B0TARGET', name: 'Amazon Echo Dot 5', price: 189, currency: 'SAR', link: 'https://amazon.sa/dp/B0TARGET' },
        ];
      }
      return [];
    },
  };
  const notifications = [];
  const mctx = {
    watchStore,
    offerStore,
    searchClient,
    notifier: { async send(n) { notifications.push(n); } },
  };

  const milkWatch = g.watch;
  await watchStore.create(milkWatch);
  const c1 = await checkWatch(mctx, milkWatch);
  // Best trustworthy price: flyer 8 (beats online 12; the 1-SAR rows are size-
  // gated, the 3-SAR compound is relevance-gated, the 2-SAR laban is FAMILY-
  // gated — if this reads 2, the family gate is broken).
  if (c1.price !== 8) fail(`expected best price 8 (flyer), got ${c1.price}`);
  if (c1.status !== 'below-target' || !c1.alerted) fail('crossing to below-target did not alert');
  let alerts = await watchStore.listAlerts({});
  if (alerts.length !== 1 || alerts[0].source !== 'flyer' || alerts[0].store !== 'othaim') fail('alert row wrong');
  if (notifications.length !== 1) fail('notifier not called once');

  // Still below on the next check -> NO second alert.
  const c2 = await checkWatch(mctx, await watchStore.get(milkWatch.id));
  if (c2.alerted) fail('re-alerted while still below target');

  // Price recovers above target -> re-arms; drops again -> ONE new alert.
  await offerStore.upsertMany([{ id: 'f1', store: 'othaim', region: 'central', source: 't', offer_id: '1', name: 'nadec fresh milk 2l', name_ar: null, price: 9.75, currency: 'SAR', valid_from: today, valid_to: inWeek, detected_at: 'x', search_text: 'nadec fresh milk 2l' }]);
  const c3 = await checkWatch(mctx, await watchStore.get(milkWatch.id));
  if (c3.status !== 'above-target' || c3.alerted) fail('recovery above target mishandled');
  await offerStore.upsertMany([{ id: 'f1', store: 'othaim', region: 'central', source: 't', offer_id: '1', name: 'nadec fresh milk 2l', name_ar: null, price: 8.5, currency: 'SAR', valid_from: today, valid_to: inWeek, detected_at: 'x', search_text: 'nadec fresh milk 2l' }]);
  const c4 = await checkWatch(mctx, await watchStore.get(milkWatch.id));
  if (!c4.alerted) fail('second crossing did not alert');
  alerts = await watchStore.listAlerts({});
  if (alerts.length !== 2) fail(`expected 2 alerts total, got ${alerts.length}`);
  console.log('grocery watch: gates + cross-source best + crossing semantics ✅');

  // (c) product watch: the EXACT product by stable id, not the cheaper noise.
  const p = buildWatch({ kind: 'product', query: 'echo dot', targetPrice: 200, provider: 'amazon', productId: 'B0TARGET', label: 'Echo Dot 5' });
  if (p.error) fail(`good product watch rejected: ${p.error}`);
  await watchStore.create(p.watch);
  const cp = await checkWatch(mctx, p.watch);
  if (cp.price !== 189 || !cp.alerted) fail(`product watch matched wrong item (price ${cp.price})`);
  // A vanished product -> no-data, arming state untouched.
  const p2 = buildWatch({ kind: 'product', query: 'echo dot', targetPrice: 10, provider: 'amazon', productId: 'B0GONE' });
  await watchStore.create(p2.watch);
  const cg = await checkWatch(mctx, p2.watch);
  if (cg.status !== 'no-data' || cg.alerted) fail('vanished product mishandled');
  console.log('product watch: id matching + not-found ✅');

  // (d) the API routes through the engine router (create -> read -> check ->
  // alerts -> seen -> delete), with the cap enforced.
  const rctx = { registry: {}, watchStore: createMemoryWatchStore(), offerStore, searchClient, notifier: null, ingestSecret: 'dev' };
  const mk = (body) => new Request('http://local/watches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const created = await (await handleRequest(mk({ kind: 'grocery', query: 'milk', targetPrice: 9, sizeText: '2 L' }), rctx)).json();
  if (!created.watch?.id) fail('POST /watches did not create');
  const bad = await handleRequest(mk({ kind: 'grocery', query: 'm', targetPrice: 9 }), rctx);
  if (bad.status !== 400) fail('invalid watch not rejected');
  const listed = await readJson(rctx, '/watches');
  if (listed.count !== 1 || listed.max !== MAX_WATCHES) fail('GET /watches wrong');
  const checkRes = await handleRequest(new Request('http://local/watches/check', { method: 'POST', headers: { 'X-Ingest-Secret': 'dev' } }), rctx);
  const checkBody = await checkRes.json();
  if (checkBody.checked !== 1 || checkBody.alerted !== 1) fail('POST /watches/check wrong');
  const unguarded = await handleRequest(new Request('http://local/watches/check', { method: 'POST' }), rctx);
  if (unguarded.status !== 403) fail('check runner not guarded');
  const alertsRead = await readJson(rctx, '/alerts?unseen=1');
  if (alertsRead.count !== 1 || alertsRead.unseen !== 1) fail('GET /alerts wrong');
  await handleRequest(new Request('http://local/alerts/seen', { method: 'POST' }), rctx);
  if ((await readJson(rctx, '/alerts?unseen=1')).count !== 0) fail('alerts/seen did not mark');
  const del = await handleRequest(new Request(`http://local/watches?id=${created.watch.id}`, { method: 'DELETE' }), rctx);
  if (del.status !== 200) fail('DELETE /watches failed');
  if ((await readJson(rctx, '/watches')).count !== 0) fail('watch not deleted');
  console.log('watch API routes ✅');
  console.log('✅ Price Monitoring verified: validation, trust gates, cross-source, crossings, product-id, routes.\n');
}

async function selftest() {
  const ctx = buildContext();
  const store = process.argv[3]; // optional: `node dev.mjs selftest <aggregator-store>`
  await selftestM1(ctx);
  await selftestM2(ctx, store || 'lulu');
  await selftestFallback();
  await selftestPriceHistory();
  await selftestOffers();
  await selftestRetention();
  await selftestMatching();
  await selftestWatches();
  await selftestOffersLive(ctx, store || 'lulu');
  console.log('✅ ALL VERIFIED — M1 (PDF), M2 (D4D images), fallback (officialLink), Price History (Pillar 3), Structured Offers (contract+ingest+live), Retention, Matching, Price Monitoring — end-to-end.');
}

if (process.argv[2] === 'selftest') {
  selftest();
} else if (process.argv[2] === 'pricetest') {
  // Just the offline Price History proof (no live network).
  selftestPriceHistory().then(() => console.log('✅ pricetest OK'));
} else if (process.argv[2] === 'offerstest') {
  // Just the offline Offers + Retention proofs (no live network).
  selftestOffers()
    .then(() => selftestRetention())
    .then(() => console.log('✅ offerstest OK'));
} else if (process.argv[2] === 'watchtest') {
  // Just the offline Matching + Price Monitoring proofs (no live network).
  selftestMatching()
    .then(() => selftestWatches())
    .then(() => console.log('✅ watchtest OK'));
} else {
  const ctx = buildContext();
  const PORT = process.env.PORT || 8787;
  http
    .createServer(async (req, res) => {
      // Buffer the request body so JSON POSTs (e.g. /watches) work locally.
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const request = new Request(`http://localhost:${PORT}${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: body.length ? body : undefined,
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
