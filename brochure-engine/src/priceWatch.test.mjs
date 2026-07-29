// priceWatch.test.mjs — PRICE and QUANTITY normalization.
//
// The attribute-matching half of this module was deleted in the product-anchor
// redesign (identity belongs to the shared resolver now — see
// identity/verify.js, identity/spec.js, watchAnchor.test.mjs). What remains is
// the part that was always sound: reading the amount a shopper actually pays,
// and turning a pack into a comparable quantity. Every production regression
// the old suite guarded is preserved here verbatim.
import assert from 'node:assert/strict';
import {
  effectivePurchasePrice,
  purchaseTerms,
  quantityForOffer,
  unitPriceFor,
  variantKey,
  watchQuantity,
} from './priceWatch.js';

let passed = 0;
const eq = (actual, expected, msg) => { assert.deepEqual(actual, expected, msg); passed += 1; };
const near = (a, b, msg) => { assert.ok(Math.abs(a - b) < 1e-6, `${msg} (${a} vs ${b})`); passed += 1; };

// --- the amount actually paid ---------------------------------------------------
{
  eq(effectivePurchasePrice({ price: 12, oldPrice: 18 }), 12, 'a strike-through price never wins');
  eq(effectivePurchasePrice({ price: 12, memberPrice: 10 }), 10, 'a member price does');
  eq(effectivePurchasePrice({ price: 20, couponPercent: 10 }), 18, 'a structured coupon applies');
  eq(effectivePurchasePrice({ price: 30, couponPrice: 25, couponAmount: 5 }), 25,
    'a post-coupon price is never discounted twice');
  eq(effectivePurchasePrice({ price: 20, discountLabel: '10% off with coupon' }), 18,
    'a coupon stated in text applies');
  eq(effectivePurchasePrice({
    priceCandidates: [
      { text: 'SAR 88.95', role: 'old' },
      { text: 'SAR 71.99', role: 'current' },
    ],
  }), 71.99, 'role-labelled candidates: the old price is excluded');
}

// --- promotions change the amount, and only explicit promotion fields may ------
{
  eq(effectivePurchasePrice({ price: 6, promotion: '2 for 10 SAR' }), 10, 'an advertised bundle total wins');
  eq(effectivePurchasePrice({ price: 25, promotion: '2 for 40 SAR', couponPercent: 10 }), 36,
    'the coupon applies AFTER the bundle total, not instead of it');
  eq(effectivePurchasePrice({ price: 6, promotion: 'Buy 2 Get 1 Free' }), 12, 'buy-2-get-1 pays for two');
  eq(effectivePurchasePrice({ price: 6, promotion: '2+1 free' }), 12, 'the "+" form too');
  eq(quantityForOffer({ name: 'Milk 1 L', promotion: 'Buy 2 Get 1 Free' }).total, 3000,
    'and the received quantity is three litres');

  const terms = purchaseTerms({ promotion: 'Buy 3 Get 1 Free' });
  eq([terms.paid, terms.received], [3, 4], 'paid and received are tracked separately');
}

// --- production regressions (do not relax these) --------------------------------
{
  // Arabic multipack notation must parse 3 × 450 g, never 450 × 450 g.
  const candidate = {
    name: 'ساديا - صدور دجاج مجمدة  ٣*٤٥٠ غرام',
    brand: 'ساديا', price: 52.5, currency: 'SAR',
  };
  const q = quantityForOffer(candidate);
  eq(q.pack, 3, 'Arabic multipack: pack of 3');
  eq(q.total, 1350, 'Arabic multipack: 1350 g total');
  near(unitPriceFor(candidate.price, q).value, 52.5 / 1.35, 'and its per-kg price');
}
{
  // "6+2 free" is the selected pack quantity, not an instruction to buy six
  // separate packs at checkout — that bug multiplied 10.99 into 65.94.
  const candidate = {
    id: 25200, name: 'مناديل مطبخ أونو (6+2 مجانا) 28 سم',
    price: 10.99, oldPrice: 16.5, size: '1 حبة', currency: 'SAR',
  };
  eq(effectivePurchasePrice(candidate), 10.99, 'a bonus pack does not multiply the price');
  const q = quantityForOffer(candidate);
  eq(q.total, 8, 'but it does set the quantity to 8');
  near(unitPriceFor(candidate.price, q).value, 1.37375, 'per-100-sheets price');
}

// --- quantity and unit conversion ------------------------------------------------
{
  eq(watchQuantity('Almarai Milk 2 L', '').total, 2000, 'litres normalize to ml');
  eq(watchQuantity('Tissues 150 sheets', '').unit, 'sheets', 'sheet counts are their own unit');
  eq(unitPriceFor(10, { unit: 'g', total: 500 }).label, 'SAR/kg', 'grams compare per kg');
  eq(unitPriceFor(10, { unit: 'ml', total: 250 }).label, 'SAR/L', 'millilitres per litre');
  eq(unitPriceFor(10, { unit: 'pcs', total: 4, src: 'count' }).label, 'SAR/Piece', 'real counts per piece');
  eq(unitPriceFor(10, { unit: 'pcs', total: 4, src: 'count-weak' }), null,
    'a weak count is never advertised per piece');
  eq(unitPriceFor(0, { unit: 'g', total: 500 }), null, 'a zero price yields no unit price');
}

// --- variantKey: order-independent, and consumed by the extractor now ----------
{
  eq(variantKey('Almarai Full Fat Milk 1 L'), 'full fat', 'a variant phrase is extracted');
  eq(variantKey('Milk Full Fat 1 L'), variantKey('Full Fat Milk 1 L'), 'word order is irrelevant');
  eq(variantKey('Twix Chocolate Twin 50 g', 'chocolate'), 'twin',
    'the family noun is not also a variant');
  eq(variantKey(''), '', 'empty text yields no key');
}

console.log(`priceWatch.test: ${passed} passed, 0 failed`);
