import { parsePackageSize } from './packageSize.js';
import { resolvePriceBasis } from './priceBasis.js';

export const SIZE_READING_VERSION = 'offer-size-reading-v1';
const digits = value => String(value ?? '').replace(/[٠-٩۰-۹]/gu, d =>
  String(d.codePointAt(0) >= 0x6f0 ? d.codePointAt(0)-0x6f0 : d.codePointAt(0)-0x660))
  .replace(/٬/gu,'').replace(/٫/gu,'.');
const unit = 'kilograms?|kilogrammes?|grams?|litres?|liters?|kilos?|kgs?|grm|gm|ml|ltr|lt|kg|g|l|كيلوجرام|كيلو|كجم|كغم|جرام|غرام|جم|غم|لتر|ليتر|مل|rolls?|pieces?|pcs?|رولات|رول|لفات|لفة|حبات|حبة|قطع|قطعة';
const unitEnd = new RegExp(`(${unit})(?=$|[^\\p{L}])`,'iu');
const expression = new RegExp(`(?:\\d+\\s*[x×]\\s*)*\\d+(?:\\.\\d+)?(?:\\s*[/–-]\\s*\\d+(?:\\.\\d+)?)*\\s*(?:${unit})(?=$|[^\\p{L}])`,'giu');
const measured = /\d\s*(?:kg|g|gm|ml|l|kilo|gram|lit|كجم|جم|جرام|غرام|مل|لتر)/iu;
const normalized = value => digits(value).replace(/[’']/gu,"'")
  .replace(/\b\d{1,3}(?:,\d{3})+(?=$|[^\d,])/gu,n=>n.replaceAll(',',''))
  .replace(/(\d+\s*,\s*\d+\s*,[\d\s,]*)/gu,list=>list.replaceAll(',','/'))
  .replace(/(?<=\d),(?=\d)/gu,'.')
  .replace(new RegExp(`((?:${unit}))\\s*,\\s*(?=\\d)`,'giu'),'$1 / ')
  .replace(/(\d(?:[\d\s/]+)?)\s*'s\b/giu,'$1 pcs').replace(/\s+/gu,' ').trim();

function fromField(raw, source, nonGrocery) {
  let value = normalized(raw).replace(/[()]/gu,'');
  if (!value) return null;
  const bonus = new RegExp(`^(\\d+)\\s*\\+\\s*(\\d+)\\s*(${unit})$`,'iu').exec(value);
  if (bonus) value = `${Number(bonus[1])+Number(bonus[2])} ${bonus[3]}`;
  const range = /\d\s*(?:[a-z\p{Script=Arabic}]+)?\s*(?:[–-]|\bto\b|إلى|الى)\s*\d/iu.test(value);
  const parts = value.split(/\s*(?:\/|\bor\b|أو|[–-]|\bto\b|إلى|الى)\s*/iu).filter(Boolean);
  const commonUnit = parts.map(p=>p.match(unitEnd)?.[1]).filter(Boolean).at(-1);
  // 5x70/75/80g shares the five-pack. Fully written alternatives such as
  // 2x500g / 1kg must retain their own counts instead.
  const commonPack = !parts[0]?.match(unitEnd) ? /^(\d+\s*[x×])\s*/iu.exec(parts[0] || '')?.[1] : null;
  const options = [];
  for (let [index, part] of parts.entries()) {
    part = part.replace(/[()]/gu,'').trim();
    if (!part.match(unitEnd) && commonUnit && /^(?:\d+\s*[x×]\s*)*\d+(?:\.\d+)?$/iu.test(part)) part += ` ${commonUnit}`;
    if (index > 0 && commonPack && !/^\d+\s*[x×]/iu.test(part)) part = `${commonPack} ${part}`;
    const comparisonValue=part.replace(/(?:رولات|رول|لفات|لفة)(?=$|[^\p{L}])/gu,'roll');
    const parsed = parsePackageSize({size:comparisonValue,nonGrocery});
    if (!parsed?.present || !parsed.canonical || (!parsed.display_ar && !parsed.display_en)) return null;
    const {canonical} = parsed;
    if (!Number.isFinite(canonical.total) || canonical.total <= 0) return null;
    if (!options.some(o=>o.canonical.unit===canonical.unit && o.canonical.pack===canonical.pack
      && Math.abs(o.canonical.total-canonical.total)<1e-6))
      options.push({value:comparisonValue,displayAr:parsed.display_ar,displayEn:parsed.display_en,canonical});
  }
  if (!options.length) return null;
  const assorted = options.length > 1;
  const display = options[0];
  let displayAr = assorted ? options.map(o=>o.displayAr).join(range?' إلى ':' أو ') : display.displayAr;
  let displayEn = assorted ? options.map(o=>o.displayEn).join(range?' to ':' or ') : display.displayEn;
  if (bonus) {
    displayAr += ` (${bonus[1]} + ${bonus[2]})`;
    displayEn = displayEn.replace(/pcs$/u,/roll|رول|لفة|لفات/iu.test(bonus[3])?'rolls':'pcs')+` (${bonus[1]} + ${bonus[2]})`;
  }
  return {version:SIZE_READING_VERSION,value:assorted ? value : options[0].value,printed:String(raw),source,
    displayAr,displayEn,assorted,kind:assorted?(range?'range':'alternatives'):'single',options,
    canonical:assorted?null:display.canonical};
}

function fromName(raw, source, nonGrocery, countOnly=false) {
  const name = normalized(raw);
  const found = [...name.matchAll(expression)];
  // A net weight takes priority over incidental slice counts in a title.
  const mass = countOnly?[]:found.filter(m=>measured.test(m[0]));
  const bonus=new RegExp(`\\d+\\s*\\+\\s*\\d+\\s*(?:${unit})(?=$|[^\\p{L}])`,'iu').exec(name);
  if (!mass.length && bonus && (!countOnly || !measured.test(bonus[0]))) return fromField(bonus[0],source,nonGrocery);
  const selected = countOnly?found.filter(m=>!measured.test(m[0])):mass.length ? mass : found;
  if (!selected.length) return null;
  if (selected.length > 1 && !/\/|\bor\b|أو|[–-]|\bto\b|إلى|الى/iu.test(name)) return null;
  return fromField(selected.map(m=>m[0]).join(' / '),source,nonGrocery);
}

function printedDimensions(raw) {
  const match=/(\d+(?:\.\d+)?(?:\s*[x×]\s*\d+(?:\.\d+)?){0,2})\s*(cm|mm|m|سم|ملم|متر)(?=$|[^\p{L}])/iu.exec(digits(raw));
  if (!match) return null;
  const units={cm:['سم','cm'],mm:['ملم','mm'],m:['متر','m'],'سم':['سم','cm'],'ملم':['ملم','mm'],'متر':['متر','m']};
  const u=units[match[2].toLowerCase()], magnitude=match[1].replace(/\s*[x×]\s*/giu,' × ');
  return {displayAr:`${magnitude} ${u[0]}`,displayEn:`${magnitude} ${u[1]}`,value:match[0]};
}

// Read one observation, never an unanchored retailer page. Price association
// outranks language: a valid selected sale size cannot be replaced by a size
// from a differently-priced carton mentioned in the title.
export function resolveOfferSize({size,nameEn,nameAr,sale,nonGrocery=false}={}) {
  const context=`${nameEn||''} ${nameAr||''}`;
  const diaper=/\b(?:diapers?|nappies|nappy)\b|حفاض|حفاظ/iu.test(context)
    && !/\bdiaper(?:\s+rash)?\s+(?:cream|ointment|lotion|balm|oil)\b|(?:كريم|مرهم|لوشن).{0,20}حفاض/iu.test(context);
  let field = fromField(size,'size_field',nonGrocery),fit=null;
  if (diaper && /kg|كجم|كغ|كيلو/iu.test(String(size)) && field?.options.some(o=>o.canonical.unit==='g')) {fit=field;field=null;}
  if (diaper && !fit) {
    const candidate=fromName(nameEn,'english_body_fit',nonGrocery) || fromName(nameAr,'arabic_body_fit',nonGrocery);
    if (candidate?.options.some(o=>o.canonical.unit==='g') && /kg|كجم|كغ|كيلو/iu.test(candidate.value)) fit=candidate;
  }
  // Sizes printed as alternatives in the English name ("(1L) / (900ml)") are
  // one assorted offer at one price; the field often kept only one of them.
  // A "+" is a bundle or bonus, never a choice; a merged OCR number
  // (150170/180g) is not a size the shopper can buy. Each alternative must
  // print its own unit: "Cashew W 180/ 500g" is a grade beside one size.
  if (field && !field.assorted && !diaper && field.canonical && !/\+/u.test(String(nameEn || ''))) {
    const listed = fromName(nameEn, 'english_name', nonGrocery);
    const same = o => o.canonical.unit === field.canonical.unit && o.canonical.pack === field.canonical.pack
      && Math.abs(o.canonical.total - field.canonical.total) < 1e-6;
    const totals = listed?.options.map(o => o.canonical.total) || [];
    const units = (String(nameEn || '').match(/\d+(?:[.,]\d+)?\s*(?:kgs?|g|gms?|gr|grams?|mg|ml|cl|l|lt|ltrs?|litres?|liters?|oz|lbs?)\b/giu) || []).length;
    if (listed?.assorted && listed.kind === 'alternatives' && listed.options.some(same)
      && units >= listed.options.length && Math.max(...totals) / Math.min(...totals) <= 20) field = listed;
  }
  if (!field && sale?.status === 'matched' && sale.count > 1 && !sale.package_size) return null;
  let reading=field || fromName(nameEn,'english_name',nonGrocery,diaper) || fromName(nameAr,'arabic_name',nonGrocery,diaper);
  if (fit && reading) {
    reading.displayAr+=` · لوزن ${fit.displayAr}`;reading.displayEn+=` · body weight ${fit.displayEn}`;
    reading.fitDisplayAr=fit.displayAr;reading.fitDisplayEn=fit.displayEn;
  } else if (fit) reading={version:SIZE_READING_VERSION,value:String(size),source:'body_fit',kind:'fit',
    displayAr:`لوزن ${fit.displayAr}`,displayEn:`For body weight ${fit.displayEn}`,
    displayOnly:true,assorted:false,options:[],canonical:null};
  const dimensions=printedDimensions(nameEn) || printedDimensions(nameAr) || printedDimensions(size);
  if (dimensions && !reading) reading={version:SIZE_READING_VERSION,value:dimensions.value,source:'printed_dimensions',
    displayAr:dimensions.displayAr,displayEn:dimensions.displayEn,displayOnly:true,assorted:false,kind:'single',options:[],canonical:null};
  else if (reading && dimensions) {
    reading.displayAr+=` · ${dimensions.displayAr}`;reading.displayEn+=` · ${dimensions.displayEn}`;
    reading.dimensions=dimensions;
  }
  if (reading && resolvePriceBasis({size}).status==='RESOLVED') reading.priceBasisInput=size;
  const basis=resolvePriceBasis({size,name:nameEn,text:nameAr,sizeResolved:true});
  if (reading && basis.status==='RESOLVED') reading.priceBasisText=[size,nameEn,nameAr].filter(Boolean).join(' ');
  return reading;
}

export function sizeOptionPrices(reading, price, saleCount=1) {
  if (!reading?.assorted || !(price>0) || !(saleCount>0)) return [];
  return reading.options.map(option=>{
    const c=option.canonical, quantity=c.total*saleCount;
    const unit=c.unit==='g'?'kg':c.unit==='ml'?'l':'piece';
    return {...option,saleCount,range:reading.kind==='range',unitPrice:{value:price/(quantity/(['g','ml'].includes(c.unit)?1000:1)),unit}};
  });
}
