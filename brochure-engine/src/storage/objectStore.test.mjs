import assert from 'node:assert/strict';
import { createTieredObjectStore } from './objectStore.js';

function memoryStore(seed = {}) {
  const objects = new Map(Object.entries(seed));
  const writes = [];
  return {
    writes,
    objects,
    async put(key, bytes, options = {}) {
      const value = { bytes: new Uint8Array(bytes), contentType: options.contentType };
      objects.set(key, value);
      writes.push({ key, ...value });
    },
    async get(key) {
      return objects.get(key) || null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

{
  const primary = memoryStore();
  const fallback = memoryStore({
    'brochures/legacy/page-1.webp': {
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'image/webp',
    },
  });
  const store = createTieredObjectStore(primary, fallback);

  const first = await store.get('brochures/legacy/page-1.webp');
  assert.deepEqual([...first.bytes], [1, 2, 3]);
  assert.equal(first.contentType, 'image/webp');
  assert.equal(primary.writes.length, 1, 'a KV hit is promoted to R2');

  await store.get('brochures/legacy/page-1.webp');
  assert.equal(primary.writes.length, 1, 'subsequent reads use R2 directly');
}

{
  const primary = memoryStore();
  const fallback = memoryStore();
  const store = createTieredObjectStore(primary, fallback);
  await store.put('brochures/new/page-1.webp', new Uint8Array([9]), {
    contentType: 'image/webp',
  });

  assert.equal(primary.objects.has('brochures/new/page-1.webp'), true);
  assert.equal(fallback.objects.has('brochures/new/page-1.webp'), false);
}

{
  const fallback = memoryStore({
    'brochures/legacy/page-2.webp': {
      bytes: new Uint8Array([4]),
      contentType: 'image/webp',
    },
  });
  const primary = memoryStore();
  primary.put = async () => {
    throw new Error('temporary R2 failure');
  };
  const store = createTieredObjectStore(primary, fallback);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const legacy = await store.get('brochures/legacy/page-2.webp');
    assert.deepEqual([...legacy.bytes], [4], 'promotion failure keeps the KV object readable');
  } finally {
    console.warn = originalWarn;
  }
}

console.log('objectStore tests passed');
