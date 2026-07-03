// amazon.test.mjs — locks the Amazon search-HTML parser against the regression
// that made Amazon feel unreliable: the current amazon.sa layout renders a
// compact BRAND <h2> before the product-title <h2>, and the old parser took the
// first <h2> — so English results were named "Almarai"/"Saudia" (no product
// words) and the frontend's honest relevance filter then dropped them.
//
// Fixtures are trimmed from real amazon.sa markup (verified live 2026-07). Run:
//   node src/providers/amazon.test.mjs

import { parseProducts } from './amazon.js';

let passed = 0;
const fail = (m) => {
  console.error('❌', m);
  process.exit(1);
};
const ok = (cond, m) => {
  if (!cond) fail(m);
  passed++;
};

// A two-<h2> English block (brand line THEN title, the current layout), with a
// strike-through list price; a single-<h2> block (no brand line); and an Arabic
// block (title only, aria-label carries the full name).
const html = `
<div>
  data-asin="B0DWX9K4N9" data-component-type="s-search-result"
  <h2 class="a-size-mini s-line-clamp-1"><span class="a-size-base-plus a-color-base">Almarai</span></h2>
  <h2 aria-label="Full Fat Fresh Milk, 2.85 Liter" class="a-size-base-plus a-spacing-none a-color-base a-text-normal"><span>Full Fat Fresh Milk, 2.85 Liter</span></h2>
  <img class="s-image" src="https://m.media-amazon.com/img1.jpg"/>
  <span class="a-price"><span class="a-offscreen">SAR 16.50</span></span>
  data-asin="B086CLM1PM" data-component-type="s-search-result"
  <h2 class="a-size-mini s-line-clamp-1"><span class="a-size-base-plus a-color-base">Nadec</span></h2>
  <h2 aria-label="Sponsored Ad – Full Fat Long Life Milk, 12 x 1 Liter" class="a-text-normal"><span>Full Fat Long Life Milk, 12 x 1 Liter</span></h2>
  <img class="s-image" src="https://m.media-amazon.com/img2.jpg"/>
  <span class="a-price"><span class="a-offscreen">SAR 51.99</span></span>
  <span class="a-price a-text-price"><span class="a-offscreen">SAR 67.50</span></span>
  data-asin="B0DQ1CNM8H" data-component-type="s-search-result"
  <h2 class="a-size-base-plus a-spacing-none a-color-base a-text-normal"><span>WHOLE MILK 1L Promo pack</span></h2>
  <img class="s-image" src="https://m.media-amazon.com/img3.jpg"/>
  <span class="a-price"><span class="a-offscreen">SAR 6.00</span></span>
  data-asin="B098RKQQZD" data-component-type="s-search-result"
  <h2 aria-label="حليب كامل الدسم من نادك، 18 × 125 مل" class="a-size-base-plus a-color-base a-text-normal"><span>حليب كامل الدسم من نادك، 18 × 125 مل</span></h2>
  <img class="s-image" src="https://m.media-amazon.com/img4.jpg"/>
  <span class="a-price"><span class="a-offscreen">SAR 14.99</span></span>
</div>`;

const r = parseProducts(html);
ok(r.length === 4, `expected 4 results, got ${r.length}`);

const [almarai, nadec, whole, arabic] = r;

// The regression: the product name must be the TITLE (with the query word
// "milk"), brand-led, NOT the bare brand.
ok(almarai.name === 'Almarai Full Fat Fresh Milk, 2.85 Liter', `brand-led name wrong: "${almarai.name}"`);
ok(almarai.brand === 'Almarai', `brand not extracted: "${almarai.brand}"`);
ok(/milk/i.test(almarai.name), 'name lost the product word "milk" (the exact regression)');
ok(almarai.oldPrice === null, 'no strike-through -> oldPrice must be null');

// Sponsored prefix stripped; strike-through list price becomes oldPrice + label.
ok(nadec.name === 'Nadec Full Fat Long Life Milk, 12 x 1 Liter', `sponsored/brand name wrong: "${nadec.name}"`);
ok(nadec.price === 51.99 && nadec.oldPrice === 67.5, `price/oldPrice wrong: ${nadec.price}/${nadec.oldPrice}`);
ok(nadec.discountLabel === '-23%', `discount label wrong: "${nadec.discountLabel}"`);

// Single-<h2> block: that h2 IS the title (no brand line to mistake for it).
ok(whole.name === 'WHOLE MILK 1L Promo pack', `single-h2 title wrong: "${whole.name}"`);
ok(whole.brand === '', 'single-h2 block should have no brand');

// Arabic block: title-only, full name intact, link is /dp/<asin>.
ok(arabic.name === 'حليب كامل الدسم من نادك، 18 × 125 مل', `arabic name wrong: "${arabic.name}"`);
ok(arabic.link === 'https://www.amazon.sa/dp/B098RKQQZD', `link wrong: "${arabic.link}"`);

console.log(`amazon.test: ${passed} passed, 0 failed`);
