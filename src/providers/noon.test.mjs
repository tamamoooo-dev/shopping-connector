// noon.test.mjs — locks the Noon Minutes payload-format regression.
//
// Minutes shipped its search results as a Next.js RSC flight
// (self.__next_f.push([1,"<json>"])) and the provider reconstructed that flight
// and JSON.parse'd the product objects out of it. Minutes then migrated to
// TanStack Start, which streams a seroval payload instead: a JavaScript object
// literal with UNQUOTED keys and $R[n]= back-references. The flight marker
// vanished, so the reconstructed flight was 0 bytes and the provider returned
// nothing for every query while the page itself still served fine.
//
// Fixture shaped from a real minutes.noon.com search page (verified live
// 2026-08-01, q=milk: 88 products parsed, prices matched the rendered grid).
// Run:
//   node src/providers/noon.test.mjs

import { noonProvider } from './noon.js';

let passed = 0;
const fail = (m) => {
  console.error('❌', m);
  process.exit(1);
};
const ok = (cond, m) => {
  if (!cond) fail(m);
  passed++;
};

// The payload, in the shape Minutes actually emits. Note what makes it hostile
// to a naive parser: unquoted keys, $R[n]= back-references, an escaped quote
// inside a title, and — critically — nested objects that REUSE `sku` and
// `title`. The multi-buy rows (qtyText) and childItemsDetails entries below all
// carry the parent's sku but a title that is really the pack size.
const payload = `(self.$R=self.$R||{})["tsr"]=[];self.$_TSR={h(){}};$R[1]=[\
$R[2]={type:"instantPLPItem",product:$R[3]={brand:"Almarai",brandCode:"almarai",\
imageKey:"pzsku/ZAAA/45/_/1/aaa",isBuyable:!0,maxQty:10,offerPrice:12.5,price:12.5,\
productLabelsV2:$R[4]=[$R[5]={code:"new",config:$R[6]={text:"\\x3Csemibold>New\\x3C/semibold>"}}],\
salePrice:null,sizeInfo:"2L",sku:"ZAAA-1",title:"Fresh Full Fat Milk",\
transparentImageUrl:"https://z.nooncdn.com/p/minutes-transparent/ZAAA-1.png"}},\
$R[7]={type:"instantPLPItem",product:$R[8]={brand:"Saudia",imageKey:"pzsku/ZBBB/45/_/1/bbb",\
isBuyable:!0,offerPrice:24.5,price:27.6,salePrice:24.5,sizeInfo:"4 x 1L",sku:"ZBBB-1",\
title:"Whole Milk \\"Family Pack\\"",transparentImageUrl:"https://z.nooncdn.com/p/minutes-transparent/ZBBB-1.png",\
variantsBottomSheet:$R[9]={options:$R[10]=[\
$R[11]={imageKey:"pzsku/ZBBB/45/_/1/bbb",price:24.5,qty:1,qtyText:"x 1",savingsText:null,\
sku:"ZBBB-1",strikedPrice:null,tag:null,title:"4 x 1L",volume:4000,weight:4},\
$R[12]={childItemsDetails:$R[13]=[$R[14]={imageKey:"pzsku/ZBBB/45/_/1/bbb",maxQty:10,\
priceText:null,qty:2,sizeInfo:"4 x 1L",sku:"ZBBB-1",title:"Whole Milk",volume:4000,weight:4}],\
discountPercent:10,imageKey:"minutes-vsku/prd/gen_1.jpg",price:47,qty:2,qtyText:"x 2",\
savingsText:"Save  2",sku:"VCCC-1",strikedPrice:49,tag:null,title:"4 x 1L",volume:8000}]}}},\
$R[15]={type:"instantPLPItem",product:$R[16]={brand:"Pepsi",imageKey:"pzsku/ZEEE/45/_/1/eee",\
isBuyable:!0,offerPrice:5.75,price:5.75,salePrice:null,sizeInfo:"1L",sku:"ZEEE-1",\
title:"Pepsi Bottle"}},\
$R[17]={sizeInfo:"1L",sku:"ZSTUB-1",title:"Recently Viewed Stub"}];`;

// The size guard rejects anything under 20 KB, so pad the document the way the
// real page is padded — with markup OUTSIDE the payload script. Attribute quotes
// living out here are exactly why the scan must be confined to the script body.
const padding = '<link rel="stylesheet" href="https://z.nooncdn.com/s/app/assets/a.css"/>'.repeat(300);
const page = (body) =>
  `<!DOCTYPE html><html lang="en-SA"><head>${padding}</head><body>` +
  `<script class="$tsr" id="$tsr-stream-barrier">${body}</script></body></html>`;

const withPage = (html) => {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => html });
};

const run = (query) => noonProvider.strategies[0].run(query);

// ---------------------------------------------------------------------------
withPage(page(payload));
const results = await run('milk');

// The regression itself: the new payload format must yield products at all.
ok(results.length > 0, 'the seroval payload must parse — zero results is the exact bug');
ok(results.length === 3, `expected 3 products, got ${results.length}: ${results.map((r) => r.name).join(' | ')}`);

// Page order is the grid's ranking; objects close innermost-first, so emitting
// on close order would scramble it.
ok(
  results.map((r) => r.id).join(',') === 'ZAAA-1,ZBBB-1,ZEEE-1',
  `wrong ids/order: ${results.map((r) => r.id).join(',')}`
);

// Nested rows must never be read as the product. Every one of these carries the
// parent's sku with the pack size as its title.
ok(!results.some((r) => r.name === '4 x 1L'), 'a multi-buy row was emitted as a product name');
ok(!results.some((r) => r.id.startsWith('V')), 'a bundle vsku was emitted as its own result');
ok(!results.some((r) => r.id === 'ZSTUB-1'), 'a priceless stub was emitted as a result');

// brand and title are separate fields; the site renders them together.
ok(results[0].name === 'Almarai Fresh Full Fat Milk', `name must include the brand: "${results[0].name}"`);
ok(results[0].brand === 'Almarai' && results[0].size === '2L', 'brand/size lost');
// ...but a title that already leads with the brand must not repeat it.
ok(results[2].name === 'Pepsi Bottle', `brand must not be duplicated: "${results[2].name}"`);

// Escaped quotes inside a title decode, and do not derail the object scan.
ok(results[1].name === 'Saudia Whole Milk "Family Pack"', `escaped quote mishandled: "${results[1].name}"`);

// price is the was-price, offerPrice/salePrice the effective one.
ok(results[1].price === 24.5 && results[1].oldPrice === 27.6, `price/oldPrice wrong: ${results[1].price}/${results[1].oldPrice}`);
ok(results[1].discountLabel === '11% Off', `discountLabel wrong: "${results[1].discountLabel}"`);
ok(results[0].oldPrice === null, 'an undiscounted product must not carry an oldPrice');

// The rest of the normalized contract.
ok(results[0].link === 'https://minutes.noon.com/saudi-en/now-product/ZAAA-1/', `link wrong: "${results[0].link}"`);
ok(results[0].currency === 'SAR', 'currency must be SAR');
ok(results[0].image === 'https://z.nooncdn.com/p/minutes-transparent/ZAAA-1.png', `image wrong: "${results[0].image}"`);
// No transparent image → build the CDN url from imageKey.
ok(results[2].image === 'https://f.nooncdn.com/p/pzsku/ZEEE/45/_/1/eee.jpg', `imageKey fallback wrong: "${results[2].image}"`);

// An Arabic query selects the Arabic storefront.
withPage(page(payload));
const ar = await run('حليب');
ok(ar[0].link.includes('/saudi-ar/'), `Arabic query must use the saudi-ar locale: "${ar[0].link}"`);

// A query with genuinely no hits is an empty answer, not an error.
withPage(page('$R[1]=[];self.$_TSR={};'));
ok((await run('zzqxwvunobrandhere')).length === 0, 'a result-less query must return an empty list');

// But a payload that carries product records we failed to read is a parse break
// and must say so — silence there is what hid this bug for a whole format change.
withPage(page('$R[1]=[$R[2]={unexpected:1,sku:"ZAAA-1"}];'));
await run('milk').then(
  () => fail('a payload with unreadable product records must throw, not return []'),
  (e) => ok(/none parsed/.test(e.message), `unhelpful parse-break error: "${e.message}"`)
);

// A Cloudflare challenge must be reported as a block, not as an empty catalogue.
withPage('<html><head><title>Just a moment...</title></head><body>' + ' '.repeat(30000) + '</body></html>');
await run('milk').then(
  () => fail('a challenge page must throw'),
  (e) => ok(/blocked/.test(e.message), `challenge not reported as a block: "${e.message}"`)
);

console.log(`noon.test: ${passed} passed, 0 failed`);
