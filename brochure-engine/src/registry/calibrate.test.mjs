// registry/calibrate.test.mjs — offline tests for the §8 calibration/replay
// harness core (calibrate.js). Run with:
//   node brochure-engine/src/registry/calibrate.test.mjs   (repo root)
//
// Guards the harness's promises:
//  • pair sampling is deterministic (seeded) and boundary-stratified, and
//    scores through the PRODUCTION scorer (vetoed pairs never surface),
//  • replay runs the production drain in ingest order and scores labels
//    correctly: converged wobble pair = attach hit; a merged different-labeled
//    pair = FALSE ATTACH; unresolved offers excluded, never guessed,
//  • the ship gate math (attach >= 95%, false-attach <= 0.5%),
//  • sweep ranks passing configurations first,
//  • measureVerdicts reports gate rates (the or_deal lock measurement path).

import {
  samplePairs, replay, sweep, measureVerdicts, pairScore, GATE,
} from './calibrate.js';
import { readFromOffer } from './read.js';
import { TUNING } from './resolver.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

// Resolver-feed rows (the listUnresolved shape) — a tiny synthetic market:
//   halah wobble pair (same oil, two phrasings, two weeks)  -> label same
//   afia oil (shares 'oil' token family but different brand) -> label different vs halah
//   berain pair (same water twice)                           -> label same
//   a declined row (never resolves)                          -> unresolvable
const row = (id, over = {}) => ({
  id, store: 'othaim', region: 'riyadh', source: 'd4d', category: 'oil-ghee',
  search_text: `ocr ${id}`, price: 20, old_price: null,
  valid_from: '2026-07-08', detected_at: `2026-07-08T06:00:${String(over.seq ?? 0).padStart(2, '0')}Z`,
  e_name: null, e_name_ar: null, e_brand: null, e_size: null, e_corroboration: 0.9,
  ...over,
});
const corpus = [
  row('o:h1', { seq: 1, e_name: 'Halah Pure Sunflower Oil', e_brand: 'Halah', e_size: '1.5L' }),
  row('o:h2', { seq: 2, e_name: 'Sunflower Oil Halah', e_brand: 'Halah', e_size: '1.5L', valid_from: '2026-07-15' }),
  row('o:afia', { seq: 3, e_name: 'Afia Sunflower Oil', e_brand: 'Afia', e_size: '1.5L' }),
  row('o:b1', { seq: 4, e_name: 'Berain Water Carton', e_brand: 'Berain', category: 'water' }),
  row('o:b2', { seq: 5, e_name: 'Berain Water Cartons', e_brand: 'Berain', category: 'water', valid_from: '2026-07-15' }),
  row('o:dead', { seq: 6, e_name: null, e_name_ar: null }),
];

// --- pair sampling ---------------------------------------------------------------
console.log('samplePairs:');
{
  const a = samplePairs(corpus, { seed: 7 });
  const b = samplePairs(corpus, { seed: 7 });
  check('deterministic under a fixed seed',
    JSON.stringify(a.pairs) === JSON.stringify(b.pairs));
  check('declined rows mint no reads (never paired)', a.reads === 5);
  const key = (p) => [p.aId, p.bId].sort().join('|');
  const keys = a.pairs.map(key);
  check('the wobble pair surfaces for labeling', keys.includes('o:h1|o:h2'));
  check('every pair carries a stratum + production score',
    a.pairs.every((p) => p.stratum && p.score > 0));

  const readOf = (r) => readFromOffer(
    { id: r.id, store: r.store, region: r.region, category: r.category, search_text: r.search_text },
    { name: r.e_name, name_ar: r.e_name_ar, brand: r.e_brand, size: r.e_size, corroboration: r.e_corroboration },
  ).read;
  const vetoed = pairScore(
    readOf(row('x', { e_name: 'Halah Oil Big', e_size: '3L' })),
    readOf(row('y', { e_name: 'Halah Oil Small', e_size: '750ml' })),
  );
  check('size-conflicting pair is vetoed (never offered for labeling)', vetoed.vetoed);
}

// --- replay + gate ---------------------------------------------------------------
console.log('replay:');
{
  const labels = [
    { aId: 'o:h1', bId: 'o:h2', label: 'same' },
    { aId: 'o:b1', bId: 'o:b2', label: 'same' },
    { aId: 'o:h1', bId: 'o:afia', label: 'different' },
    { aId: 'o:h1', bId: 'o:dead', label: 'same' }, // unresolvable side
  ];
  const m = await replay(corpus, labels);
  check('wobble + berain pairs converge (attach hits)', m.attachHits === 2 && m.attachRate === 1);
  // P2 revised (2026-07-21): the brand-conflicting afia read (containment
  // 0.67, size equal) used to land in the REVIEW band on the halah product —
  // the exact cross-brand pollution production showed (Nadec onto Al Safi).
  // The brand-conflict veto now sends it to create-on-doubt at the priors.
  check('cross-brand pair splits at the priors (brand-conflict veto)',
    m.falseAttaches === 0 && m.pass === true);
  check('unresolvable pair excluded, counted', m.unresolvable === 1 && m.labeled.same === 2);
  check('gate constants are the §8 promise', GATE.attach === 0.95 && GATE.falseAttach === 0.005);

  // A calibrated tReview (what sweep would find) pushes the conflicted pair
  // to create-on-doubt without losing either genuine attach.
  const calibrated = await replay(corpus, labels, { tuning: { ...TUNING, tReview: 0.62 } });
  check('calibrated thresholds pass the ship gate (attaches kept, false split off)',
    calibrated.pass === true && calibrated.attachHits === 2 && calibrated.falseAttaches === 0);

  // Reckless thresholds merge everything and fail loudly. The brand veto is
  // threshold-independent, so the trap pair here is SAME-brand different
  // products (Halah rice vs Halah oil) — thresholds are their only defence.
  const looseCorpus = [
    ...corpus,
    row('o:h3', { seq: 7, e_name: 'Halah Basmati Rice', e_brand: 'Halah' }),
  ];
  const loose = await replay(looseCorpus, [
    ...labels,
    { aId: 'o:h1', bId: 'o:h3', label: 'different' },
  ], {
    tuning: { ...TUNING, tAttach: 0.01, tReview: 0.005 },
  });
  check('reckless thresholds produce FALSE ATTACHES and fail the gate',
    loose.falseAttaches >= 1 && loose.pass === false);
}

// --- sweep -----------------------------------------------------------------------
console.log('sweep:');
{
  const labels = [
    { aId: 'o:h1', bId: 'o:h2', label: 'same' },
    { aId: 'o:h1', bId: 'o:afia', label: 'different' },
  ];
  const results = await sweep(corpus, labels, {
    tAttachGrid: [0.1, 0.7],
    tReviewGrid: [0.05, 0.45, 0.62],
  });
  check('grid skips tReview >= tAttach', results.every((r) => r.tuning.tReview < r.tuning.tAttach));
  // With the brand-conflict veto the afia pair splits at EVERY grid point, so
  // all configurations pass this corpus's gate; the sweep still ranks passing
  // configs first (its contract).
  check('passing configurations rank first',
    results[0].pass === true && results.every((r) => r.falseAttaches === 0));
}

// --- measureVerdicts -------------------------------------------------------------
console.log('measureVerdicts:');
{
  const m = measureVerdicts([
    ...corpus,
    row('o:or', { e_name: 'Tide Detergent 3kg or Persil Powder 3kg' }),
  ]);
  check('verdict counts + rates (or_deal measured for the §3 lock)',
    m.counts.minted === 5 && m.counts.declined === 1 && m.counts.or_deal === 1 &&
    m.rates.or_deal > 0);
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll calibrate tests passed.');
