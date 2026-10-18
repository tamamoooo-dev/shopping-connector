import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const dir=new URL('./',import.meta.url),read=n=>JSON.parse(readFileSync(new URL(n,dir)));
const results=read('results.json').results,targets=read('target-results.json').results;
const hashes={};
for(const path of ['src/matching.js','src/offers/enrich.js','src/lexicon/brands.js'])hashes['engine/'+path]=createHash('sha256').update(readFileSync(path,'utf8').replaceAll('\r\n','\n')).digest('hex');
for(const path of ['src/match.js','index.html'])hashes['frontend/'+path]=createHash('sha256').update(readFileSync(resolve(process.argv[2],path),'utf8').replaceAll('\r\n','\n')).digest('hex');
const images=['99094656','99077634','99118386','99120081','98962230'].map(id=>({id,sha256:createHash('sha256').update(readFileSync(new URL('images/'+id+'.jpg',dir))).digest('hex')}));
const changes=results.map(r=>({q:r.q,before:r.before.frontend.price.length,after:r.after.frontend.price.length,lost:r.before.frontend.price.filter(o=>!r.after.frontend.price.some(n=>n.id===o.id)),gained:r.after.frontend.price.filter(o=>!r.before.frontend.price.some(n=>n.id===o.id))}));
const fields=['name','nameAr','price','oldPrice','size','unitPrice','eachPrice'];let common=0;const displayChanges=[];
for(const r of results)for(const o of r.before.engine){const next=r.after.engine.find(n=>n.id===o.id);if(!next)continue;common++;for(const field of fields)if(JSON.stringify(o[field])!==JSON.stringify(next[field]))displayChanges.push({q:r.q,id:o.id,field});}
const summary={checkedAt:new Date().toISOString(),baselineEngine:'e0670b5',baselineFrontend:'aa2addc',catalogRows:12972,queryCount:results.length,exactTargetBefore:targets.filter(r=>r.before.frontendFound).length,exactTargetAfter:targets.filter(r=>r.after.frontendFound).length,targetRegressions:targets.filter(r=>r.before.frontendFound&&!r.after.frontendFound),targetImprovements:targets.filter(r=>!r.before.frontendFound&&r.after.frontendFound),commonOfferComparisons:common,displayChanges,changes,hashes,images,limitations:'Development checks, not blinded. Same captured public catalogue as the preceding release. Original 64-query target set contains four unavailable probes and a visually disproven Swiszone/سويز equivalence; the original set is kept for transparent comparison, not treated as perfect ground truth.'};
writeFileSync(new URL('summary.json',dir),JSON.stringify(summary,null,2));
console.log(JSON.stringify({...summary,changes:changes.filter(r=>r.before!==r.after||r.lost.length)},null,2));
