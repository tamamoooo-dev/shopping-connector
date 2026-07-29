// Prompt C trial: does directing the model to the BROCHURE TITLE (rather than the
// package artwork) improve English title extraction?
//
// Controls: same frozen crop bytes, same model, same settings as the main run.
// Base prompt is the original Expanded JSON prompt; ONLY the name_en instruction
// block is replaced. Price rules, JSON schema and all other field rules are
// byte-identical to the baseline.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = process.env.BENCHMARK_MISTRAL_KEY_FILE
  || resolve(HERE, '../../../../.mistral.key.backup2.txt');
const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
const MEDIUM = 'mistral-medium-latest';

// 10 new name_en failures. Eight retailers, none of them used in the prompt-B
// subset, and ten distinct product categories.
const SUBSET = [8, 9, 22, 25, 28, 30, 36, 40, 44, 49];

const NAME_RULE = `Extract ONLY the English product title shown in the brochure.

Ignore all English text printed on the product package, including brand logos,
slogans, descriptions, promotional text and packaging artwork.

The brochure title is usually located directly below the product image.

Copy that title exactly as written.
Do not translate.
Do not normalize.
Do not correct spelling.
Do not abbreviate.
Return only the brochure title.`;

const PROMPT_C = `You are extracting one advertised product from one Saudi retail flyer crop.
The pixels are the only source of truth. Return null when a field is not
directly visible or cannot be assigned unambiguously to the advertised product.

For name_en, follow these rules exactly:
${NAME_RULE}

Arabic is an independent literal display caption, not a translation. Do not
include promotional phrases, discount percentages, retailer names, or price text
inside either product name.

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

// Prompt B, re-run on the SAME 10 crops so the two candidate rewrites can be
// compared head to head rather than across different samples.
const PROMPT_B = (await readFile(join(HERE, 'run-prompt-b.mjs'), 'utf8'))
  .match(/const PROMPT_B = `([\s\S]*?)`;/u)[1];

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
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

const key = (await readFile(KEY_PATH, 'utf8')).trim();
const frozen = JSON.parse(await readFile(join(HERE, 'frozen-sample.json'), 'utf8'));

async function extract(prompt, image) {
  const started = performance.now();
  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MEDIUM,
      temperature: 0,
      top_p: 1,
      reasoning_effort: 'none',
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: image }],
      }],
    }),
  });
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content ?? null;
  return {
    ok: response.ok,
    structured: parseJsonContent(content) || {},
    raw_output: content,
    usage: body?.usage ?? null,
    latency_ms: Math.round((performance.now() - started) * 100) / 100,
  };
}

const out = {
  schema_version: 'prompt-c-brochure-title-trial-v1',
  ran_at: new Date().toISOString(),
  model: MEDIUM,
  variant: 'medium_expanded_json_brochure_title',
  prompt_c_sha256: createHash('sha256').update(PROMPT_C).digest('hex'),
  prompt_b_sha256: createHash('sha256').update(PROMPT_B).digest('hex'),
  settings: { temperature: 0, top_p: 1, reasoning_effort: 'none', ocr: false, requests_per_crop: 1 },
  subset: SUBSET,
  samples: [],
};

for (const index of SUBSET) {
  const sample = frozen.samples.find((item) => item.index === index);
  const bytes = await readFile(join(HERE, sample.file));
  if (createHash('sha256').update(bytes).digest('hex') !== sample.sha256) {
    throw new Error(`sample ${index} hash mismatch`);
  }
  const image = `data:${sample.content_type};base64,${Buffer.from(bytes).toString('base64')}`;
  const c = await extract(PROMPT_C, image);
  await sleep(400);
  const b = await extract(PROMPT_B, image);
  out.samples.push({
    index,
    id: sample.id,
    store: sample.store,
    category: sample.category,
    file: sample.file,
    sha256: sample.sha256,
    prompt_c: c,
    prompt_b: b,
  });
  process.stdout.write(`${String(index).padStart(2)} ${sample.store.padEnd(11)} C=${JSON.stringify(c.structured.name_en)}\n`);
  await sleep(400);
}

await writeFile(join(HERE, 'prompt-c-results.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
