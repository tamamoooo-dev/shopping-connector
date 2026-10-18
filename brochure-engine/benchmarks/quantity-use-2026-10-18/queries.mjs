import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {frontendModule} from '../search-quality-2026-10-18/frontend-module.mjs';
import {applyEnrichment} from '../../src/offers/enrich.js';
import {corroboratedPackCount} from '../../src/offers/observedPackCount.js';
const dir=new URL('./',import.meta.url),front=new URL('../../../../brochure-frontend-release-2026-10-18/',import.meta.url);
const frontend=await frontendModule(new URL('src/',front),new URL('.data/frontend/',dir));
const queries=JSON.parse(gunzipSync(readFileSync(new URL('benchmarks/dedupe-2026-10-18/responses.json.gz',front)))).results;
const catalog=JSON.parse(gunzipSync(readFileSync(new URL('../search-quality-2026-10-18/catalog.json.gz',dir)))).results;
const byId=new Map(catalog.map(r=>[r.id,r]));
const counts=new Map(JSON.parse(gunzipSync(readFileSync(new URL('counts.json.gz',dir)))).map(r=>[r.id,r.quantity]));
const result=[];
for(const {q,offers} of queries){
 const project=enabled=>offers.map(o=>{const r=byId.get(o.id);if(!r)return {...o};const next={...o};applyEnrichment(next,enabled?{...r,e_pack_count:corroboratedPackCount(counts.get(r.id),r.search_text)}:r);return next;});
 const before=project(false),after=project(true);
 const ids=rows=>rows.filter(o=>frontend.compare.flyerListing(o,q)).map(o=>o.id);
 assert.deepEqual(ids(after),ids(before),q+' admissions');
 const brief=rows=>{const c=frontend.compare.computeComparison(q,[],rows,null);return c?{id:c.headline.listing.offer?.id,up:c.headline.listing.up,size:c.headline.listing.size,price:c.headline.listing.price}:null;};
 result.push({q,before:brief(before),after:brief(after),offers:ids(after).length});
}
writeFileSync(new URL('query-results.json',dir),JSON.stringify({queries:result.length,admissionChanges:0,headlineChanges:result.filter(r=>r.before?.id!==r.after?.id),results:result},null,2));
console.log(JSON.stringify({queries:result.length,admissionChanges:0,headlineChanges:result.filter(r=>r.before?.id!==r.after?.id)},null,2));
