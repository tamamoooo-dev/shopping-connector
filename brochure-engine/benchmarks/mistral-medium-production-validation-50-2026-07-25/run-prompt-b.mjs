// Prompt B trial: does an explicit "copy the complete title verbatim" directive
// fix the English-name decomposition behaviour?
//
// Controls: same frozen crop bytes, same model, same settings as the main run.
// The ONLY variable is the name_en instruction block.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = process.env.BENCHMARK_MISTRAL_KEY_FILE
  || resolve(HERE, '../../../../.mistral.key.backup2.txt');
const CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';
const MEDIUM = 'mistral-medium-latest';

// One crop per distinct failure mode observed in the main run.
const SUBSET = [3, 6, 10, 14, 16, 17, 19, 20, 33, 37];

const PROMPT_B = `You are extracting one advertised product from one Saudi retail flyer crop.
The pixels are the only source of truth. Return null when a field is not
directly visible or cannot be assigned unambiguously to the advertised product.

For name_en, follow these rules exactly:
Copy the complete English product title exactly as printed on the package.
Do not remove the brand.
Do not remove the size.
Do not normalize.
Do not correct spelling.
Do not abbreviate.
Return the exact visible text.

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

The brand and the size must ALSO be repeated in their own fields. Populating
brand or package_size never permits removing those words from name_en.

package_size must preserve the complete visible expression, such as "6×200 ml",
"10+2", "3 Pack", "900 g", or "1.5 L". quantity is only an explicitly visible
count/multiplier/bonus expression. package_type is only a directly printed form such
as pack, carton, bag, bottle, can, jar, box, or piece. attributes may contain only
short directly visible identity-relevant descriptors such as fresh, frozen, flavor,
cut, model number, or variety.`;

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

const out = {
  schema_version: 'prompt-b-name-trial-v1',
  ran_at: new Date().toISOString(),
  model: MEDIUM,
  variant: 'medium_expanded_json_verbatim_name',
  prompt_sha256: createHash('sha256').update(PROMPT_B).digest('hex'),
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
        content: [{ type: 'text', text: PROMPT_B }, { type: 'image_url', image_url: image }],
      }],
    }),
  });
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content ?? null;
  const structured = parseJsonContent(content) || {};
  out.samples.push({
    index,
    id: sample.id,
    store: sample.store,
    file: sample.file,
    sha256: sample.sha256,
    ok: response.ok,
    structured,
    raw_output: content,
    usage: body?.usage ?? null,
    latency_ms: Math.round((performance.now() - started) * 100) / 100,
  });
  process.stdout.write(`${index} ${sample.store}: ${JSON.stringify(structured.name_en)}\n`);
  await sleep(400);
}

await writeFile(join(HERE, 'prompt-b-results.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');
