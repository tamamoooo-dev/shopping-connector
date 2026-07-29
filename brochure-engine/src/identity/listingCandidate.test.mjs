import assert from 'node:assert/strict';
import {
  listingBrand,
  listingIdentityCandidate,
  listingSemantics,
  listingSize,
} from './listingCandidate.js';
import { readFromIdentityCandidate } from '../registry/candidate.js';

const listing = (over = {}) => ({
  id: '12345',
  name: 'Sadia Chicken Breast 900 g',
  image: 'https://cdn.example/img/sadia-breast.jpg',
  price: 24.95,
  oldPrice: null,
  currency: 'SAR',
  link: 'https://panda.sa/en/p/12345.sadia-chicken-breast',
  size: '900 g',
  brand: 'Sadia',
  discountLabel: '',
  ...over,
});

// --- semantics ----------------------------------------------------------------
{
  const s = listingSemantics(listing());
  assert.equal(s.family, 'chicken', 'family from the bilingual taxonomy');
  assert.equal(s.cut, 'breast', 'cut from the form taxonomy');
}

// Word order must not change the identity — the fragmentation case.
{
  const a = listingSemantics(listing({ name: 'Sadia Chicken Breast 900 g' }));
  const b = listingSemantics(listing({ name: 'Chicken Breast Sadia 900 g' }));
  assert.deepEqual(a, b, 'word order is not identity');
}

// Arabic and English titles for the same product must produce the same
// canonical semantics — that is what lets a flyer-minted product be verified
// against an online listing.
{
  const en = listingSemantics(listing({ name: 'Sadia Chicken Breast 900 g' }));
  const ar = listingSemantics(listing({ name: 'ساديا صدور دجاج 900 جم', brand: 'ساديا' }));
  assert.equal(ar.family, en.family, 'family is language-independent');
  assert.equal(ar.cut, en.cut, 'cut is language-independent');
}

// --- processing vs variety ----------------------------------------------------
{
  const s = listingSemantics(listing({ name: 'Sadia Frozen Chicken Breast 900 g' }));
  assert.equal(s.processing, 'frozen');
  assert.ok(
    !String(s.variety || '').includes('frozen'),
    'a processing word must not also be counted as a variety',
  );
}
// REGRESSION: matching.js PROCESSED_MARKERS deliberately contains frozen-food
// BRAND names (sadia, seara, alkabeer…) for its fresh-produce demotion, and its
// contract says "صدور ساديا etc. are unaffected". Deriving `processing` from it
// generally stamped processing:'processed' on every Sadia product from the
// brand alone — which the resolver then treats as identity-bearing and vetoes
// on ('processing-not-evidenced') against the same product read elsewhere.
// The generic fallback must stay inside its declared scope: produce.
{
  assert.equal(
    listingSemantics(listing({ name: 'Sadia Chicken Breast 900 g', brand: 'Sadia' })).processing,
    null,
    'a frozen-food BRAND alone must never set processing',
  );
  assert.equal(
    listingSemantics(listing({ name: 'Sadia Frozen Chicken Breast 900 g', brand: 'Sadia' })).processing,
    'frozen',
    'but a real processing word still does',
  );
  assert.equal(
    listingSemantics(listing({ name: 'Montana Strawberry 1 kg', brand: 'Montana' })).processing,
    'processed',
    'and the produce fallback still fires where it was designed to',
  );
}

// REGRESSION (production, 2026-07-29): a processing word must be excluded from
// `variety` in EVERY surface form, not just its canonical value. Filtering on
// values alone left the Arabic forms behind, so the same product in two
// languages disagreed on variety — and the resolver vetoes that pair
// (variety-not-evidenced), which is a silent non-match. It also let one concept
// counted twice satisfy the resolver's two-dimension minimum, minting a product
// that should have asked for confirmation.
{
  const ar = listingSemantics(listing({ name: 'ساديا صدور دجاج مجمدة 900 جم', brand: 'ساديا' }));
  const en = listingSemantics(listing({ name: 'Sadia Frozen Chicken Breast 900 g', brand: 'Sadia' }));
  assert.equal(ar.processing, 'frozen', 'the Arabic form sets processing');
  assert.equal(en.processing, 'frozen', 'and so does the English form');
  assert.equal(ar.variety, en.variety, 'the two languages must agree on variety');
  assert.equal(ar.variety, null, 'the processing word appears in exactly one dimension');
}

{
  const s = listingSemantics(listing({ name: 'Almarai Full Fat Milk 1 L', brand: 'Almarai' }));
  assert.equal(s.family, 'milk');
  assert.ok(String(s.variety).includes('full fat'), 'variant phrases land in variety');
  assert.equal(s.processing, null, 'a variant is not processing');
}

// --- brand --------------------------------------------------------------------
{
  assert.equal(listingBrand(listing()), 'sadia', 'the structured brand field wins');
  assert.equal(
    listingBrand(listing({ brand: '', name: 'Almarai Fresh Milk 1 L' })),
    'almarai',
    'an empty brand column falls back to the title',
  );
  assert.equal(listingBrand(listing({ brand: '', name: 'Chicken Breast 900 g' })), null);
}

// --- size ---------------------------------------------------------------------
{
  const { size, count } = listingSize(listing());
  assert.deepEqual(size, { value: 900, unit: 'g' });
  assert.equal(count, null, 'a single pack carries no count');
}
{
  const { size, count } = listingSize(listing({ name: 'Nadec Milk 6 x 200 ml', size: '' }));
  assert.deepEqual(size, { value: 200, unit: 'ml' }, 'per-item size, not the pack total');
  assert.equal(count, 6);
}
{
  const { size, count } = listingSize(listing({ name: 'Eggs 30 pieces', size: '' }));
  assert.equal(size, null, 'a piece count is not a measured size');
  assert.equal(count, 30);
}
{
  const { size } = listingSize(listing({ name: 'Mystery Item', size: '' }));
  assert.equal(size, null, 'an unreadable size is null, never invented');
}

// --- the full candidate, and the resolver's own acceptance --------------------
{
  const c = listingIdentityCandidate(listing());
  assert.equal(c.brand, 'sadia');
  assert.equal(c.family, 'chicken');
  assert.equal(c.cut, 'breast');
  assert.deepEqual(c.size, { value: 900, unit: 'g' });

  // The real gate: the registry's own adapter must accept it and project a
  // read. This is what proves the extractor speaks the resolver's contract
  // rather than a look-alike of it.
  const r = readFromIdentityCandidate(c);
  assert.equal(r.ok, true, `read must project: ${JSON.stringify(r.errors || [])}`);
  assert.equal(r.read.corroboration, 1, 'structured retailer data is self-evidencing');
  assert.deepEqual(r.read.size, { unit: 'g', each: 900, pack: 1 });
  assert.ok(r.read.tokens.includes('family:chicken'));
  assert.ok(r.read.tokens.includes('cut:breast'));
}

// A single-dimension listing is INSUFFICIENT for automatic resolution — that
// is the resolver's rule and the watch layer must inherit it rather than
// invent a weaker one. Watch creation handles this in the foreground.
{
  const c = listingIdentityCandidate(listing({ name: 'Pepsi 1 L', brand: 'Pepsi', size: '1 L' }));
  const r = readFromIdentityCandidate(c);
  assert.equal(r.ok, false, 'family alone cannot establish identity');
  assert.equal(r.verdict, 'insufficient_identity_candidate');
}

// A named variety lifts the same listing to two dimensions.
{
  const c = listingIdentityCandidate(listing({ name: 'Pepsi Diet 1 L', brand: 'Pepsi', size: '1 L' }));
  const r = readFromIdentityCandidate(c);
  assert.equal(r.ok, true, 'family + variety is sufficient');
}

// --- degenerate input ---------------------------------------------------------
{
  assert.equal(listingIdentityCandidate(null), null);
  assert.equal(listingIdentityCandidate({ name: '   ' }), null);
}

console.log('identity/listingCandidate.test.mjs — all assertions passed');
