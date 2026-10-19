import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { compressStoredObjects, putStoredBytes, readStoredBytes, readStoredJson, COMPRESSION_MAX_BYTES } from './r2Compression.js';
import { createR2ObjectStore } from './objectStore.js';
import { createR2VisionVerificationHistoryStore } from './visionVerificationHistoryStore.js';
import { handleRequest } from '../engine.js';
const enc = new TextEncoder();
const key='vision-verification/attempts/offer/20261019-00000001.json';
const text=JSON.stringify({observation:'حليب Milk '.repeat(1500),price:8.5});
const objects=new Map();let version=0,damageNextRead=false,failCondition=false;
const bucket={
 async put(key,body,options={}) {
  if(options.onlyIf && (failCondition || objects.get(key)?.etag!==options.onlyIf.etagMatches))return null;
  const bytes=typeof body==='string'?enc.encode(body):new Uint8Array(body);
  const object={bytes,etag:String(++version),size:bytes.byteLength,httpMetadata:options.httpMetadata,customMetadata:options.customMetadata};
  objects.set(key,object);return {key,etag:object.etag};
 },
 async get(key) {
  const o=objects.get(key);if(!o)return null;
  return {...o,async arrayBuffer(){
   if(damageNextRead && o.customMetadata?.storageEncoding==='gzip'){damageNextRead=false;return enc.encode('corrupt').buffer;}
   return o.bytes.slice().buffer;
  }};
 },
 async list({prefix}){return {objects:[...objects.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};},
};
await bucket.put(key,text,{httpMetadata:{contentType:'application/json'},customMetadata:{recordType:'evidence'}});
const before=objects.get(key).size;
const result=await compressStoredObjects(bucket,[key]);
assert.equal(result.compressed,1);assert.ok(result.savedBytes>before*0.6);
assert.equal(new TextDecoder().decode(await readStoredBytes(await bucket.get(key))),text);
assert.equal(objects.get(key).customMetadata.recordType,'evidence');
assert.equal(objects.get(key).httpMetadata.contentEncoding,'gzip');
assert.equal((await compressStoredObjects(bucket,[key])).compressed,0);
assert.equal(objects.size,1);
await assert.rejects(compressStoredObjects(bucket,['brochures/store/page00.webp']),/Invalid/);
await assert.rejects(compressStoredObjects(bucket,['backups/d1/active.json']),/Invalid/);
await assert.rejects(compressStoredObjects(bucket,Array(201).fill(key)),/Invalid/);

const changed=key.replace('offer/','changed/');
await bucket.put(changed,text);failCondition=true;
assert.equal((await compressStoredObjects(bucket,[changed])).results[0].status,'changed');
assert.equal(new TextDecoder().decode(objects.get(changed).bytes),text);failCondition=false;
const corrupt=key.replace('offer/','corrupt/');
await bucket.put(corrupt,text);damageNextRead=true;
const failed=await compressStoredObjects(bucket,[corrupt]);
assert.equal(failed.results[0].status,'error');assert.match(failed.results[0].error,/original restored/);
assert.equal(new TextDecoder().decode(objects.get(corrupt).bytes),text);
const large=key.replace('offer/','large/');
objects.set(large,{size:COMPRESSION_MAX_BYTES+1,etag:'oversized'});
assert.equal((await compressStoredObjects(bucket,[large])).results[0].status,'skipped');
const small=key.replace('offer/','small/');await putStoredBytes(bucket,small,'{}');
assert.equal(objects.get(small).size,2);

// Future writes and legacy reads share the same paths. Backup restore uses
// gzip magic detection and Node gunzip, as exercised here on real JSONL rows.
const backup='backups/d1/2026-10-19/offers/00000.jsonl';
const rows=Array.from({length:100},(_,i)=>({__rowid:i+1,id:'o'+i,name:'حليب Milk',price:8.5}));
const jsonl=rows.map(JSON.stringify).join('\n')+'\n';
await putStoredBytes(bucket,backup,jsonl);
assert.deepEqual(gunzipSync(objects.get(backup).bytes).toString('utf8').trim().split('\n').map(JSON.parse),rows);
const store=createR2ObjectStore(bucket);
const archive='ops-archive/2026-10-19/evidence.ndjson';
await store.put(archive,enc.encode(text),{contentType:'application/x-ndjson'});
assert.equal(new TextDecoder().decode((await store.get(archive)).bytes),text);
const history=createR2VisionVerificationHistoryStore(bucket);
const saved=await history.recordAttempt({offerId:'future',attemptNo:1,initialOutcome:'accepted',attempt:{output:JSON.parse(text),accepted:true}});
assert.equal(objects.get(saved.key).customMetadata.storageEncoding,'gzip');
assert.equal((await history.readAttempts('future'))[0].observation.price,8.5);
assert.equal((await readStoredJson(await bucket.get(saved.key))).observation.price,8.5);
const endpoint='https://engine.example/compress-storage';
assert.equal((await handleRequest(new Request(endpoint,{method:'POST',body:'{}'}),{})).status,403);
assert.equal((await handleRequest(new Request(endpoint,{method:'POST',headers:{'X-Ingest-Secret':'wrong'},body:'{}'}),{ingestSecret:'secret',storageBucket:bucket})).status,403);
assert.equal((await handleRequest(new Request(endpoint,{method:'POST',headers:{'X-Ingest-Secret':'secret'},body:JSON.stringify({keys:['brochures/store/page00.webp']})}),{ingestSecret:'secret',storageBucket:bucket})).status,400);
console.log('R2 compression: verified lossless reads, backup restore, history reads, conditional writes, corruption rollback and bounds');
