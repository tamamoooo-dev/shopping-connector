// registry/pipeline.test.mjs — offline, dependency-free tests for the
// vision-canonical /offers path and the resolution drain. Run with:
//   node brochure-engine/src/registry/pipeline.test.mjs   (repo root)
//
// Guards the milestone's promises:
//  • drainResolution processes every unresolved enrichment EXACTLY once:
//    servable reads resolve through the four outcomes, non-servable ones are
//    stamped with their defer verdict, re-runs scan nothing (§3.1 + §1.3),
//  • cross-week wobble converges to one product through the drain itself,
//  • /offers is vision-canonical (2026-07-21): servable vision reads feed
//    matching/display through the ONE gate (a vision-only match that OCR
//    cannot see IS found), unenriched offers serve their OCR extraction
//    fallback, results carry registry productId annotation, and the retired
//    ?pipeline / ?compare params are inert,
//  • /resolve is secret-guarded; /registry/stats serves the §8 aggregates.

import { drainResolution } from './drain.js';
import { handleRequest } from '../engine.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

// --- twins ----------------------------------------------------------------------

// Registry store twin — the shared in-memory twin (memstore.js).
import { createMemRegistryStore as memRegistry } from './memstore.js';

// Enrichment store twin for the drain: joined offer+enrichment rows with
// mint_verdict bookkeeping.
function memEnrichFeed(rows) {
  const verdicts = new Map();
  return {
    _verdicts: verdicts,
    async reindexMatchText() { return 0; },
    async listUnresolved({ limit = 50 } = {}) {
      return rows.filter((r) => !verdicts.has(r.id)).slice(0, limit);
    },
    async setVerdicts(pairs) {
      for (const { id, verdict } of pairs) verdicts.set(id, verdict);
    },
  };
}

const feedRow = (id, over = {}) => ({
  id, store: 'othaim', region: 'riyadh', source: 'd4d', category: 'oil-ghee',
  search_text: 'halah sunflower oil ocr', price: 21.9, old_price: null,
  valid_from: '2026-07-08', detected_at: '2026-07-08T06:00:00Z',
  e_name: 'Halah Pure Sunflower Oil', e_name_ar: null, e_brand: 'Halah',
  e_size: '1.5L x 2', e_corroboration: 0.9, ...over,
});

// --- resolution drain -----------------------------------------------------------
console.log('drainResolution:');
{
  const registry = memRegistry();
  const feed = memEnrichFeed([
    feedRow('o:w1'),
    feedRow('o:w2', {
      valid_from: '2026-07-15', search_text: 'sunflower oil halah ocr w2',
      e_name: 'Sunflower Oil Halah', price: 20.9,
    }),
    feedRow('o:shaky', { e_corroboration: 0.1, e_name: 'Hallucinated Thing' }),
    feedRow('o:decl', { e_name: null, e_name_ar: null }),
  ]);
  const rep = await drainResolution({ enrichStore: feed, registryStore: registry }, { limit: 50, currentOn: '2026-07-18' });
  check('scanned all four', rep.scanned === 4);
  check('wobble pair converged: 1 created + 1 attached, ONE product',
    rep.created === 1 && rep.attached === 1 && registry._products.size === 1);
  check('defer verdicts stamped, sightings only for resolved',
    rep.deferred === 2 && registry._sightings.size === 2);
  check('verdict counters (§3.1)',
    rep.verdicts.minted === 2 && rep.verdicts.low_corroboration === 1 && rep.verdicts.declined === 1);
  check('every row stamped exactly once', feed._verdicts.size === 4);

  const rep2 = await drainResolution({ enrichStore: feed, registryStore: registry }, { limit: 50, currentOn: '2026-07-18' });
  check('re-run scans nothing (processed exactly once)', rep2.scanned === 0);
}

// --- drainResolution D1 memoization (2026-07-20 free-plan-budget fix) ------------
// The per-offer D1 fan-out is what blows the per-invocation subrequest budget.
// Two cheap, behaviour-preserving cuts: snapshot the batch-invariant productCount
// ONCE per drain (not per offer), and reuse the product row the resolver already
// fetched on the attach path instead of a second getProducts. This guards both.
console.log('drainResolution memoization:');
{
  const base = memRegistry();
  const n = { productCount: 0, getProducts: 0 };
  const registry = new Proxy(base, {
    get(t, k) {
      if (k === 'productCount') return async () => { n.productCount += 1; return base.productCount(); };
      if (k === 'getProducts') return async (ids) => { n.getProducts += 1; return base.getProducts(ids); };
      return t[k];
    },
  });
  // The same wobble pair as above: 1 create + 1 attach — the attach exercises the
  // product-reuse path (create takes no candidates, so it never fetches).
  const feed = memEnrichFeed([
    feedRow('mm:1'),
    feedRow('mm:2', {
      valid_from: '2026-07-15', search_text: 'sunflower oil halah ocr w2',
      e_name: 'Sunflower Oil Halah', price: 20.9,
    }),
  ]);
  const rep = await drainResolution({ enrichStore: feed, registryStore: registry }, { limit: 50, currentOn: '2026-07-18' });
  check('memo setup still converges (1 create + 1 attach, one product)',
    rep.created === 1 && rep.attached === 1 && base._products.size === 1);
  check('productCount snapshotted ONCE per drain, not once per offer',
    n.productCount === 1, `productCount calls=${n.productCount}`);
  // Old path: the attach re-fetched the winner via getProducts (2 total — one in
  // resolveRead, one in applyDecision). Reuse drops it to the single resolveRead
  // fetch; the create offer fetches nothing (no candidates).
  check('attach reuses the resolver-fetched product (no second getProducts)',
    n.getProducts === 1, `getProducts calls=${n.getProducts}`);
}

// --- /offers vision-canonical path ------------------------------------------------
console.log('/offers vision-canonical:');
{
  // Rows as the vision-canonical offerStore.search returns them: offers
  // columns + the aliased e_* enrichment columns (ENRICH_ROW_COLS).
  const offerRow = (id, over = {}) => ({
    id, store: 's', region: 'central', source: 'd4d', offer_id: id,
    flyer_ref: null, page_ref: null, edition: null, name: null, name_ar: null,
    price: 9.99, old_price: null, currency: 'SAR', category_id: null,
    category: null, image_url: 'http://c/i.jpg', source_url: null,
    valid_from: null, valid_to: '2099-01-01', detected_at: 'now',
    search_text: 'unrelated ocr junk', identity: null, brand_slug: null,
    e_name: null, e_name_ar: null, e_match_text: null, e_corroboration: null,
    ...over,
  });
  // Three offers:
  //   o:visonly — OCR name unrelated, servable VISION read matches "berain"
  //               (the case OCR alone could never find),
  //   o:ocr     — plain OCR offer matching "berain", no enrichment (the
  //               extraction fallback),
  //   o:shaky   — below-floor corroboration: vision names must NOT serve.
  const rows = [
    offerRow('o:visonly', {
      name: 'Some OCR Name', search_text: 'entirely different text',
      e_name: 'Berain Water Bottle', e_corroboration: 0.9, e_match_text: 'berain water bottle',
    }),
    offerRow('o:ocr', { name: 'Berain Water Carton', search_text: 'berain water carton' }),
    offerRow('o:shaky', {
      name: 'Berain Cartons OCR', search_text: 'berain cartons ocr',
      e_name: 'Hallucinated Thing', e_corroboration: 0.1, e_match_text: 'hallucinated thing',
    }),
  ];
  const registry = memRegistry();
  registry._sightings.set('o:visonly', { product_id: 'pr_bw', match_band: 'auto' });
  const ctx = {
    registry: {},
    offerStore: { search: async () => rows },
    registryStore: registry,
  };

  const res = await (await handleRequest(new Request('http://x/offers?q=berain'), ctx)).json();
  check('no top-level pipeline field (one canonical path)', !('pipeline' in res));
  const vo = res.offers.find((o) => o.id === 'o:visonly');
  check('vision-only match IS found, vision name served, flagged enriched',
    vo && vo.name === 'Berain Water Bottle' && vo.enriched === true && !('pipeline' in vo));
  check('registry productId annotated', vo && vo.productId === 'pr_bw' && vo.matchBand === 'auto');
  const oc = res.offers.find((o) => o.id === 'o:ocr');
  check('unenriched offer serves its OCR extraction fallback', oc && oc.name === 'Berain Water Carton' && !oc.enriched);
  const sh = res.offers.find((o) => o.id === 'o:shaky');
  check('below-floor read never serves: OCR name kept (the ONE servable gate)',
    sh && sh.name === 'Berain Cartons OCR' && !sh.enriched);

  // The retired evaluation params are inert: identical payloads.
  const p1 = await (await handleRequest(new Request('http://x/offers?q=berain&pipeline=ocr'), ctx)).json();
  const p2 = await (await handleRequest(new Request('http://x/offers?q=berain&compare=1'), ctx)).json();
  check('?pipeline and ?compare are inert',
    JSON.stringify(p1) === JSON.stringify(res) && JSON.stringify(p2) === JSON.stringify(res));
}

// --- /offers canonical sibling expansion (2026-07-21) -----------------------------
// A query that lexically matched one retailer's offer surfaces the SAME
// canonical product at other retailers, even a sibling whose extracted name is
// generic ("Milk") and can never match the query text.
console.log('/offers canonical siblings:');
{
  const offerRow = (id, over = {}) => ({
    id, store: 's', region: 'central', source: 'd4d', offer_id: id,
    flyer_ref: null, page_ref: null, edition: null, name: null, name_ar: null,
    price: 9.99, old_price: null, currency: 'SAR', category_id: null,
    category: null, image_url: 'http://c/i.jpg', source_url: null,
    valid_from: null, valid_to: '2099-01-01', detected_at: 'now',
    search_text: 'x', identity: null, brand_slug: null,
    e_name: null, e_name_ar: null, e_match_text: null, e_corroboration: null,
    ...over,
  });
  const matched = offerRow('o:farm', {
    store: 'farm', name: 'NADEC UHT Milk', search_text: 'nadec uht milk', price: 19.99,
    brand_slug: 'nadec',
  });
  const sibling = offerRow('o:othaim', {
    store: 'othaim', name: 'Milk', search_text: 'milk', price: 18.99, brand_slug: 'nadec',
  });
  // A polluted sighting: different brand under the same productId (the live
  // Al Safi-on-Nadec case) — the brand guard must refuse it.
  const impostor = offerRow('o:alsafi', {
    store: 'nesto', name: 'Al Safi Milk', search_text: 'al safi milk', price: 52.99,
    brand_slug: 'alsafi',
  });
  const registry = memRegistry();
  registry._sightings.set('o:farm', { product_id: 'pr_m', match_band: 'review' });
  registry._sightings.set('o:othaim', { product_id: 'pr_m', match_band: 'review' });
  registry._sightings.set('o:alsafi', { product_id: 'pr_m', match_band: 'review' });
  registry.sightingsForProducts = async (pids) =>
    [...registry._sightings.entries()]
      .filter(([, s]) => pids.includes(s.product_id))
      .map(([offer_id, s]) => ({ offer_id, ...s }));
  const ctx = {
    registry: {},
    offerStore: {
      search: async () => [matched],
      getByIds: async (ids) => [sibling, impostor].filter((r) => ids.includes(r.id)),
    },
    registryStore: registry,
  };
  const res = await (await handleRequest(new Request('http://x/offers?q=nadec'), ctx)).json();
  const sib = res.offers.find((o) => o.id === 'o:othaim');
  check('sibling appended with its true price + productId', sib && sib.price === 18.99 && sib.productId === 'pr_m');
  check('sibling flagged as identity-reached', sib && sib.canonicalSibling === true);
  check('lexically-matched offer still ranks first', res.offers[0].id === 'o:farm');
  check('brand guard: a different-brand sighting on the same productId is refused',
    !res.offers.some((o) => o.id === 'o:alsafi'));
}

// --- /resolve + /registry/stats routes -------------------------------------------
console.log('routes:');
{
  const registry = memRegistry();
  const feed = memEnrichFeed([feedRow('o:r1')]);
  feed.verdictCounts = async () => ({ minted: 1 });
  const ctx = {
    registry: {},
    ingestSecret: 'sek',
    enrichStore: feed,
    registryStore: registry,
  };
  const denied = await handleRequest(new Request('http://x/resolve', { method: 'POST' }), ctx);
  check('/resolve without secret -> 403', denied.status === 403);
  const ok = await handleRequest(
    new Request('http://x/resolve?limit=10', { method: 'POST', headers: { 'X-Ingest-Secret': 'sek' } }),
    ctx,
  );
  const rep = await ok.json();
  check('/resolve drains (created 1)', ok.status === 200 && rep.created === 1);
  const stats = await (await handleRequest(new Request('http://x/registry/stats'), ctx)).json();
  check('/registry/stats serves §8 aggregates + verdicts',
    stats.products.active === 1 && stats.verdicts.minted === 1);
  const gone = await handleRequest(new Request('http://x/__compare'), ctx);
  check('retired /__compare evaluation page is gone', gone.status === 404);
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll pipeline tests passed.');
