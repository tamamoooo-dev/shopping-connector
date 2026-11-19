// offers/secondRead.js — when a flyer crop is read a second time (owner,
// 2026-11-19: "make rules for the two products crops or any difficult crops
// .. if it is necessary it could be read twice as an exception .. keep it
// tight up to 5 percent").
//
// The PC reader reads ten crops a call from their pixels alone. A crop cut
// from a flyer page can hold two products, a choice of products, or the
// edges of neighbouring offers, and then the reading may name the wrong
// product, both products, or none. Such a crop is read once more ON ITS OWN,
// told D4D's price ("read ONLY the offer sold at 8.99 SAR"), when:
//
//   'price'     D4D's price is on no price line of the reading (the engine
//               would then tie no size to it and show "see the image");
//   'name'      the reading names no product;
//   'products'  the crop shows two or more selling prices and the name joins
//               products ("KitKat 2 Finger … OR KitKat Miniatures").
//
// Measured on 314 random current crops: 2.5% read twice; on 117 difficult
// ones the second read named the product at D4D's price (Kako White bread at
// 3.95, not the Brown at 4.50; KitKat Miniatures at 8.99) and refused where
// D4D's price is not a selling price in the crop (a blender's "1.9 Ltr").
// Pure: the engine's tests and the PC reader (pc-reader/vision.mjs) share it.

export const SECOND_READ_SHARE = 0.05;

const cents = (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
};
const text = (s) => (typeof s === 'string' ? s.trim() : '');
// "A / B", "A or B", "A أو B": the reading names more than one product.
const JOINED = /\s(?:or|\/)\s|\sأو\s/iu;

// D4D's price selects a line the way the engine does (selectSaleObservation):
// the price lines at that price must agree on size and deal. A reading with
// no price lines has its one current price.
export function priceFound(entry, price) {
  const p = cents(price);
  if (p == null || !entry || typeof entry !== 'object') return false;
  if (!Array.isArray(entry.sale_options)) return cents(entry.current_price) === p;
  const lines = entry.sale_options.filter((o) => cents(o?.current_price) === p);
  const kinds = new Set(lines.map((o) => JSON.stringify([o.package_size ?? null, o.sale_count ?? null, o.sale_count_text ?? null])));
  return kinds.size === 1;
}

const named = (entry) => !!(entry && (text(entry.name_en) || text(entry.name_ar)));

// -> 'price' | 'name' | 'products' | null (read once is enough).
export function secondReadReason(entry, price) {
  if (cents(price) == null) return null; // no D4D price to ask about
  if (!entry || typeof entry !== 'object') return null; // no answer: the batch path retries it
  if (!priceFound(entry, price)) return 'price';
  if (!named(entry)) return 'name';
  const prices = new Set((Array.isArray(entry.sale_options) ? entry.sale_options : [])
    .map((o) => cents(o?.current_price)).filter((v) => v != null));
  if (prices.size > 1 && JOINED.test(`${text(entry.name_en)} ${text(entry.name_ar)}`)) return 'products';
  return null;
}

// The second reading replaces the first unless it is worse: price found
// counts most, then a name. It was asked the exact question, so on a tie it
// wins.
export function chooseReading(first, second, price) {
  if (!second || typeof second !== 'object') return first;
  const score = (e) => (priceFound(e, price) ? 2 : 0) + (named(e) ? 1 : 0);
  const s2 = score(second);
  return s2 > 0 && s2 >= score(first) ? second : first;
}

// How many second reads a run may make so far: 5% of the crops it fetched,
// rounded DOWN, so no run goes over (a run of 19 crops reads none twice).
export function secondReadsAllowed(crops) {
  return Math.floor(SECOND_READ_SHARE * Math.max(0, Number(crops) || 0) + 1e-9);
}
