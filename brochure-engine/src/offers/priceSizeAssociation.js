// Source-local veto for legacy and contradictory price-specific readings.
// This never supplies a price, a size or a count. It only rejects a quantity
// when the retailer crop explicitly prices a PACK and a CASE differently.
import { parsePackageSize } from '../lexicon/packageSize.js';

const digits = value => String(value ?? '').normalize('NFKC').toLowerCase()
  .replace(/[٠-٩۰-۹]/gu,d=>String(d.codePointAt(0)>0x6ef?d.codePointAt(0)-0x6f0:d.codePointAt(0)-0x660))
  .replace(/٫/gu,'.').replace(/[\u064b-\u065fـ]/gu,'');
const cents = n => Number.isFinite(Number(n)) && Number(n)>0 ? Math.round(Number(n)*100) : null;
const labels = /(?<!\p{L})(case|carton|pack|الصندوق|صندوق|الكرتون|كرتون|العبوة|العبوه|عبوة|عبوه)(?!\p{L})/giu;
const kind = text => /case|carton|صندوق|كرتون/iu.test(text) ? 'case'
  : /pack|عبو[ةه]/iu.test(text) ? 'pack' : null;
const oldPrice = /\b(?:reg(?:ular)?|old|was|before|save|discount)\b|السعر العادي|قبل|وفر|خصم/iu;

export function sourcePackagePrices(raw) {
  const text=digits(raw), output=new Map();
  for (const label of text.matchAll(labels)) {
    const prefix=text.slice(Math.max(0,label.index-65),label.index);
    // Normalized retailer OCR stores "16.99" as "16 99". Only an explicit
    // two-decimal amount immediately before the selling label is usable.
    const numbers=[...prefix.matchAll(/(?<!\d)(\d{1,5})[.\s]+(\d{2})(?!\d)/gu)];
    const price=numbers.at(-1);
    if (!price) continue;
    const between=prefix.slice(price.index+price[0].length);
    if (between.length>30 || /\d/u.test(between) || oldPrice.test(between)) continue;
    if (oldPrice.test(prefix.slice(Math.max(0,price.index-20),price.index))) continue;
    const value=Number(price[1])*100+Number(price[2]);
    if (!(value>0)) continue;
    const unit=kind(label[0]);
    output.set(`${unit}:${value}`,{unit,cents:value});
  }
  return [...output.values()];
}

export function legacyPriceSizeConflict({price,size,packageType,text,sale}={}) {
  if (sale?.status==='matched') size=sale.package_size;
  const prices=sourcePackagePrices(text), selected=prices.filter(p=>p.cents===cents(price));
  const units=new Set(selected.map(p=>p.unit));
  if (units.size!==1 || !prices.some(p=>p.cents!==cents(price) && !units.has(p.unit))) return null;
  const selectedUnit=selected[0].unit, observedUnit=kind(String(packageType||''));
  const canonical=parsePackageSize({size})?.canonical;
  if (!canonical) return null;
  if (sale?.status==='matched') {
    const original=parsePackageSize({size:sale.original?.package_size})?.canonical;
    // The general caption's container does not describe a separately bound
    // size. Veto a new option only when it copied that very container's size.
    if (!original || !observedUnit || selectedUnit===observedUnit
      || original.unit!==canonical.unit || original.pack!==canonical.pack
      || Math.abs(original.total-canonical.total)>1e-6) return null;
  }
  if ((observedUnit && selectedUnit!==observedUnit) || (selectedUnit==='pack' && canonical.pack>1)) {
    return {status:'unbound',reason:'different_package_prices',selectedUnit,observedUnit};
  }
  return null;
}

// Browse omits the full OCR haystack. Carry it only on the rare rows that
// could contain this conflict; the JS guard still validates word/price roles.
export function priceSizeContextSql(o='o') {
  return `CASE WHEN (LOWER(${o}.search_text) LIKE '%case%' OR LOWER(${o}.search_text) LIKE '%carton%'
    OR ${o}.search_text LIKE '%صندوق%' OR ${o}.search_text LIKE '%كرتون%')
    AND (LOWER(${o}.search_text) LIKE '%pack%' OR ${o}.search_text LIKE '%عبوه%' OR ${o}.search_text LIKE '%عبوة%')
    THEN ${o}.search_text END`;
}
