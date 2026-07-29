import assert from 'node:assert/strict';
import { createPipeline } from '../pipeline.js';
import { createMemoryMetadataStore } from '../storage/local.js';
import {
  collectD4dBatch,
  D4D_BATCH_PAGES,
  publishD4dCollection,
} from './d4dResumable.js';
import { d4dAdapter } from './adapters/d4d.js';

function createMemoryObjectStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes, { contentType } = {}) {
      objects.set(key, {
        bytes: new Uint8Array(bytes),
        contentType: contentType || 'application/octet-stream',
      });
    },
    async get(key) {
      const object = objects.get(key);
      return object
        ? { bytes: new Uint8Array(object.bytes), contentType: object.contentType }
        : null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function createAdapter(pageCount) {
  const ref = {
    id: 748683,
    slug: 'summer',
    title: 'Summer Offers',
    validFrom: '2026-07-22',
    validTo: '2099-07-28',
    url: 'https://d4donline.test/en/saudi-arabia/riyadh/offers/shop-1/748683/summer',
  };
  return {
    async listBrochureRefs() {
      return [ref];
    },
    async loadBrochure() {
      return {
        ...ref,
        sourceUrl: ref.url,
        pages: Array.from({ length: pageCount }, (_, index) => `https://cdn.test/page-${index}.webp`),
        pageIds: Array.from({ length: pageCount }, (_, index) => `page-${index}`),
        hotspots: [{ index: pageCount - 1, spots: [{ offerId: 'offer-last' }] }],
      };
    },
  };
}

function createFetch() {
  const fetched = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    const index = Number(/page-(\d+)/.exec(url)?.[1] || 0);
    return new Response(new Uint8Array([index % 251, 7, 9]), {
      status: 200,
      headers: { 'content-type': 'image/webp' },
    });
  };
  return { fetched, fetchImpl };
}

const objectStore = createMemoryObjectStore();

const refs = await d4dAdapter.listBrochureRefs('shop-1', {
  region: 'central',
  regionConfig: { city: 'riyadh' },
  fetchText: async () =>
    '<a href="/offers/shop-1/748683/summer" class="book-cover" title="Summer. 2099-08-01T00:00:00Z">',
});
assert.equal(refs.length, 1);
assert.equal(refs[0].id, 748683);

const metadataStore = createMemoryMetadataStore();
const pipeline = createPipeline({ objectStore, metadataStore });
const collectionEvents = [];
const collectionStore = {
  async markPending(store, region, detail) {
    collectionEvents.push({ status: 'pending', store, region, ...detail });
  },
  async markComplete(store, region, detail) {
    collectionEvents.push({ status: 'complete', store, region, ...detail });
  },
};
const registry = {
  shop: {
    regions: {
      central: { store: 'shop-1', city: 'riyadh' },
    },
  },
};
const offerStore = {
  async requiredFlyerRefs() {
    return ['748683'];
  },
};
const ctx = {
  objectStore,
  metadataStore,
  pipeline,
  collectionStore,
  offerStore,
  registry,
};
const adapter = createAdapter(45);
const fetcher = createFetch();

const first = await collectD4dBatch(ctx, {
  store: 'shop',
  adapter,
  fetchImpl: fetcher.fetchImpl,
});
assert.equal(first.complete, false);
assert.equal(first.pagesCollected, D4D_BATCH_PAGES);
assert.equal(first.nextPage, 20);
assert.equal(
  [...objectStore.objects.keys()].some((key) => !key.includes('/_resume/') && key.endsWith('/meta.json')),
  false,
  'public meta.json must not exist after the first batch',
);
assert.equal(
  [...objectStore.objects.keys()].some((key) => key.endsWith('/hotspots.json')),
  false,
  'hotspots.json must not exist after the first batch',
);
assert.equal((await metadataStore.getCurrent('shop', 'central')).length, 0);

// Prove progress validation resumes at the first missing stored object, not page 1.
const manifestKey = 'brochures/_resume/d4d/shop/central/manifest.json';
const manifestBeforeHole = JSON.parse(
  new TextDecoder().decode((await objectStore.get(manifestKey)).bytes),
);
objectStore.objects.delete(manifestBeforeHole.flyers[0].pages[7].key);
const second = await collectD4dBatch(ctx, {
  store: 'shop',
  adapter,
  fetchImpl: fetcher.fetchImpl,
});
assert.equal(second.complete, false);
assert.equal(second.batch.startIndex, 7);
assert.equal(second.batch.endIndex, 26);
assert.equal(second.nextPage, 27);

const third = await collectD4dBatch(ctx, {
  store: 'shop',
  adapter,
  fetchImpl: fetcher.fetchImpl,
});
assert.equal(third.complete, true);
assert.equal(third.storeComplete, true);
assert.equal(third.batch.startIndex, 27);
assert.equal(third.batch.endIndex, 44);
assert.equal(third.totalPages, 45);
assert.equal(third.externalRequests, 18);

const current = await metadataStore.getCurrent('shop', 'central');
assert.equal(current.length, 1);
const finalBase = `brochures/${current[0].storage_key}`;
const metaObject = await objectStore.get(`${finalBase}/meta.json`);
const hotspotObject = await objectStore.get(`${finalBase}/hotspots.json`);
assert.ok(metaObject, 'final meta.json must be written');
assert.ok(hotspotObject, 'final hotspots.json must be written');
const meta = JSON.parse(new TextDecoder().decode(metaObject.bytes));
assert.equal(meta.complete, true);
assert.equal(meta.advertisedPageCount, 45);
assert.equal(meta.flyerRef, '748683');
assert.equal(meta.pages.length, 45);
assert.ok(await objectStore.get(manifestKey), 'manifest remains until exact offer linkage succeeds');
assert.equal(collectionEvents.at(-1).status, 'pending');
assert.equal(collectionEvents.at(-1).collectedPages, 45);
await publishD4dCollection(ctx, third);
assert.equal(await objectStore.get(manifestKey), null, 'publication removes the progress manifest');
assert.equal(collectionEvents.at(-1).status, 'complete');

// A legacy retained prefix is promoted in bounded, separately checkpointed
// batches instead of being rescanned from page 1 in one invocation.
{
  const legacyObjects = createMemoryObjectStore();
  const legacyMetadata = createMemoryMetadataStore();
  const legacyPipeline = createPipeline({
    objectStore: legacyObjects,
    metadataStore: legacyMetadata,
  });
  const legacyAdapter = createAdapter(20);
  const sourceUrl =
    'https://d4donline.test/en/saudi-arabia/riyadh/offers/shop-1/748683/summer';
  await legacyMetadata.upsert({
    id: 'shop:central:legacy',
    store: 'shop',
    region: 'central',
    edition: 'legacy',
    source_type: 'images',
    source_url: sourceUrl,
    storage_key: 'shop/central/legacy',
    checksum: 'sha256:legacy',
    detected_at: '2026-07-01T00:00:00.000Z',
  });
  const legacyPages = [];
  for (let index = 0; index < 12; index += 1) {
    const imageUrl = `brochures/shop/central/legacy/page-${index}.webp`;
    legacyPages.push({ index, imageUrl, pageId: `page-${index}` });
    await legacyObjects.put(imageUrl, new Uint8Array([index]), { contentType: 'image/webp' });
  }
  await legacyObjects.put(
    'brochures/shop/central/legacy/meta.json',
    new TextEncoder().encode(JSON.stringify({ pages: legacyPages })),
    { contentType: 'application/json' },
  );
  const events = [];
  const legacyCtx = {
    objectStore: legacyObjects,
    metadataStore: legacyMetadata,
    pipeline: legacyPipeline,
    collectionStore: {
      async markPending(store, region, detail) {
        events.push({ status: 'pending', store, region, ...detail });
      },
      async markComplete(store, region, detail) {
        events.push({ status: 'complete', store, region, ...detail });
      },
    },
    offerStore,
    registry,
  };
  const legacyFetch = createFetch();

  const seedOne = await collectD4dBatch(legacyCtx, {
    store: 'shop',
    adapter: legacyAdapter,
    fetchImpl: legacyFetch.fetchImpl,
  });
  assert.equal(seedOne.legacyMigrationBatch, true);
  assert.equal(seedOne.pagesReused, 8);
  assert.equal(seedOne.pagesCollected, 0);

  const seedTwo = await collectD4dBatch(legacyCtx, {
    store: 'shop',
    adapter: legacyAdapter,
    fetchImpl: legacyFetch.fetchImpl,
  });
  assert.equal(seedTwo.legacyMigrationBatch, true);
  assert.equal(seedTwo.pagesReused, 12);
  assert.equal(seedTwo.pagesCollected, 0);

  const finish = await collectD4dBatch(legacyCtx, {
    store: 'shop',
    adapter: legacyAdapter,
    fetchImpl: legacyFetch.fetchImpl,
  });
  assert.equal(finish.storeComplete, true);
  assert.equal(finish.batch.startIndex, 12);
  assert.equal(finish.batch.endIndex, 19);
  await publishD4dCollection(legacyCtx, finish);
}

console.log('d4dResumable.test: generic batching, first-missing resume, and bounded legacy migration passed');
