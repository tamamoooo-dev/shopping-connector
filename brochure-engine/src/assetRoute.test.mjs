// GET /asset/<key> (engine.js) is public and unauthenticated, so it serves only
// a brochure's own files — the manifest, original PDF and page images the
// app's flyer viewer loads — and answers 404 for every other key in the
// bucket (D1 backups, ops archives, price archive, vision evidence, settings)
// without reading it.
import assert from 'node:assert/strict';
import { handleRequest, isPublicAssetKey } from './engine.js';

const BASE = 'https://engine.test';
const enc = new TextEncoder();

const objects = new Map([
  ['brochures/aljazera/central/2026-W47-801675/meta.json', ['application/json', '{"pages":[]}']],
  ['brochures/aljazera/central/2026-W47-801675/page00.webp', ['image/webp', 'RIFF']],
  ['brochures/othaim/central/2026-W27/original.pdf', ['application/pdf', '%PDF-1.7']],
  ['brochures/othaim/central/2026-W27/hotspots.json', ['application/json', '{"offers":[]}']],
  ['brochures/_resume/d4d/panda/central/manifest.json', ['application/json', '{}']],
  ['backups/d1/2026-11-15/watches/00000.jsonl', ['application/x-ndjson', '{"id":1}']],
  ['backups/d1/active.json', ['application/json', '{}']],
  ['ops-archive/2026-11-01/1-9-abc.ndjson', ['application/x-ndjson', '{}']],
  ['price-archive/2026-11-17/part.jsonl', ['application/x-ndjson', '{}']],
  ['brochure-data/x/abc.json', ['application/json', '{}']],
  ['vision-verification/attempts/1.json', ['application/json', '{}']],
  ['ops/settings/vision-model.json', ['application/json', '{}']],
  ['cache/browse-generation.txt', ['text/plain', '1']],
  ['minimarts/t.sshoco/R38XrLDwQ5SH2jq-2SFujQ-photo.jpg', ['image/jpeg', 'jpg']],
]);
const reads = [];
const objectStore = {
  async get(key) {
    reads.push(key);
    const hit = objects.get(key);
    return hit ? { bytes: enc.encode(hit[1]), contentType: hit[0] } : null;
  },
};
const ctx = { objectStore };
const call = (path) => handleRequest(new Request(`${BASE}${path}`), ctx);

// --- what the app loads still streams, with CORS (the viewer crops pages on a canvas)
for (const [key, type] of [
  ['brochures/aljazera/central/2026-W47-801675/meta.json', 'application/json'],
  ['brochures/aljazera/central/2026-W47-801675/page00.webp', 'image/webp'],
  ['brochures/othaim/central/2026-W27/original.pdf', 'application/pdf'],
]) {
  const res = await call(`/asset/${key}`);
  assert.equal(res.status, 200, key);
  assert.equal(res.headers.get('content-type'), type, key);
  assert.equal(res.headers.get('access-control-allow-origin'), '*', key);
  assert.equal(await res.text(), objects.get(key)[1], key);
}
// The viewer's assetUrl() joins the key as-is, but an encoded slash decodes too.
assert.equal((await call('/asset/brochures%2Faljazera%2Fcentral%2F2026-W47-801675%2Fmeta.json')).status, 200);

// A brochure key that is allowed but not stored is still a plain 404.
assert.equal((await call('/asset/brochures/lulu/central/2026-W01/page03.webp')).status, 404);

// --- everything else answers 404 and is never read from the bucket
reads.length = 0;
const privateKeys = [...objects.keys()].filter((k) => !isPublicAssetKey(k));
assert.equal(privateKeys.length, objects.size - 3);
for (const key of privateKeys) {
  for (const path of [`/asset/${key}`, `/asset/${encodeURIComponent(key)}`]) {
    const res = await call(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: 'Asset not found' }, path);
  }
}
for (const path of [
  '/asset/backups%2Fd1%2F2026-11-15%2Fwatches%2F00000.jsonl',
  '/asset/brochures%2F..%2Fbackups%2Fd1%2Factive.json',
  '/asset/brochures/x/y/..%2F..%2F..%2Fbackups/d1/active.json',
  '/asset/brochures/aljazera/central/2026-W47-801675/%2E%2E%2F%2E%2E%2Fbackups%2Fd1%2Factive.json',
  '/asset/brochures/aljazera/central/2026-W47-801675/page00.webp%00',
  '/asset/brochures/aljazera/central/2026-W47-801675/',
  '/asset/brochures/aljazera/central/meta.json',
  '/asset/brochures/a/b/c/d/meta.json',
  '/asset/%E0%A4%A',
  '/asset/',
]) {
  const res = await call(path);
  assert.equal(res.status, 404, path);
}
assert.deepEqual(reads, [], `private keys were read: ${reads.join(', ')}`);

// Not GET: the route does not answer at all (falls through to the router's 404).
assert.notEqual((await handleRequest(new Request(`${BASE}/asset/brochures/othaim/central/2026-W27/original.pdf`, { method: 'DELETE' }), ctx)).status, 200);

// The predicate itself.
assert.equal(isPublicAssetKey('brochures/carrefour/central/2026-W34-762042/page12.jpg'), true);
assert.equal(isPublicAssetKey('brochures/carrefour/central/2026-W34-762042/page1.img'), true);
assert.equal(isPublicAssetKey('brochures/carrefour/central/2026-W34-762042/hotspots.json'), false);
assert.equal(isPublicAssetKey('brochures/../central/2026-W34/meta.json'), false);
assert.equal(isPublicAssetKey(null), false);
assert.equal(isPublicAssetKey(undefined), false);

console.log('assetRoute: ok');
