import { parsePackageSize } from '../lexicon/packageSize.js';
import { resolvePackageType } from '../lexicon/shopping.js';

export function hasAmbiguousSizeOptions(size) {
  if (!size || !/\d\s*(?:kg|kgs|g|gm|grams?|ml|l|كجم|جم|مل|لتر)?\s*[/–-]\s*\d/iu.test(size)) return false;
  const measure = /\d\s*(kg|kgs|g|gm|grams?|ml|l|كجم|جم|مل|لتر)\b/giu;
  const printed = [...String(size).matchAll(measure)], fallbackUnit = printed.at(-1)?.[1];
  const choices = String(size).split(/[/–-]/u).map(part => {
    const explicit = /\d\s*(?:kg|kgs|g|gm|grams?|ml|l|كجم|جم|مل|لتر)\b/iu.test(part);
    return parsePackageSize({size: !explicit && fallbackUnit ? `${part.trim()}${fallbackUnit}` : part})?.canonical;
  });
  return choices.some(choice => !choice || choice.unit !== choices[0]?.unit
    || Math.abs(choice.total - choices[0].total) > 1e-6);
}

export function saleUnitKind(name, size, packageType) {
  const text = String(name || '').toLowerCase();
  const contents = parsePackageSize({size});
  // External deal units can themselves contain several bottles/sachets.
  if (contents?.canonical?.pack > 1) return 'group';
  const cut = /\b(?:breast|leg|wing|fillet|strip|tender|nugget|burger|liver|gizzard|heart|popcorn)\w*\b/.test(text);
  if (!cut && /\b(?:whole chicken|chicken griller|griller chicken)\b/.test(text)) return 'chicken';
  // The word chicken alone does not establish whole birds or their container.
  if (/\bchicken\b/.test(text) && !cut) return 'item';
  const type = resolvePackageType(packageType)?.id;
  return {bottle:'bottle',can:'can',jar:'jar',box:'box',pack:'pack',bag:'bag',
    cup:'cup',sachet:'sachet',roll:'roll',tube:'tube',set:'set',piece:'item'}[type] || 'item';
}
