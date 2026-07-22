/**
 * Vision-first / smarter selective OCR fallback validation — same 50 crops.
 *
 * Isolation contract:
 * - Never imported by the Worker or any production path.
 * - Reads the prior Vision-first manifest verbatim plus both stored baselines.
 * - Writes only inside this directory.
 * - Has no D1, KV, R2, Registry, migration, deployment, or production-write path.
 * - Uses one provider attempt per invoked model; retries are intentionally absent.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeText, parseSize } from '../../src/matching.js';
import { BRAND_BY_SLUG, detectBrand, matchBrandToken } from '../../src/browse/brands.js';
import { visionMatchText } from '../../src/storage/enrichStore.js';
import { buildVisionRequest, DEFAULT_MODEL, VISION_PROMPT } from '../../src/offers/enrich.js';
import { parseVisiblePackCount } from '../../src/offers/smartExtraction.js';
import { loadMistralKeys } from '../../local-secrets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULT_DIR = join(HERE, 'regression-resolution-accepted-v3');
mkdirSync(RESULT_DIR, { recursive: true });
const OCR_FIRST_DIR = join(HERE, '..', 'ocr-first-production-validation-1000-2026-07-21');
const PRIOR_VISION_DIR = join(HERE, '..', 'vision-first-ocr-fallback-50-2026-07-22');
const PRIOR_MANIFEST = join(PRIOR_VISION_DIR, 'manifest.json');
const PRIOR_OBSERVATIONS = join(PRIOR_VISION_DIR, 'observations.json');
const MANIFEST_FILE = join(RESULT_DIR, 'manifest.json');
const CHECKPOINT_FILE = join(RESULT_DIR, 'observations.jsonl');
const OBSERVATIONS_FILE = join(RESULT_DIR, 'observations.json');
const METRICS_FILE = join(RESULT_DIR, 'metrics.json');
const SUMMARY_FILE = join(RESULT_DIR, 'summary.md');
const COMPARISON_FILE = join(RESULT_DIR, 'comparison.md');
const FAILURE_FILE = join(RESULT_DIR, 'failure-analysis.json');

const SAMPLE_COUNT = 50;
const SEED = 'mistral-cost-benchmark-50-2026-07-21-v1';
const EXPECTED_SAMPLE_DIGEST = '9eb9c73cbd6f7995dd335e05447c94cf7864a06fe81aae448a63308930f8b499';
const EXPECTED_PROMPT_DIGEST = '6d9c9ca64ac64779bfc7e96a12f5f4c4e46a1755f4ddf693427db59dc81dbf15';
const OCR_MODEL = 'mistral-ocr-latest';
const OCR_URL = 'https://api.mistral.ai/v1/ocr';
const VISION_URL = 'https://api.mistral.ai/v1/chat/completions';
const REQUEST_TIMEOUT_MS = 60_000;
const SOURCE_FIELDS = ['name_en', 'name_ar', 'brand', 'size', 'pack_count'];
const VISION_FIELDS = ['name_en', 'name_ar', 'brand', 'size', 'pack_count'];
const DERIVED_FIELDS = ['normalized_name', 'parsed_size', 'canonical_brand', 'package_quantity'];

// Copied unchanged from the existing OCR-first validation admission rules.
const PROMO_LINE = /^(?:each|ea|pc|pcs|per\s+(?:pack|kg|item)|special\s+(?:offer|price)|super\s+deal|offer|assorted|limited\s+stock|before|best\s+price|save|free|new|rewards?|الحبة|للحبة|عرض\s+خاص|وفر|مجانا)$/iu;
const PRICE_ONLY = /^[\s#~€$£₹₽﷼ر\.\-+%\d٠-٩۰-۹,]+$/u;
const IMAGE_MARKER = /^!\[[^\]]*\]\([^)]*\)$/u;
const SPEC_LINE = /^(?:[-•*]\s*)?(?:battery|memory|ram|screen|front\s+camera|back\s+camera|camera|network|white\s+stick|model|warranty)\b/iu;
const SIZE_PATTERN = /(?:\d+(?:[.,]\d+)?|[٠-٩۰-۹]+(?:[.,][٠-٩۰-۹]+)?)\s*(?:fl\.?\s*oz|portions?|servings?|gb|tb|gm|kg|kgs|ml|cl|ltr|litres?|liters?|g|l|oz|lb|كغم|كجم|كيلو(?:غرام)?|غرام|جرام|غم|مل|لتر|قطعة|قطع|حبة|حبات)(?:\s*[xX×*\/]\s*(?:\d+(?:[.,]\d+)?|[٠-٩۰-۹]+(?:[.,][٠-٩۰-۹]+)?)\s*(?:fl\.?\s*oz|portions?|servings?|gb|tb|gm|kg|kgs|ml|cl|ltr|litres?|liters?|g|l|oz|lb|كغم|كجم|كيلو(?:غرام)?|غرام|جرام|غم|مل|لتر|قطعة|قطع|حبة|حبات)?)?/giu;
const SALE_SIZE_SYNTAX = /(?:\d|[٠-٩۰-۹])\s*(?:fl\.?\s*oz|portions?|servings?|gm|kg|kgs|ml|cl|ltr|litres?|liters?|g|l|oz|lb|كغم|كجم|كيلو(?:غرام)?|غرام|جرام|غم|مل|لتر|قطعة|قطع|حبة|حبات)\b/iu;
const PACK_PATTERN = /(?:\d+\s*(?:pcs?|pieces?|portions?|servings?|rolls?|bags?|cans?|bottles?|tablets?|tabs?|capsules?|sachets?|diapers?|قطعة|قطع|حبة|حبات|عبوات?|أكياس?|رولات?|لفات?|علب|قوارير|أقراص|كبسولات|حفاضات)|\d+\s*(?:\+\s*\d+)|(?:[xX×]\s*\d+)|(?:\d+\s*[xX×]))/giu;
const CORRUPTION_SIGNATURE = /"box_2d"\s*:|<table[\s>]|<td[\s>]|colspan\\?=/iu;
const GENERIC_FIRST_WORD = new Set(['the', 'new', 'best', 'fresh', 'special', 'offer', 'assorted', 'mixed', 'حليب', 'دجاج', 'أرز', 'ارز', 'جبنة', 'جبن', 'عرض']);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function textPresent(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function percent(value, total) {
  return total ? round((value / total) * 100, 2) : 0;
}

function countBy(values, key) {
  const out = {};
  for (const value of values) {
    const name = typeof key === 'function' ? key(value) : value[key];
    out[name ?? 'null'] = (out[name ?? 'null'] || 0) + 1;
  }
  return out;
}

function seededRandom(seed) {
  let h = 2166136261 >>> 0;
  for (const char of seed) {
    h ^= char.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function prepare() {
  const priorManifest = JSON.parse(readFileSync(PRIOR_MANIFEST, 'utf8'));
  const priorRows = JSON.parse(readFileSync(PRIOR_OBSERVATIONS, 'utf8'));
  const priorById = new Map(priorRows.map((row) => [row.id, row]));
  if (priorManifest.sample_count !== SAMPLE_COUNT || priorManifest.samples.length !== SAMPLE_COUNT) {
    throw new Error(`Prior manifest must contain exactly ${SAMPLE_COUNT} samples`);
  }
  const samples = priorManifest.samples.map((sample, index) => {
    const prior = priorById.get(sample.id);
    if (!prior || prior.benchmark_index !== index + 1 || prior.source_index !== sample.index) {
      throw new Error(`Prior Vision-first observation mismatch: ${sample.id}`);
    }
    return {
      ...sample,
      benchmark_index: index + 1,
      baseline_vision_first: {
        ocr_fallback_required: prior.ocr_fallback_required,
        ocr_fallback_reasons: prior.ocr_fallback_reasons,
        final_enrichment: prior.final_enrichment,
        provenance: prior.provenance,
        api_attempts: (prior.vision?.attempt_count || 0) + (prior.ocr?.attempt_count || 0),
        elapsed_ms: prior.elapsed_ms,
      },
    };
  });
  const digest = sha256(samples.map((sample) => `${sample.id}\0${sample.crop.sha256}`).join('\n'));
  if (digest !== EXPECTED_SAMPLE_DIGEST || digest !== priorManifest.ordered_set_sha256) {
    throw new Error(`Frozen sample digest mismatch: ${digest}`);
  }
  const promptDigest = sha256(VISION_PROMPT);
  if (promptDigest !== EXPECTED_PROMPT_DIGEST) {
    throw new Error(`Vision prompt changed: ${promptDigest}`);
  }
  const manifest = {
    experiment: 'Vision-first with smarter selective OCR fallback — same 50 crops',
    created_at: new Date().toISOString(),
    seed: SEED,
    selection_method: 'Verbatim ordered reuse of the prior Vision-first 50-crop manifest; no replacement or reshuffle.',
    sample_count: samples.length,
    retailer_count: new Set(samples.map((sample) => sample.store)).size,
    category_count: new Set(samples.map((sample) => sample.category)).size,
    ordered_set_sha256: digest,
    source_manifest: '../vision-first-ocr-fallback-50-2026-07-22/manifest.json',
    source_observations: '../vision-first-ocr-fallback-50-2026-07-22/observations.json',
    prompt_source: '../../src/offers/enrich.js#VISION_PROMPT',
    prompt_sha256: promptDigest,
    models: { vision: DEFAULT_MODEL, ocr: OCR_MODEL },
    retry_policy: 'disabled; exactly one attempt per invoked model',
    trigger_policy: 'OCR only for missing product name, missing Arabic product name, missing brand, missing/invalid size when deterministic Vision-text size evidence exists, malformed/unusable Vision, or required-field validation failure; confidence is ignored',
    samples,
  };
  writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function singleCall(model, operation) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  try {
    const final = await operation();
    return {
      model,
      success: true,
      attempt_count: 1,
      started_at: startedAt,
      duration_ms: Math.round(performance.now() - started),
      http_status: final.http_status,
      final,
    };
  } catch (error) {
    return {
      model,
      success: false,
      attempt_count: 1,
      started_at: startedAt,
      duration_ms: Math.round(performance.now() - started),
      http_status: error?.http_status ?? null,
      error: String(error?.message || error),
      raw_http_body: error?.raw_http_body ?? null,
      final: null,
    };
  }
}

async function postJson(url, body, apiKey) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}: ${rawBody.slice(0, 300)}`), {
      http_status: response.status,
      raw_http_body: rawBody,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (error) {
    throw Object.assign(new Error(`Malformed JSON: ${error.message}`), { http_status: response.status, raw_http_body: rawBody });
  }
  return { response, rawBody, parsed };
}

function parseJsonObject(value) {
  const text = String(value || '').trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON object found');
    return JSON.parse(match[0]);
  }
}

async function runVision(sample, bytes, apiKey) {
  return singleCall(DEFAULT_MODEL, async () => {
    const { response, rawBody, parsed } = await postJson(VISION_URL, buildVisionRequest({
      model: DEFAULT_MODEL,
      contentType: sample.crop.content_type,
      base64: bytes.toString('base64'),
    }), apiKey);
    const rawOutput = parsed?.choices?.[0]?.message?.content;
    if (!textPresent(rawOutput)) throw Object.assign(new Error('Vision content is empty'), { http_status: response.status });
    const object = parseJsonObject(rawOutput);
    return {
      http_status: response.status,
      raw_http_body: rawBody,
      raw_output: rawOutput,
      parsed_output: object,
      response_model: parsed?.model ?? null,
      response_usage: parsed?.usage ?? null,
      finish_reason: parsed?.choices?.[0]?.finish_reason ?? null,
      prompt_sha256: sha256(VISION_PROMPT),
    };
  });
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

function visionFieldDecision(field, value, transportOk) {
  if (!transportOk) return { status: 'Rejected', value: null, candidate: null, reasons: ['Vision transport/API/parsing failure'] };
  if (!textPresent(value)) return { status: 'Missing', value: null, candidate: null, reasons: ['Vision returned null or no value'] };
  const candidate = String(value).trim();
  const reasons = [];
  if (candidate.length > (field.startsWith('name_') ? 400 : 120)) reasons.push('Candidate exceeds deterministic field length limit');
  if (isNoiseLine(candidate)) reasons.push('Candidate is promotional, price-only, specification-only, or identifier noise');
  if (field === 'name_en' && scriptCounts(candidate).latin < 2) reasons.push('Candidate lacks required English script evidence');
  if (field === 'name_ar' && scriptCounts(candidate).arabic < 2) reasons.push('Candidate lacks required Arabic script evidence');
  if (field === 'size' && !parseSize('', candidate)?.unit) reasons.push('Candidate is not accepted by the production size parser');
  if (field === 'pack_count' && !parseVisiblePackCount(candidate, { allowStandaloneMultiplier: true })) reasons.push('Candidate lacks a bounded visible package-count expression');
  if (reasons.length) return { status: 'Rejected', value: null, candidate, reasons };
  return { status: 'Accepted', value: candidate, candidate, reasons: [] };
}

function directVisionSizeEvidence(candidates) {
  const sources = ['name_en', 'name_ar', 'brand'];
  for (const field of sources) {
    if (!textPresent(candidates[field])) continue;
    const parsed = parseSize(String(candidates[field]), '');
    if (parsed?.unit) {
      return {
        visible: true,
        field,
        text: String(candidates[field]).trim(),
        parsed,
        method: 'production parseSize over raw Vision textual fields',
      };
    }
  }
  return {
    visible: false,
    field: null,
    text: null,
    parsed: null,
    method: 'production parseSize over raw Vision textual fields',
  };
}

function directVisionPackEvidence(candidates) {
  const sizeUnit = parseSize('', candidates.size)?.unit ?? null;
  const explicit = parseVisiblePackCount(candidates.pack_count, {
    allowStandaloneMultiplier: true,
    allowBareCount: ['g', 'kg', 'ml', 'l'].includes(sizeUnit),
  });
  for (const field of ['size', 'name_en', 'name_ar']) {
    if (!textPresent(candidates[field])) continue;
    const parsed = parseVisiblePackCount(candidates[field]);
    if (parsed) return {
      ...parsed, field, text: String(candidates[field]).trim(),
      conflicting_explicit_count: explicit && explicit.count !== parsed.count ? explicit.count : null,
    };
  }
  return explicit ? { ...explicit, field: 'pack_count', text: String(candidates.pack_count).trim(), conflicting_explicit_count: null } : null;
}

function admitVision(vision) {
  const object = vision?.success ? vision.final?.parsed_output || {} : {};
  const candidates = {
    name_en: object.name_en,
    name_ar: object.name_ar,
    brand: object.brand,
    size: object.size,
    pack_count: object.pack_count ?? object.packCount,
  };
  const fields = Object.fromEntries(VISION_FIELDS.map((field) => [field, visionFieldDecision(field, candidates[field], Boolean(vision?.success))]));
  if (fields.size.status === 'Missing' && fields.pack_count.status === 'Rejected') {
    const misplacedSize = String(fields.pack_count.candidate || '').trim();
    if (SALE_SIZE_SYNTAX.test(misplacedSize) && parseSize('', misplacedSize)?.unit) {
      fields.size = {
        status: 'Accepted', value: misplacedSize, candidate: misplacedSize, reasons: [],
        method: 'deterministic-vision-field-mapping', evidence_field: 'pack_count',
      };
    }
  }
  const packEvidence = directVisionPackEvidence(candidates);
  if ((fields.pack_count.status !== 'Accepted' && packEvidence)
      || (fields.pack_count.status === 'Accepted' && packEvidence?.field !== 'pack_count')) {
    fields.pack_count = {
      status: 'Accepted', value: packEvidence.expression, candidate: packEvidence.expression,
      reasons: [], method: 'deterministic-visible-vision-text-rule', evidence_field: packEvidence.field,
      count: packEvidence.count,
    };
  }
  if (fields.size.status === 'Missing' && fields.pack_count.status === 'Accepted'
      && parseSize('', fields.pack_count.value)?.unit === 'pcs') {
    fields.size = {
      status: 'Accepted', value: fields.pack_count.value, candidate: fields.pack_count.value,
      reasons: [], method: 'deterministic-count-size-mapping', evidence_field: 'pack_count',
    };
  }
  const accepted = VISION_FIELDS.filter((field) => fields[field].status === 'Accepted');
  const sizeVisibility = directVisionSizeEvidence(candidates);
  const triggers = [];
  const addTrigger = (code, fields = [], detail = null) => {
    if (!triggers.some((trigger) => trigger.code === code)) triggers.push({ code, fields, detail });
  };
  if (!vision?.success || !object || typeof object !== 'object' || Array.isArray(object)) {
    addTrigger('malformed_or_unusable_vision', VISION_FIELDS, vision?.error || 'Vision response was unavailable or unusable');
  }
  if (fields.name_en.status !== 'Accepted' && fields.name_ar.status !== 'Accepted') {
    addTrigger('product_name_missing', ['name_en', 'name_ar']);
  }
  if (fields.name_en.status !== 'Accepted') addTrigger('english_product_name_missing_or_invalid', ['name_en']);
  if (fields.name_ar.status !== 'Accepted') addTrigger('arabic_product_name_missing_or_invalid', ['name_ar']);
  if (fields.brand.status !== 'Accepted') addTrigger('brand_missing_or_invalid', ['brand']);
  if (fields.size.status === 'Missing' && sizeVisibility.visible && fields.pack_count.status !== 'Accepted') {
    addTrigger('size_missing_with_direct_vision_text_evidence', ['size'], sizeVisibility);
  }
  const rejectedRequired = VISION_FIELDS.filter((field) => fields[field].status === 'Rejected'
    && field !== 'pack_count'
    && (field !== 'size' || SALE_SIZE_SYNTAX.test(String(fields[field].candidate || ''))));
  if (rejectedRequired.length) {
    addTrigger('required_field_validation_failure', rejectedRequired, rejectedRequired.map((field) => ({ field, reasons: fields[field].reasons })));
  }
  return {
    rule_version: 'vision-primary-smart-ocr-trigger-v2',
    confidence_used_for_admission: false,
    fields,
    accepted_fields: accepted,
    rejected_fields: VISION_FIELDS.filter((field) => fields[field].status === 'Rejected'),
    missing_fields: VISION_FIELDS.filter((field) => fields[field].status === 'Missing'),
    size_visibility_evidence: sizeVisibility,
    pack_count_evidence: packEvidence,
    trigger_decisions: triggers,
    required_failures: triggers.map((trigger) => trigger.code),
    ocr_required: triggers.length > 0,
  };
}

async function runOcr(sample, bytes, apiKey) {
  return singleCall(OCR_MODEL, async () => {
    const { response, rawBody, parsed } = await postJson(OCR_URL, {
      model: OCR_MODEL,
      document: { type: 'image_url', image_url: `data:${sample.crop.content_type};base64,${bytes.toString('base64')}` },
    }, apiKey);
    if (!Array.isArray(parsed?.pages) || parsed.pages.length === 0) throw Object.assign(new Error('OCR response has no pages'), { http_status: response.status });
    const rawOutput = parsed.pages.map((page) => page?.markdown ?? '').join('\n').trim();
    if (!rawOutput) throw Object.assign(new Error('OCR page text is empty'), { http_status: response.status });
    return {
      http_status: response.status,
      raw_http_body: rawBody,
      raw_output: rawOutput,
      parsed_output: parsed,
      response_model: parsed?.model ?? null,
      response_usage: parsed?.usage_info ?? parsed?.usage ?? null,
    };
  });
}

function lineRecords(markdown) {
  return String(markdown || '').replaceAll('\r', '').split('\n').map((raw, index) => {
    const trimmed = raw.trim();
    const heading = /^#{1,6}\s+/.test(trimmed);
    const text = trimmed.replace(/^#{1,6}\s+/, '').replace(/^[-*]\s+(?=\p{L})/u, '').replace(/^\*\*/u, '').replace(/\*\*$/u, '').trim();
    return { index, raw: trimmed, text, heading };
  }).filter(({ text }) => text && !IMAGE_MARKER.test(text));
}

function pureSize(text) {
  const stripped = String(text).replace(SIZE_PATTERN, '').replace(PACK_PATTERN, '').replace(/[()\s/,+-]/g, '');
  return !stripped;
}

function candidateGroups(records, language) {
  const groups = [];
  let current = [];
  for (const record of records) {
    const counts = scriptCounts(record.text);
    const matches = language === 'en' ? counts.latin >= 2 && counts.latin >= counts.arabic : counts.arabic >= 2 && counts.arabic > counts.latin;
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
  const headings = records.filter((record) => {
    const counts = scriptCounts(record.text);
    const matches = language === 'en' ? counts.latin >= 2 && counts.latin >= counts.arabic : counts.arabic >= 2 && counts.arabic > counts.latin;
    return record.heading && matches && !isNoiseLine(record.text) && !pureSize(record.text);
  });
  if (headings.length) return { value: headings.at(-1).text, evidence_lines: [headings.at(-1).index] };
  const scored = candidateGroups(records, language).map((group) => {
    const value = group.map((row) => row.text).join('\n');
    const words = value.split(/\s+/u).filter(Boolean).length;
    const letters = scriptCounts(value)[language === 'en' ? 'latin' : 'arabic'];
    return { value, evidence_lines: group.map((row) => row.index), score: words * 3 + Math.min(letters, 100) + group.at(-1).index * 0.2 };
  }).sort((a, b) => b.score - a.score);
  return scored[0] ?? { value: null, evidence_lines: [] };
}

function chooseBrand(records, names) {
  const nameLines = new Set([...names.name_en.evidence_lines, ...names.name_ar.evidence_lines]);
  for (const record of [...records.filter((row) => nameLines.has(row.index)), ...records]) {
    for (const word of record.text.split(/\s+/u).filter(Boolean)) {
      if (matchBrandToken(word)) return { value: word, evidence_lines: [record.index], method: 'production-known-brand-token' };
    }
  }
  const first = String(names.name_en.value || '').split(/\s+/u)[0]?.replace(/[^A-Za-z0-9'’-]/gu, '') || null;
  if (first && first.length >= 3 && !GENERIC_FIRST_WORD.has(first.toLowerCase()) && /^[A-Z][A-Za-z0-9'’-]+$/u.test(first)) {
    return { value: first, evidence_lines: names.name_en.evidence_lines.slice(0, 1), method: 'caption-leading-proper-token' };
  }
  return { value: null, evidence_lines: [], method: null };
}

function allMatches(records, pattern) {
  const matches = [];
  for (const record of records) {
    pattern.lastIndex = 0;
    for (const match of record.text.matchAll(pattern)) matches.push({ value: match[0].trim(), line: record.index, offset: match.index ?? 0, source: record.text });
  }
  return matches;
}

function chooseSize(records, names) {
  const prioritized = [...records.filter((record) => names.name_en.evidence_lines.includes(record.index) || names.name_ar.evidence_lines.includes(record.index)), ...records];
  const seen = new Set();
  const matches = allMatches(prioritized, SIZE_PATTERN).filter((match) => {
    const key = `${match.line}:${match.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const valid = matches.filter((match) => parseSize('', match.value)?.unit);
  valid.sort((a, b) => ((/[xX×*\/]/u.test(b.value) ? 1000 : 0) + b.value.length) - ((/[xX×*\/]/u.test(a.value) ? 1000 : 0) + a.value.length) || a.line - b.line);
  return { value: valid[0]?.value ?? null, evidence_lines: valid[0] ? [valid[0].line] : [], candidates: matches };
}

function choosePackCount(records, names) {
  const prioritized = [...records.filter((record) => names.name_en.evidence_lines.includes(record.index) || names.name_ar.evidence_lines.includes(record.index)), ...records];
  const matches = allMatches(prioritized, PACK_PATTERN);
  matches.sort((a, b) => ((/\+/u.test(b.value) ? 1000 : 0) + (/[xX×*]/u.test(b.value) ? 500 : 0) + b.value.length) - ((/\+/u.test(a.value) ? 1000 : 0) + (/[xX×*]/u.test(a.value) ? 500 : 0) + a.value.length) || a.line - b.line);
  return { value: matches[0]?.value ?? null, evidence_lines: matches[0] ? [matches[0].line] : [], source_text: matches[0]?.source ?? null, candidates: matches };
}

function packNumber(value) {
  const numbers = String(value || '').match(/\d+/g)?.map(Number) || [];
  if (!numbers.length) return null;
  return /\+/u.test(value) ? numbers.reduce((sum, number) => sum + number, 0) : numbers.at(-1);
}

function validPackCount(value, sourceText = value, { requireContextForMultiplier = false } = {}) {
  const text = String(value || '').trim();
  if (!text || /\*/u.test(text)) return false;
  PACK_PATTERN.lastIndex = 0;
  if (!PACK_PATTERN.test(text)) return false;
  const count = packNumber(text);
  if (!(count >= 1 && count <= 99)) return false;
  const multiplierOnly = /^[xX×]\s*\d+$|^\d+\s*[xX×]$/u.test(text);
  if (requireContextForMultiplier && multiplierOnly) {
    SIZE_PATTERN.lastIndex = 0;
    const hasSize = SIZE_PATTERN.test(String(sourceText || ''));
    const hasPackWord = /pcs?|pieces?|portions?|servings?|rolls?|bags?|cans?|bottles?|tablets?|tabs?|capsules?|sachets?|diapers?|قطعة|قطع|حبة|حبات|عبوات?|أكياس?|رولات?|لفات?|علب|قوارير|أقراص|كبسولات|حفاضات/iu.test(String(sourceText || ''));
    if (!hasSize && !hasPackWord) return false;
  }
  return true;
}

function ocrFieldDecision(field, candidate, global) {
  if (!global.transport_ok || global.catastrophic) return { status: 'Rejected', value: null, candidate: candidate.value ?? null, reasons: global.reasons, evidence_lines: candidate.evidence_lines || [] };
  if (!textPresent(candidate.value)) return { status: 'Missing', value: null, candidate: null, reasons: ['No deterministic OCR candidate for this field'], evidence_lines: [] };
  const reasons = [];
  if (String(candidate.value).length > (field.startsWith('name_') ? 400 : 120)) reasons.push('Candidate exceeds deterministic field length limit');
  if (isNoiseLine(String(candidate.value))) reasons.push('Candidate is promotional, price-only, specification-only, or identifier noise');
  if (field.startsWith('name_') && scriptCounts(candidate.value)[field === 'name_en' ? 'latin' : 'arabic'] < 2) reasons.push('Candidate lacks the required script evidence');
  if (field === 'size' && !parseSize('', candidate.value)?.unit) reasons.push('Candidate is not accepted by the production size parser');
  if (field === 'pack_count' && !validPackCount(candidate.value, candidate.source_text, { requireContextForMultiplier: true })) reasons.push('Candidate lacks a bounded, package-context count expression');
  if (reasons.length) return { status: 'Rejected', value: null, candidate: candidate.value, reasons, evidence_lines: candidate.evidence_lines || [] };
  return { status: 'Accepted', value: candidate.value, candidate: candidate.value, reasons: [], evidence_lines: candidate.evidence_lines || [], method: candidate.method ?? 'deterministic-caption-rule' };
}

function admitOcr(ocr) {
  const raw = ocr?.final?.raw_output || '';
  const reasons = [];
  const transportOk = Boolean(ocr?.success && raw.trim());
  if (!transportOk) reasons.push('OCR transport/API/empty-response failure');
  if (raw.length > 20_000) reasons.push(`OCR output length ${raw.length} exceeds 20,000 characters`);
  if (CORRUPTION_SIGNATURE.test(raw)) reasons.push('Layout/table serialization signature detected');
  if (raw.replaceAll('\r', '').split('\n').some((line) => line.length > 1_000)) reasons.push('Pathological OCR line longer than 1,000 characters');
  const global = { transport_ok: transportOk, catastrophic: reasons.length > (transportOk ? 0 : 1) || (transportOk && reasons.length > 0), reasons };
  const records = lineRecords(raw);
  const names = { name_en: chooseName(records, 'en'), name_ar: chooseName(records, 'ar') };
  const candidates = { name_en: names.name_en, name_ar: names.name_ar, brand: chooseBrand(records, names), size: chooseSize(records, names), pack_count: choosePackCount(records, names) };
  const fields = Object.fromEntries(SOURCE_FIELDS.map((field) => [field, ocrFieldDecision(field, candidates[field], global)]));
  return {
    rule_version: 'ocr-field-admission-v1',
    global,
    fields,
    accepted_fields: SOURCE_FIELDS.filter((field) => fields[field].status === 'Accepted'),
    rejected_fields: SOURCE_FIELDS.filter((field) => fields[field].status === 'Rejected'),
    missing_fields: SOURCE_FIELDS.filter((field) => fields[field].status === 'Missing'),
    size_candidates: candidates.size.candidates,
    pack_count_candidates: candidates.pack_count.candidates,
  };
}

function emptyOcrAdmission() {
  return {
    rule_version: 'ocr-not-invoked',
    global: { transport_ok: null, catastrophic: false, reasons: [] },
    fields: Object.fromEntries(SOURCE_FIELDS.map((field) => [field, { status: 'NotInvoked', value: null, candidate: null, reasons: [] }])),
    accepted_fields: [], rejected_fields: [], missing_fields: [], size_candidates: [], pack_count_candidates: [],
  };
}

function mergeFields(visionAdmission, ocrAdmission) {
  const final = {};
  const provenance = {};
  const decisions = {};
  const overwrittenVisionFields = [];
  for (const field of VISION_FIELDS) {
    const vision = visionAdmission.fields[field];
    const ocr = ocrAdmission.fields[field];
    if (vision.status === 'Accepted') {
      final[field] = vision.value;
      provenance[field] = 'Vision';
      decisions[field] = { action: 'preserve_accepted_vision', value: vision.value };
      if (ocr?.status === 'Accepted' && ocr.value !== vision.value) overwrittenVisionFields.push({ field, vision_value: vision.value, ignored_ocr_value: ocr.value });
    } else if (ocr?.status === 'Accepted') {
      final[field] = ocr.value;
      provenance[field] = 'OCR';
      decisions[field] = { action: `ocr_completed_${vision.status.toLowerCase()}_vision_field`, value: ocr.value };
    } else {
      final[field] = null;
      provenance[field] = 'Null';
      decisions[field] = { action: 'remain_null', vision_status: vision.status, ocr_status: ocr?.status ?? 'NotInvoked' };
    }
  }
  const preserved = visionAdmission.accepted_fields.every((field) => final[field] === visionAdmission.fields[field].value && provenance[field] === 'Vision');
  if (!preserved) throw new Error('Accepted Vision preservation invariant violated');
  return { final, provenance, decisions, accepted_vision_fields_preserved: preserved, accepted_vision_fields_overwritten: 0, ignored_ocr_conflicts: overwrittenVisionFields };
}

function deriveProductionFields(sample, merged) {
  const name = [merged.final.brand, merged.final.name_en, merged.final.name_ar].filter(Boolean).join(' ');
  const sizeEvidence = [merged.final.size, merged.final.pack_count].filter(Boolean).join(' ');
  const parsed = parseSize(name, sizeEvidence);
  const slug = detectBrand({ source: 'd4d', category: sample.category, name: [merged.final.brand, merged.final.name_en].filter(Boolean).join(' '), nameAr: merged.final.name_ar });
  const canonical = slug ? BRAND_BY_SLUG.get(slug) : null;
  const values = {
    normalized_name: visionMatchText({ name: merged.final.name_en, name_ar: merged.final.name_ar, brand: merged.final.brand }),
    parsed_size: parsed?.src ? parsed : null,
    canonical_brand: canonical ? { slug: canonical.slug, en: canonical.en, ar: canonical.ar } : null,
    package_quantity: parsed?.src ? parsed.pack : null,
  };
  return { values, provenance: Object.fromEntries(DERIVED_FIELDS.map((field) => [field, values[field] == null ? 'Null' : 'Rule-derived'])) };
}

function compareWithBaseline(final, baseline, baselineName) {
  const weights = { name_en: 2, name_ar: 2, brand: 1, size: 1, pack_count: 0.5 };
  let currentScore = 0;
  let baselineScore = 0;
  let normalizedMatches = 0;
  let comparablePairs = 0;
  const fields = {};
  for (const field of SOURCE_FIELDS) {
    const current = final[field] ?? null;
    const prior = baseline[field] ?? null;
    if (current) currentScore += weights[field];
    if (prior) baselineScore += weights[field];
    const currentNorm = normalizeText(current || '');
    const priorNorm = normalizeText(prior || '');
    const normalizedMatch = currentNorm === priorNorm;
    if (current || prior) comparablePairs += 1;
    if (normalizedMatch && (current || prior)) normalizedMatches += 1;
    fields[field] = { current, baseline: prior, normalized_match: normalizedMatch };
  }
  const delta = currentScore - baselineScore;
  return {
    method: 'weighted deterministic completeness plus normalized field agreement; not human ground truth',
    baseline: baselineName,
    classification: delta > 0 ? 'Better' : (delta < 0 ? 'Worse' : 'Comparable'),
    current_completeness_score: currentScore,
    baseline_completeness_score: baselineScore,
    delta,
    normalized_matches: normalizedMatches,
    comparable_pairs: comparablePairs,
    fields,
  };
}

function analyzeFailures(sample, visionAdmission, ocr, merged, comparisons) {
  const categories = [];
  const details = [];
  const add = (category, detail) => {
    if (!categories.includes(category)) categories.push(category);
    details.push({ category, detail });
  };
  for (const trigger of visionAdmission.trigger_decisions) add('Vision missing or invalid required field', `${trigger.code}: ${trigger.fields.join(', ') || 'global'}`);
  for (const field of visionAdmission.rejected_fields) add('Vision field validation rejection', `${field}: ${visionAdmission.fields[field].reasons.join('; ')}`);
  if (visionAdmission.ocr_required && !ocr?.success) add('OCR technical failure', ocr?.error || 'OCR fallback failed');
  for (const trigger of visionAdmission.trigger_decisions) {
    if (trigger.fields.length && !trigger.fields.some((field) => merged.provenance[field] === 'OCR')) {
      add('OCR did not complete triggered field', `${trigger.code}: ${trigger.fields.join(', ')}`);
    }
  }
  if (sample.crop.difficulty_proxy === 'difficult' && visionAdmission.ocr_required) add('Image quality', 'Difficult image proxy required OCR fallback');
  if (merged.accepted_vision_fields_overwritten) add('Merge issue', 'Accepted Vision field was overwritten');
  if (comparisons.ocr_first.classification === 'Worse') add('Regression versus OCR-first baseline', `Completeness delta ${comparisons.ocr_first.delta}`);
  if (comparisons.vision_first.classification === 'Worse') add('Regression versus original Vision-first baseline', `Completeness delta ${comparisons.vision_first.delta}`);
  return { has_failure_signal: categories.length > 0, categories, details };
}

async function processSample(sample, apiKey) {
  const cropPath = join(HERE, sample.crop.file);
  const bytes = readFileSync(cropPath);
  if (sha256(bytes) !== sample.crop.sha256) throw new Error(`Crop hash mismatch: ${sample.id}`);
  const started = performance.now();
  const vision = await runVision(sample, bytes, apiKey);
  const visionAdmission = admitVision(vision);
  const ocr = visionAdmission.ocr_required ? await runOcr(sample, bytes, apiKey) : null;
  const ocrAdmission = ocr ? admitOcr(ocr) : emptyOcrAdmission();
  const merge = mergeFields(visionAdmission, ocrAdmission);
  const derived = deriveProductionFields(sample, merge);
  const finalEnrichment = { ...merge.final, ...derived.values };
  const comparisons = {
    ocr_first: compareWithBaseline(merge.final, sample.baseline_ocr_first.final_enrichment, 'OCR-first 50'),
    vision_first: compareWithBaseline(merge.final, sample.baseline_vision_first.final_enrichment, 'Original Vision-first 50'),
  };
  const failureAnalysis = analyzeFailures(sample, visionAdmission, ocr, merge, comparisons);
  return {
    benchmark_index: sample.benchmark_index,
    source_index: sample.index,
    id: sample.id,
    store: sample.store,
    category: sample.category,
    crop_file: sample.crop.file,
    crop_sha256: sample.crop.sha256,
    observed_at: new Date().toISOString(),
    elapsed_ms: Math.round(performance.now() - started),
    vision,
    vision_admission: visionAdmission,
    ocr_fallback_required: visionAdmission.ocr_required,
    ocr_fallback_reasons: visionAdmission.required_failures,
    ocr,
    ocr_admission: ocrAdmission,
    merge,
    derived,
    final_enrichment: finalEnrichment,
    provenance: { ...merge.provenance, ...derived.provenance },
    baseline_ocr_first: sample.baseline_ocr_first,
    baseline_vision_first: sample.baseline_vision_first,
    comparisons,
    failure_analysis: failureAnalysis,
  };
}

async function run() {
  const manifest = existsSync(MANIFEST_FILE) ? JSON.parse(readFileSync(MANIFEST_FILE, 'utf8')) : prepare();
  if (manifest.samples.length !== SAMPLE_COUNT) throw new Error('Manifest must contain exactly 50 samples');
  const apiKey = loadMistralKeys()[0];
  if (!apiKey) throw new Error('No local Mistral API key found');
  const completed = existsSync(CHECKPOINT_FILE)
    ? readFileSync(CHECKPOINT_FILE, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  if (completed.some((row, index) => row.id !== manifest.samples[index]?.id)) throw new Error('Checkpoint does not match manifest order');
  for (let i = completed.length; i < manifest.samples.length; i += 1) {
    const sample = manifest.samples[i];
    process.stdout.write(`${i + 1}/50 ${sample.id} vision`);
    const observation = await processSample(sample, apiKey);
    console.log(observation.ocr_fallback_required ? ' -> OCR' : ' -> accept');
    appendFileSync(CHECKPOINT_FILE, `${JSON.stringify(observation)}\n`, 'utf8');
    completed.push(observation);
  }
  writeFileSync(OBSERVATIONS_FILE, `${JSON.stringify(completed, null, 2)}\n`, 'utf8');
  report();
}

function report() {
  const manifest = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
  const rows = existsSync(OBSERVATIONS_FILE)
    ? JSON.parse(readFileSync(OBSERVATIONS_FILE, 'utf8'))
    : readFileSync(CHECKPOINT_FILE, 'utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
  if (rows.length !== SAMPLE_COUNT) throw new Error(`Report requires 50 observations; found ${rows.length}`);
  const visionOnly = rows.filter((row) => !row.ocr_fallback_required).length;
  const ocrFallback = rows.length - visionOnly;
  const visionAcceptedFields = rows.reduce((sum, row) => sum + row.vision_admission.accepted_fields.length, 0);
  const ocrAcceptedFields = rows.reduce((sum, row) => sum + row.ocr_admission.accepted_fields.length, 0);
  const ocrCompletedFields = rows.reduce((sum, row) => sum + SOURCE_FIELDS.filter((field) => row.provenance[field] === 'OCR').length, 0);
  const nullFields = rows.reduce((sum, row) => sum + SOURCE_FIELDS.filter((field) => row.provenance[field] === 'Null').length, 0);
  const ruleDerivedFields = rows.reduce((sum, row) => sum + DERIVED_FIELDS.filter((field) => row.provenance[field] === 'Rule-derived').length, 0);
  const visionLatency = rows.reduce((sum, row) => sum + row.vision.duration_ms, 0) / rows.length;
  const ocrRows = rows.filter((row) => row.ocr);
  const ocrLatency = ocrRows.length ? ocrRows.reduce((sum, row) => sum + row.ocr.duration_ms, 0) / ocrRows.length : 0;
  const totalRequests = rows.length + ocrRows.length;
  const ocrFirstVisionCalls = rows.filter((row) => row.baseline_ocr_first.vision_invoked).length;
  const originalVisionFirstOcrCalls = rows.filter((row) => row.baseline_vision_first.ocr_fallback_required).length;
  const comparisonMetrics = (key, baselineFinal, baselineRequests, baselineOcrCalls) => {
    const classifications = countBy(rows, (row) => row.comparisons[key].classification);
    const fieldAgreement = Object.fromEntries(SOURCE_FIELDS.map((field) => {
      const comparable = rows.filter((row) => row.comparisons[key].fields[field].current || row.comparisons[key].fields[field].baseline);
      const matches = comparable.filter((row) => row.comparisons[key].fields[field].normalized_match).length;
      return [field, { comparable: comparable.length, normalized_matches: matches, normalized_agreement_pct: percent(matches, comparable.length) }];
    }));
    return {
      classifications,
      regressions: classifications.Worse || 0,
      equal_or_better: (classifications.Better || 0) + (classifications.Comparable || 0),
      field_agreement: fieldAgreement,
      baseline_ocr_calls: baselineOcrCalls,
      current_ocr_calls: ocrFallback,
      ocr_call_delta: ocrFallback - baselineOcrCalls,
      ocr_usage_reduction_pct: baselineOcrCalls ? round(((baselineOcrCalls - ocrFallback) / baselineOcrCalls) * 100, 2) : null,
      baseline_total_api_requests: baselineRequests,
      current_total_api_requests: totalRequests,
      baseline_average_requests_per_sample: round(baselineRequests / rows.length, 3),
      current_average_requests_per_sample: round(totalRequests / rows.length, 3),
      baseline_final_null_source_fields: rows.reduce((sum, row) => sum + SOURCE_FIELDS.filter((field) => !baselineFinal(row)[field]).length, 0),
      current_final_null_source_fields: nullFields,
      quality_scope: 'Deterministic completeness and normalized output agreement; not human ground-truth accuracy.',
    };
  };
  const fallbackSamples = rows.filter((row) => row.ocr_fallback_required).map((row) => ({
    benchmark_index: row.benchmark_index,
    source_index: row.source_index,
    id: row.id,
    store: row.store,
    category: row.category,
    reasons: row.vision_admission.trigger_decisions,
    ocr_success: row.ocr?.success ?? false,
    fields_completed_by_ocr: SOURCE_FIELDS.filter((field) => row.provenance[field] === 'OCR'),
  }));
  const metrics = {
    generated_at: new Date().toISOString(),
    experiment: manifest.experiment,
    sample: {
      total: rows.length,
      retailers: manifest.retailer_count,
      categories: manifest.category_count,
      seed: manifest.seed,
      ordered_set_sha256: manifest.ordered_set_sha256,
      difficulty_proxy: countBy(manifest.samples, (sample) => sample.crop.difficulty_proxy),
      language_proxy: countBy(manifest.samples, 'language_proxy'),
    },
    architecture: {
      vision_primary: true,
      ocr_fallback_only: true,
      confidence_used_for_fallback: false,
      retries: 0,
      accepted_vision_fields_overwritten: rows.reduce((sum, row) => sum + row.merge.accepted_vision_fields_overwritten, 0),
      trigger: manifest.trigger_policy,
      size_visible_method: 'A missing size triggers only when production parseSize finds direct size evidence in another raw Vision textual field; no OCR or historical metadata is consulted.',
    },
    overall: {
      total_samples: rows.length,
      vision_only_samples: visionOnly,
      ocr_fallback_samples: ocrFallback,
      ocr_invocation_rate_pct: percent(ocrFallback, rows.length),
      vision_accepted_fields: visionAcceptedFields,
      ocr_accepted_fields: ocrAcceptedFields,
      fields_completed_by_ocr: ocrCompletedFields,
      null_source_fields: nullFields,
      populated_rule_derived_fields: ruleDerivedFields,
      total_api_requests: totalRequests,
      average_api_requests_per_sample: round(totalRequests / rows.length, 3),
      average_vision_latency_ms: round(visionLatency, 2),
      average_ocr_latency_ms: round(ocrLatency, 2),
      average_end_to_end_latency_ms: round(rows.reduce((sum, row) => sum + row.elapsed_ms, 0) / rows.length, 2),
    },
    provenance: Object.fromEntries(['Vision', 'OCR', 'Rule-derived', 'Null'].map((source) => [source, rows.reduce((sum, row) => sum + Object.values(row.provenance).filter((value) => value === source).length, 0)])),
    per_field: Object.fromEntries([...SOURCE_FIELDS, ...DERIVED_FIELDS].map((field) => [field, countBy(rows, (row) => row.provenance[field])])),
    trigger_counts: countBy(rows.flatMap((row) => row.vision_admission.trigger_decisions), (trigger) => trigger.code),
    comparison_to_ocr_first: comparisonMetrics(
      'ocr_first',
      (row) => row.baseline_ocr_first.final_enrichment,
      rows.length + ocrFirstVisionCalls,
      rows.length,
    ),
    comparison_to_original_vision_first: comparisonMetrics(
      'vision_first',
      (row) => row.baseline_vision_first.final_enrichment,
      rows.length + originalVisionFirstOcrCalls,
      originalVisionFirstOcrCalls,
    ),
    fallback_samples: fallbackSamples,
  };
  const failureRows = rows.filter((row) => row.failure_analysis.has_failure_signal);
  const failureAnalysis = {
    generated_at: metrics.generated_at,
    sample_count: rows.length,
    samples_with_failure_signals: failureRows.length,
    category_counts: countBy(failureRows.flatMap((row) => row.failure_analysis.categories), (value) => value),
    samples: failureRows.map((row) => ({ benchmark_index: row.benchmark_index, source_index: row.source_index, id: row.id, categories: row.failure_analysis.categories, details: row.failure_analysis.details })),
  };
  const summary = `# Vision-first with smarter selective OCR fallback — same 50 crops\n\n`
    + `This isolated experiment reused the exact ordered 50-crop set from the original Vision-first run (digest \`${manifest.ordered_set_sha256}\`). OCR triggers were deterministic, confidence-independent, and based only on missing/invalid required Vision fields plus direct Vision-text size evidence. Retries were disabled.\n\n`
    + `## Headline metrics\n\n`
    + `| Metric | Result |\n|---|---:|\n`
    + `| Vision-only samples | ${visionOnly} (${percent(visionOnly, rows.length)}%) |\n`
    + `| OCR fallback samples | ${ocrFallback} (${percent(ocrFallback, rows.length)}%) |\n`
    + `| Vision accepted fields | ${visionAcceptedFields} |\n`
    + `| OCR accepted fields | ${ocrAcceptedFields} |\n`
    + `| Fields completed by OCR | ${ocrCompletedFields} |\n`
    + `| Final null source fields | ${nullFields} |\n`
    + `| Rule-derived fields populated | ${ruleDerivedFields} |\n`
    + `| Total API requests | ${totalRequests} |\n`
    + `| Average requests/sample | ${round(totalRequests / rows.length, 3)} |\n`
    + `| Average Vision latency | ${round(visionLatency, 2)} ms |\n`
    + `| Average OCR latency when invoked | ${round(ocrLatency, 2)} ms |\n`
    + `| Average end-to-end latency | ${metrics.overall.average_end_to_end_latency_ms} ms |\n\n`
    + `Accepted Vision fields overwritten by OCR: **${metrics.architecture.accepted_vision_fields_overwritten}**.\n\n`
    + `## Deterministic comparison result\n\n`
    + `Versus OCR-first: ${JSON.stringify(metrics.comparison_to_ocr_first.classifications)}; OCR reduction ${metrics.comparison_to_ocr_first.ocr_usage_reduction_pct}%. Versus original Vision-first: ${JSON.stringify(metrics.comparison_to_original_vision_first.classifications)}; OCR change ${metrics.comparison_to_original_vision_first.ocr_call_delta >= 0 ? '+' : ''}${metrics.comparison_to_original_vision_first.ocr_call_delta} calls. These are completeness/output-agreement measures, not human ground truth.\n`;
  const fallbackLines = fallbackSamples.map((sample) => `- ${sample.benchmark_index}. \`${sample.id}\` — ${sample.reasons.map((reason) => reason.code).join(', ')}; OCR fields: ${sample.fields_completed_by_ocr.join(', ') || 'none'}`).join('\n');
  const agreementLines = SOURCE_FIELDS.map((field) => {
    const ocrFirst = metrics.comparison_to_ocr_first.field_agreement[field];
    const visionFirst = metrics.comparison_to_original_vision_first.field_agreement[field];
    return `| ${field} | ${ocrFirst.normalized_agreement_pct}% (${ocrFirst.normalized_matches}/${ocrFirst.comparable}) | ${visionFirst.normalized_agreement_pct}% (${visionFirst.normalized_matches}/${visionFirst.comparable}) |`;
  }).join('\n');
  const comparison = `# Comparison with both previous 50-crop experiments\n\n`
    + `All columns use the identical frozen crop set. Better/Comparable/Worse measures deterministic weighted field completeness; normalized agreement measures output equality and must not be read as human-adjudicated extraction accuracy.\n\n`
    + `| Metric | OCR-first baseline | Original Vision-first | Smart-trigger Vision-first |\n|---|---:|---:|---:|\n`
    + `| OCR invocations | ${rows.length} | ${originalVisionFirstOcrCalls} | ${ocrFallback} |\n`
    + `| Vision invocations | ${ocrFirstVisionCalls} | ${rows.length} | ${rows.length} |\n`
    + `| Average requests/sample, no retries | ${metrics.comparison_to_ocr_first.baseline_average_requests_per_sample} | ${metrics.comparison_to_original_vision_first.baseline_average_requests_per_sample} | ${round(totalRequests / rows.length, 3)} |\n`
    + `| Final null source fields | ${metrics.comparison_to_ocr_first.baseline_final_null_source_fields} | ${metrics.comparison_to_original_vision_first.baseline_final_null_source_fields} | ${nullFields} |\n\n`
    + `## Completeness and quality proxies\n\n`
    + `- Versus OCR-first: ${JSON.stringify(metrics.comparison_to_ocr_first.classifications)}; regressions ${metrics.comparison_to_ocr_first.regressions}; equal-or-better ${metrics.comparison_to_ocr_first.equal_or_better}/${rows.length}.\n`
    + `- Versus original Vision-first: ${JSON.stringify(metrics.comparison_to_original_vision_first.classifications)}; regressions ${metrics.comparison_to_original_vision_first.regressions}; equal-or-better ${metrics.comparison_to_original_vision_first.equal_or_better}/${rows.length}.\n`
    + `- OCR reduction versus OCR-first: **${metrics.comparison_to_ocr_first.ocr_usage_reduction_pct}%**.\n`
    + `- OCR reduction versus original Vision-first: **${metrics.comparison_to_original_vision_first.ocr_usage_reduction_pct}%** (negative means an increase).\n\n`
    + `### Normalized output agreement\n\n| Field | Versus OCR-first | Versus original Vision-first |\n|---|---:|---:|\n${agreementLines}\n\n`
    + `## Observed advantages\n\n- OCR is skipped for ${visionOnly} samples.\n- Accepted Vision fields are never overwritten.\n- Confidence does not create fallback traffic.\n\n`
    + `## Observed regressions\n\n- Worse versus OCR-first: ${metrics.comparison_to_ocr_first.regressions}.\n- Worse versus original Vision-first: ${metrics.comparison_to_original_vision_first.regressions}.\n- Current null source fields: ${nullFields}.\n- Per-field normalized disagreements are in metrics.json.\n\n`
    + `## Every OCR fallback sample\n\n${fallbackLines || '- None'}\n\n`
    + `## Validation conclusion\n\n`
    + `The experiment determines whether the smarter trigger recovered deterministic completeness while retaining substantial OCR savings. The measured result is reported above without changing production or making an architectural recommendation.\n`;
  writeFileSync(METRICS_FILE, `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');
  writeFileSync(FAILURE_FILE, `${JSON.stringify(failureAnalysis, null, 2)}\n`, 'utf8');
  writeFileSync(SUMMARY_FILE, summary, 'utf8');
  writeFileSync(COMPARISON_FILE, comparison, 'utf8');
  console.log(JSON.stringify(metrics.overall));
}

function selfTest() {
  const complete = admitVision({
    success: true,
    final: { parsed_output: { name_en: 'Test Product', name_ar: 'منتج تجريبي', brand: 'TestBrand', size: '400g', confidence: 0.01 } },
  });
  if (complete.ocr_required) throw new Error('Low confidence incorrectly triggered OCR');
  const missingArabic = admitVision({
    success: true,
    final: { parsed_output: { name_en: 'Test Product', name_ar: null, brand: 'TestBrand', size: '400g', confidence: 0.99 } },
  });
  if (!missingArabic.required_failures.includes('arabic_product_name_missing_or_invalid')) throw new Error('Missing Arabic name did not trigger OCR');
  const missingBrand = admitVision({
    success: true,
    final: { parsed_output: { name_en: 'Test Product', name_ar: 'منتج تجريبي', brand: null, size: '400g', confidence: 0.99 } },
  });
  if (!missingBrand.ocr_required || !missingBrand.required_failures.includes('brand_missing_or_invalid')) throw new Error('Missing brand did not trigger OCR');
  const sizeAbsentWithoutEvidence = admitVision({
    success: true,
    final: { parsed_output: { name_en: 'Test Product', name_ar: 'منتج تجريبي', brand: 'TestBrand', size: null } },
  });
  if (sizeAbsentWithoutEvidence.ocr_required) throw new Error('Missing size without direct Vision-text evidence incorrectly triggered OCR');
  const sizeAbsentWithEvidence = admitVision({
    success: true,
    final: { parsed_output: { name_en: 'Test Product 400g', name_ar: 'منتج تجريبي', brand: 'TestBrand', size: null } },
  });
  if (!sizeAbsentWithEvidence.required_failures.includes('size_missing_with_direct_vision_text_evidence')) throw new Error('Visible embedded size did not trigger OCR');
  const malformed = admitVision({ success: false, error: 'Malformed JSON', final: null });
  if (!malformed.required_failures.includes('malformed_or_unusable_vision')) throw new Error('Malformed Vision did not trigger OCR');
  const ocrAdmission = {
    fields: {
      name_en: { status: 'Accepted', value: 'Different OCR Name' },
      name_ar: { status: 'Missing', value: null },
      brand: { status: 'Accepted', value: 'DifferentBrand' },
      size: { status: 'Accepted', value: '1kg' },
      pack_count: { status: 'Accepted', value: '12 pcs' },
    },
  };
  const merged = mergeFields(complete, ocrAdmission);
  if (merged.final.name_en !== 'Test Product' || merged.final.brand !== 'TestBrand' || merged.final.size !== '400g') throw new Error('Accepted Vision field was overwritten');
  if (merged.final.pack_count !== '12 pcs') throw new Error('Already-invoked OCR packaging field was not consumed');
  if (merged.accepted_vision_fields_overwritten !== 0) throw new Error('Overwrite metric is non-zero');
  console.log(JSON.stringify({
    ok: true,
    confidence_trigger_disabled: true,
    missing_arabic_trigger: true,
    missing_brand_trigger: true,
    missing_size_without_evidence_does_not_trigger: true,
    embedded_size_evidence_triggers: true,
    malformed_vision_triggers: true,
    accepted_vision_preserved: true,
    retries: 0,
  }));
}

const command = process.argv[2];
if (command === 'prepare') prepare();
else if (command === 'run') await run();
else if (command === 'report') report();
else if (command === 'self-test') selfTest();
else throw new Error('Usage: node run-validation.mjs prepare|run|report|self-test');
