import assert from 'node:assert/strict';
import {classifyArchivedProduct as classify} from './classification.js';
import {dictionaryProductTitle,isProductAttribute} from '../lexicon/productTitle.js';
import {productKnowledge,applyEnrichment} from '../offers/enrich.js';
import {AISLE_BY_ID} from '../browse/taxonomy.js';
import {ARCHIVE_PRODUCT_TYPES} from './archiveProductTypes.js';
import {resolveBrand,BRAND_ALIAS_COLLISIONS} from '../lexicon/brands.js';

for(const [name,aisle] of [
 ['Pringles Potato Chips','chips-snacks'],['Castania Pumpkin Seeds','dates-dried-fruits'],
 ['Nongshim Shin Ramyun','pasta-noodles'],['Green Moong 1 kg','pulses-grains'],
 ['Al Oula Harees','pulses-grains'],['Ritter Sport Milk Chocolate','chocolates-candies'],
 ['Nadec Soy Milk','milk-laban'],['Leduc Camembert Bites','frozen-food'],
 ['Sea Bass Fillet','fish'],['Castelijn Mini Stroopwafels','biscuits'],
 ['Freeze Dried Fruits','dates-dried-fruits'],['Freeze Pops','ice-cream'],
 ['Baking Powder','flour-baking'],['Curry Powder','spices'],
 ['Jif Floor Cleaner','cleaning'],['Fresh Frozen Chicken','frozen-poultry'],
]) {
 const result=classify({name});assert.equal(result.aisle,aisle,name);
 assert.equal(result.status,'classified');assert(AISLE_BY_ID.has(result.aisle));
}
for(const [nameAr,aisle] of [['جل الاستحمام نيفيا','bath-body'],['بنطال رياضي','fashion'],
 ['مرطب الشفاه','skin-face'],['مكعبات قرع داري','vegetables'],['كمثرى كوشيا إسبانيا','fruits']])
 assert.equal(classify({nameAr}).aisle,aisle,nameAr);
const evidence={names:{'en:known cereal':{aisle:'cereals',evidence:3}},brands:{}};
assert.equal(classify({name:'Known Cereal'},evidence).source,'archive_consensus');
assert.notEqual(classify({name:'Known Cereal Extra'},evidence).source,'archive_consensus','An archive phrase is an exact key, not a prefix');
const brand=resolveBrand('Rabea');
const affinity=classify({name:'Unknown Variant',brand:'Rabea'},{names:{},brands:{[brand.brand_id]:{aisle:'tea-coffee',evidence:9}}});
assert.equal(affinity.aisle,'tea-coffee');assert.equal(affinity.reviewRequired,true);
assert.equal(classify({name:'Zorblax'}).status,'pending_review','Unknown is never called confidently classified');
assert.equal(classify({}).status,'pending_review');
assert.equal(BRAND_ALIAS_COLLISIONS.length,0);
assert(ARCHIVE_PRODUCT_TYPES.every(t=>AISLE_BY_ID.has(t.aisle)),'Every added type must belong to a real canonical aisle');
assert.equal(resolveBrand('Pringles').display_ar,'برينجلز');
assert.equal(resolveBrand('Plyms').display_ar,'بليمز');
const knowledge=productKnowledge({productName:'Al Batal Potato Chips',arabicName:'بطاطس شيبس البطل',brand:'Al Batal',size:'100g'},{});
assert.equal(knowledge.arabicBuilder.product_title.classification.aisle,'chips-snacks');
const served={price:7,category:null};applyEnrichment(served,{e_name:'Al Batal Potato Chips',e_name_ar:'بطاطس شيبس البطل',
 e_brand:'Al Batal',e_size:'100g',e_corroboration:1,e_product_title:knowledge.arabicBuilder.product_title});
assert.equal(served.classification.aisle,'chips-snacks');assert.equal(served.price,7);
assert.equal(served.category,null,'Classification must not rewrite the retailer input or weaken quantity admission');
assert.equal(dictionaryProductTitle({nameEn:'Golden Chicken Whole Legs',brand:'Golden Chicken'}).name.includes('دجاج'),true);
console.log('Archive classification: groceries, bilingual fallback, bounded evidence, real aisles and serving contract passed.');

assert.notEqual(resolveBrand('Rabea').brand_id,resolveBrand('Al Rabie').brand_id);
assert.equal(resolveBrand('ربيع').brand_id,resolveBrand('Rabea').brand_id);
assert.equal(resolveBrand('الربيع').brand_id,resolveBrand('Al Rabie').brand_id);
assert(dictionaryProductTitle({nameEn:'Sukkary Al Qassim Dates',nameAr:'تمر سكري القصيم',brand:'Sukkary Al Qassim'}).name.includes('القصيم'));

assert.equal(isProductAttribute('Sukkary Al Qassim'),true);
assert.equal(isProductAttribute('Rice Master'),false);

assert.equal(resolveBrand('Farm').display_ar,'فارم');
assert.equal(resolveBrand('فآرم').brand_id,resolveBrand('Farm').brand_id);
