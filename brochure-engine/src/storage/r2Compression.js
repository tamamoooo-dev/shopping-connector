// Lossless storage encoding for immutable text evidence. Keys and logical
// content stay unchanged; legacy plain objects remain readable.
export const COMPRESSION_MIN_BYTES = 2048;
export const COMPRESSION_MAX_BYTES = 4 * 1024 * 1024;
const COMPRESSION_WRITE_MAX_BYTES = 16 * 1024 * 1024;
const enc = new TextEncoder();
export function compressibleKey(key) {
  return typeof key === 'string' && (
    /^vision-verification\/attempts\/.+\.json$/.test(key)
    || /^vision-verification\/migrations\/.+\.ndjson$/.test(key)
    || /^backups\/d1\/\d{4}-\d{2}-\d{2}\/[^/]+\/\d+\.jsonl$/.test(key)
    || /^ops-archive\/.+\.ndjson$/.test(key)
    || /^d1-retention\/migrations\/.+\.ndjson$/.test(key)
    || /^brochure-data\/.+\.json$/.test(key));
}
export async function transformBytes(bytes, decompress = false) {
  const stream = new Blob([bytes]).stream().pipeThrough(
    decompress ? new DecompressionStream('gzip') : new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function decodeStoredBytes(bytes) {
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? transformBytes(bytes, true) : bytes;
}
export async function readStoredBytes(object) {
  const bytes = object.arrayBuffer
    ? new Uint8Array(await object.arrayBuffer()) : enc.encode(await object.text());
  return decodeStoredBytes(bytes);
}
export async function readStoredJson(object) {
  return JSON.parse(new TextDecoder().decode(await readStoredBytes(object)));
}
export async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2,'0')).join('');
}
export async function putStoredBytes(bucket, key, body, options = {}) {
  const bytes = typeof body === 'string' ? enc.encode(body) : body;
  if (!compressibleKey(key) || bytes.byteLength < COMPRESSION_MIN_BYTES
      || bytes.byteLength > COMPRESSION_WRITE_MAX_BYTES) return bucket.put(key, body, options);
  const packed = await transformBytes(bytes);
  if (packed.byteLength >= bytes.byteLength * 0.95) return bucket.put(key, body, options);
  return bucket.put(key, packed, {
    ...options,
    httpMetadata: { ...options.httpMetadata, contentEncoding: 'gzip' },
    customMetadata: { ...options.customMetadata, storageEncoding: 'gzip', originalBytes: String(bytes.byteLength) },
  });
}

// Bounded authenticated maintenance: never touches page images or live state.
// The conditional write cannot replace an object changed by another writer.
export async function compressStoredObjects(bucket, keys) {
  if (!bucket || !Array.isArray(keys) || keys.length > 200
      || keys.some(k => !compressibleKey(k) || k.length > 1500)) throw new Error('Invalid compression keys');
  const results = []; let next = 0;
  async function worker() {
    while (next < keys.length) {
      const key = keys[next++];
      try {
        const object = await bucket.get(key);
        if (!object) { results.push({key,status:'missing'}); continue; }
        if (object.customMetadata?.storageEncoding === 'gzip' || object.httpMetadata?.contentEncoding
            || object.size > COMPRESSION_MAX_BYTES || object.size < COMPRESSION_MIN_BYTES) {
          results.push({key,status:'skipped'}); continue;
        }
        const original = new Uint8Array(await object.arrayBuffer());
        if (original[0] === 0x1f && original[1] === 0x8b) { results.push({key,status:'skipped'}); continue; }
        const packed = await transformBytes(original);
        if (packed.byteLength >= original.byteLength * 0.95) { results.push({key,status:'skipped'}); continue; }
        const expected = await sha256(original);
        if (await sha256(await transformBytes(packed,true)) !== expected) throw new Error('Compression round-trip failed');
        const written = await bucket.put(key, packed, {
          onlyIf: {etagMatches:object.etag},
          httpMetadata: {...object.httpMetadata,contentEncoding:'gzip'},
          customMetadata: {...object.customMetadata,storageEncoding:'gzip',originalBytes:String(original.byteLength),originalSha256:expected},
        });
        if (!written) { results.push({key,status:'changed'}); continue; }
        try {
          const stored = await bucket.get(key);
          if (!stored || await sha256(await readStoredBytes(stored)) !== expected) throw new Error('Stored content verification failed');
        } catch (error) {
          const restored = await bucket.put(key,original,{onlyIf:{etagMatches:written.etag},httpMetadata:object.httpMetadata,customMetadata:object.customMetadata});
          throw new Error(`${error.message}; original ${restored ? 'restored' : 'changed concurrently'}`);
        }
        results.push({key,status:'compressed',before:original.byteLength,after:packed.byteLength,sha256:expected});
      } catch (error) { results.push({key,status:'error',error:error.message}); }
    }
  }
  await Promise.all(Array.from({length:4},worker));
  return {compressed:results.filter(r=>r.status==='compressed').length,
    savedBytes:results.reduce((n,r)=>n+(r.before||0)-(r.after||0),0),results};
}
