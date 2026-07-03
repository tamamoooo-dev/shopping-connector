// panda.test.mjs — locks the Panda navigation regression: the product page (and
// its /v3/products/<id> detail call) resolve only by the VARIETY id, never the
// catalogue product.id. The products-v3 strategy used to emit product.id, so
// opening a Panda result reached Panda and then rendered "No products found".
//
// Fixture shaped from a real api.panda.sa /v3/products response (verified live
// 2026-07: product.id 18499 → detail 412, variety.id 28874 → detail 200). Run:
//   node src/providers/panda.test.mjs

import { normalizeProduct } from './panda.js';

let passed = 0;
const fail = (m) => {
  console.error('❌', m);
  process.exit(1);
};
const ok = (cond, m) => {
  if (!cond) fail(m);
  passed++;
};

// A product whose catalogue id (18499) differs from its variety id (28874).
const product = {
  id: 18499,
  name: 'Almarai Long Life Milk Full Fat 18x150Ml',
  brand: { name: 'Almarai' },
  varieties: [
    { id: 28874, price: '25.50', undiscounted_price: '30.00', size: '150', unit: 'Ml', sku: '100144162', discount_label: '-15%' },
  ],
};

const r = normalizeProduct(product, 'en');

// The regression: id and link must be the VARIETY id (the storefront's key),
// NOT the catalogue product.id — otherwise the page shows "No products found".
ok(r.id === 28874, `result id must be the variety id 28874, got ${r.id}`);
ok(r.link === 'https://panda.sa/en/p/28874.almarai-long-life-milk-full-fat-18x150ml', `link must use the variety id: "${r.link}"`);
ok(!String(r.link).includes('18499'), 'link must NOT contain the catalogue product id 18499 (the exact bug)');

// The rest of the normalized contract stays intact.
ok(r.name === 'Almarai Long Life Milk Full Fat 18x150Ml', `name wrong: "${r.name}"`);
ok(r.price === 25.5 && r.oldPrice === 30, `price/oldPrice wrong: ${r.price}/${r.oldPrice}`);
ok(r.brand === 'Almarai', `brand wrong: "${r.brand}"`);
ok(r.size === '150 Ml', `size wrong: "${r.size}"`);

// Defensive fallback: a product with no variety keeps the catalogue id rather
// than emitting an undefined id/link.
const noVariety = normalizeProduct({ id: 555, name: 'Orphan Product', varieties: [] }, 'en');
ok(noVariety.id === 555, `no-variety fallback id wrong: ${noVariety.id}`);
ok(noVariety.link.includes('555'), `no-variety fallback link wrong: "${noVariety.link}"`);

console.log(`panda.test: ${passed} passed, 0 failed`);
