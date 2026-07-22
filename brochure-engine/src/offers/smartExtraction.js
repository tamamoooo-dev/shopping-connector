// smartExtraction.js — source-only product observation admission and merge.
//
// This module deliberately stops at extraction. It has no storage, Registry,
// identity, search, ranking, history, or product-normalization dependency.
// Vision is authoritative in strategies that invoke it; deterministic OCR
// parsing fills fields Vision left missing. OCR-first/only are independent,
// OCR-authoritative strategies and never require a Vision observation.

import { parseSize } from '../matching.js';
import { matchBrandToken } from '../browse/brands.js';

export const EXTRACTION_STRATEGIES = Object.freeze({
  VISION_FIRST: 'vision-first',
  OCR_FIRST: 'ocr-first',
  VISION_ONLY: 'vision-only',
  OCR_ONLY: 'ocr-only',
});

export const DEFAULT_EXTRACTION_STRATEGY = EXTRACTION_STRATEGIES.VISION_FIRST;
export const EXTRACTION_FIELDS = Object.freeze(['name_en', 'name_ar', 'brand', 'size', 'pack_count']);

const STRATEGY_ALIASES = new Map([
  ['vision first', EXTRACTION_STRATEGIES.VISION_FIRST],
  ['vision-first', EXTRACTION_STRATEGIES.VISION_FIRST],
  ['vision_first', EXTRACTION_STRATEGIES.VISION_FIRST],
  ['ocr first', EXTRACTION_STRATEGIES.OCR_FIRST],
  ['ocr-first', EXTRACTION_STRATEGIES.OCR_FIRST],
  ['ocr_first', EXTRACTION_STRATEGIES.OCR_FIRST],
  ['vision only', EXTRACTION_STRATEGIES.VISION_ONLY],
  ['vision-only', EXTRACTION_STRATEGIES.VISION_ONLY],
  ['vision_only', EXTRACTION_STRATEGIES.VISION_ONLY],
  ['ocr only', EXTRACTION_STRATEGIES.OCR_ONLY],
  ['ocr-only', EXTRACTION_STRATEGIES.OCR_ONLY],
  ['ocr_only', EXTRACTION_STRATEGIES.OCR_ONLY],
]);

export function normalizeExtractionStrategy(value, fallback = DEFAULT_EXTRACTION_STRATEGY) {
  const key = String(value || '').trim().toLowerCase();
  return STRATEGY_ALIASES.get(key) || fallback;
}

const PROMO_LINE = /^(?:each|ea|pc|pcs|per\s+(?:pack|kg|item)|special\s+(?:offer|price)|super\s+deal|offer|assorted|limited\s+stock|before|best\s+price|save|free|new|rewards?|الحبة|للحبة|عرض\s+خاص|وفر|مجانا)$/iu;
const PRICE_ONLY = /^[\s#~€$£₹₽﷼ر.\-+%\d٠-٩۰-۹,]+$/u;
const PRICE_IN_FIELD = /(?:^|\s)(?:sar|sr|ريال|رس)\.?\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*(?:sar|sr|ريال|رس)(?=\s|[.,;:]|$)/iu;
const IMAGE_MARKER = /^!\[[^\]]*\]\([^)]*\)$/u;
const SPEC_LINE = /^(?:[-•*]\s*)?(?:battery|memory|ram|screen|front\s+camera|back\s+camera|camera|network|white\s+stick|model|warranty)\b/iu;
const CORRUPTION_SIGNATURE = /"box_2d"\s*:|<table[\s>]|<td[\s>]|colspan\\?=/iu;
const GENERIC_FIRST_WORD = new Set([
  'the', 'new', 'best', 'fresh', 'special', 'offer', 'assorted', 'mixed',
  'حليب', 'دجاج', 'أرز', 'ارز', 'جبنة', 'جبن', 'عرض',
]);
const SIZE_PATTERN = /(?:\d+(?:[.,]\d+)?|[٠-٩۰-۹]+(?:[.,][٠-٩۰-۹]+)?)\s*(?:fl\.?\s*oz|portions?|servings?|gb|tb|gm|kg|kgs|ml|cl|ltr|litres?|liters?|g|l|oz|lb|كغم|كجم|كيلو(?:غرام)?|غرام|جرام|غم|مل|لتر|قطعة|قطع|حبة|حبات)(?:\s*[xX×*\/]\s*(?:\d+(?:[.,]\d+)?|[٠-٩۰-۹]+(?:[.,][٠-٩۰-۹]+)?)\s*(?:fl\.?\s*oz|portions?|servings?|gb|tb|gm|kg|kgs|ml|cl|ltr|litres?|liters?|g|l|oz|lb|كغم|كجم|كيلو(?:غرام)?|غرام|جرام|غم|مل|لتر|قطعة|قطع|حبة|حبات)?)?/giu;
const SALE_SIZE_SYNTAX = /(?:\d|[٠-٩۰-۹])\s*(?:fl\.?\s*oz|portions?|servings?|gm|kg|kgs|ml|cl|ltr|litres?|liters?|g|l|oz|lb|كغم|كجم|كيلو(?:غرام)?|غرام|جرام|غم|مل|لتر|قطعة|قطع|حبة|حبات)\b/iu;
const PACK_WORD = '(?:packs?|pk|pcs?|pieces?|counts?|ct|portions?|servings?|rolls?|bags?|cans?|bottles?|tablets?|tabs?|capsules?|sachets?|diapers?|عبوات?|أكياس?|رولات?|لفات?|علب|قوارير|أقراص|كبسولات|حفاضات|قطعة|قطع|حبة|حبات)';
const MEASURE_WORD = '(?:fl\\.?\\s*oz|gm|kg|kgs|ml|cl|ltr|litres?|liters?|g|l|oz|lb|كغم|كجم|كيلو(?:غرام)?|غرام|جرام|غم|مل|لتر)';

const present = (value) => typeof value === 'string' && value.trim().length > 0;

function asciiDigits(value) {
  return String(value || '').replace(/[٠-٩۰-۹]/gu, (digit) => {
    const code = digit.codePointAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

// Extract only an explicitly printed package-count expression. This is source
// observation parsing, not product interpretation: no count is created unless
// the Vision/OCR text itself contains a multiplier, bonus, or count word.
export function parseVisiblePackCount(value, { allowStandaloneMultiplier = false, allowBareCount = false } = {}) {
  if (!present(value)) return null;
  const raw = String(value).trim();
  const text = asciiDigits(raw);
  const candidates = [
    { kind: 'buy_get', re: /\bbuy\s*(\d{1,3})\s*(?:get|plus)\s*(\d{1,3})(?:\s*free)?\b/iu, count: (m) => Number(m[1]) + Number(m[2]) },
    { kind: 'bonus', re: /\b(\d{1,3})\s*\+\s*(\d{1,3})\b/u, count: (m) => Number(m[1]) + Number(m[2]) },
    { kind: 'apostrophe_count', re: /\b(\d{1,3})\s*['’]s\b/iu, count: (m) => Number(m[1]) },
    { kind: 'compact_count', re: /\b(\d{1,3})s\b/iu, count: (m) => Number(m[1]) },
    { kind: 'count_word', re: new RegExp(`\\b(\\d{1,3})\\s*${PACK_WORD}\\b`, 'iu'), count: (m) => Number(m[1]) },
    // Prefix form: 6x200 ml, 12 x 23g, or 5X130/140/145Gm.
    { kind: 'multiplier', re: /\b(\d{1,3})\s*[x×*]\s*(?=\d)/iu, count: (m) => Number(m[1]) },
    // Reverse form: 200 ml x 6. Return the visible multiplier suffix only.
    { kind: 'multiplier', re: new RegExp(`\\b\\d+(?:[.,]\\d+)?\\s*${MEASURE_WORD}\\s*([x×*]\\s*(\\d{1,3}))\\b`, 'iu'), count: (m) => Number(m[2]), expression: (m) => m[1] },
  ];
  if (allowStandaloneMultiplier) {
    candidates.push(
      { kind: 'multiplier', re: /^\s*(\d{1,3})\s*[x×*]\s*$/iu, count: (m) => Number(m[1]) },
      { kind: 'multiplier', re: /^\s*[x×*]\s*(\d{1,3})\s*$/iu, count: (m) => Number(m[1]) },
    );
  }
  if (allowBareCount) {
    candidates.push({ kind: 'bare_count', re: /^\s*(\d{1,3})\s*$/u, count: (m) => Number(m[1]) });
  }
  for (const candidate of candidates) {
    const match = candidate.re.exec(text);
    if (!match) continue;
    const count = candidate.count(match);
    if (!Number.isInteger(count) || count < 1 || count > 500) continue;
    const expressionText = candidate.expression ? candidate.expression(match) : match[0];
    const offset = candidate.expression ? match.index + match[0].lastIndexOf(expressionText) : match.index;
    return {
      expression: raw.slice(offset, offset + expressionText.length).trim(),
      count,
      kind: candidate.kind,
    };
  }
  return null;
}

function visiblePackEvidence(candidates) {
  const sizeUnit = parseSize('', candidates.size)?.unit ?? null;
  const explicit = parseVisiblePackCount(candidates.pack_count, {
    allowStandaloneMultiplier: true,
    allowBareCount: ['g', 'kg', 'ml', 'l'].includes(sizeUnit),
  });
  // Embedded count evidence in size/name is stronger than a separate model
  // field because it preserves the exact visible context (for example 5X145g).
  for (const field of ['size', 'name_en', 'name_ar']) {
    const parsed = parseVisiblePackCount(candidates[field], { allowStandaloneMultiplier: field === 'pack_count' });
    if (parsed) return {
      ...parsed,
      field,
      text: String(candidates[field]).trim(),
      conflictingExplicitCount: explicit && explicit.count !== parsed.count ? explicit.count : null,
    };
  }
  return explicit ? { ...explicit, field: 'pack_count', text: String(candidates.pack_count).trim(), conflictingExplicitCount: null } : null;
}

function scriptCounts(text) {
  return {
    arabic: (String(text).match(/[\p{Script=Arabic}]/gu) || []).length,
    latin: (String(text).match(/[A-Za-z]/g) || []).length,
  };
}

function isNoiseLine(text) {
  return !text
    || PROMO_LINE.test(text)
    || PRICE_ONLY.test(text)
    || SPEC_LINE.test(text)
    || /^\d{6,}$/u.test(text)
    || /^\p{Sc}/u.test(text)
    || /^[-–—]\s*\d/u.test(text)
    || /^\d+(?:[.,]\d+)?%$/u.test(text);
}

function fieldDecision(field, value, usable, source) {
  if (!usable) {
    return { status: 'Rejected', value: null, candidate: null, reasons: [`${source} response was unavailable or malformed`] };
  }
  if (!present(value)) {
    return { status: 'Missing', value: null, candidate: null, reasons: [`${source} returned null or no value`] };
  }
  const candidate = String(value).trim();
  const reasons = [];
  if (candidate.length > (field.startsWith('name_') ? 400 : 120)) {
    reasons.push('Candidate exceeds deterministic field length limit');
  }
  if (isNoiseLine(candidate)) {
    reasons.push('Candidate is promotional, price-only, specification-only, or identifier noise');
  }
  if (PRICE_IN_FIELD.test(candidate)) reasons.push('Candidate contains a price or currency fragment');
  if (field === 'name_en' && scriptCounts(candidate).latin < 2) {
    reasons.push('Candidate lacks required English script evidence');
  }
  if (field === 'name_ar' && scriptCounts(candidate).arabic < 2) {
    reasons.push('Candidate lacks required Arabic script evidence');
  }
  if (field === 'size' && !parseSize('', candidate)?.unit) {
    reasons.push('Candidate is not accepted by the production size parser');
  }
  if (field === 'pack_count' && !parseVisiblePackCount(candidate, { allowStandaloneMultiplier: true })) {
    reasons.push('Candidate lacks a bounded visible package-count expression');
  }
  if (field === 'brand' && parseSize('', candidate)?.unit) {
    reasons.push('Brand cannot be only a package size');
  }
  return reasons.length
    ? { status: 'Rejected', value: null, candidate, reasons }
    : { status: 'Accepted', value: candidate, candidate, reasons: [] };
}

function directVisionSizeEvidence(candidates) {
  for (const field of ['name_en', 'name_ar', 'brand']) {
    if (!present(candidates[field])) continue;
    const parsed = parseSize(String(candidates[field]), '');
    if (parsed?.unit) {
      return { visible: true, field, text: String(candidates[field]).trim(), parsed };
    }
  }
  return { visible: false, field: null, text: null, parsed: null };
}

export function parseVisionObject(text) {
  try {
    const match = /\{[\s\S]*\}/.exec(String(text || ''));
    const value = JSON.parse(match ? match[0] : text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, value: null, error: 'Vision response is not a JSON object' };
    }
    return { ok: true, value, error: null };
  } catch (error) {
    return { ok: false, value: null, error: `Vision JSON parse failed: ${error.message}` };
  }
}

export function validateVisionOutput(output, { usable = true, error = null } = {}) {
  const objectOk = usable && output && typeof output === 'object' && !Array.isArray(output);
  const candidates = {
    name_en: objectOk ? output.name_en : null,
    name_ar: objectOk ? output.name_ar : null,
    brand: objectOk ? output.brand : null,
    size: objectOk ? output.size : null,
    pack_count: objectOk ? (output.pack_count ?? output.packCount) : null,
  };
  const fields = Object.fromEntries(
    EXTRACTION_FIELDS.map((field) => [field, fieldDecision(field, candidates[field], objectOk, 'Vision')]),
  );
  // Repair only an explicit field-placement error: a measurement such as
  // "80g Each" cannot be a package count, but it remains direct Vision text
  // and can populate a missing size without guessing.
  if (fields.size.status === 'Missing' && fields.pack_count.status === 'Rejected') {
    const misplacedSize = String(fields.pack_count.candidate || '').trim();
    if (SALE_SIZE_SYNTAX.test(misplacedSize) && parseSize('', misplacedSize)?.unit) {
      fields.size = {
        status: 'Accepted', value: misplacedSize, candidate: misplacedSize, reasons: [],
        method: 'deterministic-vision-field-mapping', evidenceField: 'pack_count',
      };
    }
  }
  const packEvidence = visiblePackEvidence(candidates);
  if ((fields.pack_count.status !== 'Accepted' && packEvidence)
      || (fields.pack_count.status === 'Accepted' && packEvidence?.field !== 'pack_count')) {
    fields.pack_count = {
      status: 'Accepted',
      value: packEvidence.expression,
      candidate: packEvidence.expression,
      reasons: [],
      method: 'deterministic-visible-vision-text-rule',
      evidenceField: packEvidence.field,
      count: packEvidence.count,
    };
  }
  // A directly visible piece count is also the sale size for a count-based
  // product. Preserve the same visible expression in both structured fields.
  if (fields.size.status === 'Missing' && fields.pack_count.status === 'Accepted'
      && parseSize('', fields.pack_count.value)?.unit === 'pcs') {
    fields.size = {
      status: 'Accepted', value: fields.pack_count.value, candidate: fields.pack_count.value,
      reasons: [], method: 'deterministic-count-size-mapping', evidenceField: 'pack_count',
    };
  }
  if (fields.name_en.status === 'Accepted'
      && fields.name_ar.status === 'Accepted'
      && fields.name_en.value === fields.name_ar.value) {
    const reason = 'English and Arabic fields cannot contain the same bilingual candidate';
    fields.name_en = { ...fields.name_en, status: 'Rejected', value: null, reasons: [reason] };
    fields.name_ar = { ...fields.name_ar, status: 'Rejected', value: null, reasons: [reason] };
  }
  const triggers = [];
  const add = (code, affectedFields = [], detail = null) => {
    if (!triggers.some((item) => item.code === code)) triggers.push({ code, fields: affectedFields, detail });
  };
  if (!objectOk) add('malformed_or_unusable_vision', EXTRACTION_FIELDS, error || 'Vision output was unavailable or unusable');
  if (fields.name_en.status !== 'Accepted' && fields.name_ar.status !== 'Accepted') {
    add('product_name_missing', ['name_en', 'name_ar']);
  }
  if (fields.name_en.status !== 'Accepted') add('english_product_name_missing_or_invalid', ['name_en']);
  if (fields.name_ar.status !== 'Accepted') add('arabic_product_name_missing_or_invalid', ['name_ar']);
  if (fields.brand.status !== 'Accepted') add('brand_missing_or_invalid', ['brand']);
  const sizeEvidence = directVisionSizeEvidence(candidates);
  if (fields.size.status === 'Missing' && sizeEvidence.visible && fields.pack_count.status !== 'Accepted') {
    add('size_missing_with_direct_vision_text_evidence', ['size'], sizeEvidence);
  }
  const rejected = EXTRACTION_FIELDS.filter((field) => fields[field].status === 'Rejected');
  // Size is optional. Retry a rejected size only when the rejected observation
  // still contains direct sale-size syntax; specs such as watts/cm and bare
  // numbers have no deterministic package-size recovery target for OCR.
  const retryableRejected = rejected.filter((field) => field !== 'pack_count'
    && (field !== 'size' || SALE_SIZE_SYNTAX.test(String(fields[field].candidate || ''))));
  if (retryableRejected.length) {
    add('required_field_validation_failure', retryableRejected, retryableRejected.map((field) => ({ field, reasons: fields[field].reasons })));
  }
  const confidence = typeof output?.confidence === 'number'
    && Number.isFinite(output.confidence)
    && output.confidence >= 0
    && output.confidence <= 1
    ? output.confidence
    : null;
  return {
    ruleVersion: 'vision-primary-smart-ocr-trigger-v2',
    confidenceUsedForAdmission: false,
    confidence,
    fields,
    acceptedFields: EXTRACTION_FIELDS.filter((field) => fields[field].status === 'Accepted'),
    rejectedFields: rejected,
    missingFields: EXTRACTION_FIELDS.filter((field) => fields[field].status === 'Missing'),
    sizeVisibilityEvidence: sizeEvidence,
    packCountEvidence: packEvidence,
    triggerDecisions: triggers,
    triggerReasons: triggers.map((trigger) => trigger.code),
    ocrRequired: triggers.length > 0,
  };
}

function lineRecords(markdown) {
  return String(markdown || '').replaceAll('\r', '').split('\n').map((raw, index) => {
    const trimmed = raw.trim();
    const heading = /^#{1,6}\s+/.test(trimmed);
    const text = trimmed
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*]\s+(?=\p{L})/u, '')
      .replace(/^\*\*/u, '')
      .replace(/\*\*$/u, '')
      .trim();
    return { index, text, heading };
  }).filter(({ text }) => text && !IMAGE_MARKER.test(text));
}

function pureSize(text) {
  SIZE_PATTERN.lastIndex = 0;
  return !String(text).replace(SIZE_PATTERN, '').replace(/[()\s/,+-]/g, '');
}

function candidateGroups(records, language) {
  const groups = [];
  let current = [];
  for (const record of records) {
    const counts = scriptCounts(record.text);
    const matches = language === 'en'
      ? counts.latin >= 2 && counts.latin >= counts.arabic
      : counts.arabic >= 2 && counts.arabic > counts.latin;
    const eligible = matches && !isNoiseLine(record.text) && !pureSize(record.text);
    if (!eligible || (current.length && record.index !== current.at(-1).index + 1)) {
      if (current.length) groups.push(current);
      current = [];
    }
    if (eligible) current.push(record);
  }
  if (current.length) groups.push(current);
  return groups;
}

function chooseName(records, language) {
  const script = language === 'en' ? 'latin' : 'arabic';
  const headings = records.filter((record) => {
    const counts = scriptCounts(record.text);
    const matches = language === 'en'
      ? counts.latin >= 2 && counts.latin >= counts.arabic
      : counts.arabic >= 2 && counts.arabic > counts.latin;
    return record.heading && matches && !isNoiseLine(record.text) && !pureSize(record.text);
  });
  if (headings.length) return { value: headings.at(-1).text, evidenceLines: [headings.at(-1).index] };
  const scored = candidateGroups(records, language).map((group) => {
    const value = group.map((row) => row.text).join('\n');
    const words = value.split(/\s+/u).filter(Boolean).length;
    const letters = scriptCounts(value)[script];
    return { value, evidenceLines: group.map((row) => row.index), score: words * 3 + Math.min(letters, 100) + group.at(-1).index * 0.2 };
  }).sort((a, b) => b.score - a.score);
  return scored[0] ?? { value: null, evidenceLines: [] };
}

function chooseBrand(records, names) {
  const nameLines = new Set([...names.name_en.evidenceLines, ...names.name_ar.evidenceLines]);
  for (const record of [...records.filter((row) => nameLines.has(row.index)), ...records]) {
    for (const word of record.text.split(/\s+/u).filter(Boolean)) {
      if (matchBrandToken(word)) return { value: word, evidenceLines: [record.index], method: 'visible-known-brand-token' };
    }
  }
  const first = String(names.name_en.value || '').split(/\s+/u)[0]?.replace(/[^A-Za-z0-9'’-]/gu, '') || null;
  if (first && first.length >= 3 && !GENERIC_FIRST_WORD.has(first.toLowerCase()) && /^[A-Z][A-Za-z0-9'’-]+$/u.test(first)) {
    return { value: first, evidenceLines: names.name_en.evidenceLines.slice(0, 1), method: 'visible-caption-leading-proper-token' };
  }
  return { value: null, evidenceLines: [], method: null };
}

function chooseSize(records, names) {
  const nameLines = new Set([...names.name_en.evidenceLines, ...names.name_ar.evidenceLines]);
  const prioritized = [...records.filter((record) => nameLines.has(record.index)), ...records];
  const matches = [];
  const seen = new Set();
  for (const record of prioritized) {
    SIZE_PATTERN.lastIndex = 0;
    for (const match of record.text.matchAll(SIZE_PATTERN)) {
      const value = match[0].trim();
      const key = `${record.index}:${value}`;
      if (!seen.has(key)) {
        seen.add(key);
        matches.push({ value, line: record.index, source: record.text });
      }
    }
  }
  const valid = matches.filter((match) => parseSize('', match.value)?.unit);
  valid.sort((a, b) => ((/[xX×*\/]/u.test(b.value) ? 1000 : 0) + b.value.length)
    - ((/[xX×*\/]/u.test(a.value) ? 1000 : 0) + a.value.length) || a.line - b.line);
  return { value: valid[0]?.value ?? null, evidenceLines: valid[0] ? [valid[0].line] : [], candidates: matches };
}

function choosePackCount(records, names) {
  const nameLines = new Set([...names.name_en.evidenceLines, ...names.name_ar.evidenceLines]);
  const prioritized = [...records.filter((record) => nameLines.has(record.index)), ...records];
  const matches = [];
  const seen = new Set();
  for (const record of prioritized) {
    const parsed = parseVisiblePackCount(record.text);
    if (!parsed) continue;
    const key = `${record.index}:${parsed.expression}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({ ...parsed, line: record.index, source: record.text });
  }
  matches.sort((a, b) => {
    const score = (item) => (item.kind === 'bonus' || item.kind === 'buy_get' ? 1_000 : 0)
      + (item.kind === 'multiplier' ? 500 : 0) + item.expression.length;
    return score(b) - score(a) || a.line - b.line;
  });
  const selected = matches[0] || null;
  return {
    value: selected?.expression ?? null,
    evidenceLines: selected ? [selected.line] : [],
    method: selected ? 'deterministic-visible-package-rule' : null,
    candidates: matches,
  };
}

export function validateOcrOutput(markdown, { usable = true, error = null } = {}) {
  const raw = typeof markdown === 'string' ? markdown : '';
  const globalReasons = [];
  const transportOk = usable && raw.trim().length > 0;
  if (!transportOk) globalReasons.push(error || 'OCR response was unavailable or empty');
  if (raw.length > 20_000) globalReasons.push(`OCR output length ${raw.length} exceeds 20,000 characters`);
  if (CORRUPTION_SIGNATURE.test(raw)) globalReasons.push('Layout/table serialization signature detected');
  if (raw.replaceAll('\r', '').split('\n').some((line) => line.length > 1_000)) {
    globalReasons.push('Pathological OCR line longer than 1,000 characters');
  }
  const catastrophic = !transportOk || globalReasons.length > 0;
  const records = lineRecords(raw);
  const names = { name_en: chooseName(records, 'en'), name_ar: chooseName(records, 'ar') };
  const candidates = {
    name_en: names.name_en,
    name_ar: names.name_ar,
    brand: chooseBrand(records, names),
    size: chooseSize(records, names),
    pack_count: choosePackCount(records, names),
  };
  const fields = Object.fromEntries(EXTRACTION_FIELDS.map((field) => {
    const candidate = candidates[field];
    const decision = fieldDecision(field, candidate.value, !catastrophic, 'OCR');
    return [field, { ...decision, evidenceLines: candidate.evidenceLines || [], method: candidate.method || 'deterministic-visible-text-rule' }];
  }));
  // OCR providers do not return a trustworthy field-level confidence. Derive
  // an auditable 0..1 score from validated visible-field coverage instead of
  // borrowing Vision confidence or inventing model certainty.
  const confidenceWeights = { name_en: 0.3, name_ar: 0.3, brand: 0.15, size: 0.15, pack_count: 0.1 };
  const confidence = catastrophic
    ? null
    : Number(EXTRACTION_FIELDS.reduce(
      (score, field) => score + (fields[field].status === 'Accepted' ? confidenceWeights[field] : 0),
      0,
    ).toFixed(2));
  return {
    ruleVersion: 'ocr-field-admission-v1',
    confidenceUsedForAdmission: false,
    confidence,
    confidenceMethod: 'validated-visible-field-coverage-v1',
    global: { transportOk, catastrophic, reasons: globalReasons },
    fields,
    acceptedFields: EXTRACTION_FIELDS.filter((field) => fields[field].status === 'Accepted'),
    rejectedFields: EXTRACTION_FIELDS.filter((field) => fields[field].status === 'Rejected'),
    missingFields: EXTRACTION_FIELDS.filter((field) => fields[field].status === 'Missing'),
    sizeCandidates: candidates.size.candidates,
    packCountCandidates: candidates.pack_count.candidates,
  };
}

export function emptySourceValidation(source) {
  return {
    ruleVersion: `${source.toLowerCase()}-not-invoked`,
    confidence: null,
    fields: Object.fromEntries(EXTRACTION_FIELDS.map((field) => [field, {
      status: 'NotInvoked', value: null, candidate: null, reasons: [],
    }])),
    acceptedFields: [],
    rejectedFields: [],
    missingFields: [],
  };
}

export function mergeValidatedExtractions(visionValidation, ocrValidation) {
  const final = {};
  const provenance = {};
  const decisions = {};
  const ignoredOcrConflicts = [];
  for (const field of EXTRACTION_FIELDS) {
    const vision = visionValidation?.fields?.[field];
    const ocr = ocrValidation?.fields?.[field];
    if (vision?.status === 'Accepted') {
      final[field] = vision.value;
      provenance[field] = 'Vision';
      decisions[field] = { action: 'preserve_accepted_vision', value: vision.value };
      if (ocr?.status === 'Accepted' && ocr.value !== vision.value) {
        ignoredOcrConflicts.push({ field, visionValue: vision.value, ignoredOcrValue: ocr.value });
      }
    } else if (ocr?.status === 'Accepted') {
      final[field] = ocr.value;
      provenance[field] = 'OCR';
      decisions[field] = { action: `ocr_completed_${String(vision?.status || 'absent').toLowerCase()}_vision_field`, value: ocr.value };
    } else {
      final[field] = null;
      provenance[field] = 'Null';
      decisions[field] = { action: 'remain_null', visionStatus: vision?.status || 'NotInvoked', ocrStatus: ocr?.status || 'NotInvoked' };
    }
  }
  provenance.confidence = visionValidation?.confidence != null ? 'Vision' : 'Null';
  const preserved = (visionValidation?.acceptedFields || []).every(
    (field) => final[field] === visionValidation.fields[field].value && provenance[field] === 'Vision',
  );
  if (!preserved) throw new Error('Accepted Vision preservation invariant violated');
  return {
    final,
    provenance,
    decisions,
    acceptedVisionFieldsPreserved: true,
    acceptedVisionFieldsOverwritten: 0,
    ignoredOcrConflicts,
  };
}

export async function runSmartExtraction({
  strategy,
  runVision,
  runOcr,
  now = () => Date.now(),
} = {}) {
  const selectedStrategy = normalizeExtractionStrategy(strategy);
  const started = now();
  let vision = null;
  let ocr = null;
  let visionValidation = emptySourceValidation('Vision');
  let ocrValidation = emptySourceValidation('OCR');
  let visionRequests = 0;
  let ocrRequests = 0;

  const invokeVision = async () => {
    visionRequests += 1;
    vision = await runVision();
    const parsed = vision?.parsedObject
      ? { ok: true, value: vision.parsedObject, error: null }
      : parseVisionObject(vision?.rawReply);
    visionValidation = validateVisionOutput(parsed.value, { usable: parsed.ok, error: parsed.error });
  };
  const invokeOcr = async () => {
    ocrRequests += 1;
    ocr = await runOcr();
    ocrValidation = validateOcrOutput(ocr?.rawOutput, {
      usable: typeof ocr?.rawOutput === 'string' && ocr.rawOutput.trim().length > 0,
      error: ocr?.error || null,
    });
  };

  if (selectedStrategy === EXTRACTION_STRATEGIES.OCR_FIRST) {
    await invokeOcr();
  } else if (selectedStrategy === EXTRACTION_STRATEGIES.OCR_ONLY) {
    await invokeOcr();
  } else {
    await invokeVision();
    if (selectedStrategy === EXTRACTION_STRATEGIES.VISION_FIRST && visionValidation.ocrRequired) {
      await invokeOcr();
    }
  }

  const merge = mergeValidatedExtractions(visionValidation, ocrValidation);
  const ocrAuthoritative = selectedStrategy === EXTRACTION_STRATEGIES.OCR_FIRST
    || selectedStrategy === EXTRACTION_STRATEGIES.OCR_ONLY;
  const confidence = ocrAuthoritative ? ocrValidation.confidence : visionValidation.confidence;
  const confidenceProvenance = confidence == null ? 'Null' : ocrAuthoritative ? 'OCR' : 'Vision';
  const structured = {
    brand: merge.final.brand,
    productName: merge.final.name_en,
    arabicName: merge.final.name_ar,
    size: merge.final.size,
    packCount: merge.final.pack_count,
    count: parseVisiblePackCount(merge.final.pack_count, { allowStandaloneMultiplier: true, allowBareCount: true })?.count ?? null,
  };
  const reason = ocrRequests
    ? (selectedStrategy === EXTRACTION_STRATEGIES.VISION_FIRST
      ? visionValidation.triggerReasons
      : [`strategy_${selectedStrategy.replaceAll('-', '_')}`])
    : (selectedStrategy === EXTRACTION_STRATEGIES.VISION_ONLY && visionValidation.ocrRequired
      ? ['ocr_disabled_by_vision_only_strategy', ...visionValidation.triggerReasons]
      : ['vision_validation_complete']);

  return {
    extraction: structured,
    confidence,
    provenance: {
      brand: merge.provenance.brand,
      productName: merge.provenance.name_en,
      arabicName: merge.provenance.name_ar,
      size: merge.provenance.size,
      packCount: merge.provenance.pack_count,
      count: merge.provenance.pack_count,
      confidence: confidenceProvenance,
    },
    diagnostics: {
      strategy: selectedStrategy,
      visionOutput: vision?.parsedObject ?? parseVisionObject(vision?.rawReply).value,
      validationResult: visionValidation,
      ocrTriggered: ocrRequests > 0,
      triggerReason: reason,
      ocrOutput: ocr?.rawOutput ?? null,
      ocrValidationResult: ocrValidation,
      finalMergedExtraction: structured,
      fieldProvenance: {
        brand: merge.provenance.brand,
        productName: merge.provenance.name_en,
        arabicName: merge.provenance.name_ar,
        size: merge.provenance.size,
        packCount: merge.provenance.pack_count,
        count: merge.provenance.pack_count,
        confidence: confidenceProvenance,
      },
      processingTimeMs: Math.max(0, now() - started),
      visionRequests,
      ocrRequests,
      acceptedVisionFieldsOverwritten: merge.acceptedVisionFieldsOverwritten,
      ignoredOcrConflicts: merge.ignoredOcrConflicts,
    },
  };
}
