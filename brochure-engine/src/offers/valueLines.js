// offers/valueLines.js — every saved flyer price of a product, PRICED per kg /
// litre / piece (2026-11-20).
//
// The brochure card shows the lowest price per kg / L / piece a product has had
// at this store and at any store, in any size. Only the engine may say what a
// price is per kilo (Comparable Quantity v4: one reference quantity, refuse
// rather than guess), so every saved line is priced here by the SAME read-path
// code as a live offer — applyEnrichment -> applyUnitPrice — at read time. No
// column, no migration, nothing written.
//
// Two sources, one shape:
//   - the permanent archive (storage/offerArchive.js), one row per old flyer
//     offer. It keeps the name, the size Vision read and the price, but not the
//     sale reading, so a multi-buy ("2 for 10") is priced as one package: its
//     value comes out HIGHER than it was. That can hide a low, never fake one.
//   - offers still in the offers table (this week's and the ones that ended in
//     the last two weeks, before retention archives them), with their full
//     enrichment.
//
// Which lines are the SAME product is the card's decision (its exact
// same-product rule, live-shopping-assistant src/viewer/sameProduct.js); this
// module only reads and prices.

import { detectBrand } from '../browse/brands.js';
import { rowToOffer } from './contract.js';
import { applyEnrichment } from './enrich.js';
import { CORROBORATION_FLOOR } from './servingFloor.js';

const sourceOf = (id) => String(id || '').split(':')[2] || null;

function line(offer, extra) {
  const out = {
    id: offer.id,
    store: offer.store,
    region: offer.region ?? null,
    price: offer.price,
    oldPrice: offer.oldPrice ?? null,
    currency: offer.currency ?? 'SAR',
    name: offer.name ?? null,
    nameAr: offer.nameAr ?? null,
    size: offer.size ?? null,
    brandSlug: offer.brandSlug ?? null,
    unitPrice: offer.unitPrice ?? null,
    quantityReviewRequired: !!offer.quantityReviewRequired,
    validFrom: extra.validFrom ?? null,
    validTo: extra.validTo ?? null,
    origin: extra.origin,
  };
  if (offer.brandSlugs?.length) out.brandSlugs = offer.brandSlugs;
  if (offer.sizeUnbound) out.sizeUnbound = true;
  if (offer.saleQuantity) out.saleQuantity = offer.saleQuantity;
  if (extra.image) out.image = extra.image;
  if (extra.link) out.link = extra.link;
  return out;
}

// One archive row -> a priced line. The archive's name IS the display name it
// had (servable Vision, else the flyer text) and its size is the size Vision
// read, so they enter the read path as that reading. The brand is stamped the
// way ingest stamps it (detectBrand on the names), then refined by the title
// reader exactly as for a live offer.
export function archiveLine(row) {
  const offer = {
    id: row.id,
    store: row.store,
    region: row.region ?? null,
    source: sourceOf(row.id),
    name: row.name ?? null,
    nameAr: row.name_ar ?? null,
    price: row.price,
    oldPrice: row.old_price ?? null,
    currency: row.currency ?? 'SAR',
    category: row.category ?? null,
  };
  offer.brandSlug = detectBrand(offer) || null;
  applyEnrichment(offer, {
    e_name: row.name ?? null,
    e_name_ar: row.name_ar ?? null,
    e_corroboration: CORROBORATION_FLOOR,
    e_size: row.size || null,
    search_text: row.match_text || null,
    category: row.category ?? null,
  });
  return line(offer, {
    validFrom: row.valid_from,
    validTo: row.valid_to,
    image: row.image_url,
    link: row.source_url,
    origin: 'archive',
  });
}

// One offers-table row (with its enrichment columns) -> a priced line.
export function offerLine(row) {
  const offer = rowToOffer(row);
  applyEnrichment(offer, row);
  return line(offer, { validFrom: row.valid_from, validTo: row.valid_to, origin: 'offers' });
}

// GET /prices/lines?q= — both sources, one line per offer id (the offers table
// wins: it has the sale reading), newest first. Lines without a price are left
// out; lines without a value stay (the card compares those by size, or not).
export async function valueLinesDoc(q, { offerArchive, offerStore, limit = 1000 } = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 1000, 2000));
  const [archived, live] = await Promise.all([
    offerArchive ? offerArchive.search({ q, limit: bounded }) : { rows: [] },
    offerStore ? offerStore.search({ q, currentOn: null, limit: 300 }) : [],
  ]);
  const byId = new Map();
  for (const row of live || []) {
    if (!(Number(row.price) > 0)) continue;
    byId.set(row.id, offerLine(row));
  }
  let fromArchive = 0;
  for (const row of archived.rows || []) {
    if (!(Number(row.price) > 0) || byId.has(row.id)) continue;
    byId.set(row.id, archiveLine(row));
    fromArchive += 1;
  }
  const lines = [...byId.values()].sort((a, b) =>
    String(b.validFrom || '').localeCompare(String(a.validFrom || '')) || a.price - b.price);
  const dates = lines.map((l) => l.validFrom).filter(Boolean).sort();
  return {
    query: q,
    lines: lines.length,
    archived: fromArchive,
    truncated: !!archived.truncated,
    first: dates[0] || null,
    last: dates[dates.length - 1] || null,
    offers: lines,
    note: 'Every saved flyer price for this search, priced per kg / litre / piece by the engine. Old flyer lines keep no multi-buy reading, so a "2 for" deal shows a higher value than it was. Prices are machine-extracted from flyer images; the flyer itself prevails on any mismatch.',
  };
}
