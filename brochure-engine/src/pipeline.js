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
//   • image set   (AggregatorCollector): { doc, pages: [{ index, bytes, contentType, url }],
//                                          hotspots: [{ index, spots }] }
// An image-set candidate also carries the per-product tap GEOMETRY the adapter
// parsed from the same leaflet HTML that listed the pages (snapshot-at-ingest):
// it is written as hotspots.json in the same ingest as the page bytes, so the
// stored geometry always describes the stored rendering and the read path
// never has to consult the aggregator again.
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

// Total tap targets across a hotspots snapshot's pages (for the parse-suspect log).
function countSpots(pages) {
  return (pages || []).reduce((n, p) => n + ((p && p.spots && p.spots.length) || 0), 0);
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
  const writeHotspots = (base, hotspotPages) =>
    objectStore.put(
      `${base}/hotspots.json`,
      encoder.encode(JSON.stringify({ pages: hotspotPages || [], capturedAt: new Date().toISOString() })),
      { contentType: 'application/json' },
    );

  // Reconcile a HELD edition's stored geometry with a freshly parsed snapshot
  // of the SAME rendering (every caller reaches here only after confirming the
  // bytes are identical: the dedupe branch below, or the engine's held-flyer
  // heal). Writes only when the stored snapshot is missing, unreadable, or
  // differs — so legacy caches written by the old on-demand path converge to
  // ingest-derived truth without wasting KV writes on the steady state.
  //
  // SAFEGUARD (the destructive-overwrite fix): because this path is always the
  // SAME rendering, a NON-EMPTY stored snapshot is still CORRECT for the stored
  // pages. So if the fresh parse is EMPTY while the stored one has spots, that
  // is almost certainly `parseHotspots` failing on a D4D markup change — not a
  // flyer that genuinely lost every product. Overwriting would silently erase
  // good geometry across all current editions on the very next cron. Instead we
  // KEEP the good snapshot and log it as the early parser-failure signal; the
  // feature keeps working on cached geometry until the parser is fixed. (This
  // guard is only sound because bytes are identical here — the changed-bytes
  // re-store path deliberately writes the fresh parse unconditionally, since
  // keeping old geometry against new pages is the misalignment bug we removed.)
  // Returns: 'skipped' | 'kept' | 'written' | 'refused-empty'.
  async function ensureHotspots(storageKey, hotspotPages) {
    if (!storageKey || !Array.isArray(hotspotPages)) return 'skipped';
    const base = `brochures/${storageKey}`;
    const stored = await objectStore.get(`${base}/hotspots.json`);
    let storedPages = null;
    if (stored) {
      try {
        storedPages = JSON.parse(new TextDecoder().decode(stored.bytes)).pages || [];
      } catch {
        storedPages = null; // unreadable -> treat as missing, rewrite below
      }
    }
    if (storedPages) {
      if (JSON.stringify(storedPages) === JSON.stringify(hotspotPages)) return 'kept';
      if (hotspotPages.length === 0 && storedPages.length > 0) {
        console.warn(
          'brochure-engine hotspots parse-suspect',
          JSON.stringify({
            storageKey,
            storedSpots: countSpots(storedPages),
            parsedPages: 0,
            action: 'kept-stored',
          }),
        );
        return 'refused-empty';
      }
    }
    await writeHotspots(base, hotspotPages);
    return 'written';
  }

  return {
    ensureHotspots,
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
        return ingestImageSet(candidate, {
          objectStore,
          metadataStore,
          writeMeta,
          writeHotspots,
          ensureHotspots,
        });
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
async function ingestImageSet(
  { doc, pages, hotspots },
  { objectStore, metadataStore, writeMeta, writeHotspots, ensureHotspots },
) {
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

  const base = `brochures/${doc.storageKey}`;
  const buildPageEntry = (p) => {
    const key = `${base}/page${String(p.index).padStart(2, '0')}.${imageExt(p.contentType, p.url)}`;
    // pageId (the aggregator's deep-link page id) rides into meta.json so a
    // flyer offer can open the in-app viewer on its own page; omitted when null.
    const entry = { index: p.index, imageUrl: key };
    if (p.pageId) entry.pageId = String(p.pageId);
    return entry;
  };

  // 2. dedupe: identical page set already held? Byte-identical pages can still
  // carry NEW deep-link page ids (the aggregator can add them to the leaflet
  // markup without re-rendering the images — that's what makes the collector
  // re-download a held flyer). Refresh meta.json only (the page keys are
  // derived the same way, no byte writes) so the ids land and the collector's
  // staleness trigger goes quiet on the next run.
  if (await metadataStore.existsByChecksum(checksum)) {
    const finalDoc = { ...doc, checksum, pages: ordered.map(buildPageEntry) };
    if (ordered.some((p) => p.pageId)) await writeMeta(base, finalDoc);
    // Byte-identical pages = the same rendering, so the freshly parsed
    // geometry is valid for the stored copy too — reconcile it (heals editions
    // ingested before capture, or legacy caches from the old on-demand path).
    if (Array.isArray(hotspots)) await ensureHotspots(doc.storageKey, hotspots);
    return { status: 'deduped', doc: finalDoc };
  }

  // 3. store each page under the edition prefix; record its object key in pages[].
  const pageMeta = [];
  for (const p of ordered) {
    const entry = buildPageEntry(p);
    await objectStore.put(entry.imageUrl, p.bytes, { contentType: p.contentType });
    pageMeta.push(entry);
  }

  // Hotspot geometry is immutable per RENDERING, not per edition — and it was
  // parsed from the SAME leaflet HTML that listed these pages, so it is stored
  // in the same ingest, unconditionally: a changed-bytes re-store (the
  // aggregator re-rendered under the same URL) OVERWRITES any stale snapshot,
  // and an empty parse still writes `{pages: []}` so the old rendering's
  // geometry can never survive its pages. Written BEFORE meta.json — the meta
  // write is the edition's commit point.
  await writeHotspots(base, hotspots || []);

  const finalDoc = { ...doc, checksum, pages: pageMeta };
  await writeMeta(base, finalDoc);

  // 4. index the row; supersede the prior current edition for this store+region.
  await metadataStore.upsert(docToRow(finalDoc));

  return { status: 'new', doc: finalDoc };
}
