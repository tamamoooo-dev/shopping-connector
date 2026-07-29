import assert from 'node:assert/strict';
import { productFromListing } from './listingCandidate.js';
import { listingRead, productForWatch, verifyListing, VERIFY_REASON } from './verify.js';
import { createMemRegistryStore } from '../registry/memstore.js';
import { profileTokens } from '../registry/model.js';
import { decodeProfile } from '../registry/model.js';

const DATE = '2026-07-29';

const listing = (over = {}) => ({
  id: '12345',
  name: 'Sadia Chicken Breast 900 g',
  price: 24.95,
  currency: 'SAR',
  link: 'https://panda.sa/en/p/12345.sadia-chicken-breast',
  size: '900 g',
  brand: 'Sadia',
  ...over,
});

const productOf = (over = {}) =>
  productFromListing(listing(over), { date: DATE, week: DATE, store: 'panda' });

// --- the happy path: a listing verifies against the product it founded -------
{
  const product = productOf();
  assert.ok(product, 'a two-dimension listing founds a product');
  assert.equal(product.family, 'chicken');
  assert.equal(product.size_unit, 'g');
  assert.equal(product.size_total, 900);

  const v = verifyListing(listing(), product);
  assert.equal(v.matched, true, `should verify: ${v.reason}`);
  assert.equal(v.reason, null);
  assert.ok(v.score >= 0.7);
}

// Word order and language must not break verification — the fragmentation case
// the old exact-key matcher could not survive.
{
  const product = productOf();
  for (const name of [
    'Chicken Breast Sadia 900 g',
    'Sadia Chicken Breast 900g',
    'ساديا صدور دجاج 900 جم',
  ]) {
    const v = verifyListing(listing({ name, brand: 'Sadia' }), product);
    assert.equal(v.matched, true, `"${name}" should still verify (${v.reason})`);
  }
}

// --- the vetoes that must still fire ----------------------------------------
{
  const product = productOf();
  // The reason must NAME the conflicting dimension. A generic
  // "attribute-conflict" is the vague answer this redesign exists to stop
  // giving — it is what an operator reads when a watch has been quiet for a
  // week and the product is visibly on the shelf.
  const cases = [
    ['Sadia', 'Sadia Chicken Nuggets 900 g', 'cut-conflict'],
    ['Sadia', 'Sadia Chicken Breast 450 g', 'size-conflict'],
    ['Americana', 'Americana Chicken Breast 900 g', 'brand-conflict'],
    ['Sadia', 'Sadia Beef Burger 900 g', 'family-conflict'],
  ];
  for (const [brand, name, expected] of cases) {
    const v = verifyListing(listing({ name, brand, size: '' }), product);
    assert.equal(v.matched, false, `"${name}" must not verify`);
    assert.equal(v.reason, expected, `"${name}" must be rejected as ${expected}`);
  }
}

// An UNKNOWN brand abstains rather than vetoing, and that is deliberate.
// The brand lexicon covers a minority of the market, so treating "I cannot
// canonicalize this brand" as "different brand" would resurrect exactly the
// silent-failure class this redesign exists to delete. The registry measured
// the same trade (resolver.js brandRelation: a missing brand stays neutral).
// The cost is a possible wrong alert, which the user SEES and can act on;
// the alternative cost is a watch that goes quiet forever, which nobody sees.
{
  const product = productOf();
  const v = verifyListing(
    listing({ name: 'Alyoum Chicken Breast 900 g', brand: 'Alyoum' }),
    product,
  );
  assert.equal(v.matched, true, 'an unresolvable brand must not veto');
}

// --- missing evidence ABSTAINS, it does not veto -----------------------------
// This is the exact inversion of the deleted watch matcher, and the single
// behavioural reason the silent-failure class existed.
{
  const product = productOf();
  // A store that publishes no brand column and no size field. The old gate
  // read both absences as "different" and went silent forever.
  const thin = listing({ name: 'Chicken Breast', brand: '', size: '' });
  const v = verifyListing(thin, product);
  assert.equal(v.matched, true, `unknown must abstain, not veto (${v.reason})`);
}

// --- rejections are explained, never silent ----------------------------------
{
  const product = productOf();
  const v = verifyListing({ name: '   ' }, product);
  assert.equal(v.matched, false);
  assert.equal(v.reason, VERIFY_REASON.NO_NAME);

  const thin = listingRead(listing({ name: 'Pepsi 1 L', brand: 'Pepsi', size: '1 L' }));
  assert.equal(thin.ok, false);
  assert.equal(thin.reason, VERIFY_REASON.INSUFFICIENT);

  assert.equal(verifyListing(listing(), null).reason, 'no-product');
}

// --- a listing too thin to found a product ----------------------------------
{
  assert.equal(
    productFromListing(listing({ name: 'Pepsi 1 L', brand: 'Pepsi' }), { date: DATE }),
    null,
    'one dimension cannot mint — watch creation surfaces this in the foreground',
  );
}

// --- merge relocation: a watch follows the tombstone chain -------------------
{
  const store = createMemRegistryStore();
  const a = productOf();
  const b = productOf({ name: 'Sadia Chicken Breast 900 g Frozen' });
  await store.createProduct(a, profileTokens(decodeProfile(a.token_profile)));
  await store.createProduct(b, profileTokens(decodeProfile(b.token_profile)));
  await store.tombstoneProduct(a.id, b.id);

  const landed = await productForWatch(store, a.id);
  assert.equal(landed.productId, b.id, 'a merged watch re-anchors on the survivor');
  assert.equal(landed.moved, true, 'the caller is told to persist the hop');
  assert.equal(landed.product.id, b.id);

  const direct = await productForWatch(store, b.id);
  assert.equal(direct.moved, false, 'an unmerged product does not move');

  assert.deepEqual(
    await productForWatch(store, 'pr_missing'),
    { product: null, productId: 'pr_missing', moved: false },
    'a vanished product is reported, not thrown',
  );
}

console.log('identity/verify.test.mjs — all assertions passed');
