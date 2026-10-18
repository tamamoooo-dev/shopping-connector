import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {resolveComparableQuantity,unitPriceFromReference} from '../../src/lexicon/comparableQuantity.js';
import {isNonGrocery} from '../../src/lexicon/productClass.js';
import {applyUnitPrice} from '../../src/offers/enrich.js';
const dir=new URL('./',import.meta.url);mkdirSync(dir,{recursive:true});
const catalog=JSON.parse(gunzipSync(readFileSync(new URL('../search-quality-2026-10-18/catalog.json.gz',dir)))).results;
const observed=JSON.parse(readFileSync(new URL('../vision-reading-2026-10-18/.data/quantity-d1.json',dir),'utf8').replace(/^\uFEFF/,''))[0].results;
const quantities=new Map(observed.map(r=>[r.id,r.quantity]));
writeFileSync(new URL('counts.json.gz',dir),gzipSync(JSON.stringify(observed),{level:9}));
const changed=[];
for(const row of catalog){
 const packCount=quantities.get(row.id);if(!packCount)continue;
 const offer={name:row.e_name,nameAr:row.e_name_ar,price:row.price,category:row.category};
 applyUnitPrice(offer,row);
 const q=resolveComparableQuantity({size:row.e_size,name:offer.name,unit:row.e_unit,packCount,text:[offer.nameAr,row.search_text].filter(Boolean).join(' '),nonGrocery:isNonGrocery(row.category)});
 const next=unitPriceFromReference(row.price,q.reference);
 if((offer.unitPrice?.value??null)!==(next?.value??null)||(offer.unitPrice?.unit??null)!==(next?.unit??null))changed.push({index:changed.length+1,id:row.id,name:row.e_name,nameAr:row.e_name_ar,size:row.e_size,count:packCount,price:row.price,category:row.category,text:row.search_text,before:offer.unitPrice,after:next,quantity:q,image:row.image_url});
}
writeFileSync(new URL('naive-changes.json',dir),JSON.stringify({catalog:catalog.length,storedCountRows:observed.length,joined:catalog.filter(r=>quantities.has(r.id)).length,changed},null,2));
console.log(JSON.stringify({catalog:catalog.length,storedCountRows:observed.length,joined:catalog.filter(r=>quantities.has(r.id)).length,changes:changed.length,rows:changed.map(r=>({i:r.index,id:r.id,name:r.name,size:r.size,count:r.count,before:r.before,after:r.after}))},null,2));
