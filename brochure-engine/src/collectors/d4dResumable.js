// Resumable D4D image collection for every D4D-backed provider.
//
// One Worker invocation advances one brochure by at most BATCH_PAGES. The
// durable manifest contains the advertised flyer/page set and a contiguous list
// of verified stored page objects. Public meta/hotspots/D1 publication happens
// only after every advertised page has been verified.

import { buildBrochureDoc } from '../contract.js';
import { d4dAdapter } from './adapters/d4d.js';

export const D4D_BATCH_PAGES = 20;

const HEADERS = {
  'User-Agent': 'BrochureEngine/0.1 (+https://github.com/tamamoooo-dev)',
  Accept: '*/*',
};

const encodeJson = (value) => new TextEncoder().encode(JSON.stringify(value));
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function decodeJson(object) {
  if (!object?.bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(object.bytes));
  } catch {
    return null;
  }
}

function manifestKey(store, region) {
  return `brochures/_resume/d4d/${store}/${region}/manifest.json`;
}

function flyerRefFromUrl(url) {
  return (/\/offers\/[^/]+\/(\d+)(?:\/|$)/.exec(String(url || '')) || [])[1] || null;
}

async function fetchWithRetry(fetchImpl, requests, url, label) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      requests.value += 1;
      const response = await fetchImpl(url, { headers: HEADERS });
      if (response.ok) return response;
      const transient = response.status >= 500 || response.status === 429;
      if (!transient || attempt === 1) throw new Error(`${label} ${url} -> HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 1) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`${label} ${url} failed`);
}

async function saveManifest(ctx, key, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await ctx.objectStore.put(key, encodeJson(manifest), { contentType: 'application/json' });
}

function collectionTotals(manifest) {
  const advertisedPages = manifest.flyers.reduce(
    (sum, flyer) => sum + (flyer.source?.pages?.length || 0),
    0,
  );
  const collectedPages = manifest.flyers.reduce(
    (sum, flyer) => sum + (flyer.pages?.length || 0),
    0,
  );
  return {
    advertisedFlyers: manifest.flyers.length,
    advertisedPages,
    collectedPages,
  };
}

async function firstMissingPage(objectStore, flyer) {
  const pages = Array.isArray(flyer.pages) ? flyer.pages : [];
  const total = flyer.source.pages.length;
  for (let index = 0; index < total; index += 1) {
    const page = pages[index];
    if (!page || page.index !== index || !page.key || !page.checksum) return index;
    if (!(await objectStore.get(page.key))) return index;
  }
  return total;
}

function docForSource(store, region, source, held) {
  if (held) {
    return {
      store,
      region,
      title: source.title ?? held.title ?? null,
      validFrom: source.validFrom ?? held.valid_from ?? null,
      validTo: source.validTo ?? held.valid_to ?? null,
      detectedAt: new Date().toISOString(),
      sourceType: 'images',
      sourceUrl: source.sourceUrl,
      pdfUrl: null,
      pages: [],
      checksum: null,
      collector: 'd4d',
      edition: held.edition,
      storageKey: held.storage_key,
      id: held.id,
    };
  }
  // A source-id variant is stable and collision-free even when several flyers
  // share a validity week. Existing exact rows retain their historical identity.
  return buildBrochureDoc({
    store,
    region,
    title: source.title ?? null,
    validFrom: source.validFrom ?? null,
    validTo: source.validTo ?? null,
    sourceType: 'images',
    sourceUrl: source.sourceUrl,
    pdfUrl: null,
    collector: 'd4d',
    variant: String(source.id),
  });
}

async function seedHeldPages(ctx, flyer, heldStorageKey, limit) {
  if (!heldStorageKey || flyer.legacySeedComplete) {
    return { seeded: 0, complete: true };
  }
  const metaObject = await ctx.objectStore.get(`brochures/${heldStorageKey}/meta.json`);
  const meta = decodeJson(metaObject);
  if (!meta || !Array.isArray(meta.pages)) {
    flyer.legacySeedComplete = true;
    return { seeded: 0, complete: true };
  }
  const seeded = Array.isArray(flyer.pages) ? flyer.pages : [];
  const startIndex = seeded.length;
  const endIndex = Math.min(
    startIndex + Math.max(1, limit),
    flyer.source.pages.length,
  );
  for (let index = startIndex; index < endIndex; index += 1) {
    const entry = meta.pages.find((page) => page.index === index);
    if (!entry?.imageUrl) {
      flyer.legacySeedComplete = true;
      break;
    }
    const object = await ctx.objectStore.get(entry.imageUrl);
    if (!object) {
      flyer.legacySeedComplete = true;
      break;
    }
    seeded.push({
      index,
      key: entry.imageUrl,
      contentType: object.contentType || 'image/webp',
      url: flyer.source.pages[index],
      checksum: await sha256Hex(object.bytes),
      ...(entry.pageId || flyer.source.pageIds?.[index]
        ? { pageId: String(entry.pageId || flyer.source.pageIds[index]) }
        : {}),
      reused: true,
    });
  }
  flyer.pages = seeded;
  flyer.reusedPages = seeded.length;
  if (
    seeded.length >= flyer.source.pages.length ||
    !meta.pages.some((page) => page.index === seeded.length && page.imageUrl)
  ) {
    flyer.legacySeedComplete = true;
  }
  return {
    seeded: seeded.length - startIndex,
    complete: flyer.legacySeedComplete === true,
  };
}

export function isD4dRegion(provider, region) {
  return !!provider?.regions?.[region]?.store && /-\d+$/.test(provider.regions[region].store);
}

export async function collectD4dBatch(
  ctx,
  {
    store,
    region = 'central',
    fetchImpl = fetch,
    adapter = d4dAdapter,
    batchPages = D4D_BATCH_PAGES,
  } = {},
) {
  const provider = ctx.registry?.[store];
  const regionConfig = provider?.regions?.[region];
  if (!provider || !isD4dRegion(provider, region)) {
    throw new Error(`${store}/${region} is not a D4D-backed provider region`);
  }
  if (!ctx.objectStore || !ctx.metadataStore || !ctx.pipeline || !ctx.collectionStore) {
    throw new Error('Resumable D4D collection requires object, metadata, pipeline, and collection stores');
  }

  const key = manifestKey(store, region);
  const requests = { value: 0 };
  const fetchText = async (url) =>
    (await fetchWithRetry(fetchImpl, requests, url, 'd4d source')).text();
  let manifest = decodeJson(await ctx.objectStore.get(key));

  if (!manifest || manifest.version !== 1 || manifest.store !== store || manifest.region !== region) {
    const refs = await adapter.listBrochureRefs(regionConfig.store, {
      region,
      regionConfig,
      fetchText,
    });
    const requiredRefs = new Set(
      ctx.offerStore?.requiredFlyerRefs
        ? await ctx.offerStore.requiredFlyerRefs(store, region, new Date().toISOString().slice(0, 10))
        : [],
    );
    refs.sort((a, b) => {
      const requiredDelta = Number(requiredRefs.has(String(b.id))) - Number(requiredRefs.has(String(a.id)));
      return requiredDelta || b.id - a.id;
    });
    manifest = {
      version: 1,
      store,
      region,
      sourceStore: regionConfig.store,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      flyers: refs.map((ref) => ({
        id: String(ref.id),
        ref,
        requiredByOffers: requiredRefs.has(String(ref.id)),
        source: null,
        doc: null,
        pages: [],
        batches: [],
        complete: false,
      })),
    };
  }

  const flyer = manifest.flyers.find((item) => !item.complete);
  if (!flyer) {
    const totals = collectionTotals(manifest);
    const checksums = manifest.flyers.map((item) => item.checksum).filter(Boolean);
    if (checksums.length && ctx.metadataStore.setCurrent) {
      await ctx.metadataStore.setCurrent(store, region, checksums, { supersedeOthers: true });
    }
    await ctx.collectionStore.markPending(store, region, totals);
    return {
      store,
      region,
      complete: true,
      storeComplete: true,
      totalPages: totals.advertisedPages,
      pagesCollected: 0,
      externalRequests: requests.value,
      batches: manifest.flyers.flatMap((item) => item.batches || []),
      brochuresCompleted: manifest.flyers.length,
      collectionTotals: totals,
      manifestKey: key,
    };
  }

  if (!flyer.source) {
    const source = await adapter.loadBrochure(flyer.ref, { fetchText });
    if (!source?.pages?.length) throw new Error(`D4D flyer ${flyer.id} has no advertised pages`);
    flyer.source = source;
    const held = ctx.metadataStore.getBySourceUrl
      ? await ctx.metadataStore.getBySourceUrl(store, region, source.sourceUrl)
      : null;
    flyer.doc = docForSource(store, region, source, held);
    flyer.heldStorageKey = held?.storage_key || null;
    flyer.legacySeedComplete = !held?.storage_key;
  }

  const legacySeed = await seedHeldPages(
    ctx,
    flyer,
    flyer.heldStorageKey,
    Math.min(8, Math.max(1, batchPages)),
  );
  if (legacySeed.seeded > 0) {
    await saveManifest(ctx, key, manifest);
    const totals = collectionTotals(manifest);
    await ctx.collectionStore.markPending(store, region, totals);
    return {
      store,
      region,
      complete: false,
      storeComplete: false,
      flyerRef: flyer.id,
      totalPages: flyer.source.pages.length,
      pagesCollected: 0,
      pagesReused: flyer.reusedPages || 0,
      nextPage: flyer.pages.length,
      externalRequests: requests.value,
      legacyMigrationBatch: true,
      legacyMigrationComplete: legacySeed.complete,
      batches: manifest.flyers.flatMap((item) => item.batches || []),
    };
  }

  const startIndex = await firstMissingPage(ctx.objectStore, flyer);
  flyer.pages = (flyer.pages || []).slice(0, startIndex);
  const totalPages = flyer.source.pages.length;
  const endIndex = Math.min(startIndex + Math.max(1, batchPages), totalPages);
  const staged = [];

  for (let index = startIndex; index < endIndex; index += 1) {
    const url = flyer.source.pages[index];
    const response = await fetchWithRetry(fetchImpl, requests, url, 'd4d page');
    const page = {
      index,
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: (response.headers.get('content-type') || 'image/webp').split(';')[0],
      url,
      ...(flyer.source.pageIds?.[index]
        ? { pageId: String(flyer.source.pageIds[index]) }
        : {}),
    };
    const entry = await ctx.pipeline.putImagePage(flyer.doc.storageKey, page);
    staged.push({
      index,
      key: entry.imageUrl,
      contentType: page.contentType,
      url,
      checksum: await sha256Hex(page.bytes),
      ...(page.pageId ? { pageId: page.pageId } : {}),
      reused: false,
    });
  }

  flyer.pages.push(...staged);
  const batch = {
    store,
    region,
    flyerRef: flyer.id,
    invocation: flyer.batches.length + 1,
    startIndex,
    endIndex: endIndex - 1,
    pagesCollected: staged.length,
    pagesReused: flyer.reusedPages || 0,
    externalRequests: requests.value,
    completedAt: new Date().toISOString(),
  };
  flyer.batches.push(batch);
  await saveManifest(ctx, key, manifest);

  if (flyer.pages.length < totalPages) {
    const totals = collectionTotals(manifest);
    await ctx.collectionStore.markPending(store, region, totals);
    return {
      store,
      region,
      complete: false,
      storeComplete: false,
      flyerRef: flyer.id,
      totalPages,
      pagesCollected: staged.length,
      pagesReused: flyer.reusedPages || 0,
      nextPage: flyer.pages.length,
      externalRequests: requests.value,
      batch,
      batches: manifest.flyers.flatMap((item) => item.batches || []),
    };
  }

  const pages = [];
  for (const stored of flyer.pages) {
    const object = await ctx.objectStore.get(stored.key);
    if (!object) throw new Error(`Missing stored D4D page ${store}/${flyer.id}/${stored.index}`);
    pages.push({
      index: stored.index,
      imageUrl: stored.key,
      pageId: stored.pageId,
    });
  }
  const checksumPayload = encodeJson({
    version: 1,
    sourceUrl: flyer.source.sourceUrl,
    pages: flyer.pages.map((page) => page.checksum),
  });
  const checksum = `sha256:${await sha256Hex(checksumPayload)}`;
  const finalDoc = {
    ...flyer.doc,
    complete: true,
    advertisedPageCount: totalPages,
    flyerRef: flyer.id,
  };
  const result = await ctx.pipeline.finalizeStoredImageSet({
    doc: finalDoc,
    pages,
    hotspots: flyer.source.hotspots || [],
    checksum,
  });
  const base = `brochures/${result.doc.storageKey}`;
  const [metaObject, hotspotsObject] = await Promise.all([
    ctx.objectStore.get(`${base}/meta.json`),
    ctx.objectStore.get(`${base}/hotspots.json`),
  ]);
  const meta = decodeJson(metaObject);
  if (
    !metaObject ||
    !hotspotsObject ||
    meta?.complete !== true ||
    meta?.advertisedPageCount !== totalPages ||
    meta?.pages?.length !== totalPages
  ) {
    throw new Error(`D4D flyer ${flyer.id} final completeness check failed`);
  }

  flyer.complete = true;
  flyer.checksum = result.doc.checksum;
  flyer.brochureId = result.doc.id;
  flyer.completedAt = new Date().toISOString();
  await saveManifest(ctx, key, manifest);

  const remaining = manifest.flyers.some((item) => !item.complete);
  const totals = collectionTotals(manifest);
  if (remaining) {
    await ctx.collectionStore.markPending(store, region, totals);
  } else {
    const checksums = manifest.flyers.map((item) => item.checksum).filter(Boolean);
    await ctx.metadataStore.setCurrent(store, region, checksums, { supersedeOthers: true });
    // Keep both the job and manifest pending until the exact offer-linkage
    // refresh succeeds. That makes publication retryable without rebuilding
    // or re-downloading an already complete brochure set.
    await ctx.collectionStore.markPending(store, region, totals);
  }

  return {
    store,
    region,
    complete: true,
    storeComplete: !remaining,
    flyerRef: flyer.id,
    brochureId: result.doc.id,
    status: result.status,
    totalPages,
    pagesCollected: staged.length,
    pagesReused: flyer.reusedPages || 0,
    externalRequests: requests.value,
    batch,
    batches: manifest.flyers.flatMap((item) => item.batches || []),
    brochuresCompleted: manifest.flyers.filter((item) => item.complete).length,
    advertisedBrochures: manifest.flyers.length,
    collectionTotals: totals,
    manifestKey: key,
  };
}

export async function publishD4dCollection(ctx, result) {
  if (!result?.storeComplete || !result.manifestKey || !result.collectionTotals) {
    throw new Error('Cannot publish an incomplete D4D collection');
  }
  await ctx.collectionStore.markComplete(result.store, result.region, result.collectionTotals);
  await ctx.objectStore.delete(result.manifestKey);
}

export { flyerRefFromUrl };
