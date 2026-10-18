import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {quantityForOffer,unitPriceFor} from '../../src/priceWatch.js';
import {offerSize} from '../../../../brochure-frontend-release-2026-10-18/src/viewer/insights.js';
const dir=new URL('./',import.meta.url),results=JSON.parse(readFileSync(new URL('results.json',dir))),cases=JSON.parse(readFileSync(new URL('review-cases.json',dir)));
for(const c of results.changes){
 const r=cases.find(r=>r.id===c.id),offer={name:r.name,nameAr:r.nameAr,price:r.price,size:c.sizeAfter,unitPrice:c.after,unitPriceResolved:true};
 const watch=unitPriceFor(offer.price,quantityForOffer(offer)),viewer=offerSize(offer).unit;
 assert.ok(Math.abs(watch.value-c.after.value)<1e-8,c.id+' watch');assert.ok(Math.abs(viewer.value-c.after.value)<1e-8,c.id+' viewer');
 assert.equal(watch.unit,c.after.unit);assert.equal(viewer.unit,({l:'L',piece:'pc'})[c.after.unit]||c.after.unit);
 assert.ok(Math.abs(c.eachAfter.value-r.price/c.eachAfter.pack)<1e-8,c.id+' each');
}
writeFileSync(new URL('surfaces.json',dir),JSON.stringify({testedAt:new Date().toISOString(),products:results.changes.length,engineViewerWatchAndEachAgree:true},null,2));console.log('33 corrected packages agree across engine, viewer, watch and per-item arithmetic.');
