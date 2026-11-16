// hungerstation.test.mjs — HungerStation Market's search page (2026-11-16).
// Fixtures shaped from the live English and Arabic search pages. Run:
//   node src/providers/hungerstation.test.mjs

import { hungerstationProvider, normalize, productLink, readPage, searchUrl } from './hungerstation.js';

let passed = 0;
const fail = (m) => {
  console.error('❌', m);
  process.exit(1);
};
const ok = (cond, m) => {
  if (!cond) fail(m);
  passed++;
};

const img = (n) => [{ id: 'img-1', url: `https://hungerstation.dhmedia.io/image/product-information-management/${n}.png`, alt: '' }];
const milk = { id: '7711dcb7-fc44-4273-93d2-9b21b5c51114', sku: '675P9K', name: 'Almarai Fresh Milk Full Fat 2.85L', images: img('a'), price: 16.5, originalPrice: 16.5, activePromotions: [] };
const promo = {
  id: '79abea07-573e-479c-a8aa-d32401ab93c8',
  sku: '92P1C7',
  name: 'Alsafi Full Fat Long Life Milk 4×1L',
  images: img('b'),
  price: 21.46,
  originalPrice: 25,
  activePromotions: [{ discountType: 'PERCENTAGE', discountValue: 14, quantity: 1, weightedDiscountValue: 0 }],
};
const arabic = { id: 'x', sku: '5YAJR4', name: 'حليب السعوديه عبوة ترويجية  كامل الدسم سعة 1لتر', images: img('c'), price: 6.3, originalPrice: 6.3, activePromotions: [] };
const page = (items, meta = { isLastPage: false, totalCount: 495 }) =>
  `<!DOCTYPE html><html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { vendor: { id: 56617 }, productSearchResult: { items, meta } } },
    page: '/hmarket',
    query: { query: 'milk' },
  })}</script></body></html>`;

// One product.
const r = normalize(milk);
ok(r.id === '675P9K', `the id is HungerStation's product code (got ${r.id})`);
ok(r.name === 'Almarai Fresh Milk Full Fat 2.85L' && r.size === '' && r.brand === '', 'the name is the store name, brand and size inside it');
ok(r.price === 16.5 && r.oldPrice === null && r.discountLabel === '' && r.currency === 'SAR', 'a plain price');
ok(r.image.startsWith('https://hungerstation.dhmedia.io/'), 'the first picture');
ok(r.link === 'https://hungerstation.com/sa-en/hmarket/product/almarai-fresh-milk-full-fat-285l-675P9K', `the link is the site's own product page (got ${r.link})`);

const p = normalize(promo);
ok(p.price === 21.46 && p.oldPrice === 25 && p.discountLabel === '14% Off', `a promotion sells at price, shows originalPrice as old (got ${p.price}/${p.oldPrice} ${p.discountLabel})`);

const a = normalize(arabic, 'ar');
ok(a.name === 'حليب السعوديه عبوة ترويجية كامل الدسم سعة 1لتر', 'double spaces fold');
ok(decodeURIComponent(a.link) === 'https://hungerstation.com/sa-ar/hmarket/product/حليب-السعوديه-عبوة-ترويجية-كامل-الدسم-سعة-1لتر-5YAJR4', `the Arabic product page (got ${decodeURIComponent(a.link)})`);

ok(normalize({ ...milk, price: 0 }).price === null, 'a 0 price is no price');
ok(normalize({ ...milk, images: [{ url: 'http://x/y.png' }] }).image === '', 'only an https picture');
ok(productLink('x', '../evil') === '', 'a code that is not a code makes no link');

// The address.
const en = new URL(searchUrl('milk'));
ok(en.hostname === 'hungerstation.com' && en.pathname === '/sa-en/hmarket' && en.searchParams.get('query') === 'milk' && !en.searchParams.has('page'), 'English words: the English search page');
const ar = new URL(searchUrl('حليب', 2));
ok(ar.pathname === '/sa-ar/hmarket' && ar.searchParams.get('query') === 'حليب' && ar.searchParams.get('page') === '2', 'Arabic words: the Arabic page; page 2');

// The page.
ok(readPage(page([milk])).items.length === 1, 'the product list is read from the page data');
ok(readPage('<html>no data</html>') === null, 'a page without data is not a search page');
ok(readPage(page([milk], { isLastPage: true, totalCount: 1 })).lastPage === true, 'the last page is known');

// The strategy.
const strategy = hungerstationProvider.strategies[0];
const realFetch = globalThis.fetch;
try {
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push({ url, init });
    const n = new URL(url).searchParams.get('page') || '1';
    return new Response(n === '1' ? page([milk, promo, { ...milk }]) : page([arabic, { ...promo, price: null }]), { status: 200 });
  };
  const results = await strategy.run('milk');
  ok(asked.length === 2, 'two pages are asked');
  ok(asked.every((x) => /^SuperSearch-connector\//.test(x.init.headers['User-Agent'])), 'the connector names itself, never a browser');
  ok(results.map((x) => x.id).join() === '675P9K,92P1C7,5YAJR4', `page 1 first, repeats and unpriced dropped (got ${results.map((x) => x.id)})`);

  globalThis.fetch = async (url) => {
    const n = new URL(url).searchParams.get('page') || '1';
    return new Response(page(n === '1' ? [milk] : [promo], { isLastPage: true, totalCount: 1 }), { status: 200 });
  };
  ok((await strategy.run('milk')).length === 1, 'when page 1 is the last, page 2 is not added');

  globalThis.fetch = async (url) => {
    const n = new URL(url).searchParams.get('page') || '1';
    return n === '1' ? new Response(page([milk])) : new Response('down', { status: 503 });
  };
  ok((await strategy.run('milk')).length === 1, 'a failed page 2 keeps page 1');

  for (const status of [401, 403, 429]) {
    globalThis.fetch = async () => new Response('no', { status });
    let err = null;
    try {
      await strategy.run('milk');
    } catch (e) {
      err = e;
    }
    ok(err && err.blocked === true, `HTTP ${status} is a refusal: blocked`);
  }
  globalThis.fetch = async () => new Response('<html><title>Just a moment...</title></html>', { status: 200 });
  let challenged = null;
  try {
    await strategy.run('milk');
  } catch (e) {
    challenged = e;
  }
  ok(challenged && challenged.blocked === true, 'a challenge page is a refusal, never solved');

  globalThis.fetch = async () => new Response('down', { status: 503 });
  let down = null;
  try {
    await strategy.run('milk');
  } catch (e) {
    down = e;
  }
  ok(down && !down.blocked, 'a 503 is a failure, not a refusal');

  globalThis.fetch = async () => new Response('<html>changed</html>', { status: 200 });
  let changed = null;
  try {
    await strategy.run('milk');
  } catch (e) {
    changed = e;
  }
  ok(changed && !changed.blocked, 'a page without its product list is a failure, not "no match"');

  globalThis.fetch = async () => new Response(page([], { isLastPage: true, totalCount: 0 }), { status: 200 });
  ok((await strategy.run('zzqxv')).length === 0, 'no match is an empty answer, not an error');
} finally {
  globalThis.fetch = realFetch;
}

console.log(`hungerstation.test: ${passed} passed`);
