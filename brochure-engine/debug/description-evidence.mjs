// Read-only: does D4D's own OCR description carry the price evidence a
// price-validation rule needs? Uses D4D items that STILL carry a real price as
// ground truth. No model calls; D4D search is the same read the engine makes.
import { createD4dOffersSource } from '../src/offers/d4dOffers.js';

const AR = '٠١٢٣٤٥٦٧٨٩';
const norm = (s) => String(s || '').replace(/[٠-٩]/g, (d) => String(AR.indexOf(d))).replace(/٫/g, '.');
// Price-like numbers: decimals (12.95 / 12,95) or integers NOT followed by a unit.
function priceNumbers(desc) {
  const t = norm(desc);
  const out = [];
  for (const m of t.matchAll(/(\d{1,5}(?:[.,]\d{1,2})?)(?!\s*(?:kg|g|gm|ml|l|ltr|ltrs|pcs|pc|x|%|'s|s\b|كجم|كيلو|غ|غم|جم|مل|لتر|حبة|قطعة))/gi)) {
    const v = Number(m[1].replace(',', '.'));
    if (Number.isFinite(v) && v > 0) out.push(v);
  }
  return out;
}
const eq = (a, b) => Math.abs(a - b) <= 0.01;
const src = createD4dOffersSource();
const stores = [[556, 'city-flower-556'], [471, 'prime-supermarket-471'], [63, 'lulu-hypermarket-63'], [62, 'carrefour-62'], [72, 'othaim-markets-72'], [68, 'tamimi-market-68']];
const S = { priced: 0, discounted: 0, curIn: 0, oldIn: 0, bothIn: 0, twoPlusNums: 0, lowestIsCur: 0, unpriced: 0, unpricedWithNums: 0, unpricedWithTwoPlus: 0 };
const samples = [];
for (const [c, slug] of stores) {
  const raws = await src.listOffers(c, { city: 'riyadh', storePageSlug: slug });
  for (const r of raws) {
    const nums = priceNumbers(r.description);
    const p = Number(r.price), o = Number(r.wasPrice);
    if (p > 0) {
      S.priced++;
      const ci = nums.some((n) => eq(n, p)); if (ci) S.curIn++;
      if (o > p) {
        S.discounted++;
        const oi = nums.some((n) => eq(n, o)); if (oi) S.oldIn++; if (ci && oi) S.bothIn++;
        const distinct = [...new Set(nums.map((n) => n.toFixed(2)))];
        if (distinct.length >= 2) S.twoPlusNums++;
        // Would "the lower of the two candidate prices" pick the true current?
        if (ci && oi && Math.min(p, o) === p) S.lowestIsCur++;
      }
      if (samples.length < 8 && o > p) samples.push({ price: p, was: o, nums, desc: norm(r.description).slice(0, 160).replace(/\s+/g, ' ') });
    } else {
      S.unpriced++;
      if (nums.length) S.unpricedWithNums++;
      if (new Set(nums.map((n) => n.toFixed(2))).size >= 2) S.unpricedWithTwoPlus++;
    }
  }
  console.log(slug, 'done', raws.length);
}
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + '%' : 'n/a');
console.log(JSON.stringify(S));
console.log(JSON.stringify({
  currentPriceInDescription: pct(S.curIn, S.priced),
  oldPriceInDescription_whenDiscounted: pct(S.oldIn, S.discounted),
  bothInDescription_whenDiscounted: pct(S.bothIn, S.discounted),
  unpricedItemsWithAnyPriceLikeNumber: pct(S.unpricedWithNums, S.unpriced),
  unpricedItemsWithTwoPlus: pct(S.unpricedWithTwoPlus, S.unpriced),
}));
for (const s of samples) console.log(JSON.stringify(s));
