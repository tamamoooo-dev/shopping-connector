import assert from 'node:assert/strict';
import {
  comparesByUnitPrice,
  countExclusion,
  describeExclusions,
  emptyExclusions,
  matchesSpec,
  specFromLegacyWatch,
  validateSpec,
} from './spec.js';
import { listingIdentityCandidate } from './listingCandidate.js';
import { CANDIDATE_DIMENSIONS } from '../registry/candidate.js';

const candidateOf = (name, over = {}) =>
  listingIdentityCandidate({ id: '1', name, price: 10, brand: '', size: '', ...over });

// --- the class watch: "any chicken breast" -----------------------------------
{
  const spec = { family: 'chicken', cut: 'breast' };
  assert.equal(validateSpec(spec).valid, true);

  for (const [name, brand] of [
    ['Sadia Chicken Breast 900 g', 'Sadia'],
    ['Americana Chicken Breast 450 g', 'Americana'],
    ['ساديا صدور دجاج 900 جم', 'ساديا'],
  ]) {
    const m = matchesSpec(candidateOf(name, { brand }), spec);
    assert.equal(m.matched, true, `"${name}" is chicken breast (failed: ${m.failed})`);
  }

  // Any brand, any size — but NOT a different cut or family.
  assert.equal(matchesSpec(candidateOf('Sadia Chicken Nuggets 900 g'), spec).failed, 'cut');
  assert.equal(matchesSpec(candidateOf('Sadia Beef Burger 900 g'), spec).failed, 'family');
}

// --- unknown does NOT satisfy a pin ------------------------------------------
// The opposite of strict-watch semantics, and deliberate: a predicate has no
// other evidence to fall back on.
{
  const spec = { family: 'chicken', cut: 'breast' };
  const m = matchesSpec(candidateOf('Mystery Value Pack'), spec);
  assert.equal(m.matched, false);
  assert.equal(m.failed, 'family', 'the unsatisfied dimension is named, so it can be counted');
}

// --- set-valued pins ----------------------------------------------------------
// How a class defined by a property of a RELATED entity is expressed: resolve
// "private label" to a brand set once, then pin membership.
{
  const spec = { family: 'milk', brand: ['almarai', 'nadec'] };
  assert.equal(validateSpec(spec).valid, true);
  assert.equal(matchesSpec(candidateOf('Almarai Fresh Milk 1 L', { brand: 'Almarai' }), spec).matched, true);
  assert.equal(matchesSpec(candidateOf('Nadec Milk 1 L', { brand: 'Nadec' }), spec).matched, true);
  assert.equal(matchesSpec(candidateOf('Saudia Milk 1 L', { brand: 'Saudia' }), spec).failed, 'brand');
}

// --- size pins compare with tolerance, not equality --------------------------
{
  const spec = { family: 'milk', size: { value: 1, unit: 'l' } };
  assert.equal(
    matchesSpec(candidateOf('Almarai Milk 1000 ml', { brand: 'Almarai' }), spec).matched,
    true,
    '1 L and 1000 ml are the same size',
  );
  assert.equal(matchesSpec(candidateOf('Almarai Milk 2 L', { brand: 'Almarai' }), spec).failed, 'size');
}

// --- the comparison basis is DERIVED from the spec, never configured ---------
{
  assert.equal(comparesByUnitPrice({ family: 'chicken', cut: 'breast' }), true,
    'no size pin -> pack prices are incomparable -> unit price');
  assert.equal(comparesByUnitPrice({ family: 'milk', size: { value: 1, unit: 'l' } }), false,
    'a pinned size makes pack prices comparable');
}

// --- validation ---------------------------------------------------------------
{
  assert.equal(validateSpec({}).valid, false, 'a spec must pin something');
  assert.equal(validateSpec(null).valid, false);

  const bogus = validateSpec({ colour: 'red' });
  assert.equal(bogus.valid, false);
  assert.match(bogus.errors[0], /not a product identity dimension/);

  assert.equal(validateSpec({ family: 'milk', brand: [] }).valid, false, 'an empty set is a mistake');

  // Every pinnable dimension is a real Identity Candidate dimension — the two
  // lists cannot drift, because one is derived from the other's schema.
  for (const key of ['brand', 'family', 'cut', 'processing', 'variety', 'package', 'size', 'count']) {
    assert.ok(CANDIDATE_DIMENSIONS.includes(key), `${key} must be a candidate dimension`);
  }
}

// --- exclusions are counted, never silent ------------------------------------
{
  const counters = emptyExclusions();
  countExclusion(counters, 'family');
  countExclusion(counters, 'family');
  countExclusion(counters, 'size');
  assert.deepEqual(counters, { family: 2, size: 1 });
  assert.equal(describeExclusions(counters), 'family ×2, size ×1');
  assert.equal(describeExclusions({}), null);
}

// --- legacy migration: every old flexible configuration maps ------------------
{
  const base = {
    identityFamily: 'chicken', identityType: 'breast',
    brandId: 'sadia', sizeUnit: 'g', sizeTotal: 900, variantKey: 'frozen',
    matchBrand: true, matchSize: true, matchVariant: true,
  };
  // all gates strict -> every attribute pinned
  assert.deepEqual(specFromLegacyWatch(base), {
    family: 'chicken', cut: 'breast', brand: 'sadia',
    size: { value: 900, unit: 'g' }, variety: 'frozen',
  });
  // brand relaxed -> brand free, the rest pinned
  assert.equal(specFromLegacyWatch({ ...base, matchBrand: false }).brand, undefined);
  // size relaxed -> size free, and the target becomes a unit price
  const sizeFree = specFromLegacyWatch({ ...base, matchSize: false });
  assert.equal(sizeFree.size, undefined);
  assert.equal(comparesByUnitPrice(sizeFree), true);
  // variant relaxed
  assert.equal(specFromLegacyWatch({ ...base, matchVariant: false }).variety, undefined);
  // all three relaxed -> PRICE_WATCH_V2 §3.3's "all recognized Chicken Breast"
  assert.deepEqual(
    specFromLegacyWatch({ ...base, matchBrand: false, matchSize: false, matchVariant: false }),
    { family: 'chicken', cut: 'breast' },
  );
  // a row with no derivable class -> empty spec, which validation refuses:
  // that watch becomes 'unresolvable' with a reason, never a silent match-all.
  assert.equal(validateSpec(specFromLegacyWatch({})).valid, false);
}

console.log('identity/spec.test.mjs — all assertions passed');
