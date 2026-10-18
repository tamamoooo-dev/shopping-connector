import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {
 buildVisionRequest,buildEnrichmentVisionRequest,enrichOffer,MISTRAL_URL,
 VISION_PROMPT,ENRICHMENT_VISION_PROMPT,ENRICHMENT_READING_BASELINE,
 QUARANTINED_OBSERVATION_FIELDS,
} from './enrich.js';

const frozen=JSON.parse(readFileSync(new URL('../../benchmarks/vision-reading-2026-10-18/protocol-confirmation.json',import.meta.url),'utf8'));
assert.equal(ENRICHMENT_VISION_PROMPT,frozen.prompts['caption-line']);
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
