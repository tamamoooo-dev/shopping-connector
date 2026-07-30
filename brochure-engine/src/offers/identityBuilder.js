// identityBuilder.js — structured extraction -> deterministic identity evidence.
//
// This is intentionally a pure boundary module. It imports no Registry, search,
// ranking, history, retailer, price, or product-id code. It never resolves or
// compares products; it only normalizes information already present in the
// structured extraction observation. lexicon/shopping.js is a pure vocabulary
// table and keeps that property.

import { resolveCategory, resolveDescriptors, DESCRIPTOR_ROLES } from '../lexicon/shopping.js';

export const IDENTITY_NORMALIZATION_MODES = Object.freeze({
  STRICT: 'strict',
  RELAXED: 'relaxed',
});

export const DEFAULT_IDENTITY_NORMALIZATION_MODE = IDENTITY_NORMALIZATION_MODES.STRICT;

const CANDIDATE_FIELDS = Object.freeze([
  'brand', 'family', 'cut', 'processing', 'variety', 'package', 'size', 'count',
]);
const STRING_INPUT_FIELDS = Object.freeze([
  'brand', 'productName', 'arabicName', 'size', 'family', 'cut', 'processing',
  'variety', 'package',
]);

const ARABIC_DIACRITICS = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED]/gu;
const ARABIC_DIGITS = new Map([
  ...[...'٠١٢٣٤٥٦٧٨٩'].map((digit, index) => [digit, String(index)]),
  ...[...'۰۱۲۳۴۵۶۷۸۹'].map((digit, index) => [digit, String(index)]),
]);

export function normalizeIdentityMode(value, fallback = DEFAULT_IDENTITY_NORMALIZATION_MODE) {
  const mode = String(value || '').trim().toLowerCase();
  return mode === IDENTITY_NORMALIZATION_MODES.RELAXED
    ? IDENTITY_NORMALIZATION_MODES.RELAXED
    : mode === IDENTITY_NORMALIZATION_MODES.STRICT
      ? IDENTITY_NORMALIZATION_MODES.STRICT
      : fallback;
}

function normalizeDigits(text) {
  return [...text].map((char) => ARABIC_DIGITS.get(char) ?? char).join('');
}

export function normalizeObservationText(value) {
  if (typeof value !== 'string') return null;
  const normalized = normalizeDigits(value.normalize('NFKC'))
    .replace(/ـ/gu, '')
    .replace(ARABIC_DIACRITICS, '')
    .replace(/[یى]/gu, 'ي')
    .replace(/ک/gu, 'ك')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/ؤ/gu, 'و')
    .replace(/ئ/gu, 'ي')
    .replace(/[‘’`´]/gu, "'")
    .replace(/[‐‑‒–—―]/gu, '-')
    .replace(/[،]/gu, ',')
    .replace(/[؛]/gu, ';')
    .replace(/٫/gu, '.')
    .replace(/٬/gu, ',')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized || null;
}

function normalizeClassifierText(value) {
  return normalizeObservationText(value)
    ?.toLocaleLowerCase('en')
    .replace(/[^\p{L}\p{N}'+.-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim() || null;
}

function titleCaseLatin(text) {
  const lower = text.toLocaleLowerCase('en');
  return lower.replace(/(^|[\s\-/])([a-z])/g, (_, prefix, letter) => prefix + letter.toUpperCase());
}

function normalizeBrand(value) {
  const text = normalizeObservationText(value);
  if (!text) return null;
  return /[A-Za-z]/.test(text) ? titleCaseLatin(text) : text;
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function phrasePresent(text, phrase) {
  if (!text) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

const FAMILY_RULES = Object.freeze([
  ['Chicken', ['chicken', 'دجاج']],
  ['Turkey', ['turkey', 'ديك رومي']],
  ['Beef', ['beef', 'لحم بقري']],
  ['Lamb', ['lamb', 'mutton', 'خروف', 'ضأن']],
  ['Fish', ['fish', 'سمك']],
  ['Shrimp', ['shrimp', 'prawn', 'روبيان', 'جمبري']],
  ['Milk', ['milk', 'حليب']],
  ['Cheese', ['cheese', 'جبن', 'جبنة']],
  ['Yogurt', ['yogurt', 'yoghurt', 'زبادي']],
  ['Juice', ['juice', 'عصير']],
  ['Water', ['water', 'ماء', 'مياه']],
  ['Rice', ['rice', 'ارز']],
  ['Oil', ['oil', 'زيت']],
  ['Eggs', ['egg', 'eggs', 'بيض']],
  ['Tea', ['tea', 'شاي']],
  ['Coffee', ['coffee', 'قهوة']],
  ['Chocolate', ['chocolate', 'شوكولاتة']],
  ['Detergent', ['detergent', 'منظف']],
  ['Diapers', ['diaper', 'diapers', 'حفاض', 'حفاضات']],
]);

const CUT_RULES = Object.freeze([
  ['Breast', ['breast', 'breasts', 'صدر', 'صدور']],
  ['Thigh', ['thigh', 'thighs', 'فخذ', 'افخاذ']],
  ['Wing', ['wing', 'wings', 'جناح', 'اجنحة']],
  ['Drumstick', ['drumstick', 'drumsticks', 'دبابيس']],
  ['Fillet', ['fillet', 'fillets', 'فيليه']],
  ['Whole', ['whole', 'كامل', 'كاملة']],
  ['Minced', ['minced', 'ground', 'مفروم']],
  ['Cubes', ['cubes', 'مكعبات']],
]);

const PROCESSING_RULES = Object.freeze([
  ['Fresh', ['fresh', 'طازج', 'طازجة']],
  ['Frozen', ['frozen', 'مجمد', 'مجمدة']],
  ['Smoked', ['smoked', 'مدخن', 'مدخنة']],
  ['Canned', ['canned', 'معلب', 'معلبة']],
  ['Dried', ['dried', 'مجفف', 'مجففة']],
  ['Cooked', ['cooked', 'مطبوخ', 'مطبوخة']],
  ['Raw', ['raw', 'نيء', 'نيئة']],
  ['Pasteurized', ['pasteurized', 'pasteurised', 'مبستر', 'مبسترة']],
]);

const VARIETY_RULES = Object.freeze([
  ['Full Fat', ['full fat', 'كامل الدسم', 'كاملة الدسم']],
  ['Low Fat', ['low fat', 'قليل الدسم', 'قليلة الدسم']],
  ['Skimmed', ['skimmed', 'skim', 'خالي الدسم', 'خالية الدسم']],
  ['Basmati', ['basmati', 'بسمتي']],
  ['Jasmine', ['jasmine', 'ياسمين']],
  ['Original', ['original', 'اصلي', 'اصلية']],
  ['Spicy', ['spicy', 'حار', 'حارة']],
  ['Boneless', ['boneless', 'بدون عظم', 'خالي من العظم']],
  ['Skinless', ['skinless', 'بدون جلد', 'خالي من الجلد']],
]);

const PACKAGE_TYPE_RULES = Object.freeze([
  ['Bottle', ['bottle', 'bottles', 'زجاجة', 'زجاجات', 'قارورة', 'قوارير']],
  ['Can', ['can', 'cans', 'علبة معدنية', 'علب معدنية']],
  ['Carton', ['carton', 'cartons', 'كرتون']],
  ['Bag', ['bag', 'bags', 'كيس', 'اكياس']],
  ['Box', ['box', 'boxes', 'صندوق', 'علبة']],
  ['Pouch', ['pouch', 'pouches', 'كيس واقف']],
  ['Tray', ['tray', 'trays', 'صينية', 'صواني']],
  ['Jar', ['jar', 'jars', 'مرطبان', 'برطمان']],
  ['Tub', ['tub', 'tubs', 'عبوة بلاستيكية']],
  ['Sachet', ['sachet', 'sachets', 'ظرف', 'اظرف']],
  ['Pack', ['pack', 'packs', 'packet', 'packets', 'عبوة', 'عبوات']],
]);

// --- lexicon-backed classification (2026-07-30) ---------------------------------
// The four rule tables above are a meat-and-dairy vocabulary — 20 families, 8
// cuts, 8 processings, 9 varieties — that was being applied to a whole
// supermarket. MEASURED over 3,000 production rows: a family resolved on only
// 27.1% of offers, and just 6.9% reached the two discriminating dimensions
// registry/candidate.js requires, so 93% of the catalogue could never mint a
// product identity no matter how good the extraction was.
//
// The engine already owns the right vocabulary — lexicon/shopping.js, 382
// categories carrying family+aisle and 126 role-tagged descriptors, with
// longest-phrase matching. Same measurement against it: family 73.9%,
// mintable 52.1%. The rules below stay as the fallback for rows with no
// English name; English is the documented source of truth (HISTORY §47) and
// carries ~100% of enriched rows.
//
// TWO SAFETY PROPERTIES ARE PRESERVED DELIBERATELY, because dropping either
// showed up as a wrong identity in the measurement:
//
//   1. AMBIGUITY IS NULL, never a guess. classifyFeature() below returns null
//      when a field has conflicting evidence. A multi-product tile
//      ("Minced Mutton/Chicken/Beef") resolves three categories of equal width
//      and the raw resolver just returns the last one — so we re-resolve past
//      the winner and drop the family when a rival names a DIFFERENT family.
//      Same rule for descriptors: two distinct values in one role means null.
//
//   2. THE CATEGORY'S OWN TOKENS ARE SKIPPED when reading descriptors. Without
//      this, "Cooking Cream" yields family=cream AND variety=cream-ingredient —
//      one observation wearing two hats, which would satisfy the
//      two-dimension rule with a single piece of evidence. That is precisely
//      the merge the rule exists to prevent.
const SPAN = (span) => {
  const out = new Set();
  for (let i = span[0]; i < span[1]; i += 1) out.add(i);
  return out;
};

// The one unambiguous descriptor for a role, or null when the tile names more
// than one (assorted/multi-variant packs).
function soleDescriptor(descriptors, roles) {
  const hits = descriptors.filter((d) => roles.includes(d.role));
  if (!hits.length) return null;
  const ids = new Set(hits.map((d) => d.id));
  return ids.size === 1 ? hits[0].id : null;
}

// Lexicon ids are lowercase slugs ('mozzarella-cheese'); every value this module
// has ever emitted is Title Case ('Chicken'). The Registry compares
// identityFields ACROSS products, and 13k stored candidates already carry the
// Title Case form — emitting raw slugs would make every new reading fail to
// match its own history and silently mint duplicates. Title-casing keeps the
// overlapping vocabulary (Chicken, Cheese, Milk, Rice, Oil, Water, Juice …)
// byte-identical to what is already stored.
const candidateValue = (slug) => (slug ? titleCaseLatin(String(slug).replace(/-/g, ' ')) : null);

export function classifyFromLexicon(englishName, diagnostics = {}) {
  const name = String(englishName || '');
  const category = resolveCategory(name);
  if (!category) {
    diagnostics.lexicon = { decision: 'unresolved', category: null };
    return { family: null, variety: null };
  }
  // Rival categories: anything the taxonomy still matches once the winner's
  // own tokens are out of the way. A rival in a different family means the
  // tile is advertising more than one product line — refuse to pick.
  const skip = SPAN(category.span);
  const rival = resolveCategory(name, { skipTokens: skip });
  const rivalFamily = rival ? (rival.family || rival.aisle || rival.id) : null;
  const family = category.family || category.aisle || category.id;
  const contested = !!rival && rivalFamily !== family;

  const descriptors = resolveDescriptors(name, { skipTokens: skip }) || [];
  // The sub-type is a SECOND dimension only when the taxonomy resolved strictly
  // below the family (mozzarella-cheese under cheese). When category.id IS the
  // family, the evidence has already been spent on `family` and variety must
  // come from a descriptor instead.
  const subType = category.family && category.id !== category.family ? category.id : null;

  diagnostics.lexicon = {
    decision: contested ? 'contested' : 'classified',
    category: category.id,
    matchedPhrase: category.matched_phrase,
    rival: rival ? rival.id : null,
    descriptors: descriptors.map((d) => `${d.id}:${d.role}`),
  };

  // `cut` and `processing` are NOT taken from the lexicon. Its form/preparation
  // roles are descriptive rather than identity-bearing and measured badly here:
  // "Dove Invisible DRY Deodorant" became processing=Dried, "Juice Glass 3Pc
  // SET" became cut=Set. The legacy tables below are purpose-built for those
  // two dimensions, cover Arabic as well as English, and stay authoritative.
  return {
    family: contested ? null : candidateValue(family),
    variety: contested
      ? null
      : candidateValue(
        subType
          ?? soleDescriptor(descriptors, [
            DESCRIPTOR_ROLES.FLAVOR, DESCRIPTOR_ROLES.GRADE, DESCRIPTOR_ROLES.ATTRIBUTE,
          ]),
      ),
  };
}

function classifyFeature(field, texts, rules, diagnostics) {
  const hits = [];
  for (const [value, phrases] of rules) {
    const evidence = [];
    for (const source of texts) {
      for (const phrase of phrases) {
        if (phrasePresent(source.text, phrase)) evidence.push({ source: source.source, phrase });
      }
    }
    if (evidence.length) hits.push({ value, evidence });
  }
  if (hits.length === 1) {
    diagnostics[field] = { decision: 'classified', value: hits[0].value, evidence: hits[0].evidence };
    return hits[0].value;
  }
  if (hits.length > 1) {
    diagnostics[field] = { decision: 'conflict', value: null, matches: hits };
    return null;
  }
  diagnostics[field] = { decision: 'unresolved', value: null, evidence: [] };
  return null;
}

const STRICT_UNIT_ALIASES = Object.freeze({
  g: ['g', 'gm', 'gms', 'gram', 'grams', 'غ', 'غم', 'غرام', 'جرام'],
  kg: ['kg', 'kgs', 'kilogram', 'kilograms', 'كغ', 'كغم', 'كجم', 'كيلو', 'كيلوغرام'],
  ml: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres', 'مل'],
  l: ['l', 'ltr', 'litre', 'litres', 'liter', 'liters', 'لتر'],
});
const RELAXED_UNIT_ALIASES = Object.freeze({
  ...STRICT_UNIT_ALIASES,
  g: [...STRICT_UNIT_ALIASES.g, 'gr', 'grm'],
  kg: [...STRICT_UNIT_ALIASES.kg, 'kilo', 'kilos'],
  ml: [...STRICT_UNIT_ALIASES.ml, 'mils'],
  l: [...STRICT_UNIT_ALIASES.l, 'lt', 'lit'],
});

function unitIndex(mode) {
  const aliases = mode === IDENTITY_NORMALIZATION_MODES.RELAXED
    ? RELAXED_UNIT_ALIASES
    : STRICT_UNIT_ALIASES;
  const index = new Map();
  for (const [unit, values] of Object.entries(aliases)) {
    for (const value of values) index.set(value, unit);
  }
  return index;
}

function parseDecimal(value) {
  const number = Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

function measurementPattern(mode, flags = 'giu') {
  const aliases = [...unitIndex(mode).keys()]
    .sort((a, b) => b.length - a.length)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*(${aliases.join('|')})(?![\\p{L}])`, flags);
}

function canonicalMeasure(value, unit) {
  return `${formatNumber(value)} ${unit}`;
}

function collectMeasures(sources, mode) {
  const index = unitIndex(mode);
  const found = [];
  for (const source of sources) {
    const pattern = measurementPattern(mode);
    for (const match of source.text.matchAll(pattern)) {
      const value = parseDecimal(match[1]);
      const unit = index.get(match[2].toLocaleLowerCase('en')) || index.get(match[2]);
      if (value != null && unit) {
        found.push({ source: source.source, raw: match[0], value, unit, canonical: canonicalMeasure(value, unit) });
      }
    }
  }
  return found;
}

function countCandidates(sources, mode) {
  const out = [];
  const measure = measurementPattern(mode, 'iu').source;
  const patterns = [
    { kind: 'multiplier', re: new RegExp(`(\\d+)\\s*[x×*]\\s*${measure}`, 'iu'), count: (m) => Number(m[1]) },
    { kind: 'multiplier', re: new RegExp(`${measure}\\s*[x×*]\\s*(\\d+)`, 'iu'), count: (m) => Number(m.at(-1)) },
    { kind: 'bonus', re: /(\d+)\s*\+\s*(\d+)/u, count: (m) => Number(m[1]) + Number(m[2]), parts: (m) => ({ baseCount: Number(m[1]), bonusCount: Number(m[2]) }) },
    { kind: 'pack', re: /(\d+)\s*(?:pack|packs|pk|pcs?|pieces?|count|ct|عبوة|عبوات|حبة|حبات|قطعة|قطع)\b/iu, count: (m) => Number(m[1]) },
    { kind: 'apostrophe-count', re: /(\d+)\s*['’]s\b/iu, count: (m) => Number(m[1]) },
  ];
  for (const source of sources) {
    for (const pattern of patterns) {
      const match = pattern.re.exec(source.text);
      if (match) {
        out.push({ source: source.source, kind: pattern.kind, raw: match[0], count: pattern.count(match), ...(pattern.parts ? pattern.parts(match) : {}) });
      }
    }
  }
  return out;
}

function explicitCount(value) {
  if (value == null || value === '') return null;
  const count = typeof value === 'number' ? value : Number(normalizeDigits(String(value)).trim());
  return Number.isInteger(count) ? count : NaN;
}

function parsePackaging(normalized, rawInput, mode, rejected, warnings) {
  const sources = [
    ['size', normalized.size],
    ['productName', normalized.productName],
    ['arabicName', normalized.arabicName],
    ['package', normalized.package],
  ].filter(([, text]) => text).map(([source, text]) => ({ source, text: text.toLocaleLowerCase('en') }));
  const measures = collectMeasures(sources, mode);
  const uniqueMeasures = [...new Map(measures.map((item) => [item.canonical, item])).values()];
  const observedCounts = countCandidates(sources, mode);
  const rangePattern = new RegExp(`\\d+(?:[.,]\\d+)?\\s*[-–—]\\s*${measurementPattern(mode, 'iu').source}`, 'iu');
  const hasRange = sources.some(({ text }) => rangePattern.test(text));
  let size = null;
  if (hasRange) {
    rejected.push({ field: 'size', reason: 'Size range is ambiguous and cannot become one canonical size', value: rawInput.size ?? null });
  } else if (uniqueMeasures.length === 1) {
    const candidate = uniqueMeasures[0];
    const max = mode === IDENTITY_NORMALIZATION_MODES.STRICT
      ? (candidate.unit === 'kg' || candidate.unit === 'l' ? 100 : 100_000)
      : (candidate.unit === 'kg' || candidate.unit === 'l' ? 10_000 : 1_000_000);
    if (!(candidate.value > 0 && candidate.value <= max)) {
      rejected.push({ field: 'size', reason: `Size is outside the ${mode} deterministic range`, value: candidate.raw });
    } else {
      size = { value: candidate.value, unit: candidate.unit };
    }
  } else if (uniqueMeasures.length > 1) {
    if (mode === IDENTITY_NORMALIZATION_MODES.STRICT) {
      rejected.push({ field: 'size', reason: 'Conflicting package measurements', value: uniqueMeasures.map((item) => item.canonical) });
    } else {
      size = { value: uniqueMeasures[0].value, unit: uniqueMeasures[0].unit };
      warnings.push({ field: 'size', reason: 'Relaxed mode selected the first of multiple visible measurements', ignored: uniqueMeasures.slice(1).map((item) => item.canonical) });
    }
  } else if (normalized.size && /\d/u.test(normalized.size)
      && !observedCounts.some((item) => item.source === 'size')) {
    rejected.push({ field: 'size', reason: 'Numeric size has no supported visible unit', value: rawInput.size });
  }

  const explicit = explicitCount(rawInput.count);
  if (Number.isNaN(explicit)) rejected.push({ field: 'count', reason: 'Explicit count is not an integer', value: rawInput.count });
  if (Number.isInteger(explicit)) observedCounts.unshift({ source: 'count', kind: 'explicit', raw: rawInput.count, count: explicit });
  const uniqueCounts = [...new Map(observedCounts.map((item) => [item.count, item])).values()];
  let count = null;
  const maxCount = mode === IDENTITY_NORMALIZATION_MODES.STRICT ? 500 : 9_999;
  if (uniqueCounts.length > 1) {
    rejected.push({ field: 'count', reason: 'Conflicting package counts', value: uniqueCounts.map((item) => item.count) });
  } else if (uniqueCounts.length === 1) {
    const value = uniqueCounts[0].count;
    if (!(Number.isInteger(value) && value >= 1 && value <= maxCount)) {
      rejected.push({ field: 'count', reason: `Count is outside the ${mode} deterministic range`, value });
    } else {
      count = value;
    }
  } else if (size) {
    count = 1;
  }

  const classificationDiagnostics = {};
  const packageType = classifyFeature('package', sources, PACKAGE_TYPE_RULES, classificationDiagnostics);
  const packageConflict = classificationDiagnostics.package?.decision === 'conflict';
  if (packageConflict) {
    rejected.push({ field: 'package', reason: 'Conflicting visible package types', value: classificationDiagnostics.package.matches.map((match) => match.value) });
  }
  const countEvidence = uniqueCounts.length === 1 ? uniqueCounts[0] : null;
  const expression = countEvidence
    ? countEvidence.kind === 'bonus'
      ? `${countEvidence.baseCount}+${countEvidence.bonusCount}`
      : countEvidence.kind === 'multiplier' && size
        ? `${countEvidence.count}x${canonicalMeasure(size.value, size.unit)}`
        : String(countEvidence.raw).trim().toLocaleLowerCase('en')
    : null;
  const packageValue = !packageConflict && (packageType || expression)
    ? { type: packageType || 'Pack', expression }
    : null;

  return {
    size,
    count,
    package: packageValue,
    diagnostics: {
      measures,
      uniqueMeasures: uniqueMeasures.map((item) => item.canonical),
      countCandidates: observedCounts,
      selectedSize: size,
      selectedCount: count,
      selectedPackage: packageValue,
      packageClassification: classificationDiagnostics.package,
    },
  };
}

function safeInputSnapshot(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input ?? null;
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value]));
}

export function buildIdentityCandidate(input, { mode, now = () => Date.now() } = {}) {
  const started = now();
  const selectedMode = normalizeIdentityMode(mode);
  const observation = safeInputSnapshot(input);
  const rejectedFields = [];
  const warnings = [];
  const normalizedValues = {};

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    const identityCandidate = Object.fromEntries(CANDIDATE_FIELDS.map((field) => [field, null]));
    return {
      identityCandidate,
      diagnostics: {
        mode: selectedMode,
        extractionInput: observation,
        normalizedValues,
        parsingDecisions: {},
        classificationDecisions: {},
        validationResult: { valid: false, status: 'invalid', errors: ['Structured extraction must be an object'], warnings: [] },
        rejectedFields: [{ field: '$', reason: 'Structured extraction must be an object', value: observation }],
        unresolvedFields: CANDIDATE_FIELDS,
        processingTimeMs: Math.max(0, now() - started),
      },
    };
  }

  for (const field of STRING_INPUT_FIELDS) {
    const value = input[field];
    if (value == null || value === '') {
      normalizedValues[field] = null;
    } else if (typeof value !== 'string') {
      normalizedValues[field] = null;
      rejectedFields.push({ field, reason: 'Expected a string observation', value });
    } else {
      normalizedValues[field] = normalizeObservationText(value);
      const limit = field === 'productName' || field === 'arabicName' ? 400 : 120;
      if (normalizedValues[field]?.length > limit) {
        rejectedFields.push({ field, reason: `Normalized field exceeds ${limit} characters`, value });
        normalizedValues[field] = null;
      }
    }
  }
  const confidence = input.confidence == null
    ? null
    : typeof input.confidence === 'number' && Number.isFinite(input.confidence) && input.confidence >= 0 && input.confidence <= 1
      ? input.confidence
      : null;
  normalizedValues.confidence = confidence;
  if (input.confidence != null && confidence == null) {
    rejectedFields.push({ field: 'confidence', reason: 'Confidence must be a number from 0 to 1', value: input.confidence });
  }

  const classificationSources = [
    ['productName', normalizedValues.productName],
    ['arabicName', normalizedValues.arabicName],
    ['family', normalizedValues.family],
    ['cut', normalizedValues.cut],
    ['processing', normalizedValues.processing],
    ['variety', normalizedValues.variety],
  ].filter(([, value]) => value).map(([source, value]) => ({ source, text: normalizeClassifierText(value) }));
  const classificationDecisions = {};
  // English is the source of truth (HISTORY §47). The legacy rule tables remain
  // the fallback for the rare row that carries no English name at all, so an
  // Arabic-only observation still classifies as well as it ever did.
  const lexical = normalizedValues.productName
    ? classifyFromLexicon(normalizedValues.productName, classificationDecisions)
    : null;
  const legacy = (field, rules) =>
    classifyFeature(field, classificationSources, rules, classificationDecisions);
  // THE LEXICON IS THE GATE; THE LEGACY TABLE IS THE REFINEMENT.
  //
  // Neither vocabulary dominates the other, so neither one wins outright:
  //
  //   • The lexicon knows what IS a product. The legacy table classifies by
  //     bare token presence, so "Prayer Mat Turkey" became poultry and a
  //     degreaser became Fish. When the lexicon resolves no category at all,
  //     the answer is null — the legacy table may not invent one.
  //   • The legacy table is more PRECISE where it does fire. The lexicon
  //     collapses lamb/turkey/beef into one `meat` family; the legacy rules
  //     keep them apart, and 13k stored candidates already carry those exact
  //     values. Preferring legacy inside the gate keeps every existing product
  //     identity comparable instead of orphaning it behind a renamed family.
  //
  // So: no category => null. Category + legacy hit => the legacy value.
  // Category + legacy silent => the lexicon value (this is the new coverage).
  const gated = (lexicalValue, legacyValue) =>
    (lexical ? (lexicalValue == null ? null : legacyValue ?? lexicalValue) : legacyValue);
  const family = gated(lexical?.family, legacy('family', FAMILY_RULES));
  const variety = gated(lexical?.variety, legacy('variety', VARIETY_RULES));
  const cut = legacy('cut', CUT_RULES);
  const processing = legacy('processing', PROCESSING_RULES);
  for (const field of ['family', 'cut', 'processing', 'variety']) {
    if (classificationDecisions[field]?.decision === 'conflict') {
      rejectedFields.push({ field, reason: 'Conflicting visible classification evidence', value: classificationDecisions[field].matches.map((match) => match.value) });
    }
  }

  const packaging = parsePackaging(normalizedValues, input, selectedMode, rejectedFields, warnings);
  const identityCandidate = {
    brand: normalizeBrand(normalizedValues.brand),
    family,
    cut,
    processing,
    variety,
    package: packaging.package,
    size: packaging.size,
    count: packaging.count,
  };
  const unresolvedFields = CANDIDATE_FIELDS.filter((field) => identityCandidate[field] == null);
  const errors = rejectedFields.map((item) => `${item.field}: ${item.reason}`);
  const hasEvidence = CANDIDATE_FIELDS.some((field) => identityCandidate[field] != null);
  const valid = errors.length === 0;
  const status = valid
    ? unresolvedFields.length ? 'valid_partial' : 'valid_complete'
    : hasEvidence ? 'partial_with_rejections' : 'invalid';

  return {
    identityCandidate,
    diagnostics: {
      mode: selectedMode,
      extractionInput: observation,
      normalizedValues,
      parsingDecisions: {
        size: packaging.diagnostics.selectedSize,
        package: packaging.diagnostics.selectedPackage,
        count: packaging.diagnostics.selectedCount,
        evidence: packaging.diagnostics,
      },
      classificationDecisions,
      validationResult: { valid, status, errors, warnings },
      rejectedFields,
      unresolvedFields,
      processingTimeMs: Math.max(0, now() - started),
    },
  };
}
