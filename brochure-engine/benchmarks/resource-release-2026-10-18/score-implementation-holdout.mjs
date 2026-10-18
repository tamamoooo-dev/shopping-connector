import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {dirname,posix} from 'node:path';
import {applyUnitPrice} from '../../src/offers/enrich.js';
import {isNonGrocery} from '../../src/lexicon/productClass.js';
import {canonicalMatchText,queryTokens} from '../../src/matching.js';
import {offerRelevance,relevanceScore} from '../../src/offers/contract.js';
import {createD1OfferStore} from '../../src/storage/offerStore.js';
import {createSqliteD1,insertOffers} from '../../src/storage/testSqliteD1.mjs';
import {applyEnrichment} from '../../src/offers/enrich.js';
const dir=new URL('./',import.meta.url),read=n=>JSON.parse(readFileSync(new URL(n,dir),'utf8').replace(/^\uFEFF/,''));
const truth=read('implementation-holdout-truth.json'),manifest=read('implementation-holdout-manifest.json');
const captured=read('implementation-holdout-d1.json')[0].results;
const protocol=read('implementation-holdout-protocol.json');
const BASELINE_COMMIT='fba1144aad881d441a6f3d29bb91a4957cefc9ab';
// Record the code being replayed. The original pre-selection freeze remains
// in protocol; a port or later regression replay is not a new blind holdout.
const candidateCodeHashes=Object.fromEntries(Object.keys(protocol.hashes).map(path=>[
 path,createHash('sha256').update(readFileSync(path)).digest('hex'),
]));
const saved=new Set();
function saveBaseline(path) {
 if(saved.has(path)) return;
 saved.add(path);
 const bytes=execFileSync('git',['show',`${BASELINE_COMMIT}:brochure-engine/src/${path}`]);
 const target=new URL(`implementation-baseline/${path}`,dir);
 mkdirSync(dirname(target.pathname.replace(/^\/(.:)/,'$1')),{recursive:true});
 writeFileSync(target,bytes);
 for(const match of bytes.toString().matchAll(/from\s*['"]([.][^'"]+)['"]/g)) {
  saveBaseline(posix.normalize(posix.join(posix.dirname(path),match[1])));
 }
}
saveBaseline('lexicon/comparableQuantity.js');
saveBaseline('storage/offerStore.js');
const baseline=await import('./implementation-baseline/lexicon/comparableQuantity.js');
const oldMatching=await import('./implementation-baseline/matching.js');
const oldStoreModule=await import('./implementation-baseline/storage/offerStore.js');
const oldEnrichment=await import('./implementation-baseline/offers/enrich.js');
const oldContract=await import('./implementation-baseline/offers/contract.js');
const score=(actual,t)=>t.exclude?'excluded':!actual?'withheld':actual.unit===t.unit&&Math.abs(actual.value-t.price/t.reference)/(t.price/t.reference)<.03?'correct':'wrong';
const rows=truth.samples.map(t=>{
 const m=manifest.samples.find(m=>m.index===t.index),r=captured.find(r=>r.id===m.id);
 const offer={name:r.e_name,nameAr:r.e_name_ar,price:r.price,category:r.category};
 applyUnitPrice(offer,r);
 const before=baseline.unitPriceFromReference(r.price,baseline.resolveComparableQuantity({size:r.e_size,name:r.e_name,unit:r.e_unit,text:[r.e_name_ar,r.search_text].filter(Boolean).join(' '),nonGrocery:isNonGrocery(r.category)}).reference);
 return {index:t.index,id:r.id,category:r.category,size:r.e_size,price:r.price,sourcePriceMatchesImage:Math.abs(r.price-t.price)<.005,
  expected:t.exclude?{excluded:t.exclude}:{unit:t.unit,value:t.price/t.reference},
  before,after:offer.unitPrice,beforeStatus:score(before,t),afterStatus:score(offer.unitPrice,t)};
});
// Fixed authored positive probes, plus wrong-primary-product contrasts. This
// measures isolated corpus matching, not production population recall.
const relevance=(name,hay,tokens,matching)=>{
 const text=matching.canonicalMatchText(hay),words=new Set(text.split(' '));
 return tokens.every(tok=>matching.bestVariantScore(tok,text,words)>0);
};
const queries=truth.samples.flatMap(t=>['en','ar'].map(lang=>{
 const m=manifest.samples.find(m=>m.index===t.index),r=captured.find(r=>r.id===m.id),q=t[lang];
 const beforeHay=r.e_match_text||r.search_text||'';
 const afterHay=[r.search_text,r.e_match_text,r.e_size,r.e_brand,r.e_attributes,r.e_package_type].filter(Boolean).join(' ');
 return {index:t.index,lang,q,
  before:relevance(r.e_name,beforeHay,oldMatching.queryTokens(q),oldMatching),
  after:relevanceScore(offerRelevance({name:r.e_name,nameAr:r.e_name_ar},queryTokens(q),afterHay))>0};
}));
const summary=key=>Object.fromEntries(['correct','wrong','withheld','excluded'].map(s=>[s,rows.filter(r=>r[key]===s).length]));
const result={scoredAt:new Date().toISOString(),method:truth.method,baselineCommit:BASELINE_COMMIT,candidateCodeHashes,
 candidateFrozenAt:protocol.frozenAt,truthSha256:createHash('sha256').update(readFileSync(new URL('implementation-holdout-truth.json',dir))).digest('hex'),
 before:summary('beforeStatus'),after:summary('afterStatus'),regressions:rows.filter(r=>r.beforeStatus==='correct'&&r.afterStatus!=='correct').map(r=>r.index),
 search:{before:queries.filter(q=>q.before).length,after:queries.filter(q=>q.after).length,total:queries.length},rows,queries};
const {raw,db,close}=createSqliteD1(['schema.sql']);
raw.exec(`INSERT INTO brochures (id,store,region,edition,detected_at,source_type,checksum,collector,storage_key)
 VALUES ('holdout','test','central','test','2026-10-18','images','holdout','test','holdout')`);
insertOffers(raw,captured);
const update=raw.prepare("UPDATE offers SET brochure_id='holdout',page_index=0,search_text=? WHERE id=?");
const insert=raw.prepare('INSERT INTO offer_enrichments (id,name,name_ar,brand,size,corroboration,model,enriched_at,match_text,extraction_json) VALUES (?,?,?,?,?,?,?,?,?,?)');
for(const r of captured){
 update.run(r.search_text,r.id);
 insert.run(r.id,r.e_name,r.e_name_ar,r.e_brand,r.e_size,r.e_corroboration,r.e_model,'2026-10-18',r.e_match_text,
  JSON.stringify({unit:r.e_unit,package_type:r.e_package_type,attributes:JSON.parse(r.e_attributes||'[]')}));
}
const stores={before:oldStoreModule.createD1OfferStore(db),after:createD1OfferStore(db)};
const sqlQueries=[];
for(const query of queries){
 const id=manifest.samples.find(s=>s.index===query.index).id,entry={index:query.index,lang:query.lang,q:query.q};
 for(const side of ['before','after']){
  const t=performance.now(),candidates=await stores[side].search({q:query.q,currentOn:'2026-10-18',limit:300});
  const contract=side==='before'?oldContract:{offerRelevance,relevanceScore,queryTokens};
  const overlay=side==='before'?oldEnrichment.applyEnrichment:applyEnrichment;
  const accepted=candidates.filter(r=>{const offer=contract.rowToOffer?contract.rowToOffer(r):{name:r.name,nameAr:r.name_ar,price:r.price,category:r.category};
   const hay=overlay(offer,r);return contract.relevanceScore(contract.offerRelevance(offer,contract.queryTokens(query.q),hay))>0;});
  entry[side]={found:accepted.some(r=>r.id===id),candidates:candidates.length,ms:performance.now()-t};
 }
 sqlQueries.push(entry);
}
result.realSql={method:'Actual D1 store queries and serving overlay on a 64-row production snapshot in SQLite; not full-catalog latency.',
 before:sqlQueries.filter(q=>q.before.found).length,after:sqlQueries.filter(q=>q.after.found).length,total:sqlQueries.length,queries:sqlQueries};
close();
writeFileSync(new URL('implementation-holdout-results.json',dir),JSON.stringify(result,null,2));
console.log(JSON.stringify({before:result.before,after:result.after,regressions:result.regressions,search:result.search,realSql:{before:result.realSql.before,after:result.realSql.after,total:result.realSql.total},priceMismatches:rows.filter(r=>!r.sourcePriceMatchesImage).map(r=>r.index)},null,2));
