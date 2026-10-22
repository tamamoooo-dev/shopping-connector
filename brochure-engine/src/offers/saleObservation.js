// External deal quantities are independent of the contents of one package.
// Model prices select evidence only; they never replace the retailer price.
export const SALE_READING_VERSION = 'sale-reading-v1';
import { repairArabicCaption } from '../lexicon/arabicCaptionRepair.js';
import { parsePackageSize } from '../lexicon/packageSize.js';

const digits = value => String(value ?? '').replace(/[٠-٩۰-۹]/gu, d =>
  String(d.codePointAt(0) >= 0x6f0 ? d.codePointAt(0) - 0x6f0 : d.codePointAt(0) - 0x660));
export function printedSaleCount(value) {
  const text = digits(value).trim().replace(/\s+(?:deal|only)$/iu, '');
  if (/حبتين|حبتان/u.test(text)) return 2;
  const bonus = /^(?:buy\s*)?(\d{1,2})\s*(?:\+|get)\s*(\d{1,2})(?:\s*(?:free|مجانا))?$/iu.exec(text);
  if (bonus) return Number(bonus[1]) + Number(bonus[2]);
  const count = /^(\d{1,2})\s*(?:pcs?|pieces?|packs?|حبات|حبة|حبه|قطعة|قطع|عبوات)(?:\s*(?:pcs?|حبات|حبة|حبه|قطعة|قطع))?$/iu.exec(text);
  return count ? Number(count[1]) : null;
}
const cents = value => typeof value === 'number' && Number.isFinite(value) && value > 0
  ? Math.round(value * 100) : null;

export function selectSaleObservation(observation, offer = {}) {
  const output = observation?.parsedObject;
  if (!Array.isArray(output?.sale_options)) return observation;
  const price = cents(offer.price);
  const options = output.sale_options.filter(o => price != null && cents(o?.current_price) === price);
  const signatures = new Set(options.map(o => JSON.stringify([o.package_size ?? null, o.sale_count ?? null, o.sale_count_text ?? null])));
  const option = signatures.size === 1 ? options[0] : null;
  const count = option?.sale_count;
  const validCount = Number.isInteger(count) && count >= 1 && count <= 99
    && printedSaleCount(option.sale_count_text) === count;
  const packageCount = parsePackageSize({ size: option?.package_size })?.canonical?.pack;
  // The model sometimes repeats the external multiplier in both fields.
  // Refuse this unresolved distinction rather than pricing nine soaps as three.
  const repeatedCount = count > 1 && packageCount === count;
  const status = !option ? 'unmatched' : count != null && (!validCount || repeatedCount) ? 'ambiguous' : 'matched';
  const sale = {
    version: SALE_READING_VERSION, status,
    price: offer.price,
    count: validCount ? count : null,
    text: validCount ? option.sale_count_text : null,
    package_size: status === 'matched' && typeof option?.package_size === 'string' ? option.package_size : null,
  };
  const parsedObject = { ...output, _sale: sale };
  // Sizes have their own validated field. A second, mistranscribed numeric
  // suffix in the Arabic caption must not contradict that field on the card.
  for (const field of ['name_en', 'name_ar']) {
    if (typeof parsedObject[field] !== 'string') continue;
    parsedObject[field] = parsedObject[field].replace(/\(([^()]*)\)/gu, (whole, inner) => {
      const value = digits(inner);
      return /\d/u.test(value) && (/(?:\b(?:ml|kg|gm|g|l)\b|جم|جرام|كيلو|مل|لتر|×|\d\s*x\s*\d)/iu.test(value)
        || /^[\d\s.,×x/+-]+$/iu.test(value)) ? '' : whole;
    }).replace(/\s+/gu, ' ').trim();
  }
  // This selected size still passes the normal source-local size validator.
  if (sale.package_size) {
    parsedObject.package_size = sale.package_size;
    delete parsedObject.size;
  }
  // An internal count next to a TOTAL weight must never multiply that weight.
  // Complete internal multipacks already carry their multiplier in size.
  parsedObject.quantity = null;
  delete parsedObject.pack_count;
  parsedObject.name_ar = repairArabicCaption({ nameAr: parsedObject.name_ar,
    nameEn: parsedObject.name_en, brand: parsedObject.brand,
    retailerText: offer.search_text ?? offer.searchText });
  return { ...observation, parsedObject };
}

export function readSaleObservation(json, price) {
  try {
    const record = typeof json === 'string' ? JSON.parse(json) : json;
    const sale = record?._sale ?? record;
    if (sale?.version !== SALE_READING_VERSION) return null;
    if (cents(sale.price) !== cents(price) || cents(price) == null) return { ...sale, status: 'stale', count: null };
    return sale;
  } catch { return null; }
}

export function saleObservationSql(e = 'e', o = 'o') {
  return `CASE WHEN json_valid(${e}.extraction_json) THEN CASE WHEN
    json_extract(${e}.extraction_json, '$._sale.version') = '${SALE_READING_VERSION}'
    THEN json_extract(${e}.extraction_json, '$._sale') END END`;
}
