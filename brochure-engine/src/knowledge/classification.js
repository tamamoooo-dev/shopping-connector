import { canonicalAisle, refineAisle } from '../browse/mapping.js';
import { AISLE_BY_ID, DEPARTMENT_BY_ID, OTHER_AISLE } from '../browse/taxonomy.js';
import { SHOPPING_CATEGORIES, normalizeShoppingText, resolveCategory } from '../lexicon/shopping.js';
import { resolveBrand } from '../lexicon/brands.js';
import { ARCHIVE_CLASSIFICATIONS, ARCHIVE_BRAND_AISLES } from './archiveClassificationData.js';
import { CLASSIFICATION_ARABIC, CLASSIFICATION_ENGLISH } from './classificationTerms.js';
import { TITLE_TERMS } from '../lexicon/productTitleDictionary.js';
import { IMAGE_CLASSIFICATION_REVIEWS } from './imageClassificationReviews.js';

export const CLASSIFICATION_VERSION='archive-classification-v1';
export function storedProductClassification(row){
  try{
    const title=typeof row?.e_product_title==='string'?JSON.parse(row.e_product_title):row?.e_product_title;
    const value=title?.classification;
    return title?.version==='dictionary-title-v1'&&value?.version===CLASSIFICATION_VERSION&&value.status==='classified'&&AISLE_BY_ID.has(value.aisle)?value:null;
  }catch{return null;}
}
export const classificationKey=value=>normalizeShoppingText(String(value||''));
const arabicKey=value=>classificationKey(value).split(' ').map(w=>w.replace(/^ال(?=[\u0621-\u064a]{3})/u,'')).join(' ');
const arabicTerms=SHOPPING_CATEGORIES.map(c=>({category:c,phrase:arabicKey(c.ar)}))
  .filter(c=>c.phrase.length>2).sort((a,b)=>b.phrase.split(' ').length-a.phrase.split(' ').length);
export function arabicCategory(nameAr,brand) {
  let text=arabicKey(nameAr);
  const b=arabicKey(resolveBrand(brand).display_ar);
  if(b)text=` ${text} `.split(` ${b} `).join(' ').trim();
  return arabicTerms.find(c=>` ${text} `.includes(` ${c.phrase} `))?.category||null;
}
const arabicRules=CLASSIFICATION_ARABIC.flatMap(([aisle,phrases])=>phrases.map(phrase=>({aisle,phrase:arabicKey(phrase)})))
  .sort((a,b)=>b.phrase.split(' ').length-a.phrase.split(' ').length);
function broadCategory(name,nameAr){
  const ar=` ${arabicKey(nameAr)} `;
  const rule=arabicRules.find(r=>ar.includes(` ${r.phrase} `)||ar.includes(` و${r.phrase} `));
  if(rule)return rule.aisle;
  const en=` ${classificationKey(name+' '+nameAr).normalize('NFKD').replace(/[\u0300-\u036f]/g,'')} `;
  for(const [aisle,phrases] of CLASSIFICATION_ENGLISH)if(phrases.some(phrase=>en.includes(` ${classificationKey(phrase)} `)))return aisle;
  if(/\b\d+\s*(?:gb|tb)\b|\b(?:4g|5g)\b/i.test(name+' '+nameAr))return 'electronics';
  return null;
}
function titleCategory(name){
  const text=` ${classificationKey(name)} `;
  const term=TITLE_TERMS.filter(([phrase])=>text.includes(` ${phrase} `)).sort((a,b)=>b[0].length-a[0].length)[0];
  if(!term)return null;
  const ar=arabicCategory(term[1]);
  return ar?.aisle&&ar.aisle!==OTHER_AISLE?ar.aisle:broadCategory('',term[1]);
}

export function classifyArchivedProduct(input={},data={names:ARCHIVE_CLASSIFICATIONS,brands:ARCHIVE_BRAND_AISLES}) {
  const imageReview=IMAGE_CLASSIFICATION_REVIEWS[input.id];
  if(imageReview?.status==='non_product')return {version:CLASSIFICATION_VERSION,aisle:'non-product',department:'review-required',
    category:{id:'non-product',en:'Not a product',ar:'صورة لا تحتوي منتجًا'},source:'image_review',reviewRequired:false,status:'non_product',
    evidence:{image:imageReview.image,reason:imageReview.reason},labelAr:'صورة لا تحتوي منتجًا',departmentAr:'مراجعة المصدر'};
  const name=input.nameEn ?? input.name ?? '',nameAr=input.nameAr ?? input.name_ar ?? '';
  const source=input.source||'d4d',provider=input.retailer_category ?? input.category;
  const mapped=canonicalAisle(source,provider);
  const lexical=resolveCategory(name || String(nameAr).replace(/[\u0600-\u06ff]+/gu,' ')),arabic=(!lexical||lexical.aisle===OTHER_AISLE)?arabicCategory(nameAr,input.brand):null;
  const broad=mapped===OTHER_AISLE?broadCategory(name,nameAr):null;
  const titleAisle=mapped===OTHER_AISLE&&(!lexical?.aisle||lexical.aisle===OTHER_AISLE)?titleCategory(name):null;
  const exact=data.names?.['en:'+classificationKey(name)] || data.names?.['ar:'+classificationKey(nameAr)];
  let aisle=mapped,method='retailer_category',evidence=null;
  const reviewed=IMAGE_CLASSIFICATION_REVIEWS[input.id];
  if(reviewed){aisle=reviewed.aisle;method='image_review';evidence={image:reviewed.image,reviewedAt:reviewed.reviewedAt};}
  if(aisle===OTHER_AISLE){
    if(exact){aisle=exact.aisle;method='archive_consensus';evidence=exact.evidence;}
    else if(lexical?.aisle&&lexical.aisle!==OTHER_AISLE&&AISLE_BY_ID.has(lexical.aisle)){aisle=lexical.aisle;method='english_dictionary';}
    else if(arabic?.aisle&&arabic.aisle!==OTHER_AISLE&&AISLE_BY_ID.has(arabic.aisle)){aisle=arabic.aisle;method='arabic_dictionary';}
    else if(titleAisle){aisle=titleAisle;method='product_title_dictionary';}
    else if(broad){aisle=broad;method='explicit_category_terms';}
    else {
      const brand=resolveBrand(input.brand);
      const supported=data.brands?.[brand.brand_id];
      if(supported){aisle=supported.aisle;method='brand_archive_consensus';evidence=supported.evidence;}
    }
  }
  aisle=refineAisle(aisle,{name,name_ar:nameAr});
  const place=AISLE_BY_ID.get(aisle);
  const pending=aisle===OTHER_AISLE;
  const type=lexical||arabic;
  return {version:CLASSIFICATION_VERSION,aisle:pending?'review-required':aisle,
    department:pending?'review-required':place.dept,
    category:!pending&&type?.aisle===aisle?{id:type.id,en:Array.isArray(type.en)?type.en[0]:type.en,ar:type.ar}:
      !pending?{id:'aisle:'+aisle,en:place.en,ar:place.ar}:{id:'review-required',en:'Classification review required',ar:'بانتظار تحديد الصنف'},
    source:pending?'review_required':method,reviewRequired:pending||method==='brand_archive_consensus',
    status:pending?'pending_review':'classified',evidence,
    labelAr:pending?'بانتظار تحديد الصنف':place.ar,
    departmentAr:pending?'مراجعة التصنيف':DEPARTMENT_BY_ID.get(place.dept)?.ar};
}
