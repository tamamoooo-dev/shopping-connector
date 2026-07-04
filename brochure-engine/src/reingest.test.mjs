// reingest.test.mjs — pure, offline tests for the held-flyer re-render
// detection (collectors/aggregator.js) and the pipeline's stale-cache
// handling (pipeline.js): hotspots.json invalidation on changed bytes and
// meta-only refresh when byte-identical pages gain deep-link page ids.
// Run: node src/reingest.test.mjs
//
// Why this exists (2026-07-05): D4D re-rendered live flyers mid-week under
// the SAME leaflet URL (lulu W27 went 40 -> 80 pages), which the sourceUrl-
// only findHeld match could not see — held editions froze on the stale
// rendering (no pageIds, misaligned cached hotspot geometry) until the
// edition rolled over.

import { createAggregatorCollector } from './collectors/aggregator.js';
import { createPipeline } from './pipeline.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --- shared fakes ---------------------------------------------------------

const week = () => {
  const d = new Date();
  const from = new Date(d.getTime() - 86400000).toISOString().slice(0, 10);
  const to = new Date(d.getTime() + 5 * 86400000).toISOString().slice(0, 10);
  return { from, to };
};

function fakeAdapter(pageCount, { withIds = false } = {}) {
  const { from, to } = week();
  return {
    name: 'd4d',
    async listBrochures() {
      return [
        {
          id: 738954,
          slug: 'weekly',
          title: 'Weekly',
          validFrom: from,
          validTo: to,
          pages: Array.from({ length: pageCount }, (_, i) => `https://cdn.example/p${i}.webp`),
          pageIds: Array.from({ length: pageCount }, (_, i) =>
            withIds && i % 2 === 0 ? String(9000 + i) : null,
          ),
          sourceUrl: 'https://d4donline.com/en/sa/riyadh/offers/store-1/738954/weekly',
        },
      ];
    },
  };
}

const fetchImpl = async () => ({
  ok: true,
  headers: { get: () => 'image/webp' },
  arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
});

function collector(adapter) {
  return createAggregatorCollector({ adapter, fetchImpl, maxPages: 36, maxTotalPages: 36 });
}

const heldRow = { id: 'store:central:2026-W27', checksum: 'sha256:x', storage_key: 'store/central/2026-W27' };
const heldPages = (count, { withIds = false } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    index: i,
    imageUrl: `brochures/store/central/2026-W27/page${String(i).padStart(2, '0')}.webp`,
    ...(withIds && i % 2 === 0 ? { pageId: String(9000 + i) } : {}),
  }));

const collectCtx = (held, pages) => ({
  store: 'store',
  region: 'central',
  regionConfig: { store: 'store-1' },
  findHeld: async () => held,
  readHeldPages: async () => pages,
});

// --- collector: re-render detection ----------------------------------------

{
  // unchanged flyer (same count, no ids anywhere) -> existing, zero downloads
  const out = await collector(fakeAdapter(20)).collect(collectCtx(heldRow, heldPages(20)));
  check('unchanged held flyer stays existing', out.length === 1 && out[0].existing === heldRow);
}

{
  // source re-paginated under the same URL (20 -> 30 pages) -> re-download
  const out = await collector(fakeAdapter(30)).collect(collectCtx(heldRow, heldPages(20)));
  check('re-paginated flyer re-downloads', out.length === 1 && out[0].pages && out[0].pages.length === 30);
}

{
  // source now exposes deep-link ids the held copy lacks -> re-download
  const out = await collector(fakeAdapter(20, { withIds: true })).collect(collectCtx(heldRow, heldPages(20)));
  check('newly exposed pageIds re-download', out.length === 1 && out[0].pages && out[0].pages.length === 20);
  check('re-download carries the ids', out.length === 1 && out[0].pages && out[0].pages[0].pageId === '9000');
}

{
  // held copy already has the ids -> existing again (the trigger goes quiet)
  const out = await collector(fakeAdapter(20, { withIds: true })).collect(
    collectCtx(heldRow, heldPages(20, { withIds: true })),
  );
  check('id-complete held flyer stays existing', out.length === 1 && out[0].existing === heldRow);
}

{
  // unreadable held meta (pruned bytes) -> conservative: existing, no downloads
  const out = await collector(fakeAdapter(30)).collect(collectCtx(heldRow, null));
  check('unreadable held meta counts as unchanged', out.length === 1 && out[0].existing === heldRow);
}

// --- pipeline: hotspots invalidation + meta-only refresh --------------------

function fakeStores({ heldChecksum = null } = {}) {
  const objects = new Map();
  const deleted = [];
  const rows = [];
  return {
    objects,
    deleted,
    rows,
    objectStore: {
      async put(key, bytes, meta) {
        objects.set(key, { bytes, meta });
      },
      async get(key) {
        return objects.get(key) || null;
      },
      async delete(key) {
        deleted.push(key);
        objects.delete(key);
      },
    },
    metadataStore: {
      async existsByChecksum(sum) {
        return heldChecksum !== null && sum === heldChecksum;
      },
      async upsert(row) {
        rows.push(row);
      },
    },
  };
}

const doc = {
  id: 'store:central:2026-W27',
  store: 'store',
  region: 'central',
  edition: '2026-W27',
  sourceType: 'images',
  storageKey: 'store/central/2026-W27',
};
const page = (index, byte, pageId = null) => ({
  index,
  bytes: new Uint8Array([byte]),
  contentType: 'image/webp',
  url: `https://cdn.example/p${index}.webp`,
  pageId,
});

{
  // changed bytes re-store -> stale hotspots.json is dropped
  const s = fakeStores();
  const pipeline = createPipeline(s);
  const res = await pipeline.ingest({ doc, pages: [page(0, 1), page(1, 2)] });
  check('changed bytes store as new', res.status === 'new');
  check(
    'hotspots cache dropped on re-store',
    s.deleted.includes('brochures/store/central/2026-W27/hotspots.json'),
  );
}

{
  // byte-identical pages with NEW ids -> deduped, meta refreshed, no byte puts
  const s = fakeStores();
  const pipeline = createPipeline(s);
  const first = await pipeline.ingest({ doc, pages: [page(0, 1), page(1, 2)] });
  const putsAfterFirst = s.objects.size;
  s.metadataStore.existsByChecksum = async (sum) => sum === first.doc.checksum;
  const res = await pipeline.ingest({ doc, pages: [page(0, 1, '9000'), page(1, 2)] });
  check('identical bytes dedupe', res.status === 'deduped');
  const meta = JSON.parse(new TextDecoder().decode(s.objects.get('brochures/store/central/2026-W27/meta.json').bytes));
  check('deduped meta gains the pageId', meta.pages[0].pageId === '9000');
  check('dedupe writes no page bytes', s.objects.size === putsAfterFirst);
}

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('\nAll re-ingest tests passed.');
