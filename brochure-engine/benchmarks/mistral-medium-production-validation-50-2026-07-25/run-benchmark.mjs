// Mistral Medium (Expanded JSON) final production validation — 50 new crops.
//
// Single model, single strategy. No OCR. No comparison model. No reasoning.
// Production settings: mistral-medium-latest, temperature 0, top_p 1,
// json_object response format, one request per crop.
//
// Read-only with respect to production: downloads public CDN crops and calls
// the Mistral API. Writes nothing to D1, KV, or the Worker.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, 'sample-manifest.json');
const ASSET_DIR = join(HERE, 'assets');
const FROZEN_PATH = join(HERE, 'frozen-sample.json');
const RESULTS_PATH = join(HERE, 'model-results.json');
const KEY_PATH = process.env.BENCHMARK_MISTRAL_KEY_FILE
  || resolve(HERE, '../../../../.mistral.key.backup2.txt');

const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
const MEDIUM = 'mistral-medium-latest';

// Verbatim current Expanded JSON prompt
// (benchmarks/extraction-strategy-20-2026-07-23/run-benchmark.mjs FINAL_PROMPT).
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

const PROMPT_SHA256 = createHash('sha256').update(FINAL_PROMPT).digest('hex');

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
  return value.trim() || null;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.replace(/[^\d.]/gu, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

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
    attributes: Array.isArray(value.attributes)
      ? value.attributes.map(clean).filter(Boolean)
      : [],
    confidence: typeof value.confidence === 'number' ? value.confidence : null,
  };
}

async function apiPost(url, key, body, { maxRetries = 4 } = {}) {
  let retries = 0;
  for (;;) {
    const started = performance.now();
    const response = await fetch(url, {
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

async function download() {
  const manifest = await loadJson(MANIFEST_PATH);
  await mkdir(ASSET_DIR, { recursive: true });
  const frozen = await loadJson(FROZEN_PATH, {
    schema_version: 'frozen-production-crop-sample-v1',
    frozen_at: new Date().toISOString(),
    source_manifest: 'sample-manifest.json',
    seed: manifest.seed,
    samples: [],
  });
  for (const sample of manifest.samples) {
    if (frozen.samples.some((item) => item.index === sample.index)) continue;
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
    frozen.samples.sort((a, b) => a.index - b.index);
    await saveJson(FROZEN_PATH, frozen);
    process.stdout.write(`downloaded ${sample.index}/${manifest.samples.length} ${sample.store}\n`);
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
    schema_version: 'mistral-medium-production-validation-v1',
    started_at: new Date().toISOString(),
    sample_digest: frozen.ordered_sample_sha256,
    model: MEDIUM,
    strategy: 'medium_expanded_json',
    prompt_sha256: PROMPT_SHA256,
    settings: {
      temperature: 0,
      top_p: 1,
      response_format: 'json_object',
      reasoning_effort: 'none',
      ocr: false,
      requests_per_crop: 1,
    },
    samples: [],
  });
  for (const sample of frozen.samples) {
    const existing = results.samples.find((item) => item.index === sample.index);
    if (existing?.ok) continue;
    const bytes = await readFile(join(HERE, sample.file));
    if (sha256(bytes) !== sample.sha256) throw new Error(`sample ${sample.index} hash mismatch`);
    const image = dataUrl(bytes, sample.content_type);
    let row;
    try {
      const response = await apiPost(CHAT_URL, key, {
        model: MEDIUM,
        temperature: 0,
        top_p: 1,
        reasoning_effort: 'none',
        response_format: { type: 'json_object' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: FINAL_PROMPT },
            { type: 'image_url', image_url: image },
          ],
        }],
      });
      const content = response.body?.choices?.[0]?.message?.content ?? null;
      row = {
        index: sample.index,
        id: sample.id,
        store: sample.store,
        category: sample.category,
        file: sample.file,
        sha256: sample.sha256,
        ok: true,
        structured: canonicalOutput(parseJsonContent(content) || {}),
        json_parsed: parseJsonContent(content) !== null,
        raw_output: content,
        response_model: response.body?.model ?? MEDIUM,
        usage: response.body?.usage ?? null,
        latency_ms: response.latency_ms,
        retries: response.retries,
      };
    } catch (error) {
      row = {
        index: sample.index,
        id: sample.id,
        store: sample.store,
        category: sample.category,
        file: sample.file,
        sha256: sample.sha256,
        ok: false,
        error: error.message,
        status: error.status ?? null,
        latency_ms: error.latency_ms ?? null,
        retries: error.retries ?? 0,
      };
    }
    const at = results.samples.findIndex((item) => item.index === sample.index);
    if (at >= 0) results.samples[at] = row;
    else results.samples.push(row);
    results.samples.sort((a, b) => a.index - b.index);
    await saveJson(RESULTS_PATH, results);
    process.stdout.write(`${sample.index}/${frozen.samples.length} ${sample.store}: ${row.ok ? 'ok' : row.error}\n`);
    await sleep(400);
  }
  results.finished_at = new Date().toISOString();
  await saveJson(RESULTS_PATH, results);
  const failures = results.samples.filter((item) => !item.ok).length;
  process.stdout.write(`done: ${results.samples.length} crops, ${failures} failures\n`);
}

const command = process.argv[2];
if (command === 'download') await download();
else if (command === 'run') await run();
else throw new Error('Usage: node run-benchmark.mjs download|run');
