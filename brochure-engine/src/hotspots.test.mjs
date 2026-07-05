// hotspots.test.mjs — pure, offline tests for the D4D hotspot parser, the
// source-index -> stored-ordinal remap, and the STORAGE-ONLY doc builder
// (snapshot-at-ingest: the read path serves stored geometry and never fetches).
// Run: node src/hotspots.test.mjs
//
// The fixture mirrors the two blob locations observed live on d4donline.com
// leaflet pages (2026-07): the carousel copy's container-level data-coords-json
// (owning the spread's FIRST page) and the plain copy's picture-level
// data-next-page-coords (owning the FOLLOWING page).

import { parseHotspots, remapHotspotPages, flyerRefFromUrl, getHotspotsDoc } from './hotspots.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const coords = (id, x1, y1, x2, y2) =>
  JSON.stringify([
    {
      id_product: id,
      url: `https:\\/\\/d4donline.com\\/x\\/${id}\\/p`,
      coordinates: [
        { x: x1, y: y1 },
        { x: x2, y: y1 },
        { x: x2, y: y2 },
        { x: x1, y: y2 },
        { x: x1, y: y1 },
      ],
    },
  ]);

const html = `
<main id="offer-pages" class="carousel">
  <figure class="carousel-cell is-selected" data-index="0">
    <div class="zoom-holder">
      <figure class="image-container flyer-container" data-coords-json='${coords(111, 100, 150, 600, 750)}'>
        <picture class="offer-page" data-width="1000" data-height="1500" data-page-no="1" data-page="738954" data-index="0" data-next-page-coords='${coords(222, 0, 0, 500, 300)}'>
          <img src="https://cdn.d4donline.com/u/a.webp" alt="Page 1">
        </picture>
      </figure>
    </div>
  </figure>
  <figure class="carousel-cell" data-index="1">
    <div class="zoom-holder">
      <figure class="image-container flyer-container" data-coords-json='[not json]'>
        <picture class="offer-page" data-width="1000" data-height="1500" data-page-no="3" data-page="738954" data-index="2" data-page-id="9393333">
          <img src="https://cdn.d4donline.com/u/c.webp" alt="Page 3">
        </picture>
      </figure>
    </div>
  </figure>
</main>
<picture class="offer-page" data-width="1000" data-height="1500" data-page-no="2" data-page="738954" data-index="1">
  <img src="https://cdn.d4donline.com/u/b.webp" alt="Page 2">
</picture>`;

const pages = parseHotspots(html);

check('parses two pages with spots (0 from container, 1 from next-page)', pages.length === 2,
  `got ${JSON.stringify(pages.map((p) => p.index))}`);

const p0 = pages.find((p) => p.index === 0);
check('page 0 exists with one spot', !!p0 && p0.spots.length === 1);
check('page 0 spot id + normalized bbox', !!p0 &&
  p0.spots[0].offerId === '111' &&
  p0.spots[0].x === 0.1 && p0.spots[0].y === 0.1 &&
  p0.spots[0].w === 0.5 && p0.spots[0].h === 0.4,
  JSON.stringify(p0 && p0.spots[0]));

const p1 = pages.find((p) => p.index === 1);
check('page 1 (from data-next-page-coords on picture 0) exists', !!p1 && p1.spots.length === 1);
check('page 1 spot normalized', !!p1 &&
  p1.spots[0].offerId === '222' &&
  p1.spots[0].x === 0 && p1.spots[0].w === 0.5 && p1.spots[0].h === 0.2,
  JSON.stringify(p1 && p1.spots[0]));

check('malformed blob loses only its page', !pages.find((p) => p.index === 2));

check('flyerRefFromUrl extracts the flyer id',
  flyerRefFromUrl('https://d4donline.com/en/saudi-arabia/riyadh/offers/lulu-hypermarket-63/738954/some-slug') === '738954');
check('flyerRefFromUrl null on non-leaflet URL',
  flyerRefFromUrl('https://d4donline.com/en/saudi-arabia/riyadh/offers/lulu-hypermarket-63') === null);

// --- remap: source data-index -> stored ordinal ------------------------------
// Stored ordinals come from the adapter's ordered page list; a source page
// with no image (here data-index 1) is not stored, so its hotspots drop and
// later pages' geometry lands on the SHIFTED ordinal, matching pageNN.webp.
{
  const spots = [{ offerId: '9', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }];
  const remapped = remapHotspotPages(
    [
      { index: 0, spots },
      { index: 1, spots }, // source page not stored -> dropped
      { index: 2, spots }, // stored at ordinal 1
    ],
    [0, 2, 3], // sourceIndexes: ordinal i holds source page sourceIndexes[i]
  );
  check('remap keeps stored pages on their ordinals',
    remapped.length === 2 && remapped[0].index === 0 && remapped[1].index === 1,
    JSON.stringify(remapped.map((p) => p.index)));
  check('remap drops geometry for unstored source pages',
    !remapped.some((p) => p.spots !== spots) && remapped.length === 2);
}

// --- doc builder: STORAGE-ONLY (never fetches the aggregator) -----------------
{
  const row = {
    id: 'lulu:central:2026-W27',
    store: 'lulu',
    region: 'central',
    source_type: 'images',
    source_url: 'https://d4donline.com/en/saudi-arabia/riyadh/offers/lulu-hypermarket-63/738954/weekly',
    storage_key: 'lulu/central/2026-W27',
  };
  const snapshot = { pages: [{ index: 0, spots: [{ offerId: '111', x: 0, y: 0, w: 0.5, h: 0.5 }] }] };
  const objects = new Map([
    ['brochures/lulu/central/2026-W27/hotspots.json',
      { bytes: new TextEncoder().encode(JSON.stringify(snapshot)) }],
  ]);
  const ctx = {
    metadataStore: { getById: async (id) => (id === row.id ? row : null) },
    objectStore: { get: async (key) => objects.get(key) || null },
    offerStore: { byFlyer: async () => [{ offer_id: '111', price: 9 }] },
  };

  const hit = await getHotspotsDoc(ctx, row.id, { rowToOffer: (r) => r });
  check('stored snapshot is served with the offers join',
    hit.status === 200 && hit.doc.pages.length === 1 && hit.doc.offers['111'].price === 9 &&
    hit.doc.flyerRef === '738954');

  objects.clear();
  const miss = await getHotspotsDoc(ctx, row.id, { rowToOffer: (r) => r });
  check('missing snapshot serves empty spots (no fetch path exists)',
    miss.status === 200 && miss.doc.pages.length === 0);

  const notFound = await getHotspotsDoc(ctx, 'nope:x:y', {});
  check('unknown brochure is a 404', notFound.status === 404);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll hotspot parser tests passed.');
