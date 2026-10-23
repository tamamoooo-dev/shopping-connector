import { BRAND_LEXICON, LEXICON_ONLY_BRANDS, resolveBrand } from './brands.js';
import { buildStructuredProduct } from './structuredProduct.js';
import { TITLE_TERMS, TITLE_DETAILS, TITLE_VARIANTS, GROCERY_ONLY_DETAILS } from './productTitleDictionary.js';
import { normalizeShoppingText, resolveDescriptors, resolveCategory, isFlavorCategory } from './shopping.js';
import { NAME_SCAN_UNSAFE } from '../knowledge/brandNameScan.js';
import { READING_BRAND_VARIANTS, READING_TERM_CORRECTIONS } from '../knowledge/readingVariants.js';
import { normalizeText } from '../matching.js';
import { BRANDS } from '../browse/brands.js';
import { AISLE_BY_ID } from '../browse/taxonomy.js';

export const PRODUCT_TITLE_VERSION = 'dictionary-title-v1';
const GROCERY_DEPARTMENTS = new Set(['fresh', 'dairy-eggs', 'beverages', 'pantry', 'snacks-sweets', 'bakery', 'frozen']);
const departmentOf = category => AISLE_BY_ID.get(category?.aisle)?.dept;
const isGrocery = category => GROCERY_DEPARTMENTS.has(departmentOf(category));
const norm = value => normalizeShoppingText(String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, ''));
const includesPhrase = (value, phrase) => ` ${value} `.includes(` ${phrase} `);
const arabicKey = s => String(s ?? '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[\u064b-\u065fـ]/g, '');
const englishAliases = BRAND_LEXICON.flatMap(brand => brand.aliases
  .filter(alias => /[a-z]/i.test(alias)).map(alias => ({ brand, phrase: norm(alias) })))
  .sort((a, b) => b.phrase.length - a.phrase.length);
// Name scanning uses only distinctive spellings. An ordinary word such as
// Golden, Crispy or Royal identifies a company only in the typed brand field.
const scanSafe = ({ brand, phrase }) => !brand.typedOnly && !NAME_SCAN_UNSAFE.has(phrase)
  && !NAME_SCAN_UNSAFE.has(phrase.replace(/\s+/gu, ''));
const compactBrands=new Map(), aliasesByBrand=new Map(), arabicAliasesByBrand=new Map();
const brandDepartments=new Map([...BRANDS,...LEXICON_ONLY_BRANDS].filter(b=>b.depts).map(b=>[b.slug,b.depts]));
for (const entry of englishAliases) {
  const compact=entry.phrase.replace(/\s+/gu,'');
  if (scanSafe(entry) && !compactBrands.has(compact)) compactBrands.set(compact,entry);
  const aliases=aliasesByBrand.get(entry.brand.id) || [];aliases.push(entry.phrase);aliasesByBrand.set(entry.brand.id,aliases);
}
for (const brand of BRAND_LEXICON) arabicAliasesByBrand.set(brand.id, brand.aliases.filter(a => /\p{Script=Arabic}/u.test(a)));
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
// A typed brand that resolves is the extractor's reading of the brand and is
// kept; a name only refines it to a longer line of the same company printed
// there (Uno -> Uno Plus, Sanita -> Sanita Club). A name word fills the brand
// only when the field is empty or unknown, and must start the clause when
// `leading` is set (retail names print the brand first).
export function titleBrand(nameEn, observedBrand, { leading = false } = {}) {
  const tokens=norm(nameEn).split(' '), matches=[];
  const observed=resolveBrand(observedBrand);
  const department=AISLE_BY_ID.get(resolveCategory(nameEn)?.aisle)?.dept;
  for (let start=0;start<(leading?1:tokens.length);start++) for (let width=1;width<=Math.min(5,tokens.length-start);width++) {
    const key=tokens.slice(start,start+width).join('');
    const entry=compactBrands.get(key);
    const allowed=entry && brandDepartments.get(entry.brand.id);
    if (entry && (entry.brand.id===observed.brand_id || !department || !allowed || allowed.includes(department))) matches.push({entry,key,length:key.length});
  }
  matches.sort((a,b)=>b.length-a.length);
  if (observed.brand_id) {
    const own=(aliasesByBrand.get(observed.brand_id)||[]).map(a=>a.replace(/\s+/gu,'')).filter(a=>a.length>=3);
    const line=matches.find(m=>m.entry.brand.id!==observed.brand_id && own.some(a=>m.key.startsWith(a)));
    return line ? resolveBrand(line.entry.brand.display_en) : observed;
  }
  return resolveBrand(matches[0]?.entry.brand.display_en || observedBrand);
}

// Historical readings (scripts/build-reading-knowledge.mjs): misread Arabic
// words with the English that names the intended dictionary word, and misread
// spellings of known brands. Keys are folded as the builder folds them.
const READING_CLITIC = /^(?:وال|بال|فال|لل|ال)/u;
const readingKey = w => normalizeText(w).replace(/\s+/gu, '');
const readingCorrections = new Map(READING_TERM_CORRECTIONS.map(([observed, canonical, required]) => [observed, { canonical, required }]));

// A fallback name is the reading's own Arabic. A word in it that historical
// readings show to be a misreading of a dictionary word is replaced, keeping
// its article or preposition, only when this offer's English carries the same
// evidence (شافوره with "rusk" is شابورة). Every other word is left alone.
export function correctedReading(name, nameEn) {
  if (!name) return { name, corrections: [] };
  const english = new Set(normalizeText(nameEn).split(' '));
  const corrections = [];
  const text = String(name).split(/(\s+)/u).map(word => {
    if (!/\p{Script=Arabic}/u.test(word)) return word;
    const key = readingKey(word), clitic = key.match(READING_CLITIC)?.[0] || '';
    const entry = readingCorrections.get(key.slice(clitic.length));
    if (!entry || !entry.required.every(w => english.has(w))) return word;
    const corrected = (word.match(READING_CLITIC)?.[0] || '') + entry.canonical.replace(READING_CLITIC, '');
    corrections.push({ observed: word, canonical: corrected, changed: true, supportedBy: entry.required, source: 'reading_knowledge' });
    return corrected;
  }).join('');
  return { name: text, corrections };
}

const ARABIC_ARTICLE = /^(?:وال|ال)/u;
const foldWord = w => arabicKey(String(w).toLowerCase()).replace(/[^\p{L}\p{N}]/gu, '');
// The Arabic product name never carries the brand: it is shown in its own
// field. Removes the brand's known spellings (Arabic, English, typed field)
// from a name, whole words only, so a stored or fallback name stays a product.
export function withoutBrand(name, brands = [], observedBrand = null) {
  if (!name) return null;
  // Each alternative separately: a segment that is only a brand (بيبسي in a
  // cola list) stays, since it is the only name that alternative has.
  const segments = String(name).split(/\s+\/\s*|\s*\/\s+/u).map(segment => segment.trim()).filter(Boolean);
  if (segments.length > 1) return segments.map(segment => brandWordsRemoved(segment, brands, observedBrand) || segment).join(' / ');
  return brandWordsRemoved(name, brands, observedBrand);
}

function brandWordsRemoved(name, brands, observedBrand) {
  const words=String(name).trim().split(/\s+/u);
  const phrases=[];
  for (const b of brands) for (const v of [b.ar, b.en, ...(arabicAliasesByBrand.get(b.id) || []), ...(aliasesByBrand.get(b.id) || [])]) {
    // An unresolved field may be a product word (حليب); only its Latin form is a brand.
    if (v && (b.id || !/\p{Script=Arabic}/u.test(v))) phrases.push(v);
  }
  for (const part of String(observedBrand || '').split(/\s*\/\s*|\s+or\s+/iu)) if (part.trim()) phrases.push(part);
  const keys=[...new Set(phrases.map(p=>String(p).trim().split(/\s+/u).map(foldWord).filter(Boolean).join(' ')).filter(Boolean))]
    .sort((a,b)=>b.split(' ').length-a.split(' ').length);
  const folded=words.map(foldWord), keep=words.map(()=>true);
  // Misread spellings of this offer's own brand (ناديك for Nadec) leave too.
  const variants=new Set(brands.flatMap(b=>READING_BRAND_VARIANTS[b.id] || []));
  if (variants.size) for (let i=0;i<words.length;i++) for (let width=Math.min(3,words.length-i);width>0;width--) {
    if (!keep.slice(i,i+width).every(Boolean)) continue;
    if (variants.has(readingKey(words.slice(i,i+width).join(' ')).replace(READING_CLITIC,''))) {
      for (let j=0;j<width;j++) keep[i+j]=false;
      break;
    }
  }
  for (const key of keys) {
    const parts=key.split(' ');
    for (let i=0;i+parts.length<=words.length;i++) {
      if (!keep[i]) continue;
      const window=folded.slice(i,i+parts.length);
      const same=window.every((w,j)=>w===parts[j] || w.replace(ARABIC_ARTICLE,'')===parts[j].replace(ARABIC_ARTICLE,''));
      if (same) for (let j=0;j<parts.length;j++) keep[i+j]=false;
    }
  }
  // Latin words inside an Arabic name are brand, line or model names.
  if (words.some((w,i)=>keep[i] && /\p{Script=Arabic}/u.test(w))) words.forEach((w,i)=>{ if (/[A-Za-z]/u.test(w)) keep[i]=false; });
  const text=words.filter((w,i)=>keep[i]).join(' ').replace(/\(\s*\)/gu,'').replace(/\s+/gu,' ').trim();
  return text && /\p{Script=Arabic}/u.test(text) ? text : null;
}

function productClause(text, brand, observedBrand) {
  // "0% Sugar" is a claim; keep it readable once the number is removed.
  let value = norm(text.split(',')[0].replace(/\([^)]*\)/g, ' ').replace(/\b0\s*%\s*(?=sugar\b)/giu, 'zero '));
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
  // A company printed before the product is not a product word either: the
  // parent of a typed line (Nestle + Pure Life) or a maker beside its brand.
  for (let width=Math.min(5,tokens.length);width>0;width--) {
    const phrase=tokens.slice(0,width).join(' ');
    const known=compactBrands.get(phrase.replace(/\s+/gu,''));
    const productTerm=TITLE_TERMS.some(([term])=>includesPhrase(value,term) && includesPhrase(term,tokens[0]));
    if (known && width<tokens.length && !productTerm && !resolveCategory(phrase)) { tokens.splice(0,width); break; }
  }
  value=tokens.join(' ');
  // Measurements, sale quantities and container names belong to other fields.
  value = value.replace(/\bper\s+(?:kg|kilo|pc|piece)\b/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:kg|g|gm|grams|ml|l|ltr|ltrs|litre|litres|liter|liters|kilo|pcs|pc|s|cm)?\b/g, ' ')
    .replace(/\b(?:bag|box|pack|packet|carton|bottle|economy pack|giant box)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // A pouch or sachet is packaging only beside a food ("Milk Powder Pouch");
  // elsewhere it is the product (Pencil Pouch). Jar, tin, can, tub and bucket
  // stay: they are products in their own right (Cookie Jar, Mop Bucket).
  const unpacked = value.replace(/\b(?:pouch|sachet)\b/g, ' ').replace(/\s+/g, ' ').trim();
  return unpacked !== value && isGrocery(resolveCategory(unpacked)) ? unpacked : value;
}

// Adjectives agree with a feminine product noun: قهوة تركية, شوكولاتة داكنة.
const FEMININE = new Map([['تركي','تركية'],['داكن','داكنة'],['أبيض','بيضاء'],['أسود','سوداء'],['أحمر','حمراء'],
  ['أخضر','خضراء'],['أصفر','صفراء'],['أزرق','زرقاء'],['هندي','هندية'],['عادي','عادية'],['حار','حارة'],
  ['طبيعي','طبيعية'],['مقرمش','مقرمشة'],['ناعم','ناعمة'],['خفيف','خفيفة'],['كبير','كبيرة'],['صغير','صغيرة'],
  ['مملح','مملحة'],['أصلي','أصلية'],['إيطالي','إيطالية'],['مصري','مصرية'],['سعودي','سعودية'],['فرنسي','فرنسية'],
  ['يوناني','يونانية'],['ذهبي','ذهبية'],['مجمد','مجمدة'],['طازج','طازجة'],['محمص','محمصة'],['مدخن','مدخنة'],
  ['مطبوخ','مطبوخة'],['مبشور','مبشورة'],['كريمي','كريمية'],['حامض','حامضة'],['حلو','حلوة'],['مالح','مالحة'],
  ['بلدي','بلدية'],['تقليدي','تقليدية'],['أمريكي','أمريكية'],['برازيلي','برازيلية'],['أردني','أردنية'],
  ['باكستاني','باكستانية'],['قابل','قابلة'],['سريع','سريعة'],['طويل','طويلة'],['محشو','محشوة'],['متوسط','متوسطة'],
  ['فاتح','فاتحة'],['مركز','مركزة'],['مطحون','مطحونة'],['منكه','منكهة'],['كلاسيكي','كلاسيكية'],['صحي','صحية'],['خالي','خالية'],['كامل','كاملة'],['قليل','قليلة'],['يمني','يمنية'],['كيني','كينية'],['صيني','صينية'],['إسباني','إسبانية'],
  ['لبناني','لبنانية'],['سوري','سورية'],['إيراني','إيرانية'],['أسترالي','أسترالية'],['محلي','محلية'],['مشكل','مشكلة'],
  ['فيتنامي','فيتنامية'],['مغربي','مغربية'],['سريلانكي','سريلانكية'],['نيوزيلندي','نيوزيلندية'],['مغطى','مغطاة'],
]);
const FEMININE_PLURAL_HEADS = new Set(['نودلز', 'بطاطس', 'حفاضات', 'مناديل', 'فوط', 'مياه']);
function feminineDetails(categoryAr, details) {
  const head = categoryAr.split(' ')[0];
  if (!head.endsWith('ة') && !FEMININE_PLURAL_HEADS.has(head)) return details;
  return details.map(detail => detail.split(' ').map((word, i, words) => i === 0 || (i === 1 && words[0] === 'غير')
    ? FEMININE.get(word) || word : word).join(' '));
}

function trailingBrandRemoved(name, brands) {
  if (!name) return null;
  let text = String(name).trim();
  // A brand list appended as one ("تونة هناء / بليمز") leaves as one.
  const joined = brands.length > 1 ? [brands.map(b => b.ar || b.en).join(' / ')] : [];
  for (const v of [...joined, ...brands.flatMap(b => [b.ar, b.en])]) {
    if (v && text !== v && arabicKey(text).endsWith(' ' + arabicKey(v))) text = text.slice(0, text.length - v.length).trim();
  }
  return text || String(name).trim();
}

// A one-word name says too little on its own (مياه), so the user's rule adds
// the dictionary brand to it (مياه أكوافينا); longer names keep the brand in
// its own field. Only an Arabic brand is added: Latin never enters the name.
function oneWordWithBrand(name, brands = []) {
  if (!name) return name;
  const text = String(name).trim();
  if (/\s/u.test(text) || !brands.length || !brands.every(b => b?.ar)) return text;
  if (brands.some(b => arabicKey(b.ar) === arabicKey(text))) return text;
  return `${text} ${brands.map(b => b.ar).join(' / ')}`;
}

// Products that are sold in flavours: the only heads a flavour clause borrows.
const FLAVORED_AISLES = new Set(['juices', 'soft-drinks', 'water', 'malt-drinks', 'drink-mixes', 'tea-coffee', 'yogurt-labneh',
  'milk-laban', 'sauces-spreads', 'cakes-pastry', 'biscuits', 'chocolates-candies', 'chips-snacks', 'pasta-noodles',
  'ice-cream', 'desserts', 'cereals', 'deli', 'dishwashing']);
const takesFlavors = category => !!category && !isFlavorCategory(category)
  && (FLAVORED_AISLES.has(category.aisle) || ['soup', 'archive-stock', 'archive-vegetable-stock'].includes(category.id));
// The flavour noun of a clause that says nothing else (brands and descriptors
// aside); '' for a descriptor-only flavour, null when the clause is more.
function flavorOnlyClause(clause, brandWords) {
  let text = ` ${norm(clause)} `;
  for (const word of brandWords) text = text.split(` ${word} `).join(' ');
  const tokens = text.trim().split(' ').filter(Boolean);
  if (tokens.length > 1 && compactBrands.has(tokens[0])) tokens.shift();
  text = tokens.join(' ');
  const flavor = resolveCategory(text);
  if (flavor && !isFlavorCategory(flavor)) return null;
  if (flavor) text = ` ${text} `.replace(` ${flavor.matched_phrase} `, ' ').trim();
  const descriptors = resolveDescriptors(text);
  for (const d of descriptors) text = ` ${text} `.replace(` ${d.matched_phrase} `, ' ').trim();
  return (flavor || descriptors.some(d => d.role === 'flavor')) && !text ? (flavor?.matched_phrase || '') : null;
}

// "Chicken / Beef / Vegetable Bouillon", "Orange / Mango Juice": the product
// noun printed once at the end belongs to every flavour-only clause before it.
function distributeSharedHead(clauses, brandWords) {
  if (clauses.length < 2) return clauses;
  const last = resolveCategory(clauses.at(-1));
  if (!takesFlavors(last)) return clauses;
  // Borrow the product noun alone: "Vegetable Bouillon" lends "bouillon".
  const words = last.matched_phrase.split(' ');
  const shared = words.map((_, i) => words.slice(i).join(' ')).reverse().find(suffix => takesFlavors(resolveCategory(suffix))) || last.matched_phrase;
  return clauses.map((clause, i) => {
    if (i === clauses.length - 1) return clause;
    const flavor = flavorOnlyClause(clause, brandWords);
    return flavor !== null && !includesPhrase(last.matched_phrase, flavor) ? `${clause} ${shared}` : clause;
  });
}

// Names contain only dictionary product terms and supported distinguishing
// details. Raw OCR is retained as evidence, never copied over a known term.
export function dictionaryProductTitle({ nameEn, nameAr, brand: observedBrand, size } = {}) {
  const brand = titleBrand(nameEn, observedBrand), titles = [], unknown = [], evidence = [];
  const brands=new Map();
  const rememberBrand=b=>{
    const en=b.display_en || b.canonical_brand;
    if(!b.brand_id && isProductAttribute(en))return;
    if (en) brands.set(b.brand_id || en,{id:b.brand_id,en,ar:b.display_ar});
  };
  // "Juice (1.3L) Excluding Orange/Mango" names what the offer is NOT.
  const offered = String(nameEn ?? '').split(/\s+(?:excluding|except|excl\.?)\s+/iu)[0];
  const brandWords = [brand.display_en, observedBrand].filter(Boolean).flatMap(b => norm(b).split(' ')).filter(Boolean);
  const clauses = distributeSharedHead(offered.split(/\s*\/\s*|\s+or\s+/i).filter(Boolean), brandWords);
  let previousCategory = null, previousProduct = null;
  for (const raw of clauses) {
    // A brand printed at the start of a clause names that clause's company
    // (multi-brand offers), unless the typed field is a longer line of it.
    const explicitBrand=titleBrand(raw,null,{leading:true});
    const fieldIsLonger=explicitBrand.brand_id && brand.brand_id && explicitBrand.brand_id!==brand.brand_id
      && (aliasesByBrand.get(brand.brand_id)||[]).some(a=>a.replace(/\s+/gu,'').startsWith(norm(explicitBrand.display_en).replace(/\s+/gu,'')));
    const clauseBrand=explicitBrand.brand_id&&!fieldIsLonger?explicitBrand:brand;
    rememberBrand(clauseBrand);
    let clause = productClause(raw, clauseBrand, observedBrand);
    // In/oil/syrup is an ingredient or packing medium, not the product head.
    const head = clause.split(/\s+(?:in|with)\s+/)[0];
    let structured = buildStructuredProduct({ name_en: head, brand: null });
    if(structured.category_diagnostics?.reason==='head_final_guard'){
      const candidate=resolveCategory(head);
      const scoped=TITLE_VARIANTS.filter(g=>g.heads.some(h=>candidate?.ar===h||candidate?.ar.startsWith(h+' ')))
        .flatMap(g=>g.terms).map(t=>t[0]).concat(TITLE_DETAILS.map(t=>t[0]));
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
    // phrase with a shorter product word, nor a product noun of the same
    // width printed after it ("Pizza Cheese" is cheese).
    if (direct && structured.category) {
      const width = structured.category.matched_phrase.split(' ').length, directWidth = direct[0].split(' ').length;
      const directAt = ` ${head} `.indexOf(` ${direct[0]} `), categoryAt = ` ${head} `.indexOf(` ${structured.category.matched_phrase} `);
      if (width > directWidth || (width === directWidth && categoryAt > directAt && !isFlavorCategory(structured.category)
        && !includesPhrase(direct[0], structured.category.matched_phrase))) direct = null;
    }
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
    // "Juice Apple / Pineapple": a later clause naming only a flavour keeps
    // the product of the clause before it.
    if (!direct && previousProduct?.takesFlavors && isFlavorCategory(structured.category) && flavorOnlyClause(head, brandWords) !== null) {
      direct = [previousProduct.en, previousProduct.ar];
    }
    const categoryEnglish = direct?.[0] || structured.category.matched_phrase;
    previousCategory = direct?.[0] || structured.category.en;
    const categoryAr = direct?.[1] || structured.category.ar;
    previousProduct = {en: categoryEnglish, ar: categoryAr, takesFlavors: takesFlavors(resolveCategory(categoryEnglish))};
    const remainder = ` ${head} `.replace(` ${categoryEnglish} `, ' ').trim();
    // Longer curated details win over the words inside them ("dark roast",
    // "blue raspberry"); flavour nouns and descriptors read what they leave.
    let detailText = remainder;
    const extras = [];
    // An unresolved head (Sukkary Rotab) keeps its origin; only a known
    // non-food department (Fine China Dinner Set) refuses food details.
    const department = departmentOf(structured.category || resolveCategory(categoryEnglish));
    const notFood = Boolean(department) && !GROCERY_DEPARTMENTS.has(department);
    for (const term of [...TITLE_DETAILS].sort((a, b) => b[0].length - a[0].length)) {
      if (!includesPhrase(detailText, term[0]) || (notFood && GROCERY_ONLY_DETAILS.has(term[0]))) continue;
      extras.push(term);
      detailText = ` ${detailText} `.replace(` ${term[0]} `, ' ').trim();
    }
    extras.sort((a, b) => ` ${remainder} `.indexOf(` ${a[0]} `) - ` ${remainder} `.indexOf(` ${b[0]} `));
    const variants = TITLE_VARIANTS.filter(group => group.heads.some(h => categoryAr === h || categoryAr.startsWith(h+' ')))
      .flatMap(group => group.terms).filter(([phrase]) => includesPhrase(remainder,phrase));
    for (const [phrase] of variants) detailText = ` ${detailText} `.replace(` ${phrase} `, ' ').trim();
    // A fruit, vegetable or meat beside the product is its flavour or type:
    // "Ketchup Tomato", "Stock Chicken".
    const flavorNouns = [];
    for (let flavor = resolveCategory(detailText); isFlavorCategory(flavor) && flavorNouns.length < 3; flavor = resolveCategory(detailText)) {
      flavorNouns.push(flavor);
      detailText = ` ${detailText} `.replace(` ${flavor.matched_phrase} `, ' ').trim();
    }
    const descriptors = resolveDescriptors(detailText);
    const tail = clause.slice(head.length);
    const tailDescriptors = resolveDescriptors(tail);
    const embedded = resolveDescriptors(categoryEnglish).filter(d => ['low-fat', 'full-fat', 'fat-free'].includes(d.id)
      && !d.ar.split(' ').every(w => categoryAr.split(' ').includes(w)));
    descriptors.push(...embedded);
    const categoryWords = new Set(categoryAr.split(' '));
    // Type and flavour first, claims ("sugar free") after them.
    const claims = [...descriptors, ...tailDescriptors].filter(d => d.role === 'attribute');
    const details = [...flavorNouns.map(f => f.ar), ...descriptors.filter(d => d.role !== 'attribute').map(d => d.ar), ...extras.map(d => d[1]),
      ...tailDescriptors.filter(d => d.role !== 'attribute').map(d => d.ar), ...claims.map(d => d.ar),
      ...packingDetails.filter(([phrase]) => includesPhrase(clause, phrase)).map(d => d[1])]
      .filter((value,i,all) => !value.split(' ').every(w => categoryWords.has(w)) && all.indexOf(value) === i);
    const variantDetails = variants.map(([,ar])=>ar).filter(ar => !details.includes(ar) && !categoryAr.includes(ar));
    // Agreement can make a detail repeat the head (شطة حارة + حار).
    let title = [categoryAr, ...feminineDetails(categoryAr, [...variantDetails, ...details])
      .filter((value, i, all) => !value.split(' ').every(w => categoryWords.has(w)) && all.indexOf(value) === i)].join(' ');
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
      // A named region says more than "local" (تمر سكري القصيم).
      if (origin) title = title.replace(/\s+محلي(?=\s|$)/u, '');
      if (origin && !title.includes(origin.ar)) title += ` ${origin.ar}`;
    }
    if (!titles.includes(title)) titles.push(title);
    let residual = direct ? remainder : structured.residual_en.join(' ');
    for (const [phrase] of variants) residual = ` ${residual} `.split(` ${phrase} `).join(' ').trim();
    for (const [phrase] of extras) residual = ` ${residual} `.split(` ${phrase} `).join(' ').trim();
    // The classifier may already have read part of a curated phrase.
    for (const word of extras.flatMap(([phrase]) => phrase.split(' '))) residual = ` ${residual} `.split(` ${word} `).join(' ').trim();
    for (const d of descriptors) residual = ` ${residual} `.split(` ${d.matched_phrase} `).join(' ').trim();
    for (const f of flavorNouns) residual = ` ${residual} `.split(` ${f.matched_phrase} `).join(' ').trim();
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
  // An unresolved Arabic field is often a product word (حليب); only a Latin
  // field is certainly a brand spelling that must leave the Arabic name.
  const typedBrand = !isProductAttribute(observedBrand) && !/\p{Script=Arabic}/u.test(String(observedBrand || '')) ? observedBrand : null;
  const repaired = dictionaryName ? { name: null, corrections: [] } : correctedReading(withoutBrand(visionName, brandList, typedBrand), nameEn);
  const fallbackName = repaired.name;
  const source = dictionaryName ? 'dictionary' : fallbackName ? 'vision_fallback' : 'missing';
  const name = oneWordWithBrand(dictionaryName || fallbackName, brandList);
  // Unknown OCR spellings are evidence for this observation, not global fuzzy
  // aliases: a typo must never become a product identity on its own. A word
  // correction needs both the learned misreading and this offer's English.
  const corrections = dictionaryName && nameAr ? [{ observed: nameAr, canonical: name,
    changed: arabicKey(nameAr) !== arabicKey(name), supportedBy: evidence.map(e => e.english) }] : repaired.corrections;
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
    // A stored name is read as the product alone, then shown by today's rule:
    // the brand only beside a one-word name. Earlier v1 rows also appended it
    // to brief multi-word heads; that brand leaves.
    const stored = title.name || offer.nameAr || null, brands = title.brands || [];
    const product = title.source === 'vision_fallback'
      ? correctedReading(withoutBrand(trailingBrandRemoved(stored, brands), brands) || stored, offer.name).name
      : trailingBrandRemoved(stored, brands);
    offer.nameAr = oneWordWithBrand(product, brands);
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
