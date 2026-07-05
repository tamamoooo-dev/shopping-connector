// reingest.test.mjs — pure, offline tests for the held-flyer re-render
// detection (collectors/aggregator.js) and the pipeline's snapshot-at-ingest
// hotspot handling (pipeline.js): hotspots.json is written WITH the pages it
// describes, overwritten on a changed-bytes re-store, reconciled on dedupe,
// and healable for held flyers — plus meta-only refresh when byte-identical
// pages gain deep-link page ids.
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

const spotFor = (i) => ({ offerId: String(100 + i), x: 0.1, y: 0.1, w: 0.2, h: 0.2 });

function fakeAdapter(pageCount, { withIds = false, withHotspots = false } = {}) {
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
          hotspots: withHotspots
            ? Array.from({ length: pageCount }, (_, i) => ({ index: i, spots: [spotFor(i)] }))
            : [],
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
  // unchanged flyer (same count, no ids anywhere) -> existing, zero downloads,
  // and the freshly parsed geometry rides along so the engine can heal a
  // missing/legacy hotspots.json for the held copy.
  const out = await collector(fakeAdapter(20, { withHotspots: true })).collect(
    collectCtx(heldRow, heldPages(20)),
  );
  check('unchanged held flyer stays existing', out.length === 1 && out[0].existing === heldRow);
  check('existing candidate carries the geometry snapshot',
    out.length === 1 && Array.isArray(out[0].hotspots) && out[0].hotspots.length === 20 &&
    out[0].hotspots[0].spots[0].offerId === '100');
}

{
  // source re-paginated under the same URL (20 -> 30 pages) -> re-download
  const out = await collector(fakeAdapter(30, { withHotspots: true })).collect(
    collectCtx(heldRow, heldPages(20)),
  );
  check('re-paginated flyer re-downloads', out.length === 1 && out[0].pages && out[0].pages.length === 30);
  check('re-download carries the geometry snapshot',
    out.length === 1 && Array.isArray(out[0].hotspots) && out[0].hotspots.length === 30);
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
  // unreadable held meta (pruned bytes) -> conservative: existing, no downloads,
  // and NO geometry attached (never resurrect keys retention deleted).
  const out = await collector(fakeAdapter(30, { withHotspots: true })).collect(collectCtx(heldRow, null));
  check('unreadable held meta counts as unchanged', out.length === 1 && out[0].existing === heldRow);
  check('unreadable held meta attaches no geometry', out.length === 1 && out[0].hotspots === undefined);
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

const hotspotsKey = 'brochures/store/central/2026-W27/hotspots.json';
const readSnapshot = (s) => {
  const obj = s.objects.get(hotspotsKey);
  return obj ? JSON.parse(new TextDecoder().decode(obj.bytes)) : null;
};

{
  // new store -> hotspots.json is written WITH the pages (snapshot-at-ingest)
  const s = fakeStores();
  const pipeline = createPipeline(s);
  const res = await pipeline.ingest({
    doc,
    pages: [page(0, 1), page(1, 2)],
    hotspots: [{ index: 0, spots: [spotFor(0)] }],
  });
  check('changed bytes store as new', res.status === 'new');
  const snap = readSnapshot(s);
  check('geometry snapshot stored with the pages',
    !!snap && snap.pages.length === 1 && snap.pages[0].spots[0].offerId === '100');

  // changed-bytes re-store (re-render) -> the snapshot is OVERWRITTEN, even by
  // an empty parse: the old rendering's geometry never survives its pages.
  const res2 = await pipeline.ingest({ doc, pages: [page(0, 3), page(1, 4)], hotspots: [] });
  check('re-render stores as new', res2.status === 'new');
  const snap2 = readSnapshot(s);
  check('stale snapshot overwritten on re-store', !!snap2 && snap2.pages.length === 0);
}

{
  // byte-identical pages with NEW ids -> deduped, meta refreshed, no byte puts,
  // and a missing snapshot is healed (same rendering, so the geometry is valid)
  const s = fakeStores();
  const pipeline = createPipeline(s);
  const first = await pipeline.ingest({ doc, pages: [page(0, 1), page(1, 2)] });
  s.objects.delete(hotspotsKey); // simulate an edition ingested before capture
  const pageObjects = [...s.objects.keys()].filter((k) => /page\d+/.test(k)).length;
  s.metadataStore.existsByChecksum = async (sum) => sum === first.doc.checksum;
  const res = await pipeline.ingest({
    doc,
    pages: [page(0, 1, '9000'), page(1, 2)],
    hotspots: [{ index: 1, spots: [spotFor(1)] }],
  });
  check('identical bytes dedupe', res.status === 'deduped');
  const meta = JSON.parse(new TextDecoder().decode(s.objects.get('brochures/store/central/2026-W27/meta.json').bytes));
  check('deduped meta gains the pageId', meta.pages[0].pageId === '9000');
  check('dedupe writes no page bytes',
    [...s.objects.keys()].filter((k) => /page\d+/.test(k)).length === pageObjects);
  const snap = readSnapshot(s);
  check('dedupe heals a missing snapshot', !!snap && snap.pages[0].index === 1);
}

{
  // ensureHotspots (the held-flyer heal): writes when missing, keeps when
  // identical, rewrites when different (legacy on-demand cache convergence)
  const s = fakeStores();
  const pipeline = createPipeline(s);
  const pages1 = [{ index: 0, spots: [spotFor(0)] }];
  check('heal writes a missing snapshot',
    (await pipeline.ensureHotspots('store/central/2026-W27', pages1)) === 'written');
  check('heal keeps an identical snapshot',
    (await pipeline.ensureHotspots('store/central/2026-W27', pages1)) === 'kept');
  const pages2 = [{ index: 0, spots: [spotFor(3)] }];
  check('heal rewrites a differing snapshot',
    (await pipeline.ensureHotspots('store/central/2026-W27', pages2)) === 'written');
  check('healed snapshot holds the new geometry',
    readSnapshot(s).pages[0].spots[0].offerId === '103');
}

{
  // SAFEGUARD: an EMPTY parse must NEVER overwrite a NON-EMPTY stored snapshot
  // on the same rendering (the dedupe/held path) — that is the destructive
  // parser-break case. ensureHotspots keeps the good geometry and reports it.
  const s = fakeStores();
  const pipeline = createPipeline(s);
  const good = [{ index: 0, spots: [spotFor(0), spotFor(1)] }];
  await pipeline.ensureHotspots('store/central/2026-W27', good);
  const status = await pipeline.ensureHotspots('store/central/2026-W27', []);
  check('empty parse over non-empty snapshot is refused', status === 'refused-empty');
  check('good geometry survives a parser break',
    readSnapshot(s).pages.length === 1 && readSnapshot(s).pages[0].spots.length === 2);

  // A genuinely empty flyer (empty stored, empty parse) is fine — not a suspect.
  const s2 = fakeStores();
  const p2 = createPipeline(s2);
  await p2.ensureHotspots('store/central/2026-W27', []);
  check('empty over missing/empty writes normally (no false alarm)',
    (await p2.ensureHotspots('store/central/2026-W27', [])) === 'kept');
}

{
  // The DEDUPE path (byte-identical pages, same rendering) must also refuse to
  // erase a held snapshot when this run's parse came back empty.
  const s = fakeStores();
  const pipeline = createPipeline(s);
  const first = await pipeline.ingest({
    doc, pages: [page(0, 1), page(1, 2)], hotspots: [{ index: 0, spots: [spotFor(0)] }],
  });
  s.metadataStore.existsByChecksum = async (sum) => sum === first.doc.checksum;
  await pipeline.ingest({ doc, pages: [page(0, 1), page(1, 2)], hotspots: [] });
  const snap = readSnapshot(s);
  check('dedupe with empty parse keeps the held geometry',
    !!snap && snap.pages.length === 1 && snap.pages[0].spots[0].offerId === '100');
}

if (failures) {
  console.error(`\n${failures} failure(s).`);
  process.exit(1);
}
console.log('\nAll re-ingest tests passed.');
