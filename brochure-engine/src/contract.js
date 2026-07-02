// contract.js — the normalized Brochure contract (ARCHITECTURE.md §4) plus the
// pure helpers that derive identity/edition/keys from a brochure.
//
// This is the HARD contract between collectors, the pipeline, storage, and the
// read API — the brochure analogue of the search connector's frozen 10-key
// result. Treat it like that contract: change it and you touch every collector.
//
// BrochureDoc (one weekly brochure for one store+region):
//   { store, region, title, validFrom, validTo, detectedAt, sourceType,
//     sourceUrl, pdfUrl, pages, checksum, collector, edition, storageKey, id }
//
// Nothing here knows any store name — it is store-agnostic by construction.

// ISO-8601 week string, e.g. "2026-W27". Weeks start Monday; the week of the
// year is the one containing that year's first Thursday.
export function isoWeek(dateish) {
  if (dateish == null || dateish === '') return null; // guard: new Date(null) is epoch 0, not invalid
  const d = new Date(dateish);
  if (Number.isNaN(d.getTime())) return null;
  // Work in UTC to keep editions stable regardless of the runner's timezone.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; // Sun(0) -> 7
  t.setUTCDate(t.getUTCDate() + 4 - day); // shift to the week's Thursday
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// The edition key groups history and names the storage prefix (§5.1). Prefer the
// ISO week derived from a real publish/valid date; fall back to the detection
// day so an edition key always exists even when the source exposes no dates.
export function deriveEdition({ validFrom, publishedAt, detectedAt }) {
  return (
    isoWeek(validFrom) ||
    isoWeek(publishedAt) ||
    `detected-${new Date(detectedAt).toISOString().slice(0, 10)}`
  );
}

// Finalize a collector's partial doc into a full BrochureDoc: fill defaults,
// derive edition/storageKey/id. `checksum` is filled by the pipeline once the
// bytes are hashed. Store-agnostic — operates purely on the contract fields.
//
// `variant` disambiguates CONCURRENT brochures for the same store+region whose
// validity falls in the same week (a store may run several flyers at once): the
// primary flyer keeps the plain weekly edition, siblings get "-<variant>"
// appended, so each holds its own identity/storage prefix instead of colliding.
export function buildBrochureDoc(partial) {
  const store = req(partial.store, 'store');
  const region = req(partial.region, 'region');
  const detectedAt = partial.detectedAt || new Date().toISOString();
  const baseEdition = deriveEdition({
    validFrom: partial.validFrom,
    publishedAt: partial.publishedAt,
    detectedAt,
  });
  const edition = partial.variant ? `${baseEdition}-${partial.variant}` : baseEdition;
  const storageKey = `${store}/${region}/${edition}`;
  return {
    store,
    region,
    title: partial.title ?? null,
    validFrom: partial.validFrom ?? null,
    validTo: partial.validTo ?? null,
    detectedAt,
    sourceType: partial.sourceType || 'pdf',
    sourceUrl: partial.sourceUrl ?? null,
    pdfUrl: partial.pdfUrl ?? null,
    pages: partial.pages || [], // empty in v1 for PDF sources (§4)
    checksum: partial.checksum ?? null,
    collector: req(partial.collector, 'collector'),
    edition,
    storageKey,
    id: `${store}:${region}:${edition}`,
  };
}

// Projection of a BrochureDoc into a flat D1 row (§5.2).
export function docToRow(doc) {
  return {
    id: doc.id,
    store: doc.store,
    region: doc.region,
    edition: doc.edition,
    title: doc.title,
    valid_from: doc.validFrom,
    valid_to: doc.validTo,
    detected_at: doc.detectedAt,
    source_type: doc.sourceType,
    source_url: doc.sourceUrl,
    pdf_url: doc.pdfUrl,
    checksum: doc.checksum,
    collector: doc.collector,
    storage_key: doc.storageKey,
    is_current: 1,
  };
}

// Inverse of docToRow — a D1 row back into a (read-API-shaped) BrochureDoc.
export function rowToDoc(row) {
  return {
    id: row.id,
    store: row.store,
    region: row.region,
    edition: row.edition,
    title: row.title,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    detectedAt: row.detected_at,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    pdfUrl: row.pdf_url,
    pages: [],
    checksum: row.checksum,
    collector: row.collector,
    storageKey: row.storage_key,
    isCurrent: !!row.is_current,
  };
}

function req(value, name) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`BrochureDoc missing required field '${name}'`);
  }
  return value;
}
