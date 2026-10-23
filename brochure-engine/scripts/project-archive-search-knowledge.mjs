// Offline migration of the internal search graph. Never runs on a keystroke.
import fs from 'node:fs';
import {gunzipSync,gzipSync} from 'node:zlib';
import {resolveBrand} from '../src/lexicon/brands.js';
import {dictionaryProductTitle} from '../src/lexicon/productTitle.js';
import {classifyArchivedProduct} from '../src/knowledge/classification.js';
import {AISLES,DEPARTMENTS} from '../src/browse/taxonomy.js';
const root=new URL('../../../',import.meta.url);
const output=new URL('archive-knowledge-audit-2026-10-23/',root);
const graphFile=new URL('brochure-frontend-release-2026-10-18/data/brochure-knowledge.json.gz',root);
const backup=new URL('search-knowledge-before.json.gz',output);
if(!fs.existsSync(backup))fs.copyFileSync(graphFile,backup);
// Always project from the same input, so reruns cannot compound corrections.
const graph=JSON.parse(gunzipSync(fs.readFileSync(backup)));
const before={groups:graph.products.length,observations:graph.stats.observations,
 registry:JSON.stringify(graph.products.map(p=>p.productIds))};
const projections=new Map(JSON.parse(fs.readFileSync(new URL('projections.json',output))).map(p=>[p.id,p]));
const entities=new Map(graph.entities.map(e=>[e.id,e]));
function entity(kind,id,en,ar,extras={}){
 const key=kind+':'+id,old=entities.get(key);
 entities.set(key,{...old,id:key,kind,en,ar,aliases:[...new Set([...(old?.aliases||[]),en,ar].filter(Boolean))],...extras});
 return key;
}
for(const a of AISLES)entity('aisle',a.id,a.en,a.ar);
for(const d of DEPARTMENTS)entity('department',d.id,d.en,d.ar);
let translatedBrands=0,filledCategories=0,correctedTitles=0,reviewRequired=0;
for(const p of graph.products){
 const oldBrand=entities.get(p.brand),resolved=resolveBrand(oldBrand?.en||oldBrand?.ar);
 if(resolved.brand_id){
  if(!oldBrand?.ar)translatedBrands++;
  p.brand=entity('brand',resolved.brand_id,resolved.display_en,resolved.display_ar,{normalized:true});
 }
 const examples=(p.examples||[]).map(e=>projections.get(e.offerId)).filter(Boolean);
 const classified=examples.filter(e=>e.classification.status==='classified');
 const choices=new Set(classified.map(e=>e.classification.aisle));
 // A grouped product may contain several observations. Disagreement remains
 // visible; one observation cannot silently overwrite the entire group.
 const chosen=choices.size===1?classified[0]:null;
 const c=chosen?.classification || classifyArchivedProduct({name:p.name,nameAr:p.nameAr,brand:oldBrand?.en});
 if(c.status==='classified'&&choices.size<=1){
  p.aisle=entity('aisle',c.aisle,c.labelAr,c.labelAr);
  const a=AISLES.find(a=>a.id===c.aisle);entity('aisle',a.id,a.en,a.ar);
  p.department='department:'+c.department;
  if(!p.category||p.category==='category:review-required'){
   p.category=entity('category',c.category.id,c.category.en,c.category.ar);filledCategories++;
  }
  p.classificationSource=c.source;p.classificationReviewRequired=c.reviewRequired;
 }else{
  p.classificationReviewRequired=true;p.classificationSource='review_required';reviewRequired++;
  if(!p.category)p.category=entity('category','review-required','Needs classification review','تصنيف يحتاج مراجعة',{reviewRequired:true});
 }
 const title=dictionaryProductTitle({nameEn:p.name,nameAr:p.nameAr,brand:resolved.brand_id?resolved.display_en:oldBrand?.en});
 if(title.source==='dictionary'&&title.name){
  const prior=p.nameAr;p.nameAr=title.name;p.nameSource=title.source;p.nameReviewRequired=title.reviewRequired;
  p.names=[...new Set([...(p.names||[]),prior,title.name].filter(Boolean))];correctedTitles++;
 }
}
if(before.groups!==graph.products.length||before.observations!==graph.stats.observations||
 before.registry!==JSON.stringify(graph.products.map(p=>p.productIds)))throw Error('Projection changed product identity or archive coverage');
graph.entities=[...entities.values()];graph.builtAt=new Date().toISOString();
const stats={translatedBrands,filledCategories,correctedTitles,reviewRequired,
 groups:graph.products.length,observations:graph.stats.observations,
 categoriesMissing:graph.products.filter(p=>!p.category).length};
graph.stats.entities=graph.entities.length;graph.stats.archiveProjection=stats;
graph.stats.unknown.category=graph.products.filter(p=>!p.category||p.category==='category:review-required').reduce((n,p)=>n+p.observations,0);
graph.stats.unknown.brand=graph.products.filter(p=>!entities.get(p.brand)?.ar).reduce((n,p)=>n+p.observations,0);
fs.writeFileSync(graphFile,gzipSync(JSON.stringify(graph),{level:9}));
fs.writeFileSync(new URL('search-projection-summary.json',output),JSON.stringify(stats,null,2));
console.log(JSON.stringify(stats));
