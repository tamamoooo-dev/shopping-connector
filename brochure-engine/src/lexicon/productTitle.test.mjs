import assert from 'node:assert/strict';
import { dictionaryProductTitle as title, applyProductTitle } from './productTitle.js';
import { productKnowledge, applyEnrichment, applyUnitPrice } from '../offers/enrich.js';
import { visionMatchText, enrichRowCols } from '../storage/enrichStore.js';
import { saleUnitKind, hasAmbiguousSizeOptions } from '../offers/saleUnit.js';
import { getBrowseOffersDoc } from '../browse/api.js';

const nadec = title({nameEn:'Nadec Greek Low Fat Yoghurt Plain (160g)',nameAr:'ناديك زبادي',brand:'ناديك',size:'160g'});
assert.equal(nadec.brand.ar,'نادك');
assert.match(nadec.name,/زبادي يوناني/);assert.match(nadec.name,/قليل الدسم/);
assert.doesNotMatch(nadec.name,/نادك|ناديك|160|جم|ريال/);
const rusk = title({nameEn:'Garameesh Rusk (375g)',nameAr:'شافوره قراميش',brand:'Garameesh'});
assert.equal(rusk.name,'شابورة قراميش');assert.equal(rusk.brand.ar,'قراميش');
assert.equal(rusk.corrections[0].observed,'شافوره قراميش');
assert.deepEqual(rusk.unknown,[]);
assert.equal(title({nameEn:'Yaumi Whole Wheat Toast (600g)',brand:'Yaumi'}).name,'خبز توست بر');
assert.equal(title({nameEn:'Valita Tuna In Vegetable Oil',brand:'Valita'}).name,'تونة بزيت نباتي');
assert.equal(title({nameEn:'Atlas Chick Peas',brand:'Atlas'}).name,'حمص حب');
assert.match(title({nameEn:'Golden Chicken Whole Legs',brand:'Golden Chicken'}).name,/أفخاذ دجاج/);
const alternatives = title({nameEn:'Lusine Cupcake Chocolate / Strawberry / Vanilla Filling',brand:'Lusine'});
assert.match(alternatives.name,/كب كيك شوكولاتة \/ كب كيك فراولة \/ كب كيك فانيليا/);
assert.match(title({nameEn:'Montana Molokhia / Spinach',brand:'Montana'}).name,/ملوخية \/ سبانخ/);
const unknown=title({nameEn:'UnknownBrand Zorblax',nameAr:'شافوره',brand:'UnknownBrand'});
assert.equal(unknown.name,'شافوره UnknownBrand');assert.equal(unknown.reviewRequired,true,'Vision fallback remains marked for dictionary review');

// A real pipeline candidate stores the title separately from raw observations;
// the serving overlay adopts it and keeps its brand outside the Arabic name.
const knowledge=productKnowledge({productName:'Nadec Milk',arabicName:'حليب ناديك',brand:'Nadec',size:'1L'},{});
assert.equal(knowledge.arabicBuilder.product_title.name,'حليب نادك');
const metadata=knowledge.arabicBuilder.product_title;
const offer={price:8};applyEnrichment(offer,{e_name:'Nadec Milk',e_name_ar:'حليب ناديك',e_corroboration:1,e_product_title:JSON.stringify(metadata),e_size:'1L'});
assert.equal(offer.nameAr,'حليب نادك');assert.equal(offer.brandNameAr,'نادك');assert.equal(offer.price,8);
const browse=await getBrowseOffersDoc({browseStore:{list:async()=>[{id:'test:milk',source:'d4d',
  name:'Nadec Milk',name_ar:'حليب ناديك',price:8,currency:'SAR',servable:1,e_size:'1L',e_product_title:JSON.stringify(metadata)}]}},{},'2026-10-23');
assert.equal(browse.offers[0].nameAr,offer.nameAr);assert.equal(browse.offers[0].brandNameAr,'نادك');
const haystack=visionMatchText({name:'Garameesh Rusk',name_ar:'شافوره',brand:'Garameesh',extraction_json:{_arabic_builder:{title_version:rusk.version,display_arabic:rusk.name}}});
assert.match(haystack,/شابوره/);assert.match(haystack,/شافوره/,'Raw typo remains searchable evidence');
assert.match(enrichRowCols(true),/e_product_title/);
const legacy={nameAr:'قديم'};applyProductTitle(legacy,{e_product_title:'invalid'});assert.equal(legacy.nameAr,'قديم');
applyProductTitle(legacy,{e_product_title:unknown});assert.equal(legacy.nameAr,'شافوره UnknownBrand');

assert.equal(saleUnitKind('Sadia Chicken Griller','1000g','box'),'chicken');
assert.equal(saleUnitKind('Chicken Breast Fillet','450g','tray'),'item');
assert.equal(saleUnitKind('Chicken Breast Fillet','450g','pack'),'pack');
assert.equal(saleUnitKind('Sadia Chicken','800g','Frozen'),'item');
assert.equal(saleUnitKind('Oska Water','6 x 1.5L','bottle'),'group');
assert.equal(saleUnitKind('Flour','1kg','bag'),'bag');
assert.equal(saleUnitKind('Olive Oil','250ml','bottle'),'bottle');
const chicken={name:'Sadia Chicken Griller',price:49.99};
applyUnitPrice(chicken,{e_size:'1000g',e_sale:{version:'sale-reading-v1',status:'matched',price:49.99,count:3,text:'3 PCS',package_size:'1000g'}});
assert.equal(chicken.saleQuantity.unitKind,'chicken');assert.equal(chicken.saleQuantity.count,3);
assert(Math.abs(chicken.unitPrice.value-49.99/3)<1e-8);
const noodles={name:'Indomie Instant Noodles',price:15.99};
applyUnitPrice(noodles,{e_size:'5 x 70/75/80g',e_sale:{version:'sale-reading-v1',status:'matched',price:15.99,count:3,text:'3 PCS',package_size:'5 x 70/75/80g'}});
assert.equal(noodles.unitPrice,null,'Alternative inner weights cannot become a single chosen denominator');
assert.equal(noodles.saleQuantity.count,3);assert.equal(noodles.saleQuantity.packagePrice,5.33);
assert.equal(noodles.quantityReviewRequired,true);
assert.equal(hasAmbiguousSizeOptions('1kg / 1000g'),false);
assert.equal(hasAmbiguousSizeOptions('0.5L / 500ml'),false);
assert.equal(hasAmbiguousSizeOptions('5 x 70/75/80g'),true);
assert.equal(hasAmbiguousSizeOptions('5 x 70g / 6 x 70g'),true);

// Whole classes of grocery terminology, not the user examples alone.
for (const [nameEn,word] of [['Crystal Hot Sauce','شطة'],['Soy Sauce','صلصة صويا'],
  ['Chickpeas','حمص حب'],['Garbanzo Beans','حمص حب'],['Hummus','حمص'],
  ['Puck Analogue Cream Cheese Spread','شبيه جبنة'],['Analogue Cream','شبيه قشطة'],
  ['Nadec Analogue Unsalted Butter','شبيه زبدة'],['Dates Mabroom Al Madinah','تمر مبروم المدينة'],
  ['Sukkary Dates Al Qassim','تمر سكري القصيم'],['Ajwa Dates Al Madinah','تمر عجوة المدينة'],
  ['Basmati Rice Punjabi 1121 5kg','1121']]) {
  assert(title({nameEn}).name?.includes(word),nameEn+' -> '+title({nameEn}).name);
}
assert.equal(title({nameEn:'Sukkary Dates',nameAr:'تمر سكري القصيم'}).name,'تمر سكري القصيم');
assert.equal(title({nameEn:'Dates Mabroom Al Madinah',nameAr:'تمر مبروم القصيم'}).name,'تمر مبروم المدينة','English region wins over a conflicting Arabic read');
assert.equal(title({nameEn:'Sukkary Dates AlQassim',nameAr:'تمر سكري المدينة'}).name,'تمر سكري القصيم');
assert.doesNotMatch(title({nameEn:'Nadec Analogue Cream Cheese'}).name,/بديل|أنالوج/);
const uno=title({nameEn:'Uno Kitchen Towel',brand:'Gigi'});assert.equal(uno.brand.ar,'أونو');assert.equal(uno.name,'مناديل مطبخ');
for (const [nameEn,ar] of [['Bambi Diapers','بامبي'],['Kotex Pads','كوتكس'],['Treva Tuna','تريفا'],
  ['Baidar Vinegar','بيدر'],['Foom Wheat Flour','فوم'],['Godiva Chocolate','جوديفا'],['Oska Water','أوسكا']])
  assert.equal(title({nameEn}).brand.ar,ar,nameEn);
assert.equal(title({nameEn:'Al Marai Milk',brand:'unreadable'}).brand.ar,'المراعي');
assert.equal(title({nameEn:'Kelloggs Cereals',brand:'unreadable'}).brand.ar,'كلوقز');
assert.equal(title({nameEn:'Unofficial Kitchen Towel'}).brand.ar,null,'A prefix is not a brand alias');
assert.equal(title({nameEn:'Fine White Sugar'}).brand.ar,null,'A grocery adjective is not the tissue brand');
const twoBrands=title({nameEn:'Sadia Chicken Strips / Seara Chicken Nuggets'});
assert.equal(twoBrands.brand.ar,'ساديا / سيارا');
assert.match(twoBrands.name,/ستربس دجاج \/ ناجتس دجاج/);
assert.match(title({nameEn:'Bambi Diapers / Pants',brand:'Bambi'}).name,/حفاضات كلوت/);
assert.match(title({nameEn:'Peanut Butter With No Added Sugar'}).name,/بدون سكر مضاف/);
assert.doesNotMatch(title({nameEn:'Peanut Butter With No Added Sugar'}).name,/خالي السكر/);
console.log('Dictionary titles, English brand precedence, raw evidence, serving contract and sale units passed.');

assert.equal(unknown.source,'vision_fallback');
assert.equal(unknown.dictionaryName,null);
assert.equal(unknown.corrections.length,0,'A Vision fallback is not a dictionary correction');
assert.equal(title({nameEn:'UnknownBrand Zorblax',nameAr:'اسم فيجن محفوظ',brand:'UnknownBrand'}).name,'اسم فيجن محفوظ');
assert.equal(title({nameEn:'UnknownBrand Zorblax',nameAr:'English only'}).name,null);
assert.equal(title({nameEn:'Rabea Tea',brand:'Rabea'}).name,'شاي ربيع');
assert.equal(title({nameEn:'Tea'}).name,'شاي');
assert.equal(rusk.source,'dictionary');
assert.equal(title({nameEn:'Unknown',nameAr:'ربيع',brand:'Rabea'}).name,'ربيع');

assert.equal(title({nameEn:'Unknown',nameAr:'١٢٣'}).name,null,'Digits are not an Arabic product name');
const fallbackKnowledge=productKnowledge({productName:'UnknownBrand Zorblax',arabicName:'اسم فيجن محفوظ',brand:'UnknownBrand'},{});
assert.equal(fallbackKnowledge.arabicBuilder.display_arabic,'اسم فيجن محفوظ');
assert.equal(fallbackKnowledge.arabicBuilder.display_source,'vision_fallback');
assert.equal(fallbackKnowledge.arabicBuilder.product_title.reviewRequired,true);

// Product identity must survive translation of a broad classifier category.
for (const [english,arabic] of [
 ['Al Batal Potato Chips','بطاطس شيبس البطل'],
 ['Al Batal Dates Maamoul','معمول بالتمر البطل'],
 ['Nadec Kashkaval Cheese','جبن قشقوان نادك'],
 ['Al Tayeb Areesh Cheese','جبن قريش الطيب'],
 ['Al Shifa Sidr Honey','عسل سدر الشفاء'],
 ['Sea Shrimps','روبيان بحري'],
 ['Cake Mix','خليط كيك'], ['Long Life Flavored Milk','حليب طويل الأجل بالنكهات'],
 ['Corn Chips','شيبس ذرة'], ['Tortilla Chips','شيبس تورتيلا'],
 ['Fig Jam','مربى تين'], ['Raspberry Jam','مربى توت العليق'],
 ['Brownie Cookies','كوكيز براوني'], ['Dates Cookies','كوكيز بالتمر'],
 ['Soda Water','مياه غازية'], ['Chicken Thighs','أفخاذ دجاج'],
 ['KDD Thick Cream','قشطة كثيفة كي دي دي']
]) assert.equal(title({nameEn:english}).name,arabic,english);
assert.equal(title({nameEn:'Al Batal Potato Chips',nameAr:'بطاطس شبس البطال'}).name,'بطاطس شيبس البطل');
assert.equal(title({nameEn:'Al Batal Potato Chips'}).dictionaryName,'بطاطس شيبس');
assert.equal(title({nameEn:'Chips'}).name,'شيبس','Do not invent potato when the source only says chips');
assert.equal(title({nameEn:'Sea Shrimps',nameAr:'روبيان بحر'}).reviewRequired,false);
assert.equal(title({nameEn:'Dates Maamoul'}).reviewRequired,false);

// One-word names always carry the available brand, including Vision fallback.
for (const input of [
  {nameEn:'Al Batal Chips',brand:'Al Batal'},
  {nameEn:'Unknown',nameAr:'شيبس',brand:'Al Batal'}
]) {
  const result=title(input);assert.equal(result.name,'شيبس البطل');
  const served={};applyProductTitle(served,{e_product_title:result});
  assert.equal(served.nameAr,'شيبس البطل','Serving must retain the brand without repeating it');
}

assert.equal(title({nameEn:'Nadec Milk Full Fat Long Life 1 Ltr*4pcs',brand:'Nadec'}).name,'حليب طويل الأجل كامل الدسم');
