// pipeline.js — the ingest pipeline (ARCHITECTURE.md §4/§5/§6.1). Store-agnostic.
//
// For each candidate a collector emits, it runs the idempotent tail of the
// architecture's pipeline:
//   1. compute checksum over the downloaded bytes (the identity/dedupe key)
//   2. MetadataStore.exists(checksum)? -> yes: skip (dedupe, no re-store)
//   3. ObjectStore.put(bytes/pages + meta.json)
//   4. MetadataStore.upsert(row); flip prior is_current=0
//
// Two candidate shapes, one idempotent pipeline (§5.1 "original.pdf … or
// /pageNN.jpg for image sets"):
//   • PDF source  (PdfIndexCollector):  { doc, bytes, contentType }
//   • image set   (AggregatorCollector): { doc, pages: [{ index, bytes, contentType, url }] }
// The checksum is over the downloaded bytes for a PDF, or over the page bytes
// concatenated in page order for an image set (§4, §7.2) — either way it is the
// single "do we already have this week?" key.
//
// Re-running (cron or manual) never double-stores: the checksum pre-check plus
// the ux_checksum unique index guarantee it (§6.1 "Idempotent").

import { docToRow } from './contract.js';

// sha256 over bytes, using Web Crypto (global in Workers and Node 18+).
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// File extension for a stored page image, from its content-type, falling back
// to the source URL's extension, then a neutral default.
function imageExt(contentType, url) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('webp')) return 'webp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('png')) return 'png';
  const m = /\.(webp|jpe?g|png)(?:[?#]|$)/i.exec(url || '');
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'img';
}

export function createPipeline({ objectStore, metadataStore }) {
  const encoder = new TextEncoder();
  const writeMeta = (base, finalDoc) =>
    objectStore.put(`${base}/meta.json`, encoder.encode(JSON.stringify(finalDoc, null, 2)), {
      contentType: 'application/json',
    });

  return {
    // Persist one candidate. Returns { status, doc } where status is
    // 'new' | 'deduped'.
    async ingest(candidate) {
      // Link path (officialLink fallback): a doc that is just a pointer to the
      // store's official offers page — no bytes, no pages. Checksum is over the
      // sourceUrl so an unchanged URL dedupes and a changed one supersedes; the
      // row is indexed but NOTHING is written to the object store.
      if (candidate.link || (candidate.doc && candidate.doc.sourceType === 'link')) {
        return ingestLink(candidate, { metadataStore });
      }

      // Image-set path (aggregator): multiple page images, checksum over the
      // page bytes concatenated in page order (§7.2). Kept separate from the
      // PDF path below, which is unchanged from M1.
      if (candidate.pages && candidate.pages.length) {
        return ingestImageSet(candidate, { objectStore, metadataStore, writeMeta });
      }

      const { doc, bytes, contentType } = candidate;
      // 1. checksum over the actual downloaded bytes.
      const checksum = `sha256:${await sha256Hex(bytes)}`;
      const finalDoc = { ...doc, checksum };

      // 2. dedupe: have we already stored these exact bytes?
      if (await metadataStore.existsByChecksum(checksum)) {
        return { status: 'deduped', doc: finalDoc };
      }

      // 3. store the bytes + a meta.json snapshot under the edition prefix.
      const base = `brochures/${finalDoc.storageKey}`;
      await objectStore.put(`${base}/original.pdf`, bytes, { contentType });
      await writeMeta(base, finalDoc);

      // 4. index the row; supersede the prior current edition for this store+region.
      await metadataStore.upsert(docToRow(finalDoc));

      return { status: 'new', doc: finalDoc };
    },
  };
}

// Link variant of ingest() (officialLink fallback). A link brochure has no
// bytes to store — it is a pointer to the store's official offers page. We hash
// the sourceUrl as the identity/dedupe key and index only the row (the same
// idempotent contract: re-ingesting the same URL dedupes; a changed URL, or a
// switch away from a prior images/pdf edition, supersedes it).
async function ingestLink({ doc }, { metadataStore }) {
  const encoder = new TextEncoder();
  const checksum = `sha256:${await sha256Hex(encoder.encode(doc.sourceUrl || doc.storageKey))}`;
  const finalDoc = { ...doc, checksum };

  if (await metadataStore.existsByChecksum(checksum)) {
    return { status: 'deduped', doc: finalDoc };
  }

  await metadataStore.upsert(docToRow(finalDoc));
  return { status: 'new', doc: finalDoc };
}

// Image-set variant of ingest() (aggregator sources). Same idempotent contract
// as the PDF path; only the "bytes" differ (many page images vs one PDF).
async function ingestImageSet({ doc, pages }, { objectStore, metadataStore, writeMeta }) {
  const ordered = [...pages].sort((a, b) => a.index - b.index);

  // 1. checksum over the concatenation of all page bytes, in page order.
  const total = ordered.reduce((n, p) => n + p.bytes.byteLength, 0);
  const concat = new Uint8Array(total);
  let offset = 0;
  for (const p of ordered) {
    concat.set(p.bytes, offset);
    offset += p.bytes.byteLength;
  }
  const checksum = `sha256:${await sha256Hex(concat)}`;

  // 2. dedupe: identical page set already held?
  if (await metadataStore.existsByChecksum(checksum)) {
    return { status: 'deduped', doc: { ...doc, checksum } };
  }

  // 3. store each page under the edition prefix; record its object key in pages[].
  const base = `brochures/${doc.storageKey}`;
  const pageMeta = [];
  for (const p of ordered) {
    const key = `${base}/page${String(p.index).padStart(2, '0')}.${imageExt(p.contentType, p.url)}`;
    await objectStore.put(key, p.bytes, { contentType: p.contentType });
    // pageId (the aggregator's deep-link page id) rides into meta.json so a
    // flyer offer can open the in-app viewer on its own page; omitted when null.
    const entry = { index: p.index, imageUrl: key };
    if (p.pageId) entry.pageId = String(p.pageId);
    pageMeta.push(entry);
  }
  const finalDoc = { ...doc, checksum, pages: pageMeta };
  await writeMeta(base, finalDoc);

  // Hotspot geometry is immutable per RENDERING, not per edition: the
  // aggregator can re-render a flyer under the same URL/edition (page count and
  // data-index layout change), and a hotspots.json cached from the old
  // rendering would then misalign with the freshly stored pages. Reaching this
  // point means the bytes CHANGED (the dedupe above didn't fire), so drop the
  // cache and let the next /brochures/hotspots request re-parse and re-cache.
  await objectStore.delete(`${base}/hotspots.json`);

  // 4. index the row; supersede the prior current edition for this store+region.
  await metadataStore.upsert(docToRow(finalDoc));

  return { status: 'new', doc: finalDoc };
}
