// hotspots.test.mjs — pure, offline tests for the D4D hotspot parser.
// Run: node src/hotspots.test.mjs
//
// The fixture mirrors the two blob locations observed live on d4donline.com
// leaflet pages (2026-07): the carousel copy's container-level data-coords-json
// (owning the spread's FIRST page) and the plain copy's picture-level
// data-next-page-coords (owning the FOLLOWING page).

import { parseHotspots, flyerRefFromUrl } from './hotspots.js';

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

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nAll hotspot parser tests passed.');
