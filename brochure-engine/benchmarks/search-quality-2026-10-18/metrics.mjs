import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const dir=new URL('./',import.meta.url),read=n=>JSON.parse(readFileSync(new URL(n,dir)));
const runs=read('results.json'),targets=read('target-results.json'),visual=read('visual-reference.json'),protocol=read('candidate-protocol.json');
const catalog=JSON.parse((await import('node:zlib')).gunzipSync(readFileSync(new URL('catalog.json.gz',dir))));
const frontendRoot=resolve(process.argv[2]||'../../live-shopping-assistant');
for(const [path,hash] of Object.entries(protocol.hashes)){
 const location=path.startsWith('../../brochure-frontend-release-2026-10-18/')?resolve(frontendRoot,path.slice('../../brochure-frontend-release-2026-10-18/'.length)):path;
 const content=protocol.hashNormalization?readFileSync(location,'utf8').replaceAll('\r\n','\n'):readFileSync(location);
 assert.equal(createHash('sha256').update(content).digest('hex'),hash,'frozen candidate: '+path);
}
assert.equal(catalog.meta.rows_written,0);
const available=new Set(catalog.results.map(r=>r.id)),validTargets=targets.results.filter(r=>available.has(r.target));
const labels=new Map(visual.records.map(r=>[r.id,r.label]));
const strawberry=runs.results.find(r=>r.q==='فراوله');
const score=side=>{const top=strawberry[side].frontend.price.slice(0,10);assert.ok(top.every(o=>labels.has(o.id)),'every top-ten crop visually reviewed');return top.filter(o=>labels.get(o.id)==='strawberry').length;};
assert.equal(score('before'),7);assert.equal(score('after'),10);
const regressions=validTargets.filter(r=>r.before.frontendFound&&!r.after.frontendFound);
assert.deepEqual(regressions,[],'previously found target offers preserved');
let preserved=0;const changedFields=[];
for(const r of runs.results){
 assert.ok(r.after.frontend.price.length>=r.before.frontend.price.length,'no decline in admitted/deduplicated count: '+r.q);
 const after=new Map(r.after.engine.map(o=>[o.id,o]));
 for(const old of r.before.engine){const current=after.get(old.id);if(!current)continue;preserved++;
  for(const field of ['name','nameAr','price','oldPrice','size','unitPrice','eachPrice'])if(JSON.stringify(old[field])!==JSON.stringify(current[field]))changedFields.push({q:r.q,id:old.id,field});
 }
}
assert.deepEqual(changedFields,[],'display, shelf prices and arithmetic unchanged for common offers');
const oldVectors=JSON.parse(execFileSync('git',['show','8fe94ac:brochure-engine/src/matcherParity.vectors.json']));
const vectors=JSON.parse(readFileSync('src/matcherParity.vectors.json'));
let vectorChanges=0;for(const [fn,list] of Object.entries(vectors.cases))list.forEach((row,i)=>{if(JSON.stringify(row)!==JSON.stringify(oldVectors.cases[fn][i]))vectorChanges++;});
const summary={generatedAt:new Date().toISOString(),baselineEngine:runs.baselineEngine,baselineFrontend:runs.baselineFrontend,catalogRows:runs.catalogRows,queryCount:runs.results.length,visualReferences:visual.records.length,strawberryTop10:{before:score('before'),after:score('after'),definition:'Fruit, including frozen strawberries; not a fresh-only score.'},targetProbes:{total:targets.results.length,available:validTargets.length,unavailable:targets.results.filter(r=>!available.has(r.target)).map(r=>({q:r.q,id:r.target})),engineBefore:validTargets.filter(r=>r.before.engineFound).length,engineAfter:validTargets.filter(r=>r.after.engineFound).length,frontendBefore:validTargets.filter(r=>r.before.frontendFound).length,frontendAfter:validTargets.filter(r=>r.after.frontendFound).length,regressions,remaining:validTargets.filter(r=>!r.after.frontendFound)},commonOfferComparisons:preserved,changedDisplayOrPriceFields:changedFields,vectorChanges,knownDivergences:vectors.divergences,
queries:runs.results.map(r=>({q:r.q,engineBefore:r.before.engine.length,engineAfter:r.after.engine.length,frontendBefore:r.before.frontend.price.length,frontendAfter:r.after.frontend.price.length,top10Before:r.before.frontend.price.slice(0,10),top10After:r.after.frontend.price.slice(0,10)}))};
writeFileSync(new URL('results-summary.json',dir),JSON.stringify(summary,null,2));
console.log(JSON.stringify({...summary,queries:undefined,targetProbes:{...summary.targetProbes,remaining:summary.targetProbes.remaining.map(r=>r.q)}} ,null,2));
