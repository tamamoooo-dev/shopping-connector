import assert from 'node:assert/strict';
import {resolveOfferSize as read,sizeOptionPrices} from './offerSizeReading.js';
import {productKnowledge,applyUnitPrice} from '../offers/enrich.js';
import {applyProductTitle} from './productTitle.js';

const choices=read({size:'5 × 70/75/80g'});
assert.equal(choices.assorted,true);
assert.deepEqual(choices.options.map(o=>o.canonical.total),[350,375,400],'The internal five-pack belongs to every size choice');
assert.equal(choices.canonical,null,'An assortment has no one preferred comparison weight');
assert.deepEqual(sizeOptionPrices(choices,15.99,3).map(o=>Math.round(o.unitPrice.value*100)),[1523,1421,1333]);
assert.equal(read({size:'1kg / 1000g'}).assorted,false,'Two equivalent expressions are not different sizes');
assert.equal(read({size:'0.5L / 500ml'}).assorted,false);
assert.equal(read({size:'132 - 135ml'}).kind,'range');
assert.deepEqual(read({size:"30/36/40’s"}).options.map(o=>o.canonical.total),[30,36,40]);
assert.equal(read({size:'6 + 2 Roll'}).canonical.total,8);
assert.match(read({size:'6 + 2 Roll'}).displayAr,/8 لفات/);
assert.equal(read({nameAr:'مناديل مطبخ ٦ + ٢ رول'}).canonical.total,8);
assert.match(read({size:'6 + 2 Roll',nameEn:'Uno Kitchen Towel 28cm'}).displayAr,/28 سم/);
assert.deepEqual(read({size:'2x500g / 1kg'}).options.map(o=>o.canonical.pack),[2,1]);
assert.equal(read({size:'1,000g'}).canonical.total,1000);
assert.equal(read({size:'١٬٠٠٠ جم'}).canonical.total,1000);
assert.equal(read({size:'0,5L'}).canonical.total,500);
assert.deepEqual(read({size:'70,75,80g'}).options.map(o=>o.canonical.total),[70,75,80]);
assert.equal(read({size:'300g, 375g'}).assorted,true);
const diaper=read({size:'7-14kg',nameEn:'Baby diapers 7-14kg, 88pcs'});
assert.equal(diaper.canonical.unit,'pcs');assert.equal(diaper.canonical.total,88);
assert.match(diaper.displayAr,/لوزن/);
assert.equal(read({size:'7-14kg',nameEn:'Baby diapers'}).assorted,false);
assert.deepEqual(sizeOptionPrices(read({size:'7-14kg',nameEn:'Baby diapers'}),20),[],'Body-weight fit is not a product-weight assortment');
assert.equal(read({size:'100g',nameEn:'Diaper Rash Cream'}).canonical.total,100,'Diaper cream is a measured product, not a body-weight fit');
assert.equal(read({nameEn:'Diapers 7-14kg 88pcs'}).canonical.total,88);
assert.equal(read({nameEn:'Milk',nameAr:'حليب ١ لتر'}).canonical.total,1000);
assert.equal(read({size:'unreadable',nameEn:'Milk 500ml',nameAr:'حليب ١ لتر'}).canonical.total,500,'English name is the first fallback');
assert.equal(read({size:'250ml',nameEn:'Milk 500ml',nameAr:'حليب ١ لتر'}).canonical.total,250,'The selected size field has precedence over unbound title sizes');
assert.equal(read({nameEn:'Milk 10 x 1L',sale:{status:'matched',count:3,package_size:null}}),null,'Do not recover a differently priced carton size');
assert.equal(read({size:'5G',nameEn:'Phone 5G',nonGrocery:true}),null,'A phone generation is not grams');

const sale={version:'sale-reading-v1',status:'matched',price:15.99,count:3,text:'3 PCS',package_size:'5 × 70/75/80g'};
const knowledge=productKnowledge({productName:'Instant Noodles',size:sale.package_size},{_sale:sale});
assert.equal(knowledge.structuredProduct.size.canonical,null,'The registry projection cannot pick one assortment weight either');
const offer={name:'Instant Noodles',price:15.99};
applyProductTitle(offer,{e_product_title:knowledge.arabicBuilder.product_title});
applyUnitPrice(offer,{e_size:sale.package_size,e_sale:sale});
assert.equal(offer.quantityReviewRequired,false,'A documented assortment is not an extraction error');
assert.equal(offer.unitPrice,null);assert.equal(offer.packageContents,null);
assert.equal(offer.sizeOptions.length,3);assert.equal(offer.saleQuantity.packagePrice,5.33);

const fish={name:'Sea Bass 800/1400g (Per Kg)',price:19.99,sizeReading:read({size:'800/1400g'})};
applyUnitPrice(fish,{e_size:'800/1400g',e_unit:'Per Kg'});
assert.equal(fish.unitPrice.value,19.99,'A printed per-kg price must not be divided by the fish weight');
assert.deepEqual(fish.sizeOptions,[]);
assert.equal(fish.priceBasis.unit,'kg');
const arabicFish={name:'Sea Bass',price:19.99};
// Explicit, correctly spelled price-basis evidence can come from Arabic too.
const arabicBasisReading=read({size:'800/1400g',nameEn:'Sea Bass',nameAr:'قاروص ٨٠٠/١٤٠٠ جم للكيلو'});
assert(arabicBasisReading.priceBasisText);
arabicFish.sizeReading=arabicBasisReading;applyUnitPrice(arabicFish,{e_size:'800/1400g'});
assert.equal(arabicFish.unitPrice?.value,19.99);
// Several sizes in the English name at one price are one assorted offer, even
// when the size field kept only one; a "+" bundle and a merged OCR number are not.
const listed=read({size:'900ml',nameEn:'Head & Shoulders Shampoo (1L) / (900ml)'});
assert.equal(listed.assorted,true);
assert.equal(listed.displayAr,'1 لتر أو 900 مل');
assert.equal(read({size:'6’s',nameEn:'Sponge Scourer (6’s + 3’s) / Steel Scourer (5Pcs)'}).assorted,false);
assert.equal(read({size:'180g',nameEn:"M&M's Chocolate (150170/180g)"}).assorted,false);
console.log('Bilingual size fallback, assortments, shared multipacks, bonus packs, equivalent units and printed-price basis passed.');
