// pipeline.js — the ingest pipeline (ARCHITECTURE.md §4/§5/§6.1). Store-agnostic.
//
// For each candidate a collector emits, it runs the idempotent tail of the
// architecture's pipeline:
//   1. compute checksum over the downloaded bytes (the identity/dedupe key)
//   2. MetadataStore.exists(checksum)? -> yes: skip (dedupe, no re-store)
//   3. ObjectStore.put(storageKey/original.pdf + meta.json)
//   4. MetadataStore.upsert(row); flip prior is_current=0
//
// Re-running (cron or manual) never double-stores: the checksum pre-check plus
// the ux_checksum unique index guarantee it (§6.1 "Idempotent").

import { docToRow } from './contract.js';

// sha256 over bytes, using Web Crypto (global in Workers and Node 18+).
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createPipeline({ objectStore, metadataStore }) {
  return {
    // Persist one candidate. Returns { status, doc } where status is
    // 'new' | 'deduped'.
    async ingest({ doc, bytes, contentType }) {
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
      await objectStore.put(
        `${base}/meta.json`,
        new TextEncoder().encode(JSON.stringify(finalDoc, null, 2)),
        { contentType: 'application/json' },
      );

      // 4. index the row; supersede the prior current edition for this store+region.
      await metadataStore.upsert(docToRow(finalDoc));

      return { status: 'new', doc: finalDoc };
    },
  };
}
