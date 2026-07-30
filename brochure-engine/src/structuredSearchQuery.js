// A search launch needs the stable semantic core of a product, not its
// retailer marketing title. This is deliberately a projection of the existing
// watch identity: it creates no identity, stores no search key, and leaves the
// displayed title untouched.

const MARKETING_WORDS = new Set([
  'fresh', 'premium', 'boneless', 'tender', 'quality', 'finest', 'selected',
  'special', 'offer', 'promo', 'promotional', 'new', 'value', 'economy',
  'pack', 'packet', 'packs', 'piece', 'pieces',
]);

const ACRONYMS = new Map([
  ['uht', 'UHT'],
  ['bbq', 'BBQ'],
]);

function objectValue(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function scalar(value) {
  if (Array.isArray(value)) return value.length === 1 ? scalar(value[0]) : '';
  return String(value ?? '').trim();
}

function phrase(value, { marketing = true } = {}) {
  const raw = scalar(value)
    .replace(/[_/|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';
  const words = raw.split(' ').filter((word) => {
    if (!marketing) return true;
    return !MARKETING_WORDS.has(word.toLocaleLowerCase('en'));
  });
  return words.map((word) => {
    const lower = word.toLocaleLowerCase('en');
    if (ACRONYMS.has(lower)) return ACRONYMS.get(lower);
    return /[a-z]/i.test(word)
      ? lower.charAt(0).toLocaleUpperCase('en') + lower.slice(1)
      : word;
  }).join(' ');
}

function firstField(sources, fields) {
  for (const source of sources) {
    for (const field of fields) {
      const value = scalar(source?.[field]);
      if (value) return value;
    }
  }
  return '';
}

export function structuredSearchQuery(watch = {}, observation = {}) {
  const sources = [
    objectValue(watch.sourceSnapshot),
    objectValue(watch.searchIdentity),
    objectValue(watch.spec),
    objectValue(watch.identityCandidate),
    objectValue(observation.sourceSnapshot),
    objectValue(observation.identityCandidate),
    observation,
  ].filter(Boolean);

  const product = firstField(sources, ['product', 'family']);
  if (!product) return '';

  const processing = phrase(firstField(sources, ['processing']));
  const variety = phrase(firstField(sources, ['variety']));
  const productPhrase = phrase(product);
  const category = phrase(firstField(sources, ['category']));
  const subcategory = phrase(firstField(sources, ['cut', 'subcategory']));
  const brand = phrase(firstField(sources, ['brand', 'brandName']), { marketing: false });

  const seen = new Set();
  return [processing, variety, productPhrase, category, subcategory, brand]
    .filter((component) => {
      const key = component.toLocaleLowerCase('en');
      if (!component || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}
