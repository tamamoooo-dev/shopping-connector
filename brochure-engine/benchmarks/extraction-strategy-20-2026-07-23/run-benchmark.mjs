import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { VISION_PROMPT } from '../../src/offers/enrich.js';
import { parseVisiblePackCount, validateOcrOutput } from '../../src/offers/smartExtraction.js';
import { parseSize } from '../../src/matching.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'sample-manifest.json');
const ASSET_DIR = join(HERE, 'assets');
const FROZEN_PATH = join(HERE, 'frozen-sample.json');
const RESULTS_PATH = join(HERE, 'model-results.json');
const KEY_PATH = process.env.BENCHMARK_MISTRAL_KEY_FILE
  || resolve(process.cwd(), '../../.mistral.key.backup2.txt');

const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
const OCR_URL = 'https://api.mistral.ai/v1/ocr';
const SMALL = 'mistral-small-latest';
const MEDIUM = 'mistral-medium-latest';
const OCR = 'mistral-ocr-latest';

const EXTRACTION_JSON_SCHEMA = {
  name: 'product_extraction',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'name_en', 'name_ar', 'brand', 'current_price', 'old_price', 'unit',
      'package_size', 'quantity', 'package_type', 'attributes', 'confidence',
    ],
    properties: {
      name_en: { type: ['string', 'null'] },
      name_ar: { type: ['string', 'null'] },
      brand: { type: ['string', 'null'] },
      current_price: { type: ['number', 'null'] },
      old_price: { type: ['number', 'null'] },
      unit: { type: ['string', 'null'] },
      package_size: { type: ['string', 'null'] },
      quantity: { type: ['string', 'null'] },
      package_type: { type: ['string', 'null'] },
      attributes: { type: 'array', items: { type: 'string' } },
      confidence: { type: ['number', 'null'] },
    },
  },
};

const FINAL_PROMPT = `You are extracting one advertised product from one Saudi retail flyer crop.
The pixels are the only source of truth. Copy visible wording exactly. Never translate,
normalize, complete, infer, or use product knowledge. Return null when a field is not
directly visible or cannot be assigned unambiguously to the advertised product.

English is the preferred identity caption. Arabic is an independent literal display
caption, not a translation. Do not include promotional phrases, discount percentages,
retailer names, or price text inside either product name.

For price: current_price is the visibly promoted selling price. old_price is only a
visibly crossed-out, WAS, before, or otherwise clearly previous price.

Return exactly one JSON object with:
{
  "name_en": string|null,
  "name_ar": string|null,
  "brand": string|null,
  "current_price": number|null,
  "old_price": number|null,
  "unit": string|null,
  "package_size": string|null,
  "quantity": string|null,
  "package_type": string|null,
  "attributes": string[],
  "confidence": number|null
}

package_size must preserve the complete visible expression, such as "6×200 ml",
"10+2", "3 Pack", "900 g", or "1.5 L". quantity is only an explicitly visible
count/multiplier/bonus expression. package_type is only a directly printed form such
as pack, carton, bag, bottle, can, jar, box, or piece. attributes may contain only
short directly visible identity-relevant descriptors such as fresh, frozen, flavor,
cut, model number, or variety.`;

const EVIDENCE_PROMPT = `Inspect this single product flyer crop and produce a literal
evidence ledger before extraction. Do not identify anything from appearance or prior
knowledge. Return JSON with arrays:
{
  "english_lines": [],
  "arabic_lines": [],
  "brand_candidates": [],
  "price_candidates": [{"text":"","role":"current|old|ambiguous"}],
  "size_quantity_lines": [],
  "package_type_lines": [],
  "attribute_lines": [],
  "ambiguities": []
}
Copy every entry exactly from visible pixels. Omit illegible text rather than guessing.`;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function loadJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function dataUrl(bytes, contentType = 'image/jpeg') {
  return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
}

function parseJsonContent(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  const match = /\{[\s\S]*\}/u.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function clean(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/[^\d.]/gu, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalOutput(value = {}) {
  return {
    name_en: clean(value.name_en ?? value.productName),
    name_ar: clean(value.name_ar ?? value.arabicName),
    brand: clean(value.brand),
    current_price: numberOrNull(value.current_price ?? value.price),
    old_price: numberOrNull(value.old_price),
    unit: clean(value.unit),
    package_size: clean(value.package_size ?? value.size),
    quantity: clean(value.quantity ?? value.pack_count ?? value.packCount),
    package_type: clean(value.package_type),
    attributes: Array.isArray(value.attributes)
      ? value.attributes.map(clean).filter(Boolean)
      : [],
    confidence: typeof value.confidence === 'number' ? value.confidence : null,
  };
}

function currentVisionOutput(value = {}) {
  const size = clean(value.size);
  const parsed = parseSize('', size);
  return canonicalOutput({
    name_en: value.name_en,
    name_ar: value.name_ar,
    brand: value.brand,
    package_size: size,
    unit: parsed?.unit ?? null,
    quantity: value.pack_count ?? value.packCount,
    confidence: value.confidence,
  });
}

function currentOcrOutput(markdown) {
  const validation = validateOcrOutput(markdown, { usable: !!String(markdown || '').trim() });
  const field = (name) => validation.fields?.[name]?.status === 'Accepted'
    ? validation.fields[name].value
    : null;
  const size = field('size');
  const pack = field('pack_count');
  const parsed = parseSize('', size);
  return {
    output: canonicalOutput({
      name_en: field('name_en'),
      name_ar: field('name_ar'),
      brand: field('brand'),
      package_size: size,
      unit: parsed?.unit ?? null,
      quantity: pack,
    }),
    validation,
  };
}

async function apiPost(url, key, body, { maxRetries = 3 } = {}) {
  let retries = 0;
  for (;;) {
    const started = performance.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const latency_ms = Math.round((performance.now() - started) * 100) / 100;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (response.ok) return { body: parsed, raw_http_body: text, latency_ms, retries };
    if (response.status !== 429 || retries >= maxRetries) {
      const error = new Error(`Mistral HTTP ${response.status}: ${text.slice(0, 300)}`);
      error.status = response.status;
      error.latency_ms = latency_ms;
      error.retries = retries;
      throw error;
    }
    retries += 1;
    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(30_000, retries * 5_000));
  }
}

function chatBody(model, prompt, image, { reasoningEffort } = {}) {
  return {
    model,
    temperature: 0,
    top_p: 1,
    response_format: { type: 'json_object' },
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: image },
      ],
    }],
  };
}

async function runChat(key, model, prompt, image, options) {
  const response = await apiPost(CHAT_URL, key, chatBody(model, prompt, image, options));
  const content = response.body?.choices?.[0]?.message?.content ?? null;
  return {
    structured: canonicalOutput(parseJsonContent(content) || {}),
    raw_output: content,
    response_model: response.body?.model ?? model,
    usage: response.body?.usage ?? null,
    latency_ms: response.latency_ms,
    retries: response.retries,
  };
}

async function runMediumTwoPassStandard(key, image) {
  const pass1 = await apiPost(CHAT_URL, key, chatBody(MEDIUM, EVIDENCE_PROMPT, image, {
    reasoningEffort: 'none',
  }));
  const evidenceRaw = pass1.body?.choices?.[0]?.message?.content ?? null;
  const evidence = parseJsonContent(evidenceRaw) || {};
  const secondPrompt = `${FINAL_PROMPT}

Use only this literal evidence ledger from the first visual pass:
${JSON.stringify(evidence)}

Return the final JSON object only. If the ledger does not support a field, return null.`;
  const pass2 = await apiPost(CHAT_URL, key, {
    model: MEDIUM,
    temperature: 0,
    top_p: 1,
    reasoning_effort: 'none',
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: secondPrompt }],
  });
  const finalRaw = pass2.body?.choices?.[0]?.message?.content ?? null;
  return {
    structured: canonicalOutput(parseJsonContent(finalRaw) || {}),
    raw_output: finalRaw,
    evidence,
    evidence_raw: evidenceRaw,
    response_model: pass2.body?.model ?? MEDIUM,
    usage: {
      pass1: pass1.body?.usage ?? null,
      pass2: pass2.body?.usage ?? null,
    },
    latency_ms: Math.round((pass1.latency_ms + pass2.latency_ms) * 100) / 100,
    retries: pass1.retries + pass2.retries,
    requests: 2,
  };
}

async function runOcr(key, image) {
  const response = await apiPost(OCR_URL, key, {
    model: OCR,
    document: { type: 'image_url', image_url: image },
    include_image_base64: false,
    include_blocks: true,
    document_annotation_format: {
      type: 'json_schema',
      json_schema: EXTRACTION_JSON_SCHEMA,
    },
    document_annotation_prompt: FINAL_PROMPT,
  });
  const markdown = (response.body?.pages || []).map((page) => page?.markdown || '').join('\n').trim();
  const current = currentOcrOutput(markdown);
  const annotationRaw = response.body?.document_annotation ?? null;
  return {
    current: {
      structured: current.output,
      raw_output: markdown,
      validation: current.validation,
      response_model: response.body?.model ?? OCR,
      usage: response.body?.usage_info ?? response.body?.usage ?? null,
      latency_ms: response.latency_ms,
      retries: response.retries,
      shared_request: 'ocr_annotated',
    },
    annotated: {
      structured: canonicalOutput(parseJsonContent(annotationRaw) || {}),
      raw_output: annotationRaw,
      ocr_markdown: markdown,
      response_model: response.body?.model ?? OCR,
      usage: response.body?.usage_info ?? response.body?.usage ?? null,
      latency_ms: response.latency_ms,
      retries: response.retries,
      shared_request: 'ocr_annotated',
    },
    raw_http_body: response.raw_http_body,
  };
}

async function download() {
  const manifest = await loadJson(MANIFEST_PATH);
  await mkdir(ASSET_DIR, { recursive: true });
  const frozen = {
    schema_version: 'frozen-production-crop-sample-v1',
    frozen_at: new Date().toISOString(),
    source_manifest: 'sample-manifest.json',
    samples: [],
  };
  for (const sample of manifest.samples) {
    const response = await fetch(sample.image_url);
    if (!response.ok) throw new Error(`crop ${sample.index} download HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const file = `${String(sample.index).padStart(2, '0')}.jpg`;
    await writeFile(join(ASSET_DIR, file), bytes);
    frozen.samples.push({
      ...sample,
      file: `assets/${file}`,
      content_type: contentType,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
    process.stdout.write(`downloaded ${sample.index}/20 ${sample.store}\n`);
  }
  frozen.ordered_sample_sha256 = sha256(Buffer.from(
    frozen.samples.map((sample) => `${sample.index}:${sample.id}:${sample.sha256}`).join('\n'),
  ));
  await saveJson(FROZEN_PATH, frozen);
  process.stdout.write(`frozen ${frozen.samples.length} crops ${frozen.ordered_sample_sha256}\n`);
}

async function run() {
  const key = (await readFile(KEY_PATH, 'utf8')).trim();
  if (!key) throw new Error(`missing benchmark key: ${KEY_PATH}`);
  const frozen = await loadJson(FROZEN_PATH);
  const results = await loadJson(RESULTS_PATH, {
    schema_version: 'mistral-extraction-strategy-benchmark-v1',
    started_at: new Date().toISOString(),
    sample_digest: frozen.ordered_sample_sha256,
    models: { small: SMALL, medium: MEDIUM, ocr: OCR },
    variants: [
      'small_current',
      'small_expanded_json',
      'ocr_current_parser',
      'ocr_structured_annotation',
      'medium_expanded_json',
      'medium_two_pass_standard',
    ],
    samples: [],
  });
  if (!results.variants.includes('medium_two_pass_standard')) {
    results.variants.push('medium_two_pass_standard');
  }
  for (const sample of frozen.samples) {
    let row = results.samples.find((item) => item.index === sample.index);
    if (!row) {
      row = {
        index: sample.index,
        id: sample.id,
        store: sample.store,
        category: sample.category,
        file: sample.file,
        sha256: sample.sha256,
        variants: {},
      };
      results.samples.push(row);
    }
    const bytes = await readFile(join(HERE, sample.file));
    if (sha256(bytes) !== sample.sha256) throw new Error(`sample ${sample.index} hash mismatch`);
    const image = dataUrl(bytes, sample.content_type);

    const execute = async (name, operation) => {
      if (row.variants[name]?.ok) return;
      try {
        row.variants[name] = { ok: true, ...(await operation()) };
      } catch (error) {
        row.variants[name] = {
          ok: false,
          error: error.message,
          status: error.status ?? null,
          latency_ms: error.latency_ms ?? null,
          retries: error.retries ?? 0,
        };
      }
      await saveJson(RESULTS_PATH, results);
      process.stdout.write(`${sample.index}/20 ${name}: ${row.variants[name].ok ? 'ok' : row.variants[name].error}\n`);
      await sleep(250);
    };

    await execute('small_current', async () => {
      const response = await apiPost(CHAT_URL, key, chatBody(SMALL, VISION_PROMPT, image));
      const content = response.body?.choices?.[0]?.message?.content ?? null;
      return {
        structured: currentVisionOutput(parseJsonContent(content) || {}),
        raw_output: content,
        response_model: response.body?.model ?? SMALL,
        usage: response.body?.usage ?? null,
        latency_ms: response.latency_ms,
        retries: response.retries,
      };
    });
    await execute('small_expanded_json', () => runChat(key, SMALL, FINAL_PROMPT, image));
    if (!row.variants.ocr_current_parser?.ok || !row.variants.ocr_structured_annotation?.ok) {
      try {
        const ocr = await runOcr(key, image);
        row.variants.ocr_current_parser = { ok: true, ...ocr.current };
        row.variants.ocr_structured_annotation = { ok: true, ...ocr.annotated };
        row.ocr_raw_http_body = ocr.raw_http_body;
      } catch (error) {
        const failed = {
          ok: false,
          error: error.message,
          status: error.status ?? null,
          latency_ms: error.latency_ms ?? null,
          retries: error.retries ?? 0,
        };
        row.variants.ocr_current_parser = failed;
        row.variants.ocr_structured_annotation = failed;
      }
      await saveJson(RESULTS_PATH, results);
      process.stdout.write(`${sample.index}/20 ocr shared request: ${row.variants.ocr_current_parser.ok ? 'ok' : 'failed'}\n`);
      await sleep(250);
    }
    await execute('medium_expanded_json', () => runChat(key, MEDIUM, FINAL_PROMPT, image, {
      reasoningEffort: 'none',
    }));
    await execute('medium_two_pass_standard', () => runMediumTwoPassStandard(key, image));
  }
  results.finished_at = new Date().toISOString();
  await saveJson(RESULTS_PATH, results);
}

const command = process.argv[2];
if (command === 'download') await download();
else if (command === 'run') await run();
else throw new Error('Usage: node run-benchmark.mjs download|run');
