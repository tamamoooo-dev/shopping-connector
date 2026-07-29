// mistral-small-2603 over the 30 randomly drawn frozen crops.
//
// This file is run-verbatim-50.mjs from the Medium production validation with
// exactly two functional changes:
//   1. MODEL: 'mistral-medium-latest' -> 'mistral-small-latest'
//   2. the sample list comes from sample-10.json instead of frozen-sample.json
// Everything else — prompt source, temperature, top_p, reasoning_effort,
// response_format, image encoding, one request per crop, retry policy,
// canonicalOutput() and parseJsonContent() — is character-for-character the
// same. The prompt is still READ OUT OF run-prompt-b.mjs, never retyped.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, '..', 'mistral-medium-production-validation-50-2026-07-25');
const RESULTS_PATH = join(HERE, 'small-30-results.json');
const KEY_PATH = process.env.BENCHMARK_MISTRAL_KEY_FILE
  || resolve(HERE, '../../../../.mistral.key.backup2.txt');
const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
const SMALL = 'mistral-small-2603';

const PROMPT = (await readFile(join(BASE, 'run-prompt-b.mjs'), 'utf8'))
  .match(/const PROMPT_B = `([\s\S]*?)`;/u)[1];
const PROMPT_SHA256 = createHash('sha256').update(PROMPT).digest('hex');
if (PROMPT_SHA256 !== 'e643b2a1b833d12256e0e3806b04c28bc5fd042bf3a86b647b989df9be7c3557') {
  throw new Error(`prompt drift: ${PROMPT_SHA256}`);
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
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

function parseJsonContent(value) {
  const text = String(value || '').trim();
  const match = /\{[\s\S]*\}/u.exec(text);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

const clean = (v) => (typeof v === 'string' ? (v.trim() || null) : null);
function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/[^\d.]/gu, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

// Identical canonicalisation to run-benchmark.mjs / run-verbatim-50.mjs.
function canonicalOutput(value = {}) {
  return {
    name_en: clean(value.name_en),
    name_ar: clean(value.name_ar),
    brand: clean(value.brand),
    current_price: numberOrNull(value.current_price),
    old_price: numberOrNull(value.old_price),
    unit: clean(value.unit),
    package_size: clean(value.package_size),
    quantity: clean(value.quantity),
    package_type: clean(value.package_type),
    attributes: Array.isArray(value.attributes) ? value.attributes.map(clean).filter(Boolean) : [],
    confidence: typeof value.confidence === 'number' ? value.confidence : null,
  };
}

async function apiPost(body, key, { maxRetries = 4 } = {}) {
  let retries = 0;
  for (;;) {
    const started = performance.now();
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const latency_ms = Math.round((performance.now() - started) * 100) / 100;
    if (response.ok) {
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      return { body: parsed, latency_ms, retries };
    }
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

const key = (await readFile(KEY_PATH, 'utf8')).trim();
const frozen = await loadJson(join(HERE, 'sample-30.json'));
const results = await loadJson(RESULTS_PATH, {
  schema_version: 'small-first-routing-30-v1',
  started_at: new Date().toISOString(),
  sample_digest: frozen.ordered_sample_sha256,
  source_sample_digest: frozen.source_sample_digest,
  model: SMALL,
  strategy: 'medium_expanded_json_verbatim_name',
  prompt_sha256: PROMPT_SHA256,
  prompt_source: 'run-prompt-b.mjs PROMPT_B, read verbatim, unmodified',
  settings: {
    temperature: 0, top_p: 1, response_format: 'json_object',
    reasoning_effort: 'none', ocr: false, requests_per_crop: 1,
  },
  samples: [],
});

for (const sample of frozen.samples) {
  if (results.samples.find((item) => item.index === sample.index)?.ok) continue;
  const bytes = await readFile(join(HERE, sample.file));
  if (createHash('sha256').update(bytes).digest('hex') !== sample.sha256) {
    throw new Error(`sample ${sample.index} hash mismatch`);
  }
  const image = `data:${sample.content_type};base64,${Buffer.from(bytes).toString('base64')}`;
  let row;
  try {
    const response = await apiPost({
      model: SMALL,
      temperature: 0,
      top_p: 1,
      reasoning_effort: 'none',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: image }],
      }],
    }, key);
    const content = response.body?.choices?.[0]?.message?.content ?? null;
    row = {
      index: sample.index, id: sample.id, store: sample.store, category: sample.category,
      file: sample.file, sha256: sample.sha256, ok: true,
      structured: canonicalOutput(parseJsonContent(content) || {}),
      json_parsed: parseJsonContent(content) !== null,
      raw_output: content,
      response_model: response.body?.model ?? SMALL,
      usage: response.body?.usage ?? null,
      latency_ms: response.latency_ms,
      retries: response.retries,
    };
  } catch (error) {
    row = {
      index: sample.index, id: sample.id, store: sample.store, category: sample.category,
      file: sample.file, sha256: sample.sha256, ok: false,
      error: error.message, status: error.status ?? null,
      latency_ms: error.latency_ms ?? null, retries: error.retries ?? 0,
    };
  }
  const at = results.samples.findIndex((item) => item.index === sample.index);
  if (at >= 0) results.samples[at] = row;
  else results.samples.push(row);
  results.samples.sort((x, y) => x.index - y.index);
  await saveJson(RESULTS_PATH, results);
  process.stdout.write(`${sample.index} ${sample.store}: ${row.ok ? `ok ${row.response_model} ${row.latency_ms}ms` : row.error}\n`);
  await sleep(400);
}

results.finished_at = new Date().toISOString();
await saveJson(RESULTS_PATH, results);
process.stdout.write(`done: ${results.samples.length} crops, ${results.samples.filter((x) => !x.ok).length} failures\n`);
process.stdout.write(`prompt sha256 ${PROMPT_SHA256}\n`);
