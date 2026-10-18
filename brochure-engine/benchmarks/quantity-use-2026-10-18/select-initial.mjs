import {readFileSync,writeFileSync} from 'node:fs';
const dir=new URL('./',import.meta.url),data=JSON.parse(readFileSync(new URL('naive-changes.json',dir)));
// The INITIAL screen, frozen before adding the bilingual-sale wording guard.
// Keep it separate so replay still includes the package-internal-count errors
// that original-image review exposed and the final policy declines.
const initial=(value,text)=>{
 if(typeof value!=='string')return false;
 const compact=value.trim().toUpperCase().replaceAll(' ','');
 return /^[2-9]PCS?$/.test(compact)&&new RegExp(`[^0-9]${compact[0]} ?pcs?[^a-z]`,'i').test(` ${text||''} `);
};
const eligible=data.changed.filter(r=>initial(r.count,r.text)&&r.before?.unit!=='piece'&&r.before&&r.after?.unit===r.before.unit&&r.quantity.pack>1);
writeFileSync(new URL('eligible.json',dir),JSON.stringify(eligible,null,2));console.log({initialReviewCandidates:eligible.length});
