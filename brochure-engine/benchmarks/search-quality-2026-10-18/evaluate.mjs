import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSqliteD1} from '../../src/storage/testSqliteD1.mjs';
import {createD1OfferStore} from '../../src/storage/offerStore.js';
import {handleRequest} from '../../src/engine.js';
import {createD1OfferStore as oldStore} from './baseline/storage/offerStore.js';
import {handleRequest as oldHandle} from './baseline/engine.js';
import {frontendModule} from './frontend-module.mjs';
const dir=new URL('./',import.meta.url),read=n=>JSON.parse(readFileSync(new URL(n,dir),'utf8').replace(/^\uFEFF/,''));
const catalogBytes=!process.argv.includes('--gzip')&&existsSync(new URL('catalog.json',dir))?readFileSync(new URL('catalog.json',dir)):gunzipSync(readFileSync(new URL('catalog.json.gz',dir)));
if(createHash('sha256').update(catalogBytes).digest('hex')!==read('catalog-digest.json').sha256)throw Error('Catalogue fixture hash mismatch');
const catalog=JSON.parse(catalogBytes);
const plan=read('plan.json');
const frontendSource=pathToFileURL(resolve(process.argv.slice(2).find(a=>!a.startsWith('--'))||'../../live-shopping-assistant','src')+'/');
const before={compare:await import('./frontend-baseline/compare.js'),match:await import('./frontend-baseline/match.js'),rank:await import('./frontend-baseline/ranking.mjs'),featured:await import('./frontend-baseline/featured.js')};
const after=await frontendModule(frontendSource,new URL(process.argv.includes('--targets')?'frontend-candidate-targets/':'frontend-candidate/',dir));
const {raw,db,close}=createSqliteD1(['schema.sql']);
const columns=raw.prepare('PRAGMA table_info(offers)').all().map(c=>c.name).filter(c=>Object.hasOwn(catalog.results[0],c));
const insert=raw.prepare(`INSERT INTO offers (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
const brochure=raw.prepare("INSERT OR IGNORE INTO brochures(id,store,region,edition,detected_at,source_type,checksum,collector,storage_key)VALUES(?,?,?,?,?,'images',?,'audit','audit')");
const enrich=raw.prepare('INSERT INTO offer_enrichments(id,name,name_ar,brand,size,corroboration,model,enriched_at,match_text,extraction_json)VALUES(?,?,?,?,?,?,?,?,?,?)');
raw.exec('BEGIN');
for(const r of catalog.results){
 brochure.run(r.brochure_id,r.store,r.region,r.edition||'audit',r.detected_at,r.brochure_id);
 insert.run(...columns.map(c=>r[c]??null));
 if(r.e_name!==null||r.e_name_ar!==null||r.e_match_text!==null)enrich.run(r.id,r.e_name,r.e_name_ar,r.e_brand,r.e_size,r.e_corroboration,r.e_model,'2026-10-18',r.e_match_text,JSON.stringify({unit:r.e_unit,package_type:r.e_package_type,attributes:JSON.parse(r.e_attributes||'[]')}));
}
raw.exec('COMMIT');
const results=[];
const holdoutTruth=JSON.parse(readFileSync(new URL('../resource-release-2026-10-18/implementation-holdout-truth.json',dir)));
const holdoutManifest=JSON.parse(readFileSync(new URL('../resource-release-2026-10-18/implementation-holdout-manifest.json',dir)));
const targets=holdoutTruth.samples.flatMap(t=>['en','ar'].map(lang=>({q:t[lang],target:holdoutManifest.samples.find(s=>s.index===t.index).id,index:t.index,lang})));
const extra=['banana','موز','apple','تفاح','mango','مانجو','strawberry milk','strawberry waffle','وافل فراولة','جيلي فراولة','lemon squeezer','عصارة ليمون','white eggs','بيض سمان','sunflower oil 1.5L','لبنة الصافي','زيتون','olive oil','egg roll','rice flour','huggies diapers','حفاضات هجيز','parachute shampoo','sunsilk shampoo'];
let queue=process.argv.includes('--targets')?targets:[...plan.queries,...extra.map(q=>({q}))];
if(process.argv.includes('--smoke'))queue=queue.slice(0,2);
for(const {q,target,index,lang} of queue){
 const entry={q};
 for(const [side,store,handler,front] of [['before',oldStore,oldHandle,before],['after',createD1OfferStore,handleRequest,after]]){
  const start=performance.now();
  const response=await handler(new Request('https://audit.local/offers?limit=120&diag=1&q='+encodeURIComponent(q)),{offerStore:store(db,{builtArabicNamesEnabled:true}),registry:{}});
  if(!response.ok)throw Error(q+' '+response.status);const data=await response.json();
  const listings=front.rank.dedupeFlyers(data.offers.map(o=>front.compare.flyerListing(o,q)).filter(Boolean));
  const modes={};
  for(const mode of ['price','featured']){
   const entries=listings.map(listing=>({kind:'flyer',listing}));
   const context=mode==='featured'?front.featured.featuredContext(q,entries.map(e=>e.listing.price)):null;
   entries.sort(front.rank.makeComparator(q,front.match.queryFamily(q),front.match.freshProduceIntent(q),mode,null,context));
   modes[mode]=entries.map((e,i)=>({rank:i+1,id:e.listing.offer.id,name:e.listing.name,price:e.listing.price,family:e.listing.family,stage:front.rank.entryStage(e,q),band:front.rank.entryBand(e,front.match.queryFamily(q),front.match.freshProduceIntent(q))}));
  }
  const summary=front.compare.computeComparison(q,[],data.offers,null);
  entry[side]={elapsedLocalMs:performance.now()-start,engine:data.offers,frontend:modes,summary};
 }
 if(target){entry.target=target;entry.index=index;entry.lang=lang;for(const side of ['before','after'])entry[side]={engineFound:entry[side].engine.some(o=>o.id===target),frontendFound:entry[side].frontend.price.some(o=>o.id===target),rank:entry[side].frontend.price.find(o=>o.id===target)?.rank??null};}
 results.push(entry);
 if(target){console.log(JSON.stringify(entry));continue;}
 console.log(JSON.stringify({q,before:entry.before.frontend.price.length,after:entry.after.frontend.price.length,topBefore:entry.before.frontend.price.slice(0,4).map(o=>o.name),topAfter:entry.after.frontend.price.slice(0,4).map(o=>o.name)}));
}
close();
writeFileSync(new URL(process.argv.includes('--smoke')?'replay-smoke.json':process.argv.includes('--targets')?'target-results.json':'results.json',dir),JSON.stringify({evaluatedAt:new Date().toISOString(),baselineEngine:'8fe94ac',baselineFrontend:'59748de',catalogCapturedAt:catalog.capturedAt,catalogRows:catalog.results.length,method:'Same captured current browseable catalogue in real SQLite, exact store SQL and engine request handler, exact frontend offer admission, deduplication and comparator. Flyer-only rankings; no inference or writes.',results},null,2));
