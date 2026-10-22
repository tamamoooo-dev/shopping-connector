import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {
 buildVisionRequest,buildEnrichmentVisionRequest,enrichOffer,MISTRAL_URL,
 VISION_PROMPT,ENRICHMENT_VISION_PROMPT,ENRICHMENT_READING_BASELINE,
 QUARANTINED_OBSERVATION_FIELDS,
 drainEnrichment,
} from './enrich.js';

const frozen=JSON.parse(readFileSync(new URL('../../benchmarks/vision-reading-2026-10-18/protocol-confirmation.json',import.meta.url),'utf8'));
assert.notEqual(ENRICHMENT_VISION_PROMPT,frozen.prompts['caption-line']);
assert.match(ENRICHMENT_VISION_PROMPT,/sale_options/);
assert.match(ENRICHMENT_VISION_PROMPT,/Arabic product caption/);
assert.match(ENRICHMENT_VISION_PROMPT,/ONE whole package BEFORE applying sale_count/);
assert.equal(createHash('sha256').update(ENRICHMENT_VISION_PROMPT).digest('hex'),ENRICHMENT_READING_BASELINE.promptSha256);
const options={base64:'AQID',contentType:'image/jpeg'};
const priceRequest=buildVisionRequest(options),enrichmentRequest=buildEnrichmentVisionRequest(options);
assert.equal(priceRequest.messages[0].content[0].text,VISION_PROMPT);
assert.match(VISION_PROMPT,/exactly as printed on the package/);
assert.equal(enrichmentRequest.messages[0].content[0].text,ENRICHMENT_VISION_PROMPT);
const restored=structuredClone(enrichmentRequest);restored.messages[0].content[0].text=VISION_PROMPT;
assert.deepEqual(restored,priceRequest,'Only the enrichment instruction changes; image, model and settings do not');

// Replay a real improvement through the actual crop -> API -> validated row
// path; the fake provider price must not reach the servable observation.
const offer={id:'test:parachute',name:null,nameAr:null,imageUrl:'https://example.test/crop.jpg',price:10};
const originalOffer=structuredClone(offer),requests=[];
const parsed={name_en:'PARACHUTE COCONUT & CASTOR SHAMPOO 340ML',name_ar:'باراشوت شامبو بجوز الهند والخروع',brand:'PARACHUTE',package_size:'340ML',quantity:null,confidence:.98,current_price:999,old_price:1000};
const fetchImpl=async(url,init)=>{
 if(url===offer.imageUrl)return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/jpeg'}});
 assert.equal(url,MISTRAL_URL);requests.push(JSON.parse(init.body));
 return Response.json({model:'ministral-14b-2512',choices:[{message:{content:JSON.stringify(parsed)}}]});
};
const result=await enrichOffer(offer,{apiKey:'test-only',strategy:'vision-only',fetchImpl});
assert.equal(requests.length,1,'Caption-first enrichment still makes exactly one provider request');
assert.equal(requests[0].messages[0].content[0].text,ENRICHMENT_VISION_PROMPT);
assert.equal(result.name,parsed.name_en);assert.equal(result.size,'340ML');
assert.deepEqual(offer,originalOffer,'Commerce input, including its price, remains untouched');
for(const field of QUARANTINED_OBSERVATION_FIELDS)assert.ok(!Object.hasOwn(result.observation,field),field);
assert.equal(result.diagnostics.visionOutput.current_price,999,'Full price evidence is retained only in diagnostics');
assert.equal(result.diagnostics.ocrRequests,0);
console.log('Caption-first production reading, frozen price request, one-call budget and price quarantine passed.');

// Exercise the scheduler's actual Stage 1 boundary, which intentionally hides
// retailer names from the model request but must retain the authoritative price
// for selecting among differently priced quantities AFTER the model returns.
const source = {id:'test:two-cheese',image_url:offer.imageUrl,price:14.5,currency:'SAR',category:'cheese-creame',search_text:'نادك شرائح جبن 2 pc'};
let saved;
const deal = {name_en:"Nadec Cheese Slices Burger 10's",name_ar:'شرائح جبن برجر نادك',brand:'Nadec',package_size:'200g',quantity:"10's",confidence:.99,sale_options:[{current_price:14.5,package_size:'200g',sale_count:2,sale_count_text:'2 PC'}]};
const batch = await drainEnrichment({mistralKey:'test-only',enrichStore:{
  listDebris:async()=>[source],
  saveVisionOutcome:async outcome=>{saved=outcome;return {stored:1,verdictStored:true};},
}},{currentOn:'2026-10-22',limit:1,maxRateRetries:0,fetchImpl:async(url,init)=>url===offer.imageUrl
  ? new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/jpeg'}})
  : Response.json({choices:[{message:{content:JSON.stringify(deal)}}]})});
assert.equal(batch.failed,0,JSON.stringify(batch.errors));
assert.equal(saved.verificationCandidate.extraction_json._sale.status,'matched');
assert.equal(saved.verificationCandidate.extraction_json._sale.count,2);
assert.equal(saved.verificationCandidate.extraction_json._sale.price,14.5);
assert.equal(saved.verificationCandidate.structured_product.size.canonical.total,200,'Registry knowledge retains the net weight of one package, not ten cheese slices times that weight');
