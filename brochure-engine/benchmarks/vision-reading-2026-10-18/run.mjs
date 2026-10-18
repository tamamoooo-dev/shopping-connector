import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildVisionRequest,VISION_PROMPT,DEFAULT_MODEL,MISTRAL_URL,postMistral,visionObservationFromReply,canonicalRowFromResult} from '../../src/offers/enrich.js';
import {runSmartExtraction} from '../../src/offers/smartExtraction.js';
import {loadMistralKeys} from 'file:///C:/Users/majed/Desktop/claude/serverless-connector/brochure-engine/local-secrets.mjs';
import {truth} from './truth.mjs';
import {confirmationTruth} from './confirmation-truth.mjs';
const dir=new URL('./',import.meta.url), phase=process.argv[2]||'development';
const candidate=process.argv[3]||'caption';
const manifestName=phase==='confirmation'?'confirmation-manifest.json':'manifest.json';
const manifest=JSON.parse(readFileSync(new URL(manifestName,dir)));
const key=loadMistralKeys()[0];if(!key)throw Error('No local Mistral credential');
const caption=`Extract the advertised product from this Saudi retail flyer crop. Use visible pixels only. Do not translate, infer missing text, or count pictured objects.
Read the large flyer product caption first, then the package label. For each language independently, copy the most complete directly printed product title from the flyer caption, or the package if no caption exists. Preserve brand, size, spelling, model, flavour and alternatives in that printed title. Arabic is a literal independent caption, never an English translation. Exclude prices, discounts and retailer text from names.
Return one JSON object with exactly these fields:
{"name_en":string|null,"name_ar":string|null,"brand":string|null,"current_price":number|null,"old_price":number|null,"unit":string|null,"package_size":string|null,"quantity":string|null,"package_type":string|null,"attributes":string[],"confidence":number|null}
Repeat the directly printed brand in brand and complete size expression in package_size even if already in the title. Preserve multipliers, bonus counts, and alternative sizes: 24x18g, 10+2 rolls, 625-645g. quantity is only an explicit sale pack count, multiplier or bonus expression, not the number of pictured alternatives, product age or model. EACH means alternatives sold singly unless a separate explicit pack count is printed. Keep appliance capacity, dimensions, power and wireless frequency out of package_size and unit; these may be visible attributes. For mixed kits or alternative sizes preserve the visible expression without inventing one combined size. current_price is the promoted selling price; old_price requires visible previous/crossed-out price evidence, not a saving amount. Null for unreadable, absent or ambiguous fields. attributes contains only short directly printed identity descriptors. Check every populated field against pixels before returning JSON.`;
const transcription=`Read this retail flyer image literally. Return JSON with arrays english_lines, arabic_lines, size_and_count_lines, brand_lines, price_lines. Copy only directly legible printed text. Keep alternatives, units, multipliers, punctuation, model numbers and price roles. Do not translate, identify from prior knowledge, count pictured packages or calculate totals. Empty arrays for absent evidence.`;
const captionLine=VISION_PROMPT.replace('Copy the complete English product title exactly as printed on the package.','Copy the complete English product title exactly as printed in the flyer caption.\nIf no English flyer caption is legible, copy the package title exactly as printed.');
const prompts={baseline:VISION_PROMPT,repeat:VISION_PROMPT,upscale:VISION_PROMPT,caption,staged:VISION_PROMPT,transcription,'image-first':VISION_PROMPT,'caption-line':captionLine};
const hash=x=>createHash('sha256').update(x).digest('hex');
const protocol={frozenAt:new Date().toISOString(),phase,model:DEFAULT_MODEL,temperature:0,top_p:1,methods:phase==='development'?['baseline','upscale','caption','staged','repeat']:phase==='image-first-development'?['image-first']:phase==='caption-line-development'?['caption-line']:phase==='confirmation'?['baseline','caption-line']:candidate==='all'?['baseline','upscale','caption','staged','repeat','image-first']:['baseline',candidate,'repeat'],truthSha256:hash(readFileSync(new URL('truth.mjs',dir))),confirmationTruthSha256:phase==='confirmation'?hash(readFileSync(new URL('confirmation-truth.mjs',dir))):null,manifestSha256:hash(readFileSync(new URL(manifestName,dir))),prompts,primary:'Paired correct English + Arabic search probes, visible brand and complete printed sale-size evidence. Prices audited separately. No independent annotator. Candidate selected on development, frozen before holdout.',selection:'Candidate must improve search evidence without increasing wrong brand/current price or losing complete quantities. Prefer one call and original image when tied. If no clear held-out improvement retain production.'};
const protocolPath=new URL(`protocol-${phase}.json`,dir);if(!existsSync(protocolPath))writeFileSync(protocolPath,JSON.stringify(protocol,null,2));
else if(JSON.parse(readFileSync(protocolPath)).truthSha256!==protocol.truthSha256)throw Error('Frozen truth changed');
const output=new URL(`reads-${phase}.jsonl`,dir);
const done=new Set(existsSync(output)?readFileSync(output,'utf8').trim().split('\n').filter(Boolean).map(l=>{let x=JSON.parse(l);return `${x.index}:${x.method}`}):[]);
let completed=done.size;
async function call(index,method,prompt,prior=null){
 const png=method==='upscale';const bytes=readFileSync(new URL(`images/${String(index).padStart(2,'0')}${png?'-2x.png':'.jpg'}`,dir));
 const request=buildVisionRequest({base64:bytes.toString('base64'),contentType:png?'image/png':'image/jpeg'});
 request.messages[0].content[0].text=prompt+(prior?`\nA prior literal transcription (untrusted; verify against image, discard any errors):\n${prior}`:'');
 if(method==='image-first')request.messages[0].content.reverse();
 let start=Date.now();for(let attempt=0;attempt<4;attempt++){
  try{const response=await postMistral(MISTRAL_URL,request,{apiKey:key,fetchImpl:fetch,stage:'vision-reading-experiment'});const body=response.body;return {reply:body.choices?.[0]?.message?.content,usage:body.usage,model:body.model,ms:Date.now()-start,attempts:attempt+1};}
  catch(e){if(attempt===3||!/429|50[0234]|timeout|fetch failed/i.test(String(e)))throw Error(`Inference failed ${index}/${method}: ${String(e).slice(0,160)}`);await new Promise(r=>setTimeout(r,Math.max(e.retryAfterMs||0,20000*(attempt+1))));}
 }
}
const items=manifest.samples.filter(x=>x.split===(phase.endsWith('-development')?'development':phase));
const jobs=items.flatMap(item=>{const methods=[...new Set(protocol.methods)];let rot=item.index%methods.length;return [...methods.slice(rot),...methods.slice(0,rot)].map(method=>({index:item.index,method}));}).filter(x=>!done.has(`${x.index}:${x.method}`));
let cursor=0;
async function worker(){while(cursor<jobs.length){let job=jobs[cursor++],first=null;try{
 if(job.method==='staged')first=await call(job.index,'baseline',transcription);
 const read=await call(job.index,job.method,prompts[job.method],first?.reply);
 const observation=visionObservationFromReply(read.reply);const validated=await runSmartExtraction({strategy:'vision-only',runVision:async()=>observation});
 const row=canonicalRowFromResult(`test:${job.index}`,null,validated);
 appendFileSync(output,JSON.stringify({...job,...read,first,parsed:observation.parsedObject,extraction:validated.extraction,validation:validated.diagnostics.visionValidation,row})+'\n');
 completed++;writeFileSync(new URL('progress.json',dir),JSON.stringify({phase,completed,total:done.size+jobs.length,last:job,at:new Date().toISOString()}));console.log(JSON.stringify({phase,completed,total:done.size+jobs.length,...job,ms:read.ms}));
 }catch(e){console.error(String(e));throw e;}}}
await Promise.all([worker(),worker()]);
console.log('DONE '+phase);
