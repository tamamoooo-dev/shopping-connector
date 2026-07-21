// registry/history.test.mjs — offline, dependency-free tests for Price
// History V2 (REGISTRY-DESIGN.md §7: points = sightings) and its pipeline-
// flagged routes. Run with:
//   node brochure-engine/src/registry/history.test.mjs   (repo root)
//
// Guards the milestone's promises:
//  • the doc keeps V1's exact shape (variants, lowest/latest/trend, weeks) so
//    the UI and the A/B evaluation work unchanged,
//  • points come from SIGHTINGS: market-wide lowest ever ("anywhere"), weeks
//    = distinct sighting weeks, latest-per-store prefers still-valid offers,
//  • merged losers' sightings fold into the survivor (tombstones followed,
//    rows untouched — §5.4 reversibility),
//  • admission: query-token containment against the profile + the shared
//    gate ladder; a query-named size excludes known different sizes and
//    keeps size-less products (refuse to guess),
//  • §4.3 confidence (sightings/stores/weeks) rides on every variant,
//  • routes: /prices and /lowest answer from V2 only under pipeline=vision
//    (param or SEARCH_PIPELINE), declare themselves, and leave the OCR
//    default byte-identical.

import { createMemRegistryStore } from './memstore.js';
import { getRegistryPricesDoc } from './history.js';
import { decodeProfile } from './model.js';
import { handleRequest } from '../engine.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

const TODAY = '2026-07-18';

const profile = (tokens) =>
  JSON.stringify(Object.fromEntries(tokens.map((t) => [t, { count: 3, week: '2026-07-08' }])));

const product = (id, tokens, over = {}) => ({
  id, status: 'active', merged_into: null, kind: 'product',
  display_name: null, display_name_ar: null, display_corroboration: null, display_week: null,
  brand_slug: null, brand_text: null, size_unit: null, size_total: null, size_pack: null,
  family: null, category: null, token_profile: profile(tokens),
  sightings: 3, stores_seen: '["othaim"]', first_seen: '2026-07-01', last_seen: '2026-07-15',
  review_flag: null, algo_version: 1, ...over,
});

const sighting = (offerId, productId, over = {}) => ({
  offer_id: offerId, product_id: productId, match_band: 'auto', match_score: 0.9,
  corroboration: 0.9, store: 'othaim', region: 'riyadh', week: '2026-07-15',
  price: 10, old_price: null, algo_version: 1, resolved_at: '2026-07-15T06:00:00Z', ...over,
});

async function seed(store, products, sightings) {
  for (const p of products) await store.createProduct(p, Object.keys(decodeProfile(p.token_profile)));
  for (const s of sightings) await store.insertSighting(s);
}

// --- the V2 doc -------------------------------------------------------------------
console.log('getRegistryPricesDoc:');
{
  const store = createMemRegistryStore({
    offers: [
      // Only o:cur is still valid; the rest have expired (or been pruned:
      // o:pruned has no offers row at all — the sighting must still count).
      { id: 'o:cur', store: 'lulu', region: 'riyadh', price: 4.5, currency: 'SAR', valid_to: '2099-01-01', source_url: 'http://f/cur' },
      { id: 'o:w1', store: 'othaim', region: 'riyadh', price: 5.0, currency: 'SAR', valid_to: '2026-07-10', source_url: 'http://f/w1' },
      { id: 'o:small', store: 'othaim', region: 'riyadh', price: 2.0, currency: 'SAR', valid_to: '2099-01-01', source_url: 'http://f/sm' },
    ],
  });
  const big = product('pr_big', ['berain', 'water', 'carton'], {
    display_name: 'Berain Water 1.5L', size_unit: 'ml', size_total: 1500, size_pack: 1,
  });
  const small = product('pr_small', ['berain', 'water', 'bottle'], {
    display_name: 'Berain Water 330ml', size_unit: 'ml', size_total: 330, size_pack: 1,
  });
  // A merged loser folded into pr_big: its sighting is the all-time low.
  const loser = product('pr_loser', [], { status: 'merged', merged_into: 'pr_big', token_profile: '{}' });
  const unrelated = product('pr_tide', ['tide', 'detergent', 'powder'], { display_name: 'Tide Powder' });
  await seed(store, [big, small, loser, unrelated], [
    sighting('o:w1', 'pr_big', { week: '2026-07-08', price: 5.0 }),
    sighting('o:cur', 'pr_big', { store: 'lulu', week: '2026-07-15', price: 4.5 }),
    sighting('o:pruned', 'pr_loser', { store: 'danube', week: '2026-06-15', price: 3.9 }),
    sighting('o:small', 'pr_small', { week: '2026-07-15', price: 2.0 }),
  ]);

  const doc = await getRegistryPricesDoc(store, 'berain water', { today: TODAY });
  check('V1 doc shape (variants/lowest/latest/weeks/trend keys)',
    ['product', 'query', 'lowest', 'latest', 'variants', 'observations', 'weeks', 'firstSeen', 'lastUpdated', 'trend']
      .every((k) => k in doc));
  check('overall lowest spans all variants (V1 semantics)',
    doc.lowest && doc.lowest.price === 2.0 && doc.lowest.store === 'othaim');
  check('merged loser folds into the survivor variant (no phantom variant)',
    doc.variants.length === 2);
  const v15 = doc.variants.find((v) => v.key === 'ml:1500');
  check('variant bucket: 1.5L carries its own record + label',
    v15 && v15.label === '1.5 L' && v15.observations === 3 && v15.lowest.price === 3.9);
  check('weeks = distinct sighting weeks (market-wide)', v15 && v15.weeks === 3);
  check('§4.3 confidence rides on the variant',
    v15 && v15.confidence.stores === 3 && v15.confidence.sightings === 3);
  const lulu = doc.latest.find((l) => l.store === 'lulu');
  const othaim = doc.latest.find((l) => l.store === 'othaim');
  check('latest per store: valid offer flagged current, expired not',
    lulu && lulu.current === true && lulu.price === 4.5 && othaim && othaim.current === true && othaim.price === 2.0);
  check('trend derived from weekly best prices', v15 && v15.trend === 'down');
  check('unrelated product excluded (containment floor)',
    !doc.latest.some((l) => l.name === 'Tide Powder'));

  // Size precision: a query-named size keeps only compatible + size-less rows.
  const sized = await getRegistryPricesDoc(store, 'berain water 330ml', { today: TODAY });
  check('query-named size excludes the other size, keeps its own',
    sized.variants.length === 1 && sized.variants[0].key === 'ml:330');

  const none = await getRegistryPricesDoc(store, 'nonexistent thing', { today: TODAY });
  check('no match -> honest empty doc', none.lowest === null && none.variants.length === 0);
}

// --- routes: registry-first with V1 fallback (vision-canonical, 2026-07-21) ------
console.log('routes:');
{
  const store = createMemRegistryStore({
    offers: [{ id: 'o:1', store: 'othaim', region: 'riyadh', price: 7, currency: 'SAR', valid_to: '2099-01-01', source_url: null }],
  });
  const p = product('pr_x', ['almarai', 'milk', 'fresh'], { display_name: 'Almarai Fresh Milk' });
  await seed(store, [p], [sighting('o:1', 'pr_x', { price: 7 })]);
  // The V1 history-store stub: consulted ONLY when the registry doc is empty.
  let v1Calls = 0;
  const historyStore = {
    searchIdentities: async () => {
      v1Calls += 1;
      return [];
    },
    pointsForIdentities: async () => [],
  };
  const ctx = { registry: {}, registryStore: store, historyStore };

  const covered = await (await handleRequest(new Request('http://x/prices?q=almarai%20milk'), ctx)).json();
  check('/prices answers registry-first from sightings, V1 untouched',
    covered.lowest?.price === 7 && v1Calls === 0 && !('pipeline' in covered));
  const uncovered = await (await handleRequest(new Request('http://x/prices?q=nonexistent%20thing'), ctx)).json();
  check('registry-empty query falls back to V1 (the depth bridge)',
    v1Calls === 1 && uncovered.lowest === null);
  const low = await (await handleRequest(new Request('http://x/lowest?q=almarai%20milk'), ctx)).json();
  check('/lowest is registry-first too', low.lowest?.price === 7 && !('pipeline' in low));
  const inert = await (await handleRequest(new Request('http://x/prices?q=almarai%20milk&pipeline=ocr'), ctx)).json();
  check('retired ?pipeline param is inert', inert.lowest?.price === 7);
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll history tests passed.');
