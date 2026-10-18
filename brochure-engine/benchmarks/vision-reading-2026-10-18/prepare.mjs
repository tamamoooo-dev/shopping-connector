import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const dir=new URL('./',import.meta.url);mkdirSync(new URL('images/',dir),{recursive:true});
const read=p=>JSON.parse(readFileSync(new URL(p,dir),'utf8').replace(/^\uFEFF/,''));
const hash=b=>createHash('sha256').update(b).digest('hex');
const prior=read('../resource-release-2026-10-18/implementation-holdout-manifest.json').samples;
const catalog=JSON.parse(gunzipSync(readFileSync(new URL('../search-quality-2026-10-18/catalog.json.gz',dir))));
const rows=Array.isArray(catalog)?catalog:catalog.results;
const excluded=new Set(prior.map(x=>x.id));
// Selection uses store and stable id only, never names or stored model outputs.
const stores=[...new Set(prior.map(x=>x.store))].sort();
const fresh=stores.flatMap(store=>rows.filter(r=>r.store===store&&!excluded.has(r.id)&&r.image_url).sort((a,b)=>hash('vision-reading-holdout-v1:'+a.id).localeCompare(hash('vision-reading-holdout-v1:'+b.id))).slice(0,2));
const selected=[...prior.map(x=>({id:x.id,store:x.store,image:x.image,split:'development'})),...fresh.map(x=>({id:x.id,store:x.store,image:x.image_url,split:'holdout'}))];
const manifest=[];
for(let i=0;i<selected.length;i++){
 const item={index:i+1,...selected[i],path:`images/${String(i+1).padStart(2,'0')}.jpg`};
 const path=new URL(item.path,dir);
 if(!existsSync(path)){const res=await fetch(item.image);if(!res.ok)throw Error(`image ${i+1}: ${res.status}`);writeFileSync(path,Buffer.from(await res.arrayBuffer()));}
 item.sha256=hash(readFileSync(path));manifest.push(item);
}
writeFileSync(new URL('manifest.json',dir),JSON.stringify({createdAt:new Date().toISOString(),selection:'32 previously reviewed development crops; 32 stable-id selected fresh crops, two per store. Fresh image interpretation before inference; no independent human adjudication.',samples:manifest},null,2));
console.log({images:manifest.length,development:32,holdout:fresh.length});
