// priceWatch.js — PRICE and QUANTITY normalization for Price Monitoring.
//
// What this module is NOT, any more: a matcher. Deciding whether a listing is
// the watched product used to live here as a conjunction of exact attribute
// equalities (brand ∧ family ∧ type ∧ size ∧ variant) in which a MISSING
// attribute on the candidate was a veto. That inverted the platform's own
// measured rule — registry/resolver.js scoreCandidate: "missing evidence is
// neutral, never a penalty" — and it was the direct cause of watches that went
// silent forever. Identity now belongs to the shared resolver, reached through
// identity/verify.js (strict) and identity/spec.js (flexible).
//
// What remains here is the part that was always sound and is genuinely
// watch-shaped: reading the amount a shopper actually pays out of a listing's
// several price-ish fields, and turning a pack into a comparable quantity.
//   • effectivePurchasePrice — the checkout amount (promotions, coupons,
//     bundle totals; strike-through prices never win)
//   • watchQuantity / quantityForOffer / unitPriceFor — pack -> SAR/kg, SAR/L
//   • variantKey — the sorted variant-token key, now consumed by the online
//     listing extractor rather than by a gate

import {
  normalizeText,
  parseSize,
  stripSizes,
} from './matching.js';
import { PRICE_BASIS_STATUS, resolvePriceBasis } from './lexicon/priceBasis.js';
import { REFERENCE_UNITS, unitPriceFromReference } from './lexicon/comparableQuantity.js';

const VARIANT_PHRASES = [
  'full fat', 'low fat', 'skimmed', 'lactose free', 'sugar free', 'zero sugar',
  'dry hair', 'oily hair', 'damaged hair', 'normal hair', 'colored hair',
  'anti dandruff', 'limited edition', 'intensive repair', 'peanut butter',
  'full cream', 'low calorie', 'extra virgin',
  'ice cream',
  'كامل الدسم', 'قليل الدسم', 'خالي الدسم', 'خالي اللاكتوز', 'خالي السكر',
  'للشعر الجاف', 'للشعر الدهني', 'للشعر التالف', 'ضد القشرة', 'إصدار محدود',
];

const VARIANT_WORDS = new Set([
  'classic', 'original', 'regular', 'diet', 'light', 'zero', 'white', 'dark',
  'vanilla', 'strawberry', 'mango', 'orange', 'lemon', 'mint', 'rose',
  'lavender', 'cherry', 'chocolate', 'caramel', 'hazelnut', 'coconut',
  'salted', 'unsalted', 'spicy', 'hot', 'mild', 'smoked', 'frozen', 'fresh',
  'crunchy', 'crispy', 'gold', 'premium', 'red', 'blue', 'green', 'black',
  'brown', 'blonde', 'floral', 'edition', 'twin', 'single', 'mini', 'xtra',
  'wafer', 'roll', 'rolls', 'repair', 'peanut',
  'كلاسيك', 'أصلي', 'عادي', 'دايت', 'خفيف', 'أبيض', 'اسود', 'أسود',
  'فانيلا', 'فراولة', 'مانجو', 'برتقال', 'ليمون', 'نعناع', 'ورد', 'لافندر',
  'كرز', 'شوكولاتة', 'كراميل', 'بندق', 'جوز', 'مملح', 'حار', 'مدخن',
  'مجمد', 'طازج', 'ذهبي', 'مميز', 'أحمر', 'ازرق', 'أزرق', 'أخضر', 'بني',
].map(normalizeText));

export function variantKey(text, family = null) {
  const norm = normalizeText(stripSizes(text || ''));
  if (!norm) return '';
  const found = new Set();
  for (const phrase of VARIANT_PHRASES) {
    const p = normalizeText(phrase);
    if (` ${norm} `.includes(` ${p} `)) found.add(p);
  }
  for (const word of norm.split(' ')) {
    if (!VARIANT_WORDS.has(word)) continue;
    // "Chocolate" is the product family for a Twix bar, but a flavour for
    // milk/protein products. Do not turn the identity noun into a variant.
    if (word === 'chocolate' && family === 'chocolate') continue;
    found.add(word);
  }
  return [...found].sort().join('|');
}

export function watchQuantity(name, sizeField = '', { unit = null, text = null } = {}) {
  const parsed = parseSize(name, sizeField);
  if (parsed?.unit && Number.isFinite(parsed.total) && parsed.total > 0) return parsed;

  const norm = normalizeText(`${name || ''} ${sizeField || ''}`);
  const sheets = /(?:^|\s)(\d{1,4})\s*(?:sheets?|ورقه|ورقة|ورقات)(?:\s|$)/u.exec(norm);
  if (sheets) {
    const total = Number(sheets[1]);
    return { unit: 'sheets', each: 1, pack: total, total, src: 'count' };
  }

  // LAST, and only when nothing above found a magnitude: the price may state its
  // own denominator ("PER KG", "/PC", "للكيلو"). Strictly additive — a watch
  // whose listing already parsed a size is untouched, so no existing target
  // price is renormalised by this branch. `sizeResolved` is false by
  // construction here, which is exactly the condition the reader wants.
  const basis = resolvePriceBasis({ unit, size: sizeField, name, text, sizeResolved: false });
  if (basis.status === PRICE_BASIS_STATUS.RESOLVED) {
    // Shaped like every other quantity here: `total` is the amount, `unit` is
    // what it is measured in. v3 also set a `pricing: 'per_unit'` flag that told
    // the arithmetic below to take a different branch; there is no different
    // branch any more, because there never needed to be one.
    return {
      unit: basis.unit,
      each: basis.quantity,
      pack: 1,
      total: basis.quantity,
      src: 'price_basis',
    };
  }
  return parsed;
}

// ONE division. `quantity` may be a `parseSize()` output (unit g/ml/pcs), a
// sheets count, or a price basis (unit kg/l/piece) — they differ only in the
// unit their `total` is expressed in, so they are converted to a reference and
// divided once. v3 branched on a `pricing` flag instead, and that branch is
// exactly where the multi-buy defect lived (see `quantityForOffer`).
export function unitPriceFor(price, quantity) {
  return unitPriceFromReference(price, referenceOf(quantity));
}

// A quantity in whatever unit it arrived in -> the denominator, in the unit a
// shopper compares in. Mirrors `comparableQuantity.js referenceFrom()`, plus the
// two shapes only Price Monitoring produces (sheets, and a basis already in
// reference units).
function referenceOf(quantity) {
  const total = Number(quantity?.total);
  if (!Number.isFinite(total) || total <= 0) return null;
  if (quantity.unit === 'g') return { quantity: total / 1000, unit: 'kg' };
  if (quantity.unit === 'ml') return { quantity: total / 1000, unit: 'l' };
  if (quantity.unit === 'sheets') return { quantity: total / 100, unit: '100-sheets' };
  if (quantity.unit === 'pcs') {
    return quantity.src === 'count-weak' ? null : { quantity: total, unit: 'piece' };
  }
  // Already a reference unit — a price basis, which needs no conversion.
  if (REFERENCE_UNITS.includes(quantity.unit)) return { quantity: total, unit: quantity.unit };
  return null;
}

const finitePositive = (value) => {
  const n = typeof value === 'string'
    ? Number(value.replace(/[^\d.,-]/g, '').replace(',', '.'))
    : Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function priceCandidates(candidate) {
  const values = [];
  const add = (value, role = '') => {
    const price = finitePositive(value);
    if (price != null) values.push({ price, role: String(role || '').toLowerCase() });
  };
  for (const key of [
    'finalPrice', 'checkoutPrice', 'couponPrice', 'memberPrice', 'salePrice',
    'offerPrice', 'nowPrice', 'currentPrice', 'price',
  ]) add(candidate?.[key], key);
  for (const entry of candidate?.prices || candidate?.priceCandidates || []) {
    if (entry && typeof entry === 'object') add(entry.price ?? entry.value ?? entry.text, entry.role);
    else add(entry);
  }
  return values.filter(({ role }) => !/(?:old|was|list|regular|rrp|mrp|unit)/.test(role));
}

export function purchaseTerms(candidate = {}) {
  // Product names and size labels describe what is already inside the selected
  // sellable pack. Treating "6+2 free" in a kitchen-towel title as a checkout
  // promotion multiplies a 10.99 SAR pack into a fabricated 65.94 SAR total.
  // Only explicit promotion fields may change the amount paid/received.
  const rawText = [
    candidate.promotion, candidate.offerText,
  ].filter(Boolean).join(' ').toLowerCase().replace(/,/g, '.');
  const text = normalizeText(rawText);

  let paid = 1;
  let received = 1;
  let advertisedTotal = null;

  let m =
    /(?:buy\s*)?(\d+)\s*(?:get|\+)\s*(\d+)(?:\s*free)?/u.exec(rawText) ||
    /(?:buy\s*)?(\d+)\s*get\s*(\d+)(?:\s*free)?/u.exec(text);
  if (m) {
    paid = Math.max(1, Number(m[1]));
    received = paid + Math.max(0, Number(m[2]));
  } else {
    m = /(?:^|\s)(\d+)\s*(?:for|ب)\s*(\d+(?:[.,]\d+)?)(?:\s*(?:sar|ريال))?(?:\s|$)/u.exec(text);
    if (m) {
      paid = received = Math.max(1, Number(m[1]));
      advertisedTotal = finitePositive(m[2]);
    }
  }
  return { paid, received, advertisedTotal };
}

// The amount paid at checkout for the represented offer. Strike-through/list
// prices never win. Explicit member/coupon/final prices do; numeric coupon
// fields are applied when the source exposes only a base price.
export function effectivePurchasePrice(candidate = {}) {
  const candidates = priceCandidates(candidate);
  if (!candidates.length) return null;
  const selected = candidates.reduce((best, item) => (
    item.price < best.price ? item : best
  ));
  let price = selected.price;

  // Establish the checkout quantity/total before applying a coupon. Otherwise
  // an advertised bundle total ("2 for 40") overwrites the discount that was
  // just calculated and reports 40 instead of the actual 36 after a 10% code.
  const terms = purchaseTerms(candidate);
  if (terms.advertisedTotal != null) price = terms.advertisedTotal;
  else if (terms.paid > 1) price *= terms.paid;

  const promoText = [
    candidate.discountLabel, candidate.promotion, candidate.offerText, candidate.description,
  ].filter(Boolean).join(' ');
  const textPercent =
    /(\d+(?:[.,]\d+)?)\s*%\s*(?:off\s*)?(?:with\s*)?(?:coupon|code)/iu.exec(promoText) ||
    /(?:coupon|code)[^\d]{0,12}(\d+(?:[.,]\d+)?)\s*%/iu.exec(promoText);
  const textAmount =
    /(\d+(?:[.,]\d+)?)\s*(?:sar|ريال)\s*(?:off\s*)?(?:with\s*)?(?:coupon|code)/iu.exec(promoText);
  const couponAmount = finitePositive(
    candidate.couponAmount ?? candidate.couponDiscount ?? textAmount?.[1],
  );
  const couponPercent = finitePositive(
    candidate.couponPercent ?? candidate.couponDiscountPercent ?? textPercent?.[1],
  );
  // couponPrice (or an array entry explicitly labelled as a coupon price) is
  // already post-coupon. Do not apply the same structured coupon a second time.
  if (!selected.role.includes('coupon')) {
    if (couponAmount != null && couponAmount < price) price -= couponAmount;
    else if (couponPercent != null && couponPercent < 100) price *= 1 - couponPercent / 100;
  }

  return Math.round(price * 100) / 100;
}

export function quantityForOffer(candidate = {}) {
  const base = watchQuantity(candidate.name, candidate.size, {
    unit: candidate.unit ?? null,
    text: [candidate.nameAr, candidate.name_ar].find((v) => typeof v === 'string' && v.trim()) ?? null,
  });
  if (!base?.unit || !base.total) return base;
  const terms = purchaseTerms(candidate);
  if (terms.received <= 1) return base;
  // A multi-buy scales what the shopper RECEIVES, and it scales it the same way
  // whatever the denominator is: "buy 2 get 1" on a 1.7 kg bag is 5.1 kg for two
  // bags' money, and on a per-kilo price it is 3 kg for two kilos' money.
  //
  // v3 exempted a stated denominator here, reasoning that "you cannot multiply
  // per-kilo". That was the pricing-mode error in miniature, and it was wrong in
  // the expensive direction: `effectivePurchasePrice` still scaled the PRICE by
  // `paid`, so a per-kilo product under "buy 2 get 1" reported 8.00 SAR/kg
  // against an undiscounted 4.00 — a promotion that doubled the advertised unit
  // price. Latent only because nothing populates `promotion` yet.
  return {
    ...base,
    pack: (base.pack || 1) * terms.received,
    total: base.total * terms.received,
  };
}
