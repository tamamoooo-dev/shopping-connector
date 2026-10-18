import {readFileSync,writeFileSync} from 'node:fs';
import {truth} from './truth.mjs';
import {compatibleVisionIdentity} from '../../src/storage/visionVerificationStore.js';
import {validateVisionOutput} from '../../src/offers/smartExtraction.js';
import {applyUnitPrice} from '../../src/offers/enrich.js';
import {quantityTruth} from './quantity-truth.mjs';
import {confirmationTruth} from './confirmation-truth.mjs';
const dir=new URL('./',import.meta.url),phase=process.argv[2]||'development';
const records=readFileSync(new URL(`reads-${phase}.jsonl`,dir),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
// Development annotation correction after original-crop close review: no Arabic
// title in 20, no legible English product title in 29/30. A null is appropriate,
// not a reading failure. Applied equally to every method; before opening holdout replies.
const noTitle={en:new Set([29,30]),ar:new Set([20])};
const norm=s=>String(s??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[أإآٱ]/g,'ا').replace(/[ى]/g,'ي').replace(/[ة]/g,'ه').replace(/[\u064b-\u065f\u0670ـ]/g,'').replace(/[٠-٩]/g,x=>'٠١٢٣٤٥٦٧٨٩'.indexOf(x));
// Same visible brand in either script is valid. Frozen before held-out reads.
const brandArabic={1:'الكبير',2:'دو',3:'باراشوت',4:'دايو',7:'كويكر',8:'غلوريا|جلوريا',9:'عافيه',10:'سكيتلز',11:'هيمالايا',12:'صانسيلك|سنسيلك',13:'رينجو',14:'هجيز',15:'مونتانا',16:'سيارا',18:'بنده',23:'الوليد',25:'الصافي',26:'الفله',28:'نادك',30:'جيباس',31:'الجميل',32:'نستله',33:'بوك',34:'عافيه',36:'هيد.*شولدر',39:'غلوريا|جلوريا',40:'راسخ',41:'سن.*توب',42:'نسكافيه',43:'بيربل',44:'سيلو',45:'اكتيفيا',46:'موج|ماوج',47:'سنسوداين',48:'بيتي.*كروكر',49:'قودي',50:'اونو',51:'بريف',52:'قودي',53:'نيو.*قولدن|جولدن',54:'اوسكار',55:'بنجابي.*محل',56:'بلانيت',57:'تيفاني',58:'كوكلين',59:'اكسلنت',60:'امريكانا',61:'بوك',62:'فرشلي',63:'هناء',64:'تاج.*الهند'};
const match=(s,p)=>new RegExp(norm(p),'iu').test(norm(s));
const sizeMatch=(s,p)=>p.split('&').every(term=>new RegExp(`(?<![0-9])(?:${term})(?![0-9])`,'iu').test(norm(s).replaceAll('×','x')));
const scored=records.map(r=>{
 const t=[...truth,...confirmationTruth].find(x=>x.index===r.index),p=r.parsed||{},final=r.row;
 const rawEn=t.en==null||noTitle.en.has(r.index)?null:match(p.name_en,t.en),rawAr=noTitle.ar.has(r.index)?null:match(p.name_ar,t.ar),en=t.en==null||noTitle.en.has(r.index)?null:match(final.name,t.en),ar=noTitle.ar.has(r.index)?null:match(final.name_ar,t.ar);
 const brand=t.brand==null?null:(match(p.brand,t.brand)||(brandArabic[t.index]?match(p.brand,brandArabic[t.index]):false));
 const size=t.size==null?null:sizeMatch(p.package_size,t.size);
 const quantity=t.size==null?null:sizeMatch([p.package_size,p.quantity].filter(Boolean).join(' '),t.size);
 const qty=quantityTruth.find(x=>x.index===r.index)||{index:t.index,unit:t.unit,reference:t.reference,excluded:t.reference?null:'Non-grocery or alternative quantities'};
 // Isolate the vision contribution: no pre-existing retailer text or names.
 const offer={name:final.name,nameAr:final.name_ar,price:t.price};
 applyUnitPrice(offer,{e_size:final.size,e_unit:p.unit},true);
 const expectedUnit=qty.unit==='pcs'?'piece':qty.unit;
 const denominator=qty.excluded?'excluded':!offer.unitPrice?'withheld':offer.unitPrice.unit===expectedUnit&&Math.abs(offer.unitPrice.value-t.price/qty.reference)/(t.price/qty.reference)<.03?'correct':'wrong';
 return {index:r.index,method:r.method,rawEn,rawAr,en,ar,brand,size,quantity,price:p.current_price===t.price,denominator,unitPrice:offer.unitPrice,expectedQuantity:qty,ms:r.ms+(r.first?.ms||0),calls:r.first?2:1,tokens:(r.usage?.total_tokens||0)+(r.first?.usage?.total_tokens||0),input:(r.usage?.prompt_tokens||0)+(r.first?.usage?.prompt_tokens||0),output:(r.usage?.completion_tokens||0)+(r.first?.usage?.completion_tokens||0),raw:p,final:{name:final.name,name_ar:final.name_ar,brand:final.brand,size:final.size},validation:validateVisionOutput(p)};
});
const aggregate=rows=>({n:rows.length,rawSearch:rows.reduce((n,r)=>n+r.rawEn+r.rawAr,0),validatedSearch:rows.reduce((n,r)=>n+r.en+r.ar,0),brandCorrect:rows.filter(r=>r.brand===true).length,brandTotal:rows.filter(r=>r.brand!==null).length,sizeComplete:rows.filter(r=>r.size===true).length,sizeTotal:rows.filter(r=>r.size!==null).length,quantityComplete:rows.filter(r=>r.quantity===true).length,priceCorrect:rows.filter(r=>r.price).length,calls:rows.reduce((n,r)=>n+r.calls,0),tokens:rows.reduce((n,r)=>n+r.tokens,0),meanMs:Math.round(rows.reduce((n,r)=>n+r.ms,0)/rows.length)});
const summary=Object.fromEntries([...new Set(scored.map(r=>r.method))].map(method=>[method,aggregate(scored.filter(r=>r.method===method))]));
for(const method of Object.keys(summary)){
 const rows=scored.filter(r=>r.method===method),s=summary[method];
 s.searchTotal=rows.reduce((n,r)=>n+(r.en!==null)+(r.ar!==null),0);
 s.englishCorrect=rows.filter(r=>r.en===true).length;s.englishTotal=rows.filter(r=>r.en!==null).length;
 s.arabicCorrect=rows.filter(r=>r.ar===true).length;s.arabicTotal=rows.filter(r=>r.ar!==null).length;
 s.priceWrong=rows.filter(r=>!r.price&&r.raw.current_price!=null).length;s.priceMissing=rows.filter(r=>r.raw.current_price==null).length;
 s.brandWrong=rows.filter(r=>r.brand===false&&r.raw.brand).length;s.brandMissing=rows.filter(r=>r.brand===false&&!r.raw.brand).length;
 s.unsupportedLanguageTitles=rows.reduce((n,r)=>n+(r.en===null&&r.raw.name_en?1:0)+(r.ar===null&&r.raw.name_ar?1:0),0);
 s.validationRejected=rows.reduce((n,r)=>n+r.validation.rejectedFields.length,0);
 s.validationLostCorrectProbes=rows.reduce((n,r)=>n+(r.rawEn&&!r.en?1:0)+(r.rawAr&&!r.ar?1:0),0);
 s.denominators=Object.fromEntries(['correct','wrong','withheld','excluded'].map(status=>[status,rows.filter(r=>r.denominator===status).length]));
}
const pairs=scored.filter(r=>r.method==='baseline').map(a=>{
 const b=records.find(r=>r.index===a.index&&r.method==='repeat');if(!b)return null;
 const original=records.find(r=>r.index===a.index&&r.method==='baseline');const accepted=compatibleVisionIdentity(original.row,b.row);
 return {index:a.index,accepted,correctProbes:a.en+a.ar,priceCorrect:a.price,brandCorrect:a.brand,rawName:original.row.name,repeatName:b.row.name};
}).filter(Boolean);
const doubleVerification={pairs:pairs.length,accepted:pairs.filter(p=>p.accepted).length,retainedSearchProbes:pairs.reduce((n,p)=>n+(p.accepted?p.correctProbes:0),0),withheldCorrectProbes:pairs.reduce((n,p)=>n+(!p.accepted?p.correctProbes:0),0),wrongPricesAmongAccepted:pairs.filter(p=>p.accepted&&!p.priceCorrect).length,wrongBrandsAmongAccepted:pairs.filter(p=>p.accepted&&p.brandCorrect===false).length,pairsDetail:pairs};
const result={phase,summary,doubleVerification,scored};
writeFileSync(new URL(`results-${phase}.json`,dir),JSON.stringify(result,null,2));console.log(JSON.stringify({phase,summary,doubleVerification:{...doubleVerification,pairsDetail:undefined}},null,2));
