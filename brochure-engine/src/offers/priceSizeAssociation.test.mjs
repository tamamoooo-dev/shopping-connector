import assert from 'node:assert/strict';
import { sourcePackagePrices,legacyPriceSizeConflict } from './priceSizeAssociation.js';
import { selectSaleObservation } from './saleObservation.js';
import { applyEnrichment,applyUnitPrice,canonicalRowFromResult,productKnowledge } from './enrich.js';
import { runSmartExtraction,finalizeValidatedExtraction,validateVisionOutput,validateOcrOutput } from './smartExtraction.js';
import { applyProductTitle } from '../lexicon/productTitle.js';
import { getBrowseOffersDoc } from '../browse/api.js';
import { createD1BrowseStore } from '../storage/browseStore.js';
import { createSqliteD1,insertOffers } from '../storage/testSqliteD1.mjs';
import { offerAsListing } from '../monitor.js';

// Real source-local retailer text from the reported Tamimi crop. The image
// shows 49.99 CASE and 16.99 PACK; only the CASE has a printed 12 x 1 L size.
const source='ناول nadec nadec milk milk حلب حليب حل سعر ثماري حليب كامل الدسم 13 1 لتر themari price 16 99 العبوه pack 23 95 السعر العادي reg price nadec سعر ثماري themari price 49 99 الصندوق case السعر العادي 71 95 حليب طويل الاجل كامل الدسم قليل الدسم او منزوع الدسم نادك 12 1 لتر nadec whole low fat or skimmed uht milk 12 x 1 liter powder 0 بودره tamimi market اسواق التميمي milk laban';
assert.deepEqual(sourcePackagePrices(source),[{unit:'pack',cents:1699},{unit:'case',cents:4999}]);
assert(legacyPriceSizeConflict({price:16.99,size:'12 x 1L',packageType:'case',text:source}));
assert.equal(legacyPriceSizeConflict({price:49.99,size:'12 x 1L',packageType:'case',text:source}),null);
assert.equal(legacyPriceSizeConflict({price:14.99,size:'18 x 125ml',packageType:'case',text:'Themari price 14 99 case reg price 23 95'}),null);
assert.deepEqual(sourcePackagePrices('السعر ١٦٫٩٩ العبوة pack السعر العادي ٢٣٫٩٥ · السعر ٤٩٫٩٩ الصندوق case'),[{unit:'pack',cents:1699},{unit:'case',cents:4999}]);
assert.deepEqual(sourcePackagePrices('old price 49.99 case SAVE 16.99 pack'),[],'Old prices and savings are not selling-price evidence');
assert.equal(legacyPriceSizeConflict({price:16.99,size:'12x1L',packageType:'case',text:'16.99 PACK 16.99 CASE'}),null,'One price is not evidence of differently priced packages');

const extracted={productName:'NADEC WHOLE, LOW FAT OR SKIMMED UHT MILK, 12 x 1 LITER',
 arabicName:'حليب نادك طويل الأجل ١٢ × ١ لتر',brand:'Nadec',size:'12 x 1L'};
const knowledge=productKnowledge(extracted,{});
const row={e_name:extracted.productName,e_name_ar:extracted.arabicName,e_size:extracted.size,
 e_brand:'Nadec',e_package_type:'case',e_unit:'case',e_corroboration:1,
 e_product_title:knowledge.arabicBuilder.product_title,search_text:source};
const legacy={price:16.99,category:'milk-laban'};applyEnrichment(legacy,row);
assert.equal(legacy.price,16.99,'The guard never overwrites the retailer price');
for(const field of ['size','sizeReading','unitPrice','eachPrice','packageContents'])assert.equal(legacy[field],null,field);
assert.equal(legacy.quantityReviewRequired,true);assert.equal(legacy.quantityReviewReason,'different_package_prices');
assert.doesNotMatch(legacy.name,/12\s*[x×]/iu,'The old caption cannot reintroduce the case size in the visible name');
assert.equal(offerAsListing(legacy,row).size,null,'Price watches cannot recover a rejected size from the enrichment row');
const legacyObservation=selectSaleObservation({parsedObject:{name_en:extracted.productName,package_size:extracted.size,package_type:'case'}},
 {price:16.99,search_text:source});
assert.equal(legacyObservation.parsedObject.package_size,null,'Legacy evidence without sale_options is subject to the same source conflict');
const correctCase={price:49.99,category:'milk-laban'};applyEnrichment(correctCase,row);
assert(Math.abs(correctCase.unitPrice.value-49.99/12)<1e-9,'The correctly priced 12-litre case remains comparable');

const options=[{current_price:49.99,package_size:'12x1L',sale_count:null,sale_count_text:null},
 {current_price:16.99,package_size:null,sale_count:null,sale_count_text:null}];
const observation=selectSaleObservation({parsedObject:{name_en:extracted.productName,name_ar:extracted.arabicName,
 brand:'Nadec',package_size:'12x1L',size:'12x1L',package_type:'case',sale_options:options}},{price:16.99});
assert.equal(observation.parsedObject.package_size,null);assert.equal(observation.parsedObject.size,undefined);
const result=await runSmartExtraction({strategy:'vision-only',runVision:async()=>observation});
const candidate=canonicalRowFromResult('fixture',{cropUrl:'https://example.test/crop.jpg'},result,{commerceContext:{price:16.99,category:'milk-laban'}});
assert.equal(candidate.size,null,'The canonical extraction cannot recover an unselected caption size');
assert.equal(candidate.structured_product?.size?.canonical??null,null);
const oldValidation=validateVisionOutput({...observation.parsedObject,_sale:undefined});
const recovered=finalizeValidatedExtraction({visionOutput:observation.parsedObject,visionValidation:oldValidation,
 ocrValidation:validateOcrOutput('NADEC Milk 12 x 1 Liter'),ocrOutput:'NADEC Milk 12 x 1 Liter'});
assert.equal(recovered.extraction.size,null,'OCR and old saved validations cannot recover the other price’s carton size');
assert.equal(recovered.extraction.packCount,null);
const selected={price:16.99,name:extracted.productName,category:'milk-laban'};
applyProductTitle(selected,{e_product_title:candidate.arabic_builder.product_title});
applyUnitPrice(selected,{...row,e_sale:observation.parsedObject._sale});
assert.equal(selected.size,null);assert.equal(selected.unitPrice,null);assert.equal(selected.eachPrice,null);

// If the reader copies the case size into the PACK option, source-local
// container evidence still vetoes that apparent association.
const copied={...observation.parsedObject._sale,package_size:'12x1L'};
const wrongOption={price:16.99,name:extracted.productName,category:'milk-laban'};
applyUnitPrice(wrongOption,{...row,e_sale:copied});assert.equal(wrongOption.unitPrice,null);
const boundPack={price:16.99,name:'Milk'};
applyUnitPrice(boundPack,{...row,e_sale:{...copied,package_size:'4x1L'}});
assert(Math.abs(boundPack.unitPrice.value-16.99/4)<1e-9,'A separately bound smaller pack is accepted; its count is never inferred by the guard');

// A genuinely different, price-specific size survives the general caption.
for(const [price,size,expected] of [[2.99,'500ml',5.98],[4.99,'1L',4.99]]){
 const sale=selectSaleObservation({parsedObject:{name_en:'Milk 500ml / 1L',package_size:'1L',sale_options:[
  {current_price:2.99,package_size:'500ml'}, {current_price:4.99,package_size:'1L'}]}},{price}).parsedObject._sale;
 const offer={price,name:'Milk 500ml / 1L'};applyUnitPrice(offer,{e_size:'1L',e_sale:sale});
 assert.equal(offer.unitPrice.value,expected);assert.equal(offer.sizeReading.assorted,false);
 assert.equal(offer.sizeReading.canonical.total,size==='500ml'?500:1000);
}
const assortment={price:9.99,name:'Cereal 300g / 375g',sizeReading:productKnowledge({productName:'Cereal 300g / 375g',size:'300g/375g'},{}).sizeReading};
applyUnitPrice(assortment,{e_size:'300g/375g'});
assert.equal(assortment.unitPrice,null);assert.deepEqual(assortment.sizeOptions,[],'Unknown price-to-size mapping cannot create same-price per-size comparisons');

// Run the actual Browse SQL projection and document builder, where the full
// matching haystack is intentionally omitted. It must make the same refusal.
const {db,raw,close}=createSqliteD1(['schema.sql']);
try{
 insertOffers(raw,[{id:'tamimi:central:d4d:price-size-fixture',store:'tamimi',name:extracted.productName,
  price:16.99,category:'milk-laban',search_text:source}]);
 raw.exec("UPDATE offers SET brochure_id='fixture',page_index=0,valid_to='2099-01-01'");
 raw.prepare('UPDATE offers SET search_text=?').run(source);
 raw.prepare('INSERT INTO offer_enrichments(id,name,name_ar,size,corroboration,enriched_at,extraction_json) VALUES(?,?,?,?,?,?,?)')
  .run('tamimi:central:d4d:price-size-fixture',extracted.productName,extracted.arabicName,extracted.size,1,'2026-10-23',
   JSON.stringify({package_type:'case',_arabic_builder:knowledge.arabicBuilder}));
 const browse=createD1BrowseStore(db);
 const rows=await browse.list({currentOn:'2026-10-23',limit:5});assert.equal(rows[0].e_price_context,source);
 const doc=await getBrowseOffersDoc({browseStore:browse},{limit:5},'2026-10-23');
 assert.equal(doc.offers[0].size,null);assert.equal(doc.offers[0].eachPrice,null);
 assert.equal(doc.offers[0].quantityReviewRequired,true);
 assert.doesNotMatch(doc.offers[0].name,/12\s*[x×]/iu);
}finally{close();}
console.log('Price-size association: Tamimi crop, source roles, unknown sizes, per-price variants, canonical extraction and real Browse SQL passed.');
