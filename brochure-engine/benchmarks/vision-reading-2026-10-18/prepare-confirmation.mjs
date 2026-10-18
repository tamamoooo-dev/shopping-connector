import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const dir=new URL('./',import.meta.url),hash=x=>createHash('sha256').update(x).digest('hex');
const original=JSON.parse(readFileSync(new URL('manifest.json',dir)));
const excluded=new Set(original.samples.map(x=>x.id));
const rows=JSON.parse(gunzipSync(readFileSync(new URL('../search-quality-2026-10-18/catalog.json.gz',dir)))).results;
const stores=[...new Set(original.samples.map(x=>x.store))].sort();
const selected=stores.flatMap(store=>rows.filter(r=>r.store===store&&!excluded.has(r.id)&&r.image_url).sort((a,b)=>hash('vision-reading-confirmation-v2:'+a.id).localeCompare(hash('vision-reading-confirmation-v2:'+b.id))).slice(0,2));
const samples=[];
for(let i=0;i<selected.length;i++){
 const row=selected[i],item={index:i+65,id:row.id,store:row.store,image:row.image_url,split:'confirmation',path:`images/${i+65}.jpg`};
 const path=new URL(item.path,dir);if(!existsSync(path)){let response=await fetch(item.image);if(!response.ok)throw Error(String(response.status));writeFileSync(path,Buffer.from(await response.arrayBuffer()));}
 item.sha256=hash(readFileSync(path));samples.push(item);
}
writeFileSync(new URL('confirmation-manifest.json',dir),JSON.stringify({createdAt:new Date().toISOString(),selection:'Two fresh stable-id selected crops per store, all previous 64 excluded. No stored extraction fields used.',samples},null,2));
console.log({confirmationImages:samples.length});
