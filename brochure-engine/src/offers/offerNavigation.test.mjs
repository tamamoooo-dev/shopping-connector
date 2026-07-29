import assert from 'node:assert/strict';
import { ingestOffers } from './ingest.js';
import { rowToOffer } from './contract.js';
import {
  createMemoryMetadataStore,
  createMemoryOfferStore,
} from '../storage/local.js';

const enc = new TextEncoder();
const today = new Date().toISOString().slice(0, 10);
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const metadataStore = createMemoryMetadataStore();
const offerStore = createMemoryOfferStore();

await metadataStore.upsert({
  id: 'shop:central:2026-W31',
  store: 'shop',
  region: 'central',
  edition: '2026-W31',
  source_type: 'images',
  source_url: 'https://d4donline.com/en/saudi-arabia/riyadh/offers/shop-1/111/weekly',
  storage_key: 'shop/central/2026-W31',
  checksum: 'sha256:test',
  detected_at: new Date().toISOString(),
});

const objects = new Map([
  [
    'brochures/shop/central/2026-W31/meta.json',
    {
      complete: true,
      advertisedPageCount: 2,
      pages: [
        { index: 0, pageId: 'page-a', imageUrl: 'page00.webp' },
        // Policy B case: no pageId, but one exact hotspot maps the offer to one
        // stored page.
        { index: 1, imageUrl: 'page01.webp' },
      ],
    },
  ],
  [
    'brochures/shop/central/2026-W31/hotspots.json',
    {
      pages: [
        { index: 0, spots: [{ offerId: 'A', x: 0, y: 0, w: 1, h: 1 }] },
        { index: 1, spots: [{ offerId: 'B', x: 0, y: 0, w: 1, h: 1 }] },
      ],
    },
  ],
]);
const objectStore = {
  async get(key) {
    const value = objects.get(key);
    return value ? { bytes: enc.encode(JSON.stringify(value)) } : null;
  },
};

const offersSource = {
  name: 'd4d',
  async listOffers() {
    const common = {
      flyerRef: '111',
      price: 10,
      description: 'Test product',
      validFrom: today,
      validTo: nextWeek,
    };
    return [
      { ...common, offerId: 'A', pageRef: 'page-a' },
      { ...common, offerId: 'B', pageRef: 'legacy-missing-page-id' },
      { ...common, offerId: 'C', pageRef: 'page-not-downloaded' },
      { ...common, offerId: 'D', flyerRef: '222', pageRef: 'other-flyer' },
    ];
  },
};
const provider = {
  id: 'shop',
  regions: { central: { store: 'shop-1', city: 'riyadh' } },
};

await offerStore.upsertMany([{
  id: 'shop:central:d4d:E',
  store: 'shop',
  region: 'central',
  source: 'd4d',
  offer_id: 'E',
  flyer_ref: '111',
  page_ref: 'page-a',
  brochure_id: null,
  page_index: null,
  edition: null,
  name: 'Stored offer omitted by latest response',
  name_ar: null,
  price: 12,
  old_price: null,
  currency: 'SAR',
  category_id: null,
  category: null,
  image_url: null,
  source_url: 'https://d4donline.test/provenance',
  valid_from: today,
  valid_to: nextWeek,
  detected_at: new Date().toISOString(),
  search_text: 'stored offer omitted by latest response',
  identity: null,
  brand_slug: null,
}]);
objects.get('brochures/shop/central/2026-W31/hotspots.json')
  .pages[0].spots.push({ offerId: 'E', x: 0, y: 0, w: 1, h: 1 });

const report = await ingestOffers({
  registry: { shop: provider },
  metadataStore,
  objectStore,
  offerStore,
  offersSource,
}, { store: 'shop' });

assert.equal(report.totals.fetched, 4);
assert.equal(report.totals.stored, 4);
assert.equal(report.totals.linked, 2);
assert.equal(report.totals.unbacked, 2);
assert.equal(report.totals.dropped, 0);
assert.equal(report.targets[0].restored, 1);
assert.equal(report.totals.navigation.failClosed, false);
assert.equal(report.totals.navigation.dual, 2);
assert.equal(report.totals.navigation.hotspotUniqueAccepted, 1);

const rows = await offerStore.listAll();
assert.deepEqual(rows.map((r) => r.offer_id).sort(), ['A', 'B', 'C', 'D', 'E']);
assert.deepEqual(
  rows.filter((r) => r.brochure_id).map((r) => ({
    id: r.offer_id,
    brochureId: r.brochure_id,
    pageIndex: r.page_index,
    provenance: r.navigation_provenance,
  })).sort((a, b) => a.id.localeCompare(b.id)),
  [
    { id: 'A', brochureId: 'shop:central:2026-W31', pageIndex: 0, provenance: 'dual' },
    { id: 'B', brochureId: 'shop:central:2026-W31', pageIndex: 1, provenance: 'hotspot_unique' },
    { id: 'E', brochureId: 'shop:central:2026-W31', pageIndex: 0, provenance: 'dual' },
  ],
);
const navigable = await offerStore.search({ currentOn: today });
assert.equal(navigable.length, 3);
assert.equal(rowToOffer(navigable[0]).brochureId, 'shop:central:2026-W31');
assert.equal(Number.isInteger(rowToOffer(navigable[0]).pageIndex), true);
assert.ok(navigable.every((r) => ['dual', 'hotspot_unique'].includes(r.navigation_provenance)));

console.log('offerNavigation.test: locally-backed ingestion and page linkage passed');
