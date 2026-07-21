// registry/learn.test.mjs — offline, dependency-free tests for Registry
// learning + apply (Phase 3: REGISTRY-DESIGN.md §1.3, §5). Run with:
//   node brochure-engine/src/registry/learn.test.mjs   (repo root)
//
// Guards the milestone's promises:
//  • §5.2: profiles increment/add/cap deterministically (lowest-count-oldest
//    dropped; a mature consensus resists poisoning),
//  • §5.3: display adoption = highest-corroboration RECENT read; size fills
//    but never overwrites (conflict flags review); brand_slug only ever
//    set/upgraded (conflict flags review),
//  • evidence summary (sightings, stores_seen, first/last_seen) tracks the
//    row; dormant products reactivate on being seen (§5.1 ⇄),
//  • apply: create/attach/review/defer write exactly what §3 prescribes; the
//    review band NEVER teaches; re-running an offer is a complete no-op
//    (§1.3 idempotency via the sighting PK),
//  • end-to-end: the §4.4 worked-example wobble pair ("Halah Pure Sunflower
//    Oil" vs "Sunflower Oil Halah") — the exact case that split V1/V2 exact
//    keys — resolves to ONE product across two weeks.

import {
  updatedProfile, adoptDisplay, adoptSize, adoptBrandSlug, learnFromSighting, LEARN_TUNING,
} from './learn.js';
import { applyDecision } from './apply.js';
import { resolveOffer } from './resolver.js';
import { observationFromOffer } from './read.js';
import { decodeProfile, REGISTRY_ALGO_VERSION } from './model.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

// The shared in-memory twin of the full registry store (memstore.js).
import { createMemRegistryStore as memRegistry } from './memstore.js';

const baseProduct = (over = {}) => ({
  id: 'pr_x', status: 'active', merged_into: null, kind: 'product',
  display_name: null, display_name_ar: null, display_corroboration: null, display_week: null,
  brand_slug: null, brand_text: null, size_unit: null, size_total: null, size_pack: null,
  family: null, category: null,
  token_profile: '{"halah":{"count":2,"week":"2026-07-08"},"oil":{"count":2,"week":"2026-07-08"}}',
  sightings: 2, stores_seen: '["othaim"]', first_seen: '2026-07-01', last_seen: '2026-07-08',
  review_flag: null, algo_version: 1, ...over,
});

// --- §5.2 profile update --------------------------------------------------------
console.log('profile update (§5.2):');
{
  const p = updatedProfile(baseProduct().token_profile, ['halah', 'pure'], '2026-07-15');
  check('seen token increments + restamps', p.halah.count === 3 && p.halah.week === '2026-07-15');
  check('unseen token joins at count 1', p.pure.count === 1 && p.oil.count === 2);

  const capped = updatedProfile(
    '{"a":{"count":3,"week":"2026-07-01"},"b":{"count":2,"week":"2026-07-01"},"c":{"count":1,"week":"2026-06-01"}}',
    ['d', 'e'],
    '2026-07-15',
    { ...LEARN_TUNING, profileCap: 4 },
  );
  check('cap drops lowest-count-OLDEST first (c out, d/e stay)',
    !capped.c && capped.d && capped.e && Object.keys(capped).length === 4);
}

// --- §5.3 display adoption ------------------------------------------------------
console.log('display adoption (§5.3):');
{
  const bare = baseProduct();
  check('no display -> adopt', adoptDisplay(bare, { name: 'Halah Oil', nameAr: null, corroboration: 0.5, week: '2026-07-15' }) !== null);
  const named = baseProduct({ display_name: 'Halah Oil', display_corroboration: 0.7, display_week: '2026-07-10' });
  check('higher corroboration wins', adoptDisplay(named, { name: 'Halah Pure Oil', nameAr: null, corroboration: 0.9, week: '2026-07-15' })?.display_name === 'Halah Pure Oil');
  check('lower corroboration, fresh pick -> keep', adoptDisplay(named, { name: 'X', nameAr: null, corroboration: 0.4, week: '2026-07-15' }) === null);
  const stale = baseProduct({ display_name: 'Halah Oil', display_corroboration: 0.9, display_week: '2026-05-01' });
  check('stale pick (> 6 weeks) -> fresh read wins anyway', adoptDisplay(stale, { name: 'New Halah Oil', nameAr: null, corroboration: 0.4, week: '2026-07-15' })?.display_name === 'New Halah Oil');
}

// --- §5.3 size + brand adoption -------------------------------------------------
console.log('size + brand adoption (§5.3):');
{
  const fill = adoptSize(baseProduct(), { unit: 'ml', each: 1500, pack: 2 });
  check('sized read fills a nosize product', fill?.fill?.size_total === 1500 && fill.fill.size_pack === 2);
  const sized = baseProduct({ size_unit: 'ml', size_total: 1500, size_pack: 2 });
  check('equal size -> nothing to do', adoptSize(sized, { unit: 'ml', each: 1500, pack: 2 }) === null);
  check('conflicting size never overwrites — flags review', adoptSize(sized, { unit: 'ml', each: 500, pack: 1 })?.flag === 'size-conflict');

  const b1 = adoptBrandSlug(baseProduct(), { name: 'Almarai Fresh Milk', nameAr: null, source: 'd4d', category: 'milk-laban' });
  check('detectBrand sets brand_slug', b1?.fill?.brand_slug === 'almarai');
  const b2 = adoptBrandSlug(baseProduct({ brand_slug: 'nadec' }), { name: 'Almarai Fresh Milk', nameAr: null, source: 'd4d', category: 'milk-laban' });
  check('conflicting detection never overwrites — flags review', b2?.flag === 'brand-conflict');
  check('same detection -> no-op', adoptBrandSlug(baseProduct({ brand_slug: 'almarai' }), { name: 'Almarai Milk', nameAr: null, source: 'd4d', category: null }) === null);
}

// --- learnFromSighting composite ------------------------------------------------
console.log('learnFromSighting:');
{
  const read = {
    tokens: ['halah', 'oil', 'sunflower'], size: { unit: 'ml', each: 1500, pack: 2 },
    brandText: 'halah', family: 'oil', category: 'oil-ghee', kind: 'product', corroboration: 0.8,
  };
  const obs = { name: 'Halah Sunflower Oil', nameAr: 'زيت هالة', source: 'd4d', category: 'oil-ghee', store: 'tamimi', week: '2026-07-15' };
  const { fields, tokens } = learnFromSighting(baseProduct({ status: 'dormant' }), read, obs);
  check('evidence: sightings+1, store joined sorted', fields.sightings === 3 && fields.stores_seen === '["othaim","tamimi"]');
  check('last_seen advances, first_seen kept', fields.last_seen === '2026-07-15' && fields.first_seen === undefined);
  check('dormant reactivates (§5.1 ⇄)', fields.status === 'active');
  check('display + provenance adopted', fields.display_name === 'Halah Sunflower Oil' && fields.display_corroboration === 0.8 && fields.display_week === '2026-07-15');
  check('brand_text follows display provenance', fields.brand_text === 'halah');
  check('size filled from the read', fields.size_unit === 'ml' && fields.size_total === 1500 && fields.size_pack === 2);
  check('profile taught + index tokens returned', decodeProfile(fields.token_profile).sunflower.count === 1 && tokens.includes('sunflower'));
  check('algo_version stamped', fields.algo_version === REGISTRY_ALGO_VERSION);
}

// --- apply: bands write exactly §3 ----------------------------------------------
console.log('apply:');
{
  const store = memRegistry();
  const offer1 = {
    id: 'othaim:riyadh:d4d:o1', store: 'othaim', region: 'riyadh', source: 'd4d',
    category: 'oil-ghee', search_text: 'halah pure sunflower oil ocr', price: 21.9,
    old_price: 29.0, valid_from: '2026-07-08', detected_at: '2026-07-08T06:00:00Z',
  };
  const enr1 = { name: 'Halah Pure Sunflower Oil', name_ar: 'زيت دوار الشمس هالة', brand: 'Halah', size: '1.5L x 2', corroboration: 0.9 };

  const d1 = await resolveOffer(offer1, enr1, store);
  const a1 = await applyDecision(d1, observationFromOffer(offer1, enr1), store);
  check('create: product founded + sighting written', a1.applied === 'create' && store._products.size === 1 && store._sightings.size === 1);
  const founded = store._products.get(a1.productId);
  check('founding row carries read evidence (size, display, week)',
    founded.size_total === 1500 && founded.size_pack === 2 && founded.display_name === 'Halah Pure Sunflower Oil' && founded.first_seen === '2026-07-08');
  const s1 = store._sightings.get(offer1.id);
  check('created-band sighting carries price + old_price + week', s1.match_band === 'created' && s1.price === 21.9 && s1.old_price === 29.0 && s1.week === '2026-07-08');

  // Idempotency: the same offer re-applied is a complete no-op.
  const again = await applyDecision(d1, observationFromOffer(offer1, enr1), store);
  check('re-run -> noop (no duplicate product, no double sighting)',
    again.applied === 'noop' && store._products.size === 1 && store._sightings.size === 1);

  // Week 2 — the §4.4 wobble pair: phrasing flips, "Pure" dropped. Under
  // exact keys this SPLIT (worked example ✗); the registry must attach.
  const offer2 = {
    ...offer1, id: 'othaim:riyadh:d4d:o2', search_text: 'sunflower oil halah ocr week2',
    price: 20.9, old_price: null, valid_from: '2026-07-15',
  };
  const enr2 = { name: 'Sunflower Oil Halah', name_ar: null, brand: 'Halah', size: '1.5L x 2', corroboration: 0.85 };
  const d2 = await resolveOffer(offer2, enr2, store);
  const a2 = await applyDecision(d2, observationFromOffer(offer2, enr2), store);
  check('§4.4 wobble pair attaches to the SAME product (band auto)',
    a2.applied === 'attach' && a2.productId === a1.productId && d2.band === 'auto');
  const taught = store._products.get(a1.productId);
  const prof = decodeProfile(taught.token_profile);
  check('auto band teaches: recurring tokens now count 2, evidence advanced',
    prof.halah.count === 2 && prof.oil.count === 2 && taught.sightings === 2 && taught.last_seen === '2026-07-15');

  // Review band: attaches but never teaches.
  const offer3 = { ...offer1, id: 'othaim:riyadh:d4d:o3', valid_from: '2026-07-15', price: 9.9 };
  const before = JSON.stringify(store._products.get(a1.productId));
  const reviewDecision = {
    outcome: 'review', verdict: 'minted', band: 'review', productId: a1.productId, score: 0.5,
    read: { tokens: ['halah', 'oil'], size: null, brandText: 'halah', family: 'oil', category: null, kind: 'product', corroboration: 0.6 },
  };
  const a3 = await applyDecision(reviewDecision, observationFromOffer(offer3, enr1), store);
  check('review: sighting written (band review)', a3.applied === 'review' && store._sightings.get(offer3.id)?.match_band === 'review');
  check('review NEVER teaches: product row byte-identical', JSON.stringify(store._products.get(a1.productId)) === before);

  // Defer writes nothing.
  const a4 = await applyDecision({ outcome: 'defer', verdict: 'low_corroboration' }, null, store);
  check('defer -> nothing written', a4.applied === 'defer' && store._sightings.size === 3 && store._products.size === 1);
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll learn/apply tests passed.');
