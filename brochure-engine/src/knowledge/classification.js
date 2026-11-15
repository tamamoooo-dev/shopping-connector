import { canonicalAisle, refineAisle, FRESH_GUARD_TERMS } from '../browse/mapping.js';
import { AISLE_BY_ID, DEPARTMENT_BY_ID, OTHER_AISLE } from '../browse/taxonomy.js';
import { SHOPPING_CATEGORIES, normalizeShoppingText, resolveCategory, isFlavorCategory } from '../lexicon/shopping.js';
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
// The explicit English product phrases alone (classificationTerms.js).
function explicitEnglishCategory(name,nameAr){
  const en=` ${classificationKey(name+' '+nameAr).normalize('NFKD').replace(/[\u0300-\u036f]/g,'')} `;
  for(const [aisle,phrases] of CLASSIFICATION_ENGLISH)if(phrases.some(phrase=>en.includes(` ${classificationKey(phrase)} `)))return aisle;
  return null;
}
function broadCategory(name,nameAr){
  const ar=` ${arabicKey(nameAr)} `;
  const rule=arabicRules.find(r=>ar.includes(` ${r.phrase} `)||ar.includes(` و${r.phrase} `));
  if(rule)return rule.aisle;
  const explicit=explicitEnglishCategory(name,nameAr);
  if(explicit)return explicit;
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

// --- a FRESH aisle guessed from a word in the name ------------------------------
// With no retailer category the name is the only evidence, and the words for
// fresh food are also flavours and ingredients: "Biorepair Kids Strawberry" is
// a toothpaste, "Indomie Chicken" is noodles, "Meat Grinder" is a machine. On
// 2026-11-15, 110 of the 688 live Fresh cards were placed by a name word and
// about 60 of those were not fresh food. A fresh guess is therefore CHALLENGED
// by what else is known, and when the challenge wins the product goes where
// that evidence points, or to review (the More department): refused, never
// guessed. A guess with nothing against it stands as before.
//
//   1. an explicit product phrase in the name for an aisle outside fresh and
//      frozen ("meat grinder", "noodle", "corned beef") names the product;
//   2. the brand's archive consensus is another department (Sheba is pet
//      food, Indomie is noodles): the brand names the product;
//   3. a flavour-capable word (a fruit, a vegetable, chicken, beef) beside a
//      brand: the word is the flavour. Kept when the brand's consensus is
//      fresh (Tanmiah), when the name carries a frozen mark (the frozen
//      refinement places it), or when a meat name says it is fresh, names
//      a butcher's cut, or is nothing but the brand and the meat. Smoked
//      meat goes to the deli.
const deptOf=aisle=>AISLE_BY_ID.get(aisle)?.dept||null;
const isFreshAisle=aisle=>deptOf(aisle)==='fresh';
const FRESH_MEAT_AISLES=new Set(['chicken-poultry','meat','fish']);
const SAYS_FRESH=new RegExp(['fresh','chilled','مبرد',...FRESH_GUARD_TERMS].join('|'),'i');
// A butcher's cut in the name says the product is the meat itself ("Al Abeer
// Beef Bone-in"), and so does a name that is nothing but the brand and the
// meat ("Urussa Chicken"). Smoked or sliced-for-breakfast meat is the deli's.
const BUTCHER_CUT=/\b(?:bone[- ]?in|boneless|whole|breasts?|thighs?|drumsticks?|legs?|wings?|minced?|fillets?|steaks?|ribs?|shoulder|liver|gizzards?)\b|بالعظم|بدون عظم|صدور|صدر|افخاذ|أفخاذ|كامل|مفروم|فيليه|ستيك|كبد|قوانص/i;
const DELI_FORM=/\bsmoked\b|\bbreakfast slices\b|مدخن/i;
const MEAT_WORDS=new Set(['chicken','beef','meat','lamb','mutton','veal','fish','fresh']);
const isBareMeatName=(name,brand)=>{
  const brandWords=new Set(classificationKey(brand).split(' '));
  const rest=classificationKey(name).split(' ').filter(w=>w&&!brandWords.has(w)&&!/^\d/.test(w));
  return rest.length>0&&rest.every(w=>MEAT_WORDS.has(w));
};
function freshGuessChallenge({name,nameAr,brand,data}){
  const brandKey=classificationKey(brand),resolved=brandKey?resolveBrand(brand):null;
  const consensus=resolved?.brand_id?data.brands?.[resolved.brand_id]:null;
  // A brand counts when the lexicon knows it, or when it stands beside a name
  // that was read (in the name or apart from it). A "brand" that is itself a
  // product word, or the only English on a card with no English name (the
  // reader put the product there: "MUSKMELON"), is no evidence.
  const hasBrand=!!brandKey&&(resolved?.status==='resolved'||(!resolveCategory(brand)
    &&(!!classificationKey(name)||` ${classificationKey(nameAr)} `.includes(` ${brandKey} `))));
  const explicit=explicitEnglishCategory(name,nameAr);
  const text=`${name} ${nameAr}`;
  return category=>{
    if(explicit&&!['fresh','frozen'].includes(deptOf(explicit)))return {aisle:explicit,method:'explicit_category_terms',evidence:null};
    if(consensus&&AISLE_BY_ID.has(consensus.aisle)&&!isFreshAisle(consensus.aisle))
      return {aisle:consensus.aisle,method:'brand_archive_consensus',evidence:consensus.evidence};
    if(!hasBrand||consensus||!isFlavorCategory(category))return null;
    if(refineAisle(category.aisle,{name,name_ar:nameAr})!==category.aisle)return null;
    if(FRESH_MEAT_AISLES.has(category.aisle)){
      if(SAYS_FRESH.test(text))return null;
      if(DELI_FORM.test(text))return category.aisle==='deli'?null:{aisle:'deli',method:'explicit_category_terms',evidence:null};
      if(BUTCHER_CUT.test(text)||isBareMeatName(name,brand))return null;
    }
    return {aisle:null,method:null,evidence:null};
  };
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
  let type=lexical||arabic,freshGuessLost=false;
  if(aisle===OTHER_AISLE){
    const valid=c=>(c?.aisle&&c.aisle!==OTHER_AISLE&&AISLE_BY_ID.has(c.aisle)?c:null);
    // One challenge per product: once a fresh guess loses, no later name-word
    // step may put the product back in Fresh.
    const challenge=freshGuessChallenge({name,nameAr,brand:input.brand,data});
    let lost=null;
    const stands=c=>{
      if(!isFreshAisle(c.aisle))return true;
      if(!lost)lost=challenge(c);
      return !lost;
    };
    const english=valid(lexical);
    if(exact){aisle=exact.aisle;method='archive_consensus';evidence=exact.evidence;}
    else if(english&&stands(english)){aisle=english.aisle;method='english_dictionary';}
    else {
      // With an English guess the Arabic and title readings were never made
      // (it used to end the search); they are made now that it lost.
      const arabicEntry=valid(english?arabicCategory(nameAr,input.brand):arabic);
      const arabicGuess=arabicEntry&&{...arabicEntry,matched_phrase:classificationKey(arabicEntry.en?.[0])};
      const title=english?titleCategory(name):titleAisle;
      // Where the challenge itself names the product (an explicit phrase, the
      // brand's consensus), that outranks every later name-word step: canned
      // "chopped tomatoes in tomato juice" is a can, not a juice.
      const steps=[['arabic_dictionary',arabicGuess],['product_title_dictionary',title&&{aisle:title}],['explicit_category_terms',broad&&{aisle:broad}]];
      let placed=false;
      const byChallenge=()=>{if(!lost?.aisle)return false;aisle=lost.aisle;method=lost.method;evidence=lost.evidence;return true;};
      placed=byChallenge();
      for(const [how,guess] of steps){
        if(placed)break;
        if(!guess)continue;
        if(stands(guess)){aisle=guess.aisle;method=how;if(how==='arabic_dictionary')type=arabicEntry;placed=true;}
        else placed=byChallenge();
      }
      if(!placed){
        const brand=resolveBrand(input.brand);
        const supported=data.brands?.[brand.brand_id];
        if(supported&&!(lost&&isFreshAisle(supported.aisle))){aisle=supported.aisle;method='brand_archive_consensus';evidence=supported.evidence;}
      }
    }
    freshGuessLost=!!lost;
  }
  aisle=refineAisle(aisle,{name,name_ar:nameAr});
  const place=AISLE_BY_ID.get(aisle);
  const pending=aisle===OTHER_AISLE;
  return {version:CLASSIFICATION_VERSION,aisle:pending?'review-required':aisle,
    department:pending?'review-required':place.dept,
    category:!pending&&type?.aisle===aisle?{id:type.id,en:Array.isArray(type.en)?type.en[0]:type.en,ar:type.ar}:
      !pending?{id:'aisle:'+aisle,en:place.en,ar:place.ar}:{id:'review-required',en:'Classification review required',ar:'بانتظار تحديد الصنف'},
    source:pending?'review_required':method,reviewRequired:pending||method==='brand_archive_consensus',
    status:pending?'pending_review':'classified',evidence,
    labelAr:pending?'بانتظار تحديد الصنف':place.ar,
    departmentAr:pending?'مراجعة التصنيف':DEPARTMENT_BY_ID.get(place.dept)?.ar,
    // Present only when a fresh guess from a name word lost its challenge: it
    // says why a product with "strawberry" in its name is not under fruits.
    ...(freshGuessLost?{challenge:'fresh_name_word'}:{})};
}
