// storage/objectStore.js — the byte store behind a narrow interface (§5).
//
// Interface (all implementations honor this, nothing else):
//   put(key, bytes, { contentType }) -> Promise<void>
//   get(key)                         -> Promise<{ bytes: Uint8Array, contentType } | null>
//
// Keys are R2-style paths, e.g. "brochures/othaim/central/2026-W27/original.pdf".
// The pipeline, collectors and Core never learn which backend is in use — that
// is the whole point of the interface (swap R2 <-> KV <-> local with zero
// changes upstream).
//
// ARCHITECTURE.md §12 recommends R2 for bytes; where an account has no R2 scope,
// KV is the approved fallback (§5.2, §12) — a brochure PDF (~1 MB) fits well
// inside KV's 25 MiB value limit. Both are provided; the deployment picks one in
// index.js by which binding exists.

// --- R2 (preferred: unlimited object size, cheap egress) ---------------------
export function createR2ObjectStore(bucket) {
  return {
    async put(key, bytes, { contentType } = {}) {
      await bucket.put(key, bytes, {
        httpMetadata: contentType ? { contentType } : undefined,
      });
    },
    async get(key) {
      const obj = await bucket.get(key);
      if (!obj) return null;
      const bytes = new Uint8Array(await obj.arrayBuffer());
      return { bytes, contentType: obj.httpMetadata?.contentType || 'application/octet-stream' };
    },
  };
}

// --- KV (fallback when R2 is unavailable) ------------------------------------
// KV has no per-key metadata for content-type on read of the raw value, so we
// store the content-type alongside the bytes in KV metadata.
export function createKvObjectStore(kv) {
  return {
    async put(key, bytes, { contentType } = {}) {
      await kv.put(key, bytes, { metadata: { contentType: contentType || 'application/octet-stream' } });
    },
    async get(key) {
      const { value, metadata } = await kv.getWithMetadata(key, { type: 'arrayBuffer' });
      if (!value) return null;
      return {
        bytes: new Uint8Array(value),
        contentType: metadata?.contentType || 'application/octet-stream',
      };
    },
  };
}
