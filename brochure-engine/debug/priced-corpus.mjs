// Read-only: dump D4D items that still carry a real price (ground truth) with
// their OCR description, as JSON lines, for offline rule evaluation.
import { createD4dOffersSource } from '../src/offers/d4dOffers.js';
const src = createD4dOffersSource();
for (const [c, slug] of [[556, 'city-flower-556'], [471, 'prime-supermarket-471'], [63, 'lulu-hypermarket-63'], [62, 'carrefour-62'], [72, 'othaim-markets-72'], [68, 'tamimi-market-68']]) {
  for (const r of await src.listOffers(c, { city: 'riyadh', storePageSlug: slug })) {
    if (Number(r.price) > 0) console.log('ROW ' + JSON.stringify({ id: r.offerId, flyer: r.flyerRef, p: Number(r.price), o: Number(r.wasPrice) || null, d: r.description }));
  }
}
