import { SHOPPING_CATEGORIES, SHOPPING_DESCRIPTORS } from './shopping.js';
import { resolveBrand, BRAND_LEXICON } from './brands.js';
import { normalizeText } from '../matching.js';
import { cleanObservedArabic } from './observedArabic.js';

const words = value => String(value ?? '').match(/[\p{Script=Arabic}]+/gu) || [];
const key = value => normalizeText(value);
const vocabulary = [...SHOPPING_CATEGORIES, ...SHOPPING_DESCRIPTORS];
// Printed retail synonyms and grammatical forms, not product-specific fixes.
const captionVocabulary = [...vocabulary,
  {en:['rusk','rusks'],ar:'شابورة'},
  {en:['chopper'],ar:'قطاعة'},
  {en:['paratha','parathas'],ar:'براتا'},
  {en:['milk powder','powdered milk'],ar:'حليب بودرة'},
  {en:['white'],ar:'بيضاء'},
  {en:['slices','sliced','strips'],ar:'شرائح شرايح'},
  {en:['ice tea','iced tea'],ar:'شاي مثلج'},
  {en:['microwave'],ar:'مايكروويف'},
  {en:['fruit','fruits'],ar:'فواكه'},
  {en:['organic'],ar:'عضوية'},
  {en:['jelly','gummy'],ar:'جيلي'},
];
const known = new Set([
  ...vocabulary.flatMap(entry => words(entry.ar)),
  ...BRAND_LEXICON.flatMap(entry => words(entry.display_ar)),
].map(key));

// One insertion, deletion or substitution; no arbitrary fuzzy rewrites.
function oneEdit(a, b) {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i=0,j=0,edits=0;
  while(i<a.length && j<b.length) {
    if(a[i]===b[j]) { i++;j++;continue; }
    if(++edits>1)return false;
    if(a.length>=b.length)i++;
    if(b.length>=a.length)j++;
  }
  return edits+(i<a.length || j<b.length ? 1:0)===1;
}

// Repair an UNKNOWN word only when a unique dictionary spelling agrees with
// BOTH the independent retailer text and an exact English concept/brand.
// This preserves the observed sentence, rather than generating a new title.
export function repairArabicCaption({ nameAr, nameEn, brand, retailerText } = {}) {
  if (typeof nameAr !== 'string' || !retailerText) return nameAr;
  const source = new Set(words(retailerText).map(key));
  const english = ` ${String(nameEn ?? '').toLowerCase().replace(/[^a-z0-9]+/gu,' ').trim()} `;
  const candidates = new Map();
  const add = word => { const k=key(word);if(k.length>=4 && source.has(k))candidates.set(k,word); };
  for(const entry of captionVocabulary) {
    if(entry.en.some(phrase=>english.includes(` ${phrase.toLowerCase().replace(/[^a-z0-9]+/gu,' ').trim()} `))) {
      for(const word of words(entry.ar))add(word);
    }
  }
  for(const word of words(resolveBrand(brand).display_ar))add(word);
  return nameAr.replace(/[\p{Script=Arabic}]+/gu, word => {
    const k=key(word);
    if(k.length<4 || known.has(k) || source.has(k))return word;
    const matches=[...candidates].filter(([candidate])=>oneEdit(k,candidate));
    return matches.length===1 ? matches[0][1] : word;
  });
}

const units = new Set(['جرام','غرام','جم','غم','كيلو','كيلوجرام','لتر','مل','حبات','حبه','حبة','قطعه','قطع','حبتين','الكيلو']);
const furniture = new Set(['وفر','اعضاء','حصريا','خصم','ريال','الفرسان','جمع','الاميال','متنوع']);

export function retailerArabicCaption(english, text) {
  if (!english || !text) return null;
  const source = normalizeText(text);
  const en = normalizeText(english).match(/[a-z]+/g) || [];
  let at = -1;
  // A unique English TITLE PREFIX anchors the preceding Arabic caption.
  // Interior phrases such as Chicken Flavour may label a package elsewhere.
  for (let length = Math.min(6,en.length); length >= 2; length--) {
    const term = en.slice(0,length).join(' ');
    if (term.length < 8) continue;
    const found = source.indexOf(term);
    if (found >= 0 && source.indexOf(term,found+1) < 0) { at=found;break; }
  }
  if (at < 0) return null;
  const match = /([\p{Script=Arabic}\p{N}\s.,/×+()\-]|\bx\b)+$/u.exec(source.slice(0,at));
  if (!match) return null;
  const tokens = (match[0].match(/[\p{Script=Arabic}]+|\//gu) || [])
    .filter(word => !/^[٠-٩۰-۹]+$/u.test(word) && !units.has(word));
  const letters = tokens.filter(word=>word!=='/');
  if (letters.length < 2 || letters.length > 20 || letters.some(word=>furniture.has(word))) return null;
  return tokens.join(' ').replace(/^[\s/]+|[\s/]+$/gu,'');
}

// Display selection AFTER extraction. The original Vision observation and its
// provenance stay unchanged. Retailer OCR may replace the display caption only
// when it is anchored to the unique English title AND contains more independently
// confirmed product/brand words. A correct observed noun cannot lose to a typo.
export function selectArabicCaption({ nameAr, nameEn, brand, retailerText, retailerCategory } = {}) {
  const caption = retailerArabicCaption(nameEn,retailerText);
  if (!caption) return null;
  const english = ` ${String(nameEn ?? '').toLowerCase().replace(/[^a-z0-9]+/gu,' ').trim()} `;
  const category = ` ${String(retailerCategory ?? '').toLowerCase().replace(/[^a-z0-9]+/gu,' ').trim()} `;
  const expected = new Set();
  for (const entry of captionVocabulary) {
    if (entry.en.some(phrase=> {
      const term = ` ${phrase.toLowerCase().replace(/[^a-z0-9]+/gu,' ').trim()} `;
      return english.includes(term) || category.includes(term);
    })) {
      for (const word of words(entry.ar)) expected.add(key(word));
    }
  }
  const brandAr = resolveBrand(brand).display_ar;
  for (const word of words(brandAr)) expected.add(key(word));
  const support = value => new Set(words(value).map(key).filter(word=>expected.has(word))).size;
  if (support(caption) <= support(nameAr)) return null;
  const observedWords = new Set(words(nameAr).map(key));
  const tokens = caption.split(' ');
  const first = tokens.findIndex(word=>expected.has(key(word)) || observedWords.has(key(word)));
  const selected = first > 0 ? tokens.slice(first).join(' ') : caption;
  const name = cleanObservedArabic(selected,{brandAr});
  return name ? {name,source:'retailer_caption',version:'arabic-caption-v1',caption} : null;
}
