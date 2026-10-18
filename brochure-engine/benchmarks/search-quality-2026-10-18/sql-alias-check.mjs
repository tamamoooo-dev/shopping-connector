import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createSqliteD1} from '../../src/storage/testSqliteD1.mjs';
import {createD1OfferStore as before} from './store-before-alias.mjs';
import {createD1OfferStore as after} from '../../src/storage/offerStore.js';
const dir=new URL('./',import.meta.url),read=n=>JSON.parse(readFileSync(new URL(n,dir)));
async function statement(factory,q){let c;await factory({prepare:sql=>({bind:(...args)=>({all:async()=>{c={sql,args};return {results:[]}}})})},{builtArabicNamesEnabled:true}).search({q,currentOn:'2026-10-18',limit:300});return c;}
const remote=process.argv.includes('--remote');
if(remote){
 const run=promisify(execFile),results=[];
 for(const q of ['فراوله','rice 1kg','nadec greek yoghurt','nuggets nugget ناجتس ناجت ناغتس nuggets']){
  let oldRows;
  for(const [variant,factory] of [['before',before],['after',after]]){
   const c=await statement(factory,q);let i=0;const sql=c.sql.replaceAll('?',()=>{const v=c.args[i++];return typeof v==='number'?String(v):`'${String(v).replaceAll("'","''")}'`});
   if(Buffer.byteLength(sql)>100000){results.push({q,variant,sqlBytes:Buffer.byteLength(sql),skipped:'exceeds D1 statement size'});continue;}
   if(variant==='before'&&process.platform==='win32'&&sql.length>24000){results.push({q,variant,sqlBytes:Buffer.byteLength(sql),skipped:'old repeated SQL exceeds safe Windows CLI argument size; local equivalence is covered separately'});continue;}
   const start=Date.now();const {stdout}=await run(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','execute','brochure-engine','--remote','--command',sql,'--json'],{maxBuffer:30*1024*1024});const data=JSON.parse(stdout.trim())[0];assert.equal(data.meta.rows_written,0);
   for(const row of data.results)delete row._search_hay;
   if(variant==='before')oldRows=data.results;else if(oldRows)assert.deepEqual(data.results,oldRows,'live identical rows/order: '+q);
   results.push({q,variant,sqlBytes:Buffer.byteLength(sql),count:data.results.length,wallMs:Date.now()-start,meta:data.meta});
   console.log(JSON.stringify(results.at(-1)));
  }
 }
 writeFileSync(new URL('sql-alias-live.json',dir),JSON.stringify(results,null,2));process.exit(0);
}
const catalog=JSON.parse(gunzipSync(readFileSync(new URL('catalog.json.gz',dir)))).results;
const {raw,db,close}=createSqliteD1(['schema.sql']);
const columns=raw.prepare('PRAGMA table_info(offers)').all().map(c=>c.name).filter(c=>Object.hasOwn(catalog[0],c));
const insert=raw.prepare(`INSERT INTO offers(${columns.join(',')})VALUES(${columns.map(()=>'?').join(',')})`);
const brochure=raw.prepare("INSERT OR IGNORE INTO brochures(id,store,region,edition,detected_at,source_type,checksum,collector,storage_key)VALUES(?,?,?,?,?,'images',?,'audit','audit')");
const enrich=raw.prepare('INSERT INTO offer_enrichments(id,name,name_ar,brand,size,corroboration,model,enriched_at,match_text,extraction_json)VALUES(?,?,?,?,?,?,?,?,?,?)');
raw.exec('BEGIN');for(const r of catalog){brochure.run(r.brochure_id,r.store,r.region,r.edition||'audit',r.detected_at,r.brochure_id);insert.run(...columns.map(c=>r[c]??null));if(r.e_name!==null||r.e_name_ar!==null||r.e_match_text!==null)enrich.run(r.id,r.e_name,r.e_name_ar,r.e_brand,r.e_size,r.e_corroboration,r.e_model,'2026-10-18',r.e_match_text,JSON.stringify({unit:r.e_unit,package_type:r.e_package_type,attributes:JSON.parse(r.e_attributes||'[]')}));}raw.exec('COMMIT');
const queries=[...read('results.json').results.map(r=>r.q),...read('target-results.json').results.map(r=>r.q),'','nuggets nugget ناجتس ناجت ناغتس nuggets','wafer yoghurt ladies slipper water eggs','nuggets wafer yoghurt ladies water slipper','milk حليب sugar','nadec نادك milk'];
const records=[];
for(const q of queries){const a=await before(db,{builtArabicNamesEnabled:true}).search({q,currentOn:'2026-10-18',limit:300}),b=await after(db,{builtArabicNamesEnabled:true}).search({q,currentOn:'2026-10-18',limit:300});assert.deepEqual(b,a,'identical fields/rows/order: '+q);const old=await statement(before,q),current=await statement(after,q);records.push({q,count:a.length,beforeBytes:Buffer.byteLength(old.sql),afterBytes:Buffer.byteLength(current.sql),bindings:current.args.length});}
const proof={checkedAt:new Date().toISOString(),queries:queries.length,allRowsFieldsAndOrderIdentical:true,records};
writeFileSync(new URL('sql-alias-proof.json',dir),JSON.stringify(proof,null,2));close();console.log(JSON.stringify({queries:queries.length,allRowsFieldsAndOrderIdentical:true,worst:records.at(-2)}));
