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
import { handleOps } from './src/ops/console.js';
import { createPipeline } from './src/pipeline.js';
import { createAggregatorCollector } from './src/collectors/aggregator.js';
import { createOfficialLinkCollector } from './src/collectors/officialLink.js';
import {
  createFsObjectStore,
  createMemoryMetadataStore,
  createMemoryHistoryStore,
  createMemoryOfferStore,
  createMemoryWatchStore,
  createMemoryOpsStore,
} from './src/storage/local.js';
import { deriveIdentity, recordOfferHistory, getQueryPricesDoc } from './src/priceHistory.js';
import { createHttpSearchClient } from './src/searchClient.js';
import { createD4dOffersSource } from './src/offers/d4dOffers.js';
import { ingestOffers } from './src/offers/ingest.js';
import {
  buildOffer,
  offerToRow,
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
  freshProduceIntent,
  isProcessedProduce,
  producePresence,
  matchStage,
  queryTokenPresence,
  resolveJourneyPool,
  querySize,
  sizeContradicts,
} from './src/matching.js';
import { buildWatch, checkWatch, MAX_WATCHES } from './src/monitor.js';
import { pruneStoredBytes } from './src/retention.js';
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
  // Price History uses a local in-memory store (harvested from the offers
  // ingest, like production). The search connector is reached over HTTP if
  // CONNECTOR_URL is set (e.g. the production connector) — watches only.
  const historyStore = createMemoryHistoryStore();
  const searchClient = process.env.CONNECTOR_URL
    ? createHttpSearchClient(process.env.CONNECTOR_URL)
    : null;
  return {
    registry: Object.fromEntries(PROVIDERS.map((p) => [p.id, p])),
    objectStore,
    metadataStore,
    pipeline: createPipeline({ objectStore, metadataStore }),
    historyStore,
    offerStore: createMemoryOfferStore(),
    offersSource: createD4dOffersSource(),
    watchStore: createMemoryWatchStore(),
    notifier: null,
    searchClient,
    ingestSecret: 'dev',
    // Ops Console locally: http://localhost:8787/__ops (token 'dev-ops' unless
    // OPS_TOKEN is set). No SELF binding here, so multi-store operations use
    // the console's in-process dev fallback.
    opsStore: createMemoryOpsStore(),
    opsToken: process.env.OPS_TOKEN || 'dev-ops',
    self: undefined,
    crons: { pipeline: '0 6 * * 2,3,5', watches: '45 5 * * *' },
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

// Price History (Pillar 3) — catalog-wide, offers-derived. OFFLINE +
// deterministic. Proves: conservative identity derivation (same product
// converges, different size splits, debris is skipped), change-only point
// recording (idempotent re-ingests, unchanged prices add nothing), that the
// lowest-ever survives later higher prices, the stage-gated query read with
// per-variant records (lowest/latest/trend/depth), bilingual reach, the
// /prices route, and the backfill route seeding from stored offers rows.
async function selftestPriceHistory() {
  console.log('=== Price History (catalog-wide, offers-derived) ===');
  const historyStore = createMemoryHistoryStore();

  const offer = (over = {}) => ({
    store: 'lulu', region: 'central',
    name: 'Almarai Fresh Milk 2L', nameAr: 'حليب المراعي 2 لتر',
    price: 10.5, oldPrice: null, currency: 'SAR', category: 'milk-laban',
    imageUrl: null, sourceUrl: 'https://agg/flyer/1',
    validFrom: '2026-06-30', validTo: '2026-07-07', ...over,
  });

  // (a) identity derivation: OCR case/space noise folds to ONE identity; a
  // different size splits; single-token debris and nameless offers derive none.
  const idA = deriveIdentity(offer());
  const idB = deriveIdentity(offer({ name: 'Almarai  fresh MILK 2L' }));
  if (!idA || !idB || idA.id !== idB.id) fail('same product did not derive the same identity');
  const idSmall = deriveIdentity(offer({ name: 'Almarai Fresh Milk 200ml', nameAr: null }));
  if (!idSmall || idSmall.id === idA.id) fail('different size did not split the identity');
  if (deriveIdentity(offer({ name: 'عرض', nameAr: null })) !== null) fail('single-token debris formed an identity');
  if (deriveIdentity(offer({ name: null, nameAr: null })) !== null) fail('nameless offer formed an identity');
  console.log('identity derivation ✅');

  // (b) week 1: first sighting -> identity + point; a concurrent sibling flyer
  // with the same product converges on the BEST advertised price; debris skipped.
  const w1 = await recordOfferHistory(historyStore, [
    offer(),
    offer({ sourceUrl: 'https://agg/flyer/2', price: 9.95 }),
    offer({ name: 'Almarai Fresh Milk 200ml', nameAr: null, price: 2 }),
    offer({ name: 'عرض', nameAr: null }),
  ], { observedAt: '2026-06-30T06:00:00Z' });
  console.log('week 1:', JSON.stringify(w1));
  if (w1.identities !== 2 || w1.points !== 2 || w1.skipped !== 1) fail(`week-1 capture wrong: ${JSON.stringify(w1)}`);

  // Idempotent re-run, same week same price -> zero new points.
  const w1b = await recordOfferHistory(historyStore, [offer({ price: 9.95 })], { observedAt: '2026-06-30T09:00:00Z' });
  if (w1b.points !== 0) fail('same-week same-price re-ingest added a point');

  // (c) week 2: a price DROP records exactly one point; week 3: a RISE records
  // too (history keeps both directions) but the lowest-ever must stay.
  const w2 = await recordOfferHistory(historyStore, [
    offer({ price: 8.75, validFrom: '2026-07-07', validTo: '2026-07-14' }),
    offer({ name: 'Almarai Fresh Milk 200ml', nameAr: null, price: 2, validFrom: '2026-07-07', validTo: '2026-07-14' }),
  ], { observedAt: '2026-07-07T06:00:00Z' });
  if (w2.points !== 1) fail(`price change did not add exactly one point (${w2.points})`);
  const w3 = await recordOfferHistory(historyStore, [
    offer({ price: 12, validFrom: '2026-07-14', validTo: '2026-07-21' }),
  ], { observedAt: '2026-07-14T06:00:00Z' });
  if (w3.points !== 1) fail('price rise not recorded');

  // (d) another store's genuine 2 L milk + a compound look-alike join the
  // pool, plus a token-HEADED name (stage 5): the primary band must merge the
  // brand-led (stage 4) and headed (stage 5) genuine products into ONE
  // history, while the flavour look-alike stays out.
  await recordOfferHistory(historyStore, [
    offer({ store: 'tamimi', name: 'Nadec Fresh Milk 2L', nameAr: 'حليب نادك 2 لتر', price: 9.5, sourceUrl: 'https://agg/t1', validFrom: '2026-07-14', validTo: '2026-07-21' }),
    offer({ store: 'tamimi', name: 'Milk Chocolate Bar 90g', nameAr: null, price: 3, validFrom: '2026-07-14', validTo: '2026-07-21' }),
    offer({ store: 'danube', name: 'Fresh Milk Full Fat 2L', nameAr: null, price: 11, sourceUrl: 'https://agg/d1', validFrom: '2026-07-14', validTo: '2026-07-21' }),
  ], { observedAt: '2026-07-14T06:00:00Z' });

  // (e) the derived read: stage-gated, per-variant, bilingual, all stats derived.
  const doc = await getQueryPricesDoc(historyStore, 'milk', { today: '2026-07-15' });
  console.log('read doc:', JSON.stringify({
    observations: doc.observations, weeks: doc.weeks, firstSeen: doc.firstSeen,
    variants: doc.variants.map((v) => ({ label: v.label, low: v.lowest?.price, trend: v.trend, weeks: v.weeks })),
  }));
  const v2l = doc.variants.find((v) => v.key === 'ml:2000');
  if (!v2l) fail('2 L variant missing');
  if (v2l.lowest.price !== 8.75 || v2l.lowest.store !== 'lulu') fail(`2 L lowest wrong (${JSON.stringify(v2l.lowest)})`);
  if (v2l.lowest.week !== '2026-07-07') fail('2 L lowest week wrong (the WHEN)');
  if (v2l.highest !== 12) fail(`2 L highest wrong (${v2l.highest})`);
  if (v2l.trend !== 'up') fail(`2 L trend should be up (got ${v2l.trend})`);
  if (v2l.weeks < 3) fail(`2 L depth wrong (weeks ${v2l.weeks})`);
  const v200 = doc.variants.find((v) => v.key === 'ml:200');
  if (!v200 || v200.lowest.price !== 2) fail('200 ml variant record wrong');
  if (doc.variants.some((v) => v.lowest && v.lowest.price === 3)) fail('milk chocolate leaked into the milk history (stage gate broken)');
  const latestStores = Object.fromEntries(v2l.latest.map((l) => [l.store, l.price]));
  if (latestStores.lulu !== 12 || latestStores.tamimi !== 9.5) fail(`latest-per-store wrong (${JSON.stringify(latestStores)})`);
  if (latestStores.danube !== 11) fail('primary band split: the token-headed name (stage 5) excluded the brand-led genuine milks');
  if (doc.firstSeen !== '2026-06-30') fail(`firstSeen wrong (${doc.firstSeen})`);
  const docAr = await getQueryPricesDoc(historyStore, 'حليب', { today: '2026-07-15' });
  if (!docAr.variants.find((v) => v.key === 'ml:2000')) fail('Arabic query missed the milk history');
  // Missing history never breaks: a nonsense query is an EMPTY doc, not an error.
  const none = await getQueryPricesDoc(historyStore, 'zzznope', { today: '2026-07-15' });
  if (none.observations !== 0 || none.lowest !== null) fail('nonsense query not an empty doc');
  console.log('derived read: stage gate, variants, lowest/highest/trend/depth, bilingual ✅');

  // (f) the routes: /prices?q= serves the doc (with the disclaimer); backfill
  // seeds the history from offers rows ALREADY stored (guarded).
  const rctx = { registry: {}, historyStore, offerStore: createMemoryOfferStore(), objectStore: createFsObjectStore(DATA_DIR) };
  const road = await readJson(rctx, '/prices?q=milk');
  if (!road.variants?.length || !road.note) fail('/prices route wrong');
  if ((await handleRequest(new Request('http://local/prices'), rctx)).status !== 400) fail('/prices without q not rejected');

  const bStore = createMemoryHistoryStore();
  const bOffers = createMemoryOfferStore();
  await bOffers.upsertMany([offerToRow({ ...offer({ price: 7.5 }), id: 'lulu:central:t:1', source: 't', offerId: '1', flyerRef: null, pageRef: null, edition: null, categoryId: null, detectedAt: '2026-06-30T06:00:00Z', searchText: 'almarai fresh milk 2l' })]);
  const bctx = { registry: { lulu: { id: 'lulu', regions: { central: {} } } }, historyStore: bStore, offerStore: bOffers, ingestSecret: 'dev' };
  const bf = await (await handleRequest(new Request('http://local/prices/backfill?store=lulu', { method: 'POST', headers: { 'X-Ingest-Secret': 'dev' } }), bctx)).json();
  if (!bf.targets?.[0] || bf.targets[0].identities !== 1) fail(`backfill did not seed from offers rows (${JSON.stringify(bf)})`);
  if ((await bStore.counts()).points !== 1) fail('backfill wrote no point');
  const unguarded = await handleRequest(new Request('http://local/prices/backfill', { method: 'POST' }), bctx);
  if (unguarded.status !== 403) fail('backfill not guarded');
  console.log('routes: /prices + guarded backfill ✅');

  console.log('✅ Price History verified: identity gates, change-only points, lows survive rises, stage-gated variant read, routes, backfill.\n');
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
  // Validity dates are RELATIVE to the run date (like selftestWatches): the
  // read path filters on "current today", so hardcoded dates go stale.
  const today = new Date().toISOString().slice(0, 10);
  const inWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

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
  const base = { offerId: '1', description: 'almarai milk 2l\n7.00', validFrom: today, validTo: inWeek };
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
    title: 'Weekly', valid_from: today, valid_to: inWeek,
    detected_at: new Date().toISOString(), source_type: 'images',
    source_url: 'https://agg.example/offers/teststore-9/738954/weekly-flyer',
    pdf_url: null, checksum: 'sha256:t', collector: 'd4d', storage_key: 'teststore/central/2026-W27',
  });
  const scriptedSource = {
    name: 'test',
    async listOffers() {
      return [
        { offerId: '101', flyerRef: '738954', price: '13.50', wasPrice: '15.00', description: 'activia kefir 850ml\n15.00', validFrom: today, validTo: inWeek },
        { offerId: '102', flyerRef: '999999', price: '5.25', description: 'nadec laban 1l', validFrom: today, validTo: inWeek },
        { offerId: '103', price: '0', description: 'broken row' }, // must be gated out
      ];
    },
  };
  const provider = { id: 'teststore', label: 'Test', regions: { central: { store: 'teststore-9', city: 'riyadh' } } };
  const historyStore = createMemoryHistoryStore();
  const ictx = { registry: { teststore: provider }, metadataStore, offerStore, offersSource: scriptedSource, historyStore };
  const r1 = await ingestOffers(ictx, { store: 'teststore' });
  console.log('ingest run1:', JSON.stringify(r1.totals), 'history:', JSON.stringify(r1.targets[0].history));
  if (r1.totals.fetched !== 3 || r1.totals.stored !== 2 || r1.totals.dropped !== 1) fail('offers ingest counts wrong');
  if (r1.totals.linked !== 1) fail('offer was not linked to the held brochure edition');
  // The ingest hook harvests Price History from the same run (Pillar 3).
  if (!r1.targets[0].history || r1.targets[0].history.identities < 1) fail('offers ingest did not record price history');
  const r2 = await ingestOffers(ictx, { store: 'teststore' });
  if (r2.totals.stored !== 2) fail('offers re-ingest not idempotent (upsert)');
  if (r2.targets[0].history.points !== 0) fail('offers re-ingest added duplicate history points');

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
  // 3 deletes: page00.webp + meta.json + hotspots.json (the tap-geometry
  // snapshot rides every images edition since snapshot-at-ingest).
  if (r1.pruned !== 1 || r1.deletes !== 3) fail(`expected 1 row / 3 deletes, got ${r1.pruned}/${r1.deletes}`);
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
  if (parseSizeM('رز بسمتي 5 کجم').total !== 5000) fail('Farsi-kaf کجم (OCR) did not parse');
  if (parseSizeM('حليب 2 لیتر').total !== 2000) fail('Farsi-yeh لیتر (OCR) did not parse');
  if (!sizeComparableM(two, parseSizeM('Nadec Milk 1.9 LTR'))) fail('1.9 L not comparable to 2 L');
  if (sizeComparableM(two, parseSizeM('Milk 200 ml'))) fail('200 ml wrongly comparable to 2 L');
  // Packaging Intelligence (mirrors frontend match.test.mjs): bonus packs
  // ("10+2" = 12 units) and packaging count words (rolls/علب/قرص/…) must give
  // BOTH notations of the same package ONE interpretation, engine-side too —
  // the price-history identity sizeKey and /prices variant buckets depend on it.
  {
    const a = parseSizeM('Uno Kitchen Towels 10+2 Free');
    const b = parseSizeM('Uno Kitchen Towels 12 Rolls');
    if (a.unit !== 'pcs' || a.total !== 12) fail(`bonus 10+2 did not parse to 12 pcs (got ${a.unit}:${a.total})`);
    if (b.unit !== 'pcs' || b.total !== 12) fail(`12 Rolls did not parse to 12 pcs (got ${b.unit}:${b.total})`);
    if (!sizeComparableM(a, b)) fail('10+2 and 12 Rolls not comparable');
  }
  if (parseSizeM('فاين مناديل سوبر 8+2 مجاناً 10 قطع', '10 حبة').total !== 10) fail('bonus 8+2 did not total 10');
  if (parseSizeM('أونو مناديل 12×28 عبوة 10+2 مجانًا 12 قطعة', '12 حبة').total !== 12) fail('bonus did not beat OCR count debris');
  { const s = parseSizeM('عصير برتقال 9+3', '1 لتر'); if (s.unit !== 'ml' || s.pack !== 12 || s.total !== 12000) fail('bonus 9+3 × 1L did not parse as 12 L'); }
  { const s = parseSizeM('عصير 9+3 × 200 مل'); if (s.pack !== 12 || s.total !== 2400) fail('adjacent bonus×size 9+3 × 200 مل misparsed'); }
  { const s = parseSizeM('Omega 3+6+9 Fish Oil'); if (s.total === 9 || s.total === 15) fail('Omega 3+6+9 wrongly read as a pack'); }
  if (parseSizeM('مناديل فاين 40 ورقة (8 رول +2 مجانا)').total !== 10) fail('8 رول +2 did not total 10');
  if (parseSizeM('أونو مناديل مطبخ ١٢ رول').total !== 12) fail('١٢ رول did not parse as a count');
  if (parseSizeM('شاي ليبتون 100 ظرف').total !== 100) fail('100 ظرف did not parse as a count');
  if (parseSizeM('فيري بلاتينم 50 قرص').total !== 50) fail('50 قرص did not parse as a count');
  { const s = parseSizeM('Pepsi 6 cans x 330ml'); if (s.unit !== 'ml' || s.total !== 1980) fail('6 cans x 330ml did not multiply'); }
  if (parseSizeM('شاي 10 أكياس').total !== 10) fail('hamza count word أكياس did not fold');
  if (parseSizeM('مناديل ورقية 500 منديل').unit !== null) fail('inner sheet count wrongly parsed as a package count');
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
  // Produce tier (mirrors frontend match.js): fresh produce is the LOWEST
  // family tier, so paste/jam/flavoured/care look-alikes classify as their
  // derived product in both word orders and never as the produce itself.
  if (productFamily('طماطم طازجه 1 كجم') !== 'tomato') fail('fresh tomatoes did not classify as tomato');
  if (productFamily('معجون طماطم 135 جم') !== 'sauce') fail('tomato paste did not classify as sauce');
  if (productFamily('Tomato Paste 400g') !== 'sauce') fail('EN tomato paste did not classify as sauce');
  if (productFamily('فراولة طازجة 250 جم') !== 'strawberry') fail('fresh strawberry did not classify as strawberry');
  if (productFamily('حليب فراولة 200 مل') !== 'milk') fail('strawberry milk (AR) did not stay milk');
  if (productFamily('Strawberry Milk 180ml') !== 'milk') fail('strawberry milk (EN) did not stay milk');
  if (productFamily('مربى الفراولة 450 جم') !== 'jam') fail('strawberry jam did not classify as jam');
  // D4D flyer OCR emits Farsi yeh (U+06CC) / kaf (U+06A9) inside Arabic names —
  // normalizeText must fold them or lexicon keywords silently miss.
  if (productFamily('مربی بوني ماما فراولة 450 جم') !== 'jam') fail('Farsi-yeh مربی (OCR) did not classify as jam');
  if (productFamily('کیکة الفراولة') !== 'cake') fail('Farsi-kaf کیکة (OCR) did not classify as cake');
  if (!isProcessedProduce('داری فراولة 1 كجم')) fail('Farsi-yeh داری (OCR) not detected as frozen brand');
  if (productFamily('بنكهة الفراولة') !== null) fail('flavour marker wrongly classified as produce');
  if (productFamily('صابون فراولة') !== 'care') fail('strawberry soap did not classify as care');
  if (productFamily('Cherry Tomatoes 250g') !== 'tomato') fail('cherry tomatoes did not stay tomato');
  if (queryFamily('طماطم') !== 'tomato') fail('طماطم query did not get the tomato family');
  if (nameRelevance('Fresh Tomatoes 1kg', 'طماطم') <= 0) fail('طماطم missed EN tomatoes (produce synonym bridge)');
  if (productFamily('جالكسي الفراولة 30غ') !== 'chocolate') fail('galaxy strawberry did not classify as chocolate');
  if (productFamily('سردين بالفلفل الحار وصلصة الطماطم') !== 'fish') fail('sardines in tomato sauce did not stay fish');
  // Fresh-produce intent: a bare produce query names the FRESH product;
  // naming the processing/form in the query switches the intent off.
  if (freshProduceIntent('فراولة') !== 'strawberry') fail('فراولة did not carry fresh intent');
  if (freshProduceIntent('فراولة مجمدة') !== null) fail('فراولة مجمدة wrongly kept fresh intent');
  if (freshProduceIntent('دجاج') !== null) fail('non-produce query wrongly got fresh intent');
  if (!isProcessedProduce('Happy Farm Frozen Strawberry')) fail('frozen marker not detected');
  if (isProcessedProduce('فراولة طازجة 250 جم')) fail('fresh punnet wrongly marked processed');
  if (producePresence('كيس مصاصات بالفراولة', 'strawberry') !== 'flavored') fail('بالفراولة not read as a flavour');
  if (producePresence('فراولة طازجة 250 جم', 'strawberry') !== 'product') fail('fresh strawberries not read as the product');
  if (producePresence('حليب المراعي 2 لتر', 'strawberry') !== null) fail('unrelated name wrongly got a produce presence');
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
  // Search Roadmap stages (mirrors frontend match.js matchStage — the /offers
  // primary sort key). Single word: token-HEADED primary matches first, then
  // other primary matches, then flavour/ingredient look-alikes; multi word:
  // every term mandatory (exact phrase first) before gradual relaxation.
  if (matchStage({ name: 'Fresh Milk Full Fat 1 L' }, 'milk') !== 5) fail('token-headed milk not stage 5');
  if (matchStage({ name: 'Almarai Fresh Milk 1 L' }, 'milk') !== 4) fail('brand-led milk not stage 4');
  if (matchStage({ name: 'Milk Chocolate Bar 90g' }, 'milk') !== 1) fail('milk chocolate not secondary stage');
  // Head-first single-word rule (the ليمون example, as a general rule).
  if (matchStage({ name: 'ليمون اصفر' }, 'ليمون') !== 5) fail('ليمون اصفر not head stage 5');
  if (matchStage({ name: 'الليمون الاخضر' }, 'ليمون') !== 5) fail('الليمون الاخضر not head stage 5');
  if (matchStage({ name: 'كلوروكس ليمون' }, 'ليمون') !== 4) fail('كلوروكس ليمون not trailing stage 4');
  if (matchStage({ name: 'عصير ليمون 1 لتر' }, 'ليمون') !== 1) fail('عصير ليمون not different-family stage 1');
  if (matchStage({ name: 'حليب بنكهة الليمون' }, 'ليمون') !== 1) fail('حليب بنكهة الليمون not flavour stage 1');
  if (matchStage({ name: 'حليب بنكهة الفراولة 200 مل' }, 'حليب') !== 5) fail('flavoured milk lost primary stage for حليب');
  if (matchStage({ name: 'حليب بنكهة الفراولة 200 مل' }, 'فراولة') !== 1) fail('flavour word not secondary for فراولة');
  if (matchStage({ name: 'حليب فراولة 200 مل' }, 'فراولة') !== 1) fail('strawberry milk not secondary for فراولة');
  if (matchStage({ name: 'فراولة طازجة 250 جم' }, 'فراولة') !== 5) fail('fresh strawberries not primary');
  if (matchStage({ name: 'حليب المراعي كامل الدسم 2 لتر' }, 'حليب المراعي') !== 5) fail('exact phrase not stage 5');
  if (matchStage({ name: 'حليب كامل الدسم 2 لتر', brand: 'المراعي' }, 'حليب المراعي') !== 4) fail('brand-completed coverage not stage 4');
  if (matchStage({ name: 'حليب نادك كامل الدسم 2 لتر' }, 'حليب المراعي') !== 1) fail('missing term did not relax to stage 1');
  if (matchStage({ name: 'عصير برتقال 1 لتر' }, 'حليب المراعي') !== 0) fail('unrelated product not stage 0');
  if (queryTokenPresence('فراولة طازجة 250 جم', 'فراولة') !== 'primary') fail('standalone word not primary');
  if (queryTokenPresence('مصاصات بالفراولة', 'فراولة') !== 'secondary') fail('بال-attached not secondary');
  if (queryTokenPresence('حليب المراعي 2 لتر', 'فراولة') !== null) fail('absent token not null');
  // Beverage + substitute look-alikes (found in production 2026-07-16):
  // "Lemon Lime Drink" is a beverage (English mirror of مشروب), a "lemon
  // substitute" names what it replaces — neither is fresh produce.
  if (productFamily('Lemon Lime Drink') !== 'syrup') fail('lemon lime drink did not classify as beverage');
  if (matchStage({ name: 'Lemon Carbonated Soft Drink Can' }, 'ليمون') !== 1) fail('lemon drink not secondary stage');
  if (productFamily('Maqadir Lemon Substitute 1L') === 'lemon') fail('lemon substitute wrongly classified as produce');
  if (matchStage({ name: 'Maqadir Lemon Substitute 1L' }, 'ليمون') !== 1) fail('lemon substitute not secondary stage');
  if (productFamily('مقادير بديل الليمون 1 لتر') === 'lemon') fail('بديل الليمون wrongly classified as produce');
  if (matchStage({ name: 'مقادير بديل الليمون 1 لتر' }, 'ليمون') !== 1) fail('بديل الليمون not secondary stage');

  // The SHARED gate ladder + the declared JOURNEY_POLICY table (HISTORY §34).
  // Mirrors the frontend match.test.mjs ladder block — keep in sync (rule 2).
  const cand = (name, stage, extra = {}) => ({
    name,
    stage,
    family: extra.family !== undefined ? extra.family : productFamily(name),
    type: extra.type !== undefined ? extra.type : productType(name),
    text: name,
    ...extra,
  });
  {
    const lemons = [cand('ليمون اصفر', 5), cand('كلوروكس ليمون', 4)];
    const sum = resolveJourneyPool(lemons, 'ليمون', 'summary');
    if (sum.kept.length !== 1 || sum.kept[0].name !== 'ليمون اصفر') fail('ladder: summary single-word exact stage broken');
    const hist = resolveJourneyPool(lemons, 'ليمون', 'history');
    if (hist.kept.length !== 2) fail('ladder: history did not band stages 5+4 together');
    const withFlavour = [...lemons, cand('حليب بنكهة الليمون', 1, { family: 'milk' })];
    if (resolveJourneyPool(withFlavour, 'ليمون', 'history').kept.length !== 2) fail('ladder: history kept a secondary stage');
  }
  {
    const pool = [cand('حليب المراعي 2 لتر', 4), cand('زبادي نادك', 4), cand('منتج بدون عائلة', 4, { family: null })];
    for (const tier of ['summary', 'alert', 'history']) {
      const r = resolveJourneyPool(pool, 'حليب', tier);
      if (r.kept.length !== 2 || r.familyExcluded !== 1 || !r.kept.some((c) => c.family === null)) {
        fail(`ladder: ${tier} family gate broken (drop yogurt, keep family-less)`);
      }
    }
    const allWrong = [cand('زبادي نادك', 4)];
    if (resolveJourneyPool(allWrong, 'حليب', 'summary').kept.length !== 1) fail('ladder: summary emptied (neverEmpty broken)');
    if (resolveJourneyPool(allWrong, 'حليب', 'history').kept.length !== 1) fail('ladder: history emptied (neverEmpty broken)');
    if (resolveJourneyPool(allWrong, 'حليب', 'alert').kept.length !== 0) fail('ladder: alert did not prefer silence');
  }
  {
    const pool = [
      cand('كيري جبنة مربعات', 3, { family: 'cheese' }),
      cand('كيري جبنة قابلة للدهن', 3, { family: 'cheese' }),
      cand('كيري بسكويت', 3, { family: 'biscuit' }),
    ];
    if (resolveJourneyPool(pool, 'كيري', 'summary').targetFamily !== 'cheese') fail('ladder: summary dominant-family fallback broken');
    if (resolveJourneyPool(pool, 'كيري', 'alert').targetFamily !== 'cheese') fail('ladder: alert dominant-family fallback broken (subset invariant)');
    if (resolveJourneyPool(pool, 'كيري', 'history').targetFamily !== null) fail('ladder: history inferred an unnamed family');
  }
  {
    const pool = [cand('Herfy Chicken Nuggets 750g', 2), cand('Herfy Chicken Roll', 2), cand('Chicken Pieces', 2, { type: null })];
    for (const tier of ['summary', 'alert', 'history']) {
      const r = resolveJourneyPool(pool, 'chicken nuggets', tier);
      if (r.kept.length !== 2 || r.typeExcluded !== 1) fail(`ladder: ${tier} type gate broken`);
    }
  }
  {
    const pool = [
      cand('فراولة طازجة 250 جم', 5),
      cand('مونتانا فراولة مجمدة 1 كجم', 5),
      cand('مصاصات بالفراولة', 5, { family: null }),
    ];
    for (const tier of ['summary', 'alert', 'history']) {
      const r = resolveJourneyPool(pool, 'فراولة', tier);
      if (r.kept.length !== 1 || r.kept[0].name !== 'فراولة طازجة 250 جم') fail(`ladder: ${tier} fresh gate broken`);
    }
    if (resolveJourneyPool(pool.slice(0, 2), 'فراولة مجمدة', 'summary').freshExcluded !== 0) fail('ladder: naming the processing did not disable the fresh gate');
  }
  // Size-aware queries (Search Experience Refinement Task 1, mirrors frontend
  // match.test.mjs): a query-named size is a STRUCTURED filter, never lexical
  // tokens — "Water" finding history while "Arwa Water 1.5L" found none was
  // the size fragments ("1", "5l") failing the AND-word gates in /prices,
  // /offers and the SQL prefilters.
  if (queryTokens('Arwa Water 1.5L').join(' ') !== 'arwa water') fail('queryTokens did not strip the size expression');
  if (queryTokens('مياه اروى ١.٥ لتر').join(' ') !== 'مياه اروي') fail('queryTokens did not strip an Arabic-Indic size');
  if (queryTokens('بيض 30 حبة').join(' ') !== 'بيض') fail('queryTokens did not strip a count expression');
  if (queryTokens('حليب المراعي').join(' ') !== 'حليب المراعي') fail('size-less query tokens changed');
  if (!queryTokens('1.5 لتر').length) fail('size-only query lost all tokens');
  { const s = querySize('Arwa Water 1.5L'); if (!s || s.unit !== 'ml' || s.total !== 1500) fail('querySize did not read 1.5L'); }
  if (querySize('حليب المراعي') !== null) fail('querySize invented a size');
  if (!sizeContradicts(parseSizeM('Arwa Water 330ml'), querySize('Arwa Water 1.5L'))) fail('330ml did not contradict 1.5L');
  if (sizeContradicts(parseSizeM('Arwa Water 1.5 Ltr'), querySize('Arwa Water 1.5L'))) fail('1.5 Ltr wrongly contradicted 1.5L');
  if (sizeContradicts(parseSizeM('Arwa Water'), querySize('Arwa Water 1.5L'))) fail('unknown size wrongly contradicted');
  if (matchStage({ name: 'Arwa Drinking Water 1.5 Ltr' }, 'Arwa Water 1.5L') < 4) fail('exact-size result lost its primary stage');
  if (matchStage({ name: 'Arwa Water 330ml' }, 'Arwa Water 1.5L') !== 1) fail('contradicting size was not capped at stage 1');
  if (matchStage({ name: 'Arwa Water' }, 'Arwa Water 1.5L') !== 5) fail('size-less result was wrongly demoted');
  if (matchStage({ name: 'مياه اروي 1.5 لتر' }, 'Arwa Water 1.5L') < 4) fail('bilingual size query missed the Arabic name');
  if (nameRelevance('Arwa Drinking Water 1.5 Ltr', 'Arwa Water 1.5L') <= 0) fail('size query killed nameRelevance');
  // Per-piece trust ladder (Task 7): weak count suffixes parse for size
  // comparability but are marked, so no per-piece price is advertised on them.
  if (parseSizeM("Indomie Noodles 6's").src !== 'count-weak') fail("6's suffix not marked count-weak");
  if (parseSizeM('بيض ابيض 30 حبة').src !== 'count') fail('count word not marked count');

  {
    // THE SUBSET INVARIANT: for the same candidates, alert kept ⊆ summary kept.
    const pools = [
      [cand('ليمون اصفر', 5), cand('كلوروكس ليمون', 4), cand('عصير ليمون', 1, { family: 'juice' })],
      [cand('حليب المراعي 2 لتر', 4), cand('زبادي نادك', 4)],
      [cand('زبادي نادك', 4)],
      [cand('فراولة طازجة', 5), cand('مونتانا فراولة', 5)],
      [cand('كيري جبنة مربعات', 3, { family: 'cheese' }), cand('كيري بسكويت', 3, { family: 'biscuit' })],
    ];
    const queries = ['ليمون', 'حليب', 'حليب', 'فراولة', 'كيري'];
    pools.forEach((p, i) => {
      const s = new Set(resolveJourneyPool(p, queries[i], 'summary').kept);
      for (const c of resolveJourneyPool(p, queries[i], 'alert').kept) {
        if (!s.has(c)) fail('ladder: alert pool is NOT a subset of the summary pool');
      }
    });
  }
  console.log('✅ Matching verified: boundaries, synonyms, compound gate, size gate, tiering, families, category signal, forms, roadmap stages, journey ladder + policy table.\n');
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

  // (b2) the SHARED-LADDER gates the monitor gained in HISTORY §34 — the two
  // accidental gaps this milestone closed. Stage gate: "كلوروكس ليمون" (a
  // trailing-token primary, stage 4) must never drive a ليمون watch while a
  // true lemon (stage 5) is present — the alert must fire on the lemon's 6,
  // not Clorox's 3. Fresh gate: a bare-produce watch is a FRESH watch — a
  // frozen-brand bag alone yields SILENCE (no-data), never a cheap wrong alert.
  {
    const ladderClient = {
      async search(provider, query) {
        if (provider !== 'panda') return [];
        if (/ليمون/.test(query)) {
          return [
            { id: 'l1', name: 'ليمون اصفر طازج', price: 6, currency: 'SAR' },
            { id: 'l2', name: 'كلوروكس ليمون', price: 3, currency: 'SAR' },
          ];
        }
        if (/فراولة/.test(query)) {
          return [{ id: 's1', name: 'مونتانا فراولة 1 كجم', price: 4, currency: 'SAR' }];
        }
        return [];
      },
    };
    const lctx = { watchStore: createMemoryWatchStore(), offerStore: createMemoryOfferStore(), searchClient: ladderClient, notifier: null };
    const lemon = buildWatch({ kind: 'grocery', query: 'ليمون', targetPrice: 7 }).watch;
    await lctx.watchStore.create(lemon);
    const cl = await checkWatch(lctx, lemon);
    if (cl.price !== 6) fail(`stage gate: ليمون watch read ${cl.price}, expected 6 (Clorox must not drive it)`);
    if (!cl.alerted) fail('stage gate: genuine lemon at 6 under target 7 did not alert');
    const alertRows = await lctx.watchStore.listAlerts({});
    if (alertRows[0].name !== 'ليمون اصفر طازج') fail('stage gate: alert names the wrong product');
    const straw = buildWatch({ kind: 'grocery', query: 'فراولة', targetPrice: 5 }).watch;
    await lctx.watchStore.create(straw);
    const cs = await checkWatch(lctx, straw);
    if (cs.status !== 'no-data' || cs.alerted) fail(`fresh gate: frozen strawberry drove a فراولة watch (${cs.status}, price ${cs.price})`);
    console.log('shared-ladder watch gates: stage + fresh (silence over a wrong product) ✅');
  }

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
        const response = (await handleOps(request, ctx)) ?? (await handleRequest(request, ctx));
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
