import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {BRAND_LEXICON,normalizeBrandKey,resolveBrand} from '../src/lexicon/brands.js';
import {SHOPPING_CATEGORIES,resolveCategory} from '../src/lexicon/shopping.js';
import {dictionaryProductTitle,isProductAttribute} from '../src/lexicon/productTitle.js';
import {IMAGE_CLASSIFICATION_REVIEWS} from '../src/knowledge/imageClassificationReviews.js';
import {canonicalAisle} from '../src/browse/mapping.js';
import {AISLES,DEPARTMENTS} from '../src/browse/taxonomy.js';
import {classifyArchivedProduct,classificationKey} from '../src/knowledge/classification.js';

const workspace=fileURLToPath(new URL('../../../',import.meta.url));
const out=path.resolve(process.argv[2]||path.join(workspace,'archive-knowledge-audit-2026-10-23'));
fs.mkdirSync(out,{recursive:true});
const sha=s=>createHash('sha256').update(s).digest('hex');
const records=new Map(),sources=[];
function load(relative,read){
  const filename=path.join(workspace,relative),bytes=fs.readFileSync(filename);
  sources.push({file:relative,sha256:sha(bytes),bytes:bytes.length});
  const doc=JSON.parse(filename.endsWith('.gz')?gunzipSync(bytes):bytes);
  for(const row of read(doc)){
    const prior=records.get(row.id);
    records.set(row.id,{...prior,...row,sourceFiles:[...new Set([...(prior?.sourceFiles||[]),relative])]});
  }
}
load('brochure-reading-release-2026-10-22/brochure-engine/benchmarks/search-quality-2026-10-18/catalog.json.gz',d=>d.results.map(r=>({
  id:r.id,name:r.e_name||r.name,name_ar:r.e_name_ar||r.name_ar,brand:r.e_brand||null,size:r.e_size,
  retailer_category:r.category,brochure_id:r.brochure_id,source_url:r.source_url,page_index:r.page_index,
  enriched_at:r.enriched_at,valid_to:r.valid_to,product_id:null,source_kind:r.e_name||r.e_name_ar?'vision':'aggregator',
})));
load('product-knowledge-data/observations.json',d=>d.records.map(r=>({...r,source_kind:'vision'})));
const sourceFile='archive-knowledge-audit-2026-10-23/pending-source-records.json';
if(fs.existsSync(path.join(workspace,sourceFile)))load(sourceFile,d=>d.map(r=>({
  id:r.id,source_text:r.search_text,source_name:r.name,source_name_ar:r.name_ar,
  source_image_url:r.image_url,
})));
load('panda-reading-audit-2026-10-23/candidates.json',d=>d.map(r=>({
  id:r.id,name:r.candidate.name,name_ar:r.candidate.name_ar,brand:r.candidate.brand,size:r.candidate.size,
  enriched_at:r.candidate.enriched_at||'2026-10-23',source_kind:'saved_image_replay',
})));
for(const relative of ['brochure-reading-release-2026-10-22/brochure-engine/data/knowledge/brand-image-reviews.json','brochure-reading-release-2026-10-22/brochure-engine/data/knowledge/brand-seeds.txt','brochure-reading-release-2026-10-22/brochure-engine/data/knowledge/image-classification-reviews.json']){
 const bytes=fs.readFileSync(path.join(workspace,relative));sources.push({file:relative,sha256:sha(bytes),bytes:bytes.length});
}
const rows=[...records.values()].sort((a,b)=>a.id.localeCompare(b.id));
const hasName=v=>typeof v==='string'&&v.trim()&&!/^(?:null|none|n\/a|undefined)$/i.test(v.trim());
for(const r of rows){if(!hasName(r.name))r.name=null;if(!hasName(r.name_ar))r.name_ar=null;}
// Independent archived sightings must agree before a missing category is
// inherited. One OCR observation cannot teach a permanent classification.
const votes=new Map(),brandVotes=new Map();
function vote(map,key,aisle,row){if(!key)return;const all=map.get(key)||new Map();const v=all.get(aisle)||{ids:new Set(),names:new Set()};v.ids.add(row.id);v.names.add(classificationKey(row.name||row.name_ar));all.set(aisle,v);map.set(key,all);}
for(const r of rows){
  const aisle=canonicalAisle('d4d',r.retailer_category);if(aisle==='other')continue;
  for(const [lang,value] of [['en',r.name],['ar',r.name_ar]])if(value)vote(votes,lang+':'+classificationKey(value),aisle,r);
  const brand=resolveBrand(r.brand);if(brand.brand_id)vote(brandVotes,brand.brand_id,aisle,r);
}
function consensus(map,minimum,distinctNames){
  const result={};
  for(const [key,choices] of map){
    const ranked=[...choices].sort((a,b)=>b[1].ids.size-a[1].ids.size),[aisle,best]=ranked[0];
    const total=ranked.reduce((n,[,v])=>n+v.ids.size,0);
    if(best.ids.size>=minimum&&best.names.size>=distinctNames&&best.ids.size/total>=0.95)
      result[key]={aisle,evidence:best.ids.size,total,examples:[...best.ids].slice(0,3)};
  }
  return result;
}
const allNames=consensus(votes,2,1),brands=consensus(brandVotes,5,3);
const usedNames={};
for(const r of rows)if(canonicalAisle('d4d',r.retailer_category)==='other'){
  for(const [lang,value] of [['en',r.name],['ar',r.name_ar]]){
    const key=lang+':'+classificationKey(value);if(value&&allNames[key])usedNames[key]=allNames[key];
  }
}
const runtime=new URL('../src/knowledge/archiveClassificationData.js',import.meta.url);
fs.writeFileSync(runtime,'// Generated from archived source evidence; no live lookup or per-query scan.\n'+
  'export const ARCHIVE_CLASSIFICATIONS = '+JSON.stringify(usedNames)+';\n'+
  'export const ARCHIVE_BRAND_AISLES = '+JSON.stringify(brands)+';\n');

const dbPath=path.join(out,'product-knowledge.sqlite');
const buildPath=path.join(out,'product-knowledge.build.sqlite');
const db=new DatabaseSync(buildPath);db.exec('PRAGMA foreign_keys=ON;');
// Only this task-owned output database is rebuilt; source archives are read-only.
db.exec(`DROP VIEW IF EXISTS review_queue; DROP TABLE IF EXISTS product_brands; DROP TABLE IF EXISTS observations;
 DROP TABLE IF EXISTS brand_aliases; DROP TABLE IF EXISTS products; DROP TABLE IF EXISTS brands;
 DROP TABLE IF EXISTS product_types; DROP TABLE IF EXISTS classifications; DROP TABLE IF EXISTS sources; DROP TABLE IF EXISTS metadata;
 CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE sources(id INTEGER PRIMARY KEY,file TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL);
 CREATE TABLE brands(id TEXT PRIMARY KEY,name_en TEXT,name_ar TEXT,status TEXT NOT NULL);
 CREATE TABLE brand_aliases(alias_key TEXT PRIMARY KEY,alias TEXT NOT NULL,brand_id TEXT NOT NULL REFERENCES brands(id),status TEXT NOT NULL);
 CREATE TABLE classifications(id TEXT PRIMARY KEY,name_en TEXT NOT NULL,name_ar TEXT NOT NULL,department TEXT NOT NULL);
 CREATE TABLE product_types(id TEXT PRIMARY KEY,name_en TEXT NOT NULL,name_ar TEXT NOT NULL,aisle TEXT);
 CREATE TABLE products(id TEXT PRIMARY KEY,name_en TEXT,name_ar TEXT,title_source TEXT NOT NULL,product_type TEXT REFERENCES product_types(id),
   aisle TEXT NOT NULL REFERENCES classifications(id),classification_source TEXT NOT NULL,review_required INTEGER NOT NULL,size_printed TEXT,product_status TEXT NOT NULL);
 CREATE TABLE observations(id TEXT PRIMARY KEY,product_id TEXT NOT NULL REFERENCES products(id),name_en TEXT,name_ar TEXT,
   brand_observed TEXT,size_observed TEXT,retailer_category TEXT,store TEXT NOT NULL,brochure_id TEXT,page_index INTEGER,
   source_url TEXT,enriched_at TEXT,registry_product_id TEXT,source_kind TEXT NOT NULL,sources_json TEXT NOT NULL,
   classification_json TEXT NOT NULL,title_review INTEGER NOT NULL,source_image_url TEXT,source_text TEXT);
 CREATE TABLE product_brands(product_id TEXT NOT NULL REFERENCES products(id),brand_id TEXT NOT NULL REFERENCES brands(id),
   PRIMARY KEY(product_id,brand_id));
 CREATE INDEX observations_product ON observations(product_id);
 CREATE INDEX observations_brochure ON observations(brochure_id);
 CREATE INDEX products_aisle ON products(aisle);
 CREATE INDEX product_brands_brand ON product_brands(brand_id);
 CREATE VIEW review_queue AS SELECT o.id,p.name_en,p.name_ar,p.aisle,p.classification_source,o.brand_observed,
   o.classification_json,o.title_review FROM observations o JOIN products p ON p.id=o.product_id
   WHERE p.review_required=1 OR o.title_review=1;
 BEGIN;`);
const insertBrand=db.prepare('INSERT OR IGNORE INTO brands VALUES(?,?,?,?)');
const insertAlias=db.prepare('INSERT OR IGNORE INTO brand_aliases VALUES(?,?,?,?)');
for(const b of BRAND_LEXICON){insertBrand.run(b.id,b.display_en,b.display_ar,'canonical');for(const a of b.aliases)insertAlias.run(normalizeBrandKey(a),a,b.id,'canonical');}
for(const a of AISLES)db.prepare('INSERT INTO classifications VALUES(?,?,?,?)').run(a.id,a.en,a.ar,a.dept);
db.prepare('INSERT INTO classifications VALUES(?,?,?,?)').run('non-product','Not a product','صورة لا تحتوي منتجًا','review-required');
db.prepare('INSERT INTO classifications VALUES(?,?,?,?)').run('review-required','Classification review required','بانتظار تحديد الصنف','review-required');
for(const a of AISLES)db.prepare('INSERT INTO product_types VALUES(?,?,?,?)').run('aisle:'+a.id,a.en,a.ar,a.id);
db.prepare('INSERT INTO product_types VALUES(?,?,?,?)').run('non-product','Not a product','صورة لا تحتوي منتجًا',null);
db.prepare('INSERT INTO product_types VALUES(?,?,?,?)').run('review-required','Classification review required','بانتظار تحديد الصنف',null);
for(const t of SHOPPING_CATEGORIES)db.prepare('INSERT INTO product_types VALUES(?,?,?,?)').run(t.id,t.en[0],t.ar,t.aisle);
for(const s of sources)db.prepare('INSERT INTO sources(file,sha256,bytes) VALUES(?,?,?)').run(s.file,s.sha256,s.bytes);
const products=new Map(),unknownBrands=new Map(),classified={},pending=[];
const insertProduct=db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?,?)');
const insertObservation=db.prepare('INSERT INTO observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const insertProductBrand=db.prepare('INSERT OR IGNORE INTO product_brands VALUES(?,?)');
const projections=[];let index=0;
const invalidBrand=/^(?:null|none|n\/a|na|unknown|unbranded|no brand|generic|assorted|selected|usa|china|india|saudi|egypt|turkey|local|fresh|imported|organic|natural|sagai|sukkary|nadorcott|بدون ماركة|بدون علامه|غير معروف|محلي|متنوع|صقعي|سكري)$/i;
for(const r of rows){
  let classification=classifyArchivedProduct(r,{names:allNames,brands});
  if(classification.status==='pending_review'&&r.source_text){
    const fallback=classifyArchivedProduct({name:r.source_text,nameAr:r.source_name_ar},{names:allNames,brands});
    if(fallback.status==='classified')classification={...fallback,source:'retailer_ocr_terms',reviewRequired:true};
  }
  classified[classification.source]=(classified[classification.source]||0)+1;
  const imageReview=IMAGE_CLASSIFICATION_REVIEWS[r.id];
  const displayEn=imageReview?.nameEn || r.name;
  const title=dictionaryProductTitle({nameEn:displayEn,nameAr:imageReview?.nameAr || r.name_ar,brand:imageReview?.brandEn || r.brand,size:r.size});
  if(imageReview?.nameEn || imageReview?.nameAr)title.evidence.push({source:'image_review',proof:imageReview.proof});
  const brandIds=[];
  const observed=String(r.brand||'').trim();
  const pieces=observed.split(/\s*\/\s*|\s+or\s+/i).filter(Boolean);
  for(const piece of pieces){
    const resolved=resolveBrand(piece);const k=normalizeBrandKey(piece);if(!k)continue;
    if(resolved.brand_id){brandIds.push(resolved.brand_id);insertAlias.run(k,piece,resolved.brand_id,'canonical');}
    else {
      const id='observed-'+sha(k.replaceAll(' ','')).slice(0,18);
      const status=(invalidBrand.test(piece)||isProductAttribute(piece))?'non_brand_attribute':'observed_needs_review';
      insertBrand.run(id,/[a-z]/i.test(piece)?piece:null,/[\u0621-\u064a]/u.test(piece)?piece:null,status);
      insertAlias.run(k,piece,id,status);if(status!=='non_brand_attribute')brandIds.push(id);
      const u=unknownBrands.get(id)||{id,observed:piece,status,count:0,examples:[]};u.count++;if(u.examples.length<3)u.examples.push({id:r.id,en:r.name,ar:r.name_ar});unknownBrands.set(id,u);
    }
  }
  const contextualBrands=(title.brands||[]).map(b=>b.id).filter(Boolean);
  if(contextualBrands.length){brandIds.length=0;brandIds.push(...contextualBrands);}
  // Knowledge ids are separate from the commercial Registry; no pr_* id is
  // created, merged or reassigned by this archive database.
  const productKey=JSON.stringify([classificationKey(r.name||r.name_ar)||r.id,[...new Set(brandIds)].sort(),classificationKey(r.size),classification.aisle]);
  const id='pk_'+sha(productKey).slice(0,24);
  if(!products.has(id)){
    const product={id,nameEn:displayEn,nameAr:title.name,titleSource:title.source,brandIds,
      classification,size:r.size||null,titleReview:title.reviewRequired};products.set(id,product);
    insertProduct.run(id,displayEn,title.name,title.source,classification.category.id,classification.aisle,
      classification.source,Number(classification.reviewRequired),r.size||null,classification.status);
    for(const brandId of new Set(brandIds))insertProductBrand.run(id,brandId);
  }
  insertObservation.run(r.id,id,r.name,r.name_ar,r.brand||null,r.size||null,r.retailer_category||null,r.id.split(':')[0],
    r.brochure_id||null,r.page_index??null,r.source_url||null,r.enriched_at||null,r.product_id||null,
    r.source_kind,JSON.stringify(r.sourceFiles),JSON.stringify(classification),Number(title.reviewRequired),r.source_image_url||null,r.source_text||null);
  if(classification.status==='pending_review')pending.push({id:r.id,en:r.name,ar:r.name_ar,brand:r.brand});
  projections.push({id:r.id,productId:id,name:displayEn,nameAr:title.name,brandIds,classification,titleSource:title.source,titleReview:title.reviewRequired});
  if(++index%5000===0)console.log('Indexed '+index+'/'+rows.length);
}
const stats={builtAt:new Date().toISOString(),published:false,observations:rows.length,products:products.size,
  stores:new Set(rows.map(r=>r.id.split(':')[0])).size,brochures:new Set(rows.map(r=>r.brochure_id).filter(Boolean)).size,
  canonicalBrands:BRAND_LEXICON.length,nonProductObservations:projections.filter(r=>r.classification.status==='non_product').length,brandRecords:db.prepare('SELECT COUNT(*) n FROM brands').get().n,
  observedBrandCandidates:[...unknownBrands.values()].filter(b=>b.status==='observed_needs_review').length,
  sourceMethods:classified,classified:projections.filter(r=>r.classification.status==='classified').length,pendingClassification:pending.length,
  classifiedPercent:Number((projections.filter(r=>r.classification.status==='classified').length*100/projections.filter(r=>r.classification.status!=='non_product').length).toFixed(3)),
  groceryPriority:{departments:['fresh','dairy-eggs','beverages','pantry','snacks-sweets','bakery','frozen'],
    observations:projections.filter(r=>['fresh','dairy-eggs','beverages','pantry','snacks-sweets','bakery','frozen'].includes(r.classification.department)).length,
    classified:projections.filter(r=>['fresh','dairy-eggs','beverages','pantry','snacks-sweets','bakery','frozen'].includes(r.classification.department)&&r.classification.status==='classified').length},
  generatedNameRules:Object.keys(usedNames).length,generatedBrandRules:Object.keys(brands).length,sources};
db.prepare('INSERT INTO metadata VALUES(?,?)').run('stats',JSON.stringify(stats));
db.exec('COMMIT;');
const integrity=db.prepare('PRAGMA integrity_check').get();
if(Object.values(integrity)[0]!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Database integrity failed');
db.close();
fs.renameSync(buildPath,dbPath);
fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify(stats,null,2));
fs.writeFileSync(path.join(out,'products.json'),JSON.stringify([...products.values()]));
fs.writeFileSync(path.join(out,'projections.json'),JSON.stringify(projections));
fs.writeFileSync(path.join(out,'classification-pending.json'),JSON.stringify(pending,null,2));
fs.writeFileSync(path.join(out,'brand-review.json'),JSON.stringify([...unknownBrands.values()].sort((a,b)=>b.count-a.count),null,2));
console.log(JSON.stringify(stats));
