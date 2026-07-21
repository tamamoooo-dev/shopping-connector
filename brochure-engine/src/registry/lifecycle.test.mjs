// registry/lifecycle.test.mjs — offline, dependency-free tests for the
// registry lifecycle jobs (REGISTRY-DESIGN.md §5.1 dormancy, §5.4
// consolidation/merge + the human review actions) and their routes. Run with:
//   node brochure-engine/src/registry/lifecycle.test.mjs   (repo root)
//
// Guards the milestone's promises:
//  • decideMerge is STRICTLY more conservative than a live attach: score bar
//    above tAttach, brand conflict vetoes (it only penalizes live), and a
//    corroborating overlap (shared store or same size both read) is required,
//  • the known-split shapes never merge (variant sizes, assortment vs
//    specific — the §10 regression the crop review mandated),
//  • merge mechanics: survivor = better-evidenced row, profile union capped
//    deterministically, tombstone single-hop (old tombstones re-pointed),
//    loser leaves the token index, resolver redirects to the survivor,
//  • §5.1: unseen products go dormant but STAY matchable (the index keeps
//    them) and reactivate on their next sighting,
//  • dangling sightings heal: sighting deleted + verdict un-stamped so the
//    next drain re-resolves,
//  • review actions: clear_flag / reassign (band review, never teaches) /
//    split (new product from the sighting's own enrichment),
//  • routes: /registry/maintain and /registry/review are secret-guarded.

import { createMemRegistryStore } from './memstore.js';
import {
  decideMerge, mergedFields, consolidate, healDanglingSightings, runMaintenance,
  LIFECYCLE_TUNING,
} from './lifecycle.js';
import { applyReviewAction } from './review.js';
import { resolveOffer } from './resolver.js';
import { applyDecision } from './apply.js';
import { observationFromOffer } from './read.js';
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

const profile = (tokens, count = 3) =>
  JSON.stringify(Object.fromEntries(tokens.map((t) => [t, { count, week: '2026-07-08' }])));

const product = (id, tokens, over = {}) => ({
  id, status: 'active', merged_into: null, kind: 'product',
  display_name: null, display_name_ar: null, display_corroboration: null, display_week: null,
  brand_slug: null, brand_text: null, size_unit: null, size_total: null, size_pack: null,
  family: null, category: null, token_profile: profile(tokens),
  sightings: 3, stores_seen: '["othaim"]', first_seen: '2026-07-01', last_seen: '2026-07-15',
  review_flag: null, algo_version: 1, ...over,
});

// --- decideMerge (§5.4 conservatism) --------------------------------------------
console.log('decideMerge:');
{
  const a = product('pr_a', ['halah', 'pure', 'sunflower', 'oil'], { sightings: 5, brand_text: 'halah' });
  const b = product('pr_b', ['halah', 'sunflower', 'oil'], { sightings: 2, brand_text: 'halah' });
  const d = decideMerge(a, b);
  check('duplicate pair with shared store merges; survivor = better-evidenced',
    d.merge && d.survivor.id === 'pr_a' && d.loser.id === 'pr_b' && d.score >= LIFECYCLE_TUNING.tMerge);

  const noOverlap = decideMerge(a, { ...b, stores_seen: '["lulu"]' });
  check('no store overlap and not both sized -> no merge', !noOverlap.merge);

  const bothSized = decideMerge(
    { ...a, size_unit: 'ml', size_total: 1500, size_pack: 1 },
    { ...b, stores_seen: '["lulu"]', size_unit: 'ml', size_total: 1500, size_pack: 1 },
  );
  check('same size read on both substitutes for store overlap', bothSized.merge);

  const variant = decideMerge(
    { ...a, size_unit: 'ml', size_total: 1500, size_pack: 1 },
    { ...b, size_unit: 'ml', size_total: 750, size_pack: 1 },
  );
  check('variant sizes NEVER merge (size veto — the known-split regression)', !variant.merge);

  const brandClash = decideMerge(a, { ...b, brand_text: 'afia' });
  check('brand conflict vetoes a merge (stricter than live matching)', !brandClash.merge);

  const kinds = decideMerge(a, { ...b, kind: 'assortment' });
  check('assortment never merges with a specific product', !kinds.merge);

  const weak = decideMerge(a, product('pr_c', ['halah', 'tomato', 'paste', 'can'], { brand_text: 'halah' }));
  check('weak containment stays below tMerge', !weak.merge);

  const dormant = decideMerge(a, { ...b, status: 'dormant' });
  check('dormant duplicates still merge (history healing)', dormant.merge);
}

// --- mergedFields ----------------------------------------------------------------
console.log('mergedFields:');
{
  const survivor = product('pr_s', ['halah', 'oil'], {
    sightings: 4, stores_seen: '["othaim"]', first_seen: '2026-07-08', last_seen: '2026-07-10',
  });
  const loser = product('pr_l', ['halah', 'oil', 'pure'], {
    sightings: 2, stores_seen: '["lulu"]', first_seen: '2026-07-01', last_seen: '2026-07-15',
    display_name: 'Halah Pure Oil', display_corroboration: 0.8, display_week: '2026-07-15',
    size_unit: 'ml', size_total: 1500, size_pack: 1, brand_text: 'halah',
  });
  const { fields, tokens } = mergedFields(survivor, loser);
  const prof = decodeProfile(fields.token_profile);
  check('profile union sums counts, keeps new tokens',
    prof.halah.count === 6 && prof.pure.count === 3 && tokens.includes('pure'));
  check('evidence summary merges (sum, union, min/max)',
    fields.sightings === 6 && fields.stores_seen === '["lulu","othaim"]' &&
    fields.first_seen === '2026-07-01' && fields.last_seen === '2026-07-15');
  check('displayless survivor adopts the loser display; size + brand fill',
    fields.display_name === 'Halah Pure Oil' && fields.size_unit === 'ml' && fields.brand_text === 'halah');
}

// --- consolidate end-to-end -------------------------------------------------------
console.log('consolidate:');
{
  const store = createMemRegistryStore();
  const dupA = product('pr_da', ['berain', 'water', 'bottle', 'carton'], { sightings: 5, brand_text: 'berain' });
  const dupB = product('pr_db', ['berain', 'water', 'carton'], { sightings: 1, brand_text: 'berain' });
  const bystander = product('pr_by', ['tide', 'detergent', 'powder']);
  // A stale tombstone that points at the soon-to-lose duplicate: single-hop
  // repair must re-point it at the survivor.
  const oldTomb = product('pr_old', [], { status: 'merged', merged_into: 'pr_db' });
  for (const p of [dupA, dupB, bystander, oldTomb]) {
    await store.createProduct(p, Object.keys(decodeProfile(p.token_profile)));
  }
  const rep = await consolidate(store);
  check('exactly the duplicate pair merged', rep.merges === 1 && rep.log[0].survivor === 'pr_da' && rep.log[0].loser === 'pr_db');
  check('loser tombstoned', store._products.get('pr_db').status === 'merged' && store._products.get('pr_db').merged_into === 'pr_da');
  check('old tombstone re-pointed single-hop', store._products.get('pr_old').merged_into === 'pr_da');
  check('survivor absorbed the evidence', store._products.get('pr_da').sightings === 6);
  check('loser left the token index', !(await store.candidateIds(['carton'])).includes('pr_db'));

  // The resolver now redirects a read that would have matched the loser.
  const res = await resolveOffer(
    { id: 'o:x', store: 'othaim', region: 'riyadh', category: null, search_text: 'x' },
    { name: 'Berain Water Bottle Carton', name_ar: null, brand: 'Berain', size: null, corroboration: 0.9 },
    store,
  );
  check('post-merge resolution lands on the survivor', res.productId === 'pr_da');

  const again = await consolidate(store);
  check('re-run is a no-op (idempotent convergence)', again.merges === 0);
}

// --- §5.1 dormancy ⇄ -------------------------------------------------------------
console.log('dormancy:');
{
  const store = createMemRegistryStore();
  const oldP = product('pr_old', ['nadec', 'juice', 'orange'], { last_seen: '2026-05-01' });
  const freshP = product('pr_new', ['almarai', 'milk', 'fresh'], { last_seen: '2026-07-15' });
  await store.createProduct(oldP, Object.keys(decodeProfile(oldP.token_profile)));
  await store.createProduct(freshP, Object.keys(decodeProfile(freshP.token_profile)));
  const n = await store.sweepDormancy('2026-06-06'); // today 2026-07-18 - 42d
  check('unseen product swept dormant, fresh one untouched',
    n === 1 && store._products.get('pr_old').status === 'dormant' && store._products.get('pr_new').status === 'active');

  // The dormant product STAYS matchable and reactivates on its next sighting.
  const offer = {
    id: 'o:season', store: 'othaim', region: 'riyadh', source: 'd4d', category: null,
    search_text: 'nadec orange juice', price: 5.5, old_price: null,
    valid_from: '2026-07-15', detected_at: '2026-07-15T06:00:00Z',
  };
  const enrichment = { name: 'Nadec Orange Juice', name_ar: null, brand: 'Nadec', size: null, corroboration: 0.9 };
  const decision = await resolveOffer(offer, enrichment, store);
  await applyDecision(decision, observationFromOffer(offer, enrichment), store);
  check('returning seasonal product re-attaches and reactivates (§5.1 ⇄)',
    decision.productId === 'pr_old' && store._products.get('pr_old').status === 'active');
}

// --- dangling-sighting healing ----------------------------------------------------
console.log('healing:');
{
  const store = createMemRegistryStore();
  const p = product('pr_ok', ['tide', 'detergent']);
  await store.createProduct(p, ['tide', 'detergent']);
  await store.insertSighting({ offer_id: 'o:ok', product_id: 'pr_ok', match_band: 'auto', store: 's', region: 'r', week: '2026-07-15', price: 1 });
  await store.insertSighting({ offer_id: 'o:dangling', product_id: 'pr_gone', match_band: 'created', store: 's', region: 'r', week: '2026-07-15', price: 1 });
  const reset = [];
  const enrichStore = { resetVerdicts: async (ids) => reset.push(...ids) };
  const rep = await healDanglingSightings({ registryStore: store, enrichStore });
  check('dangling sighting deleted, healthy one kept',
    rep.healed === 1 && !store._sightings.has('o:dangling') && store._sightings.has('o:ok'));
  check('verdict un-stamped for re-resolution', reset.join(',') === 'o:dangling');
}

// --- runMaintenance + routes ------------------------------------------------------
console.log('maintenance + routes:');
{
  const store = createMemRegistryStore();
  const recorded = [];
  const ctx = {
    registry: {},
    ingestSecret: 'sek',
    registryStore: store,
    enrichStore: { resetVerdicts: async () => {}, getForIds: async () => new Map() },
    opsStore: { record: async (row) => recorded.push(row) },
  };
  const rep = await runMaintenance(ctx, { today: '2026-07-18' });
  check('runMaintenance composes the three duties', 'dormant' in rep && rep.consolidation && 'healed' in rep);
  check('ops audit row written (the §5.4 merge log trail)', recorded.some((r) => r.action === 'registry:maintain'));

  const denied = await handleRequest(new Request('http://x/registry/maintain', { method: 'POST' }), ctx);
  check('/registry/maintain without secret -> 403', denied.status === 403);
  const ok = await handleRequest(
    new Request('http://x/registry/maintain', { method: 'POST', headers: { 'X-Ingest-Secret': 'sek' } }),
    ctx,
  );
  check('/registry/maintain runs', ok.status === 200 && 'dormant' in (await ok.json()));

  // Review surface: flag a product, list, act.
  const flagged = product('pr_f', ['clorox', 'bleach'], { review_flag: 'size-conflict' });
  const target = product('pr_t', ['clorox', 'bleach', 'lemon']);
  await store.createProduct(flagged, ['clorox', 'bleach']);
  await store.createProduct(target, ['clorox', 'bleach', 'lemon']);
  await store.insertSighting({ offer_id: 'o:rev', product_id: 'pr_f', match_band: 'review', store: 's', region: 'r', week: '2026-07-15', price: 3 });

  const listDenied = await handleRequest(new Request('http://x/registry/review'), ctx);
  check('/registry/review GET is guarded', listDenied.status === 403);
  const list = await (await handleRequest(
    new Request('http://x/registry/review', { headers: { 'X-Ingest-Secret': 'sek' } }), ctx,
  )).json();
  check('review queue lists flagged products + review-band sightings',
    list.flagged.some((p) => p.id === 'pr_f') && list.reviewSightings.some((s) => s.offer_id === 'o:rev'));

  const act = (body) => handleRequest(
    new Request('http://x/registry/review', {
      method: 'POST', headers: { 'X-Ingest-Secret': 'sek' }, body: JSON.stringify(body),
    }), ctx,
  );
  const re = await (await act({ action: 'reassign', offerId: 'o:rev', toProductId: 'pr_t' })).json();
  check('reassign moves the sighting (band review, target profile untaught)',
    re.done && store._sightings.get('o:rev').product_id === 'pr_t' &&
    decodeProfile(store._products.get('pr_t').token_profile).clorox.count === 3);
  const cf = await (await act({ action: 'clear_flag', productId: 'pr_f' })).json();
  check('clear_flag clears', cf.done && store._products.get('pr_f').review_flag === null);
  const bad = await act({ action: 'nope' });
  check('unknown action -> 400', bad.status === 400);

  // Split: needs the sighting's own enrichment.
  ctx.enrichStore.getForIds = async (ids) =>
    new Map(ids.filter((i) => i === 'o:rev').map((i) => [i, {
      id: i, name: 'Clorox Bleach Lemon 950ml', name_ar: null, brand: 'Clorox',
      size: '950ml', corroboration: 0.9,
    }]));
  const sp = await (await act({ action: 'split', offerId: 'o:rev' })).json();
  check('split mints a new product from the sighting read and moves the sighting',
    sp.done && sp.productId?.startsWith('pr_') &&
    store._sightings.get('o:rev').product_id === sp.productId &&
    store._products.get(sp.productId).size_total === 950);
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll lifecycle tests passed.');
