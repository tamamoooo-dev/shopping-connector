import { CORROBORATION_FLOOR } from '../offers/servingFloor.js';

// Use the same published, unchanged-crop rule as Stage 2: a successful first
// reading is settled even if its dormant verification row is still queued.
export const SETTLED_OFFER_SQL = `COALESCE((
  (NULLIF(TRIM(e.name), '') IS NOT NULL OR NULLIF(TRIM(e.name_ar), '') IS NOT NULL)
  AND e.corroboration >= ${CORROBORATION_FLOOR}
  AND e.crop_url = o.image_url AND e.mint_verdict = 'minted'
  AND s.offer_id IS NOT NULL AND s.match_band IN ('auto', 'created')
  AND v.accepted = 1 AND q.status <> 'claimed'
  AND (q.status = 'verified' OR q.initial_outcome = 'accepted')
  AND (r.status IS NULL OR r.status IN ('resolved', 'dismissed'))
  AND (ocr.status IS NULL OR ocr.status = 'completed')
), 0)`;

export const PROCESSING_JOINS_SQL = `
 LEFT JOIN offer_enrichments e ON e.id = o.id
 LEFT JOIN offer_acceptance_verdicts v ON v.offer_id = o.id
 LEFT JOIN offer_vision_verification_queue q ON q.offer_id = o.id
 LEFT JOIN offer_recovery_queue r ON r.offer_id = o.id
 LEFT JOIN offer_ocr_queue ocr ON ocr.offer_id = o.id
 LEFT JOIN product_sightings s ON s.offer_id = o.id`;

export function processingComplete(row, meta, hotspots, snapshot) {
  if (row.source_type !== 'images' || !snapshot || !snapshot.offers?.length) return false;
  const pages = meta?.pages;
  if (meta?.complete !== true || !Number.isInteger(meta.advertisedPageCount)
      || !Array.isArray(pages) || !pages.length || pages.length !== meta.advertisedPageCount
      || !pages.every((p, i) => p.index === i
        && typeof p.imageUrl === 'string'
        && p.imageUrl.startsWith(`brochures/${row.storage_key}/page`))
      || !Array.isArray(hotspots?.pages) || hotspots.pages.length !== pages.length
      || new Set(hotspots.pages.map(p => p.index)).size !== pages.length) return false;
  if (!snapshot.offers.every(o => o.brochure_id === row.id
      && Number(o.processing_complete) === 1
      && Number.isInteger(o.page_index) && pages[o.page_index])) return false;
  // No missing hotspot product can be mistaken for a completed extraction.
  const offered = new Set(snapshot.offers.map(o => String(o.offer_id)));
  const rejected = new Set();
  for (const p of snapshot.pending || []) {
    if (p.status === 'rejected') rejected.add(String(p.offer_id));
    else if (!['accepted', 'superseded'].includes(p.status) || !offered.has(String(p.offer_id))) return false;
  }
  let expected = 0;
  for (const page of hotspots.pages) {
    if (!Number.isInteger(page.index) || !pages[page.index] || !Array.isArray(page.spots)) return false;
    for (const spot of page.spots) {
      if (spot.offerId == null) return false;
      expected += 1;
      if (!offered.has(String(spot.offerId)) && !rejected.has(String(spot.offerId))) return false;
    }
  }
  return expected > 0;
}
