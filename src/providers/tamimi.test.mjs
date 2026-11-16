// tamimi.test.mjs — Tamimi's new search service (Constructor, 2026-11-16).
// Fixtures shaped from live answers of the Arabic and English indexes. Run:
//   node src/providers/tamimi.test.mjs

import { BRANCH, normalize, packPrice, searchUrl, tamimiProvider } from './tamimi.js';

let passed = 0;
const fail = (m) => {
  console.error('❌', m);
  process.exit(1);
};
const ok = (cond, m) => {
  if (!cond) fail(m);
  passed++;
};
const at = (v) => ({ [BRANCH]: v, V152: 999 });

const pack = (id, variant, barcode, list, net, inStock = true) => ({
  url: 'https://ecom.tamimimarkets.com/products/milk-long-life-full-fat-334500',
  variant,
  barcode,
  image_url: `https://ecommedia.tamimimarkets.com/ecom-prod/productimages/${id}_1.png`,
  variation_id: id,
  price: at(list),
  net_price: at(net),
  discount: at(Math.round((list - net) * 100) / 100),
  on_promotion: at(list > net),
  in_stock: at(inStock),
});

// The search shows the single 150 ml; the 18-pack comes first in variations.
const single = pack('334500EA', '150 مل', 6281007046237, 1.5, 1.5);
const multipack = pack('334500PAK', '18 x 150 مل', 6281007046244, 26.95, 26.95);
const longLife = {
  value: 'حليب طويل الاجل كامل الدسم',
  data: { id: '334500', brand: 'المراعي', tm_code: 'TM1.7.2', ...single },
  variations: [
    { value: 'حليب طويل الاجل كامل الدسم', data: multipack },
    { value: 'حليب طويل الاجل كامل الدسم', data: single },
  ],
};

const r = normalize(longLife);
ok(r.id === 334500, `the product number stays a number, as the old shop gave it (got ${JSON.stringify(r.id)})`);
ok(r.name === 'حليب طويل الاجل كامل الدسم', 'the name is the store name, brand and size apart');
ok(r.brand === 'المراعي' && r.size === '150 مل', 'brand and size are their own fields');
ok(r.price === 1.5 && r.oldPrice === null && r.discountLabel === '', 'the shown pack prices the result');
ok(r.currency === 'SAR' && r.inStock === true, 'riyals, in stock at the branch');
ok(r.link === 'https://www.tamimimarkets.com/products/milk-long-life-full-fat-334500', `the link opens on Tamimi's own site (got ${r.link})`);
ok(r.image.startsWith('https://ecommedia.tamimimarkets.com/'), 'the image is kept');
ok(r.barcodes.length === 1 && r.barcodes[0] === '628100704623', `the barcode is the 12-digit key (got ${r.barcodes})`);
ok(r.variants.length === 2 && r.variants[0].id === '334500EA', 'the shown pack is the first variant, so it keeps the product id');
ok(r.variants[1].id === '334500PAK' && r.variants[1].size === '18 x 150 مل' && r.variants[1].price === 26.95, 'the 18-pack is its own priced variant');
ok(r.variants[1].barcodes[0] === '628100704624', 'each pack carries its own barcode');

// A promotion: net_price is the selling price, price the list price.
const promo = packPrice({ price: at(5.95), net_price: at(4.99), discount: at(0.96), in_stock: at(true) });
ok(promo.price === 4.99 && promo.oldPrice === 5.95, 'a promotion sells at net_price and shows the list price as old');
const promoResult = normalize({ value: 'Milk Full Fat', data: { id: '1', variation_id: '1EA', brand: 'Nada', variant: '1L', price: at(5.95), net_price: at(4.99), in_stock: at(true) } });
ok(promoResult.discountLabel === '16% Off', `the discount label (got ${promoResult.discountLabel})`);
ok(promoResult.variants.length === 1 && promoResult.variants[0].price === 4.99, 'a product with no variations is its own single pack');

// Sold out at 0.00: no price, never a zero price.
const soldOut = packPrice({ price: at(0), net_price: at(0), in_stock: at(false) });
ok(soldOut.price === null && soldOut.oldPrice === null && soldOut.inStock === false, 'a 0.00 sold-out pack has no price');
ok(packPrice({}).price === null && packPrice({}).inStock === null, 'a pack without branch fields has no price and unknown stock');

// Only the chosen branch is read, never another branch's price.
ok(packPrice({ net_price: { V152: 3 } }).price === null, 'another branch price is not ours');

// The address: English and Arabic indexes, the branch's hidden fields.
const en = new URL(searchUrl('milk'));
ok(en.hostname === 'ac.cnstrc.com' && en.pathname === '/v1/search/milk', 'the search service');
ok(en.searchParams.get('key') === 'key_87HUpZO6lbVJRtwV', 'English words ask the English index');
ok(en.searchParams.get('us') === BRANCH && en.searchParams.get('section') === 'Products', 'the branch and the products section');
ok(en.searchParams.getAll('fmt_options[hidden_fields]').join() === `price.${BRANCH},net_price.${BRANCH},discount.${BRANCH},in_stock.${BRANCH}`, 'the branch price fields');
ok(en.searchParams.get('fmt_options[variations_return_type]') === 'all', 'every pack comes back');
const ar = new URL(searchUrl('حليب نادك'));
ok(ar.searchParams.get('key') === 'key_nx6GIIy1DgcBsOjt', 'Arabic words ask the Arabic index');
ok(decodeURIComponent(ar.pathname) === '/v1/search/حليب نادك', 'the words travel in the path');

// The strategy: a refusal reports blocked; a good answer is normalized.
const strategy = tamimiProvider.strategies[0];
const realFetch = globalThis.fetch;
try {
  let asked = null;
  globalThis.fetch = async (url, init) => {
    asked = { url, init };
    return new Response(JSON.stringify({ response: { results: [longLife, { value: '', data: {} }] } }), { status: 200 });
  };
  const results = await strategy.run('حليب');
  ok(results.length === 1 && results[0].id === 334500, 'a nameless result is dropped');
  ok(/^SuperSearch-connector\//.test(asked.init.headers['User-Agent']), 'the connector names itself, never a browser');

  for (const status of [400, 401, 403, 429]) {
    globalThis.fetch = async () => new Response('no', { status });
    let err = null;
    try {
      await strategy.run('milk');
    } catch (e) {
      err = e;
    }
    ok(err && err.blocked === true, `HTTP ${status} is a refusal: blocked`);
  }
  globalThis.fetch = async () => new Response('down', { status: 503 });
  let down = null;
  try {
    await strategy.run('milk');
  } catch (e) {
    down = e;
  }
  ok(down && !down.blocked, 'a 503 is a failure, not a refusal');
  globalThis.fetch = async () => new Response(JSON.stringify({ response: { results: [] } }), { status: 200 });
  ok((await strategy.run('zzqxv')).length === 0, 'no match is an empty answer, not an error');
} finally {
  globalThis.fetch = realFetch;
}

console.log(`tamimi.test: ${passed} passed`);
