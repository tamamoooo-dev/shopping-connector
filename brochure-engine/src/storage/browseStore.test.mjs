// Brand Browse counts and pages, executed against real SQLite and the real
// schema. This pins the production defect where two flyer variants inflated a
// brand's badge and were removed only after LIMIT/OFFSET.

import assert from 'node:assert/strict';
import { productKnowledge } from '../offers/enrich.js';
import { resolveBrand } from '../lexicon/brands.js';
import { createD1BrowseStore } from './browseStore.js';
import { createSqliteD1, insertOffers } from './testSqliteD1.mjs';

const CURRENT_ON = '2026-07-20';
const { db, raw, close } = createSqliteD1(['schema.sql']);

insertOffers(raw, [
  { id: 'lulu:central:d4d:one', name: 'Snickers Bar 50g', price: 3, category: 'chocolates' },
  { id: 'lulu:central:d4d:one-copy', name: 'Snickers Bar 50g', price: 3, category: 'chocolates' },
  { id: 'panda:central:d4d:two', name: 'Snickers Minis 200g', price: 12, category: 'chocolates' },
]);

raw.exec(`
  UPDATE offers
     SET brochure_id = 'fixture-brochure', page_index = 0, brand_slug = 'snickers';
  UPDATE offers
     SET identity = 'ph_snickers_bar'
   WHERE id IN ('lulu:central:d4d:one', 'lulu:central:d4d:one-copy');
  UPDATE offers SET identity = 'ph_snickers_minis'
   WHERE id = 'panda:central:d4d:two';
`);

const store = createD1BrowseStore(db);

const counts = await store.brandCounts(CURRENT_ON);
assert.deepEqual(
  counts.map((row) => ({ brand_slug: row.brand_slug, n: Number(row.n), stores: Number(row.stores) })),
  [{ brand_slug: 'snickers', n: 2, stores: 2 }],
  'the brand badge counts unique deals, not flyer variants',
);

const facets = await store.brandFacets('snickers', CURRENT_ON);
assert.equal(facets.reduce((sum, row) => sum + Number(row.n), 0), 2,
  'family counts add up to the same unique brand deals');

const firstPage = await store.list({
  brand: 'snickers', currentOn: CURRENT_ON, sort: 'price', limit: 1, offset: 0,
});
const secondPage = await store.list({
  brand: 'snickers', currentOn: CURRENT_ON, sort: 'price', limit: 1, offset: 1,
});
assert.equal(firstPage.length, 1);
assert.equal(secondPage.length, 1);
assert.notEqual(firstPage[0].identity, secondPage[0].identity,
  'pagination happens after dedupe and never skips the second real product');

// Saved canonical classification must agree across counts, filtering and cards.
insertOffers(raw,[
 {id:'panda:central:d4d:classified',name:'Al Batal Potato Chips',category:null},
 {id:'panda:central:d4d:unservable',name:'Raw Rice',category:'rice'},
]);
raw.exec("UPDATE offers SET brochure_id='fixture-brochure',page_index=0,brand_slug='lays' WHERE id LIKE '%:classified' OR id LIKE '%:unservable'");
const knowledge=productKnowledge({productName:'Al Batal Potato Chips',arabicName:'بطاطس شيبس البطل',brand:'Al Batal',size:'100g'},{});
const insertEnrichment=raw.prepare('INSERT INTO offer_enrichments(id,name,name_ar,brand,corroboration,enriched_at,extraction_json) VALUES(?,?,?,?,?,?,?)');
for(const [suffix,score] of [['classified',1],['unservable',0]]) insertEnrichment.run('panda:central:d4d:'+suffix,
 'Al Batal Potato Chips','بطاطس شيبس البطل','Al Batal',score,'2026-07-20',JSON.stringify({_arabic_builder:knowledge.arabicBuilder}));
const typed=await store.list({include:[{source:'knowledge',categories:['chips-snacks']}],currentOn:CURRENT_ON,limit:20});
assert.deepEqual(typed.map(r=>r.id),['panda:central:d4d:classified']);
const categoryCounts=await store.categoryCounts(CURRENT_ON);
assert.equal(Number(categoryCounts.find(r=>r.source==='knowledge'&&r.category==='chips-snacks')?.n),1);
assert.equal(Number(categoryCounts.find(r=>r.source==='d4d'&&r.category==='rice')?.n),1,'Unservable metadata cannot override retailer category');
const canonicalBrand=resolveBrand('Al Batal').brand_id;
assert.equal(typed[0].brand_slug,canonicalBrand);
const canonicalCounts=await store.brandCounts(CURRENT_ON);
assert.equal(Number(canonicalCounts.find(r=>r.brand_slug===canonicalBrand)?.n),1);
assert.equal((await store.list({brand:canonicalBrand,currentOn:CURRENT_ON,limit:20}))[0].id,'panda:central:d4d:classified');
close();
console.log('browseStore brand dedupe: 3 assertions passed');
