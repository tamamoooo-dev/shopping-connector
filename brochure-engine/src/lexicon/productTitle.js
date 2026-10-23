import { BRAND_LEXICON, resolveBrand } from './brands.js';
import { buildStructuredProduct } from './structuredProduct.js';
import { TITLE_TERMS, TITLE_DETAILS, TITLE_VARIANTS } from './productTitleDictionary.js';
import { normalizeShoppingText, resolveDescriptors, resolveCategory } from './shopping.js';
import { BRANDS } from '../browse/brands.js';
import { AISLE_BY_ID } from '../browse/taxonomy.js';

export const PRODUCT_TITLE_VERSION = 'dictionary-title-v1';
const norm = value => normalizeShoppingText(String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
const includesPhrase = (value, phrase) => ` ${value} `.includes(` ${phrase} `);
const arabicKey = s => String(s ?? '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[\u064b-\u065fـ]/g, '');
const englishBrands = BRAND_LEXICON.filter(brand => !brand.typedOnly).flatMap(brand => brand.aliases
  .filter(alias => /[a-z]/i.test(alias)).map(alias => ({ brand, phrase: norm(alias) })))
  .sort((a, b) => b.phrase.length - a.phrase.length);
const compactBrands=new Map(), aliasesByBrand=new Map();
const brandDepartments=new Map(BRANDS.filter(b=>b.depts).map(b=>[b.slug,b.depts]));
for (const entry of englishBrands) {
  const compact=entry.phrase.replace(/\s+/gu,'');
  if (!compactBrands.has(compact)) compactBrands.set(compact,entry);
  const aliases=aliasesByBrand.get(entry.brand.id) || [];aliases.push(entry.phrase);aliasesByBrand.set(entry.brand.id,aliases);
}
const packingDetails = [['in vegetable oil', 'بزيت نباتي'], ['in sunflower oil', 'بزيت دوار الشمس'],
  ['in olive oil', 'بزيت الزيتون'], ['in syrup', 'في شراب سكري']];
const dateOrigins = [
  { en:['al madinah','al madina','madinah','medina'], ar:'المدينة' },
  { en:['al qassim','al qasem','al qassim','qassim','qaseem','qasem'], ar:'القصيم' },
  { en:['al ahsa','al hasa','ahsa'], ar:'الأحساء' },
  { en:['al ula','alula'], ar:'العلا' },
];

export const isProductAttribute = value => {
  const text=norm(value), category=resolveCategory(text);
  const phrases=[...TITLE_TERMS.map(t=>t[0]),...TITLE_DETAILS.map(t=>t[0]),
    ...TITLE_VARIANTS.flatMap(g=>g.terms.map(t=>t[0])),...dateOrigins.flatMap(g=>g.en),
    ...(category?[category.matched_phrase]:[])].sort((a,b)=>b.length-a.length);
  let residual=' '+text+' ',matched=false;
  for(const phrase of phrases)if(residual.includes(' '+phrase+' ')){
    residual=residual.split(' '+phrase+' ').join(' ');matched=true;
  }
  // A brand containing a food word is still an unverified brand, e.g. Rice
  // Master. Only a field fully explained by product attributes is rejected.
  residual=residual.replace(/\b(?:local|fresh|imported|al)\b/gu,' ').trim();
  return matched&&!residual;
};

// English brand evidence wins over the Arabic reading, including its typos.
// Match whole phrases; never repair an unknown brand by fuzzy similarity.
export function titleBrand(nameEn, observedBrand) {
  const tokens=norm(nameEn).split(' '), matches=[];
  const observed=resolveBrand(observedBrand);
  const department=AISLE_BY_ID.get(resolveCategory(nameEn)?.aisle)?.dept;
  for (let start=0;start<tokens.length;start++) for (let width=1;width<=Math.min(5,tokens.length-start);width++) {
    const key=tokens.slice(start,start+width).join('');
    const entry=compactBrands.get(key);
    const allowed=entry && brandDepartments.get(entry.brand.id);
    if (entry && (entry.brand.id===observed.brand_id || !department || !allowed || allowed.includes(department))) matches.push({entry,length:key.length});
  }
  const found=matches.sort((a,b)=>b.length-a.length)[0]?.entry;
  return resolveBrand(found?.brand.display_en || observedBrand);
}

function productClause(text, brand, observedBrand) {
  let value = norm(text.split(',')[0].replace(/\([^)]*\)/g, ' '));
  const rawBrand = norm(observedBrand), brandNoun = resolveCategory(rawBrand);
  const productDetail = [...TITLE_TERMS, ...TITLE_DETAILS, ...TITLE_VARIANTS.flatMap(g=>g.terms)]
    .some(([phrase])=>includesPhrase(rawBrand,phrase)) || dateOrigins.some(g=>g.en.some(p=>includesPhrase(rawBrand,p)));
  // Unverified brand fields sometimes contain a product variety or origin.
  // Such evidence must remain in the product clause, never be stripped as a company.
  const safeBrand = productDetail && !brand.brand_id ? '' : brandNoun ? rawBrand.split(' ').slice(0, brandNoun.span[0]).join(' ') : rawBrand;
  for (const alias of [brand.display_en, ...(brand.brand_id ? [brand.canonical_brand] : [safeBrand]), ...(aliasesByBrand.get(brand.brand_id) || [])]) {
    const phrase = norm(alias);
    if (phrase && phrase !== value && includesPhrase(value,phrase)) {
      const remainder=` ${value} `.split(` ${phrase} `).join(' ').trim();
      // A company name can also supply the only product noun: Golden Chicken
      // Whole Legs must retain chicken after stripping the company prefix.
      const sharedNoun=resolveCategory(phrase);
      const replacement=sharedNoun && !resolveCategory(remainder) ? sharedNoun.matched_phrase : '';
      value=` ${value} `.split(` ${phrase} `).join(` ${replacement} `).trim();
    }
  }
  // The lookup accepts exact space-free brand aliases; remove those same
  // multi-token spellings from the name without deleting product words.
  const tokens=value.split(' ');
  for (let i=0;i<tokens.length;i++) for (let width=Math.min(5,tokens.length-i);width>0;width--) {
    if (compactBrands.get(tokens.slice(i,i+width).join(''))?.brand.id===brand.brand_id && !resolveCategory(tokens.slice(i,i+width).join(' '))) {
      tokens.splice(i,width);i--;break;
    }
  }
  value=tokens.join(' ');
  // Measurements, sale quantities and container names belong to other fields.
  return value.replace(/\bper\s+(?:kg|kilo|pc|piece)\b/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|gm|grams|ml|l|ltr|ltrs|litre|litres|liter|liters|kilo|pcs|pc|s|cm)?\b/g, ' ')
    .replace(/\b(?:bag|box|pack|packet|carton|bottle|economy pack|giant box)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// A one-word title needs its brand for a useful display name. Multiword
// product details and the separate brand field keep their existing meaning.
function shortNameWithBrand(name, brand, briefHead = false) {
  if (!name) return null;
  const text = String(name).trim();
  return brand && (text.split(/\s+/u).length === 1 || briefHead) && !text.includes(' / ') && !arabicKey(text).endsWith(' '+arabicKey(brand)) && arabicKey(text) !== arabicKey(brand)
    ? `${text} ${brand}` : text;
}

// Names contain only dictionary product terms and supported distinguishing
// details. Raw OCR is retained as evidence, never copied over a known term.
export function dictionaryProductTitle({ nameEn, nameAr, brand: observedBrand, size } = {}) {
  const brand = titleBrand(nameEn, observedBrand), titles = [], unknown = [], evidence = [];
  let hasBriefHead = false;
  const brands=new Map();
  const rememberBrand=b=>{
    const en=b.display_en || b.canonical_brand;
    if(!b.brand_id && isProductAttribute(en))return;
    if (en) brands.set(b.brand_id || en,{id:b.brand_id,en,ar:b.display_ar});
  };
  const clauses = String(nameEn ?? '').split(/\s*\/\s*|\s+or\s+/i).filter(Boolean);
  let previousCategory = null, previousProduct = null;
  for (const raw of clauses) {
    const explicitBrand=titleBrand(raw,null);
    const clauseBrand=explicitBrand.brand_id?explicitBrand:brand;
    rememberBrand(clauseBrand);
    let clause = productClause(raw, clauseBrand, observedBrand);
    // In/oil/syrup is an ingredient or packing medium, not the product head.
    const head = clause.split(/\s+(?:in|with)\s+/)[0];
    let structured = buildStructuredProduct({ name_en: head, brand: null });
    if(structured.category_diagnostics?.reason==='head_final_guard'){
      const candidate=resolveCategory(head);
      const scoped=TITLE_VARIANTS.filter(g=>g.heads.some(h=>candidate?.ar===h||candidate?.ar.startsWith(h+' ')))
        .flatMap(g=>g.terms).map(t=>t[0]);
      let clarified=' '+head+' ';
      for(const phrase of scoped)clarified=clarified.split(' '+phrase+' ').join(' ');
      // Known, category-scoped details are not unknown trailing nouns. Keep
      // the original clause for display details and retain the refusal guard
      // for every other unexplained word. Registry parsing is unchanged.
      if(clarified.trim()!==head)structured=buildStructuredProduct({name_en:clarified.trim(),brand:null});
    }

    let direct = TITLE_TERMS.filter(([phrase]) => includesPhrase(head, phrase))
      .sort((a,b) => b[0].split(' ').length - a[0].split(' ').length)[0];
    // A title dictionary hit must not replace a more specific classifier
    // phrase with a shorter product word.
    if (direct && structured.category?.matched_phrase.split(' ').length > direct[0].split(' ').length) direct = null;
    const detailsOnly = [...resolveDescriptors(head).map(d => d.matched_phrase),
      ...TITLE_DETAILS.filter(([phrase]) => includesPhrase(head, phrase)).map(d => d[0])];
    let leftover = head.replace(/^with /, '');
    for (const phrase of detailsOnly) leftover = ` ${leftover} `.split(` ${phrase} `).join(' ').trim();
    // Keep the prior head for a modifier-only branch. Re-run the dictionary on
    // the inherited phrase so cupcake/strawberry never resolves as fruit.
    if (!direct && previousProduct && detailsOnly.length && !leftover) {
      direct = [previousProduct.en, previousProduct.ar];
    }
    if (!direct && !structured.category && previousCategory && clause) {
      structured = buildStructuredProduct({ name_en: `${previousCategory} ${head}`, brand: null });
    }
    if (!direct && !structured.category) {
      if (/[a-z]/i.test(clause)) unknown.push(clause);
      continue;
    }
    const categoryEnglish = direct?.[0] || structured.category.matched_phrase;
    previousCategory = direct?.[0] || structured.category.en;
    const categoryAr = direct?.[1] || structured.category.ar;
    previousProduct = {en: categoryEnglish, ar: categoryAr};
    const remainder = ` ${head} `.replace(` ${categoryEnglish} `, ' ').trim();
    const descriptors = resolveDescriptors(remainder);
    const tail = clause.slice(head.length);
    const tailDescriptors = resolveDescriptors(tail);
    const extras = TITLE_DETAILS.filter(([phrase]) => includesPhrase(remainder, phrase));
    const embedded = resolveDescriptors(categoryEnglish).filter(d => ['low-fat', 'full-fat', 'fat-free'].includes(d.id)
      && !d.ar.split(' ').every(w => categoryAr.split(' ').includes(w)));
    descriptors.push(...embedded);
    const categoryWords = new Set(categoryAr.split(' '));
    const details = [...descriptors.map(d => d.ar), ...extras.map(d => d[1]), ...tailDescriptors.map(d => d.ar),
      ...packingDetails.filter(([phrase]) => includesPhrase(clause, phrase)).map(d => d[1])]
      .filter((value,i,all) => !value.split(' ').every(w => categoryWords.has(w)) && all.indexOf(value) === i);
    const variants = TITLE_VARIANTS.filter(group => group.heads.some(h => categoryAr === h || categoryAr.startsWith(h+' ')))
      .flatMap(group => group.terms).filter(([phrase]) => includesPhrase(remainder,phrase));
    const variantDetails = variants.map(([,ar])=>ar).filter(ar => !details.includes(ar) && !categoryAr.includes(ar));
    let title = [categoryAr, ...variantDetails, ...details].join(' ');
    // Keep the brand context of a formerly short generic head even when its
    // full noun phrase or missing subtype is restored.
    if (!details.length && (categoryAr.split(' ').length===1 ||
        (direct && structured.category?.ar.split(' ').length===1))) hasBriefHead = true;
    if (categoryAr.startsWith('زبدة')) title = title.replace(/غير مملح/g, 'غير مملحة').replace(/طبيعي/g, 'طبيعية').replace(/ناعم/g, 'ناعمة').replace(/مقرمش/g, 'مقرمشة');
    if (categoryAr === 'قشطة' && includesPhrase(head, 'analogue')) title = 'بديل قشطة';
    if (/\banalog(?:ue)?\b/u.test(clause)) {
      // Grocery substitutes take the conventional name of the dairy product,
      // rather than a transliteration or one generic translation for all foods.
      const withoutAnalogue = title.replace(/\s+بديل(?=\s|$)/gu, '').replace(/^بديل\s+/u, '');
      if (/^جبن(?:ة)?(?:\s|$)/u.test(withoutAnalogue)) title = withoutAnalogue
        .replace(/^جبن(?:ة)?/u, 'شبيه جبنة').replace(/كريمي/gu, 'كريمية').replace(/أبيض/gu, 'بيضاء');
      else if (/^قشطة/u.test(withoutAnalogue)) title = `شبيه ${withoutAnalogue}`;
      else if (/^زبدة/u.test(withoutAnalogue)) title = `شبيه ${withoutAnalogue}`;
    }
    if (categoryAr === 'تونة') title = title.replace(/خفيف/g, 'خفيفة');
    if (categoryAr === 'فوط صحية') title = title.replace(/كبير/g, 'كبيرة').replace(/صغير/g, 'صغيرة');
    if (categoryAr.startsWith('حفاضات') && includesPhrase(head,'pants')) title+=' كلوت';
    if (structured.category?.family === 'bread' || categoryAr.startsWith('خبز'))
      title = title.replace(/حبوب كاملة|أسمر/g, 'بر').replace(/بر نخالة/g, 'بر');
    // Registered rice varieties are identity details, not package dimensions.
    if (structured.category?.family==='rice' && /\b1121\b/u.test(raw)) title+=' 1121';
    let origin = null, originSource = null;
    if (/^(?:تمر|رطب)(?:\s|$)/u.test(categoryAr)) {
      const englishOrigins = dateOrigins.filter(region => region.en.some(phrase => includesPhrase(clause, phrase)
        || includesPhrase(clause,phrase.replace(/\s+/gu,''))));
      const arabicOrigins = dateOrigins.filter(region => includesPhrase(arabicKey(nameAr), arabicKey(region.ar)));
      if (englishOrigins.length === 1) { origin = englishOrigins[0]; originSource = 'english'; }
      else if (!englishOrigins.length && arabicOrigins.length === 1) { origin = arabicOrigins[0]; originSource = 'arabic'; }
      if (origin && !title.includes(origin.ar)) title += ` ${origin.ar}`;
    }
    if (!titles.includes(title)) titles.push(title);
    let residual = direct ? remainder : structured.residual_en.join(' ');
    for (const [phrase] of variants) residual = ` ${residual} `.split(` ${phrase} `).join(' ').trim();
    for (const [phrase] of extras) residual = ` ${residual} `.split(` ${phrase} `).join(' ').trim();
    for (const d of descriptors) residual = ` ${residual} `.split(` ${d.matched_phrase} `).join(' ').trim();
    if (categoryAr.startsWith('حفاضات')) residual=` ${residual} `.replace(/ pants /gu,' ').trim();
    if (origin) for (const phrase of origin.en) residual = ` ${residual} `.split(` ${phrase} `).join(' ').split(` ${phrase.replace(/\s+/gu,'')} `).join(' ').trim();
    if (residual.trim()) unknown.push(residual.trim());
    evidence.push({ english: raw, category: direct ? categoryEnglish : structured.category.id, title,
      ...(origin ? {origin:origin.ar,originSource} : {}) });
  }
  const dictionaryName = titles.join(' / ') || null;
  // Explicit multi-brand choices remain choices outside the product title.
  // An unrecognised typed brand is retained for review, never transliterated.
  const observedParts=String(observedBrand || '').split(/\s*\/\s*|\s+or\s+/iu);
  if (observedParts.length>1) for (const part of observedParts) {
    if (includesPhrase(norm(nameEn),norm(part))) rememberBrand(resolveBrand(part));
  }
  if (!brands.size) rememberBrand(brand);
  const brandList=[...brands.values()];
  const visionName = /(?=\p{Script=Arabic})\p{L}/u.test(String(nameAr || '')) ? String(nameAr).trim() : null;
  const source = dictionaryName ? 'dictionary' : visionName ? 'vision_fallback' : 'missing';
  const name = shortNameWithBrand(dictionaryName || visionName, brandList.map(b => b.ar || b.en).join(' / '), !!dictionaryName && hasBriefHead);
  // Unknown OCR spellings are evidence for this observation, not global fuzzy
  // aliases: a typo must never become a product identity on its own.
  const corrections = dictionaryName && nameAr ? [{ observed: nameAr, canonical: name,
    changed: arabicKey(nameAr) !== arabicKey(name), supportedBy: evidence.map(e => e.english) }] : [];
  return { version: PRODUCT_TITLE_VERSION, name, source, dictionaryName, brand: {
    id: brandList.length===1?brandList[0].id:null,
    en:brandList.map(b=>b.en).join(' / ') || null,
    ar:brandList.some(b=>b.ar)?brandList.map(b=>b.ar || b.en).join(' / '):null,
  }, brands:brandList, brandReviewRequired:brandList.some(b=>!b.ar),size: size || null, reviewRequired: !dictionaryName || unknown.length > 0,
  unknown: [...new Set(unknown)], evidence, corrections };
}

// Consume only this version's stored projection. Historical rows keep their
// previous contract until they are explicitly reprocessed; no expensive title
// building on each search request and no backfill hidden inside a read.
export function applyProductTitle(offer, row) {
  try {
    const title = typeof row?.e_product_title === 'string' ? JSON.parse(row.e_product_title) : row?.e_product_title;
    if (title?.version !== PRODUCT_TITLE_VERSION) return;
    offer.nameAr = shortNameWithBrand(title.name || offer.nameAr || null, title.brand?.ar || title.brand?.en);
    offer.nameSource = title.source || (title.name ? 'dictionary' : offer.nameAr ? 'vision_fallback' : 'missing');
    if (title.classification?.version === 'archive-classification-v1') offer.classification=title.classification;
    offer.productTitleVersion = title.version;
    offer.nameReviewRequired = title.reviewRequired === true;
    offer.brandNameAr = title.brand?.ar || null;
    offer.brandNameEn = title.brand?.en || null;
    if (title.brand?.id && title.brands?.length===1) offer.brandSlug=title.brand.id;
    if (title.brands?.length>1) {offer.brandSlugs=title.brands.map(b=>b.id).filter(Boolean);offer.brandSlug=null;}
    if (title.sizeReading?.version === 'offer-size-reading-v1') offer.sizeReading=title.sizeReading;
  } catch { /* Invalid optional metadata cannot erase a name. */ }
}
