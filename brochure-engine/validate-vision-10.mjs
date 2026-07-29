// Controlled crop-only Vision validation. This is deliberately NOT a backfill:
// exactly ten fixed offers are observed, results are written only to a local
// visual report, and production D1 is queried read-only after every Vision call
// has completed. D4D OCR/metadata never enters the model request or parser.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyChain } from './src/offers/mistralKeys.js';
import { DEFAULT_MODEL, observeWithFailover, VISION_PROMPT } from './src/offers/enrich.js';
import { visionMatchText } from './src/storage/enrichStore.js';
import { loadMistralKeys } from './local-secrets.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = join(HERE, 'validation', 'vision-crop-only-10-2026-07-21');
const ASSET_DIR = join(REPORT_DIR, 'assets');
const OBSERVATIONS_FILE = join(REPORT_DIR, 'observations.json');

// Fixed before execution. Only id + crop URL exist in the extraction manifest.
// Category, OCR, title, prior enrichment, and Registry data are fetched later,
// after all ten observations, solely to build the human comparison report.
const SAMPLES = Object.freeze([
  { id: 'danube:central:d4d:93263697', imageUrl: 'https://cdn.d4donline.com/u/i/26/07/15/fe338a1a846f025c668f745505117f4b.jpg' },
  { id: 'aljazera:central:d4d:93167235', imageUrl: 'https://cdn.d4donline.com/u/a/26/07/14/929ad93668a4b6063409e78535ee26d0.jpg' },
  { id: 'danube:central:d4d:93264495', imageUrl: 'https://cdn.d4donline.com/u/i/26/07/15/8191e1ebdde2d07426597e1fedf8514e.jpg' },
  { id: 'carrefour:central:d4d:93216687', imageUrl: 'https://cdn.d4donline.com/u/a/26/07/14/1c28388b1313d0165e51efd474afd130.jpg' },
  { id: 'amarket:central:d4d:93222585', imageUrl: 'https://cdn.d4donline.com/u/a/26/07/14/e49f0d9457c3cfc7acfb440c3639fd2e.jpg' },
  { id: 'aljazera:central:d4d:93166458', imageUrl: 'https://cdn.d4donline.com/u/a/26/07/14/315a0e51eebe1b39634e91b2cd94f1fe.jpg' },
  { id: 'aljazera:central:d4d:93167271', imageUrl: 'https://cdn.d4donline.com/u/a/26/07/14/e383dc36abfc00344069e261c84f3897.jpg' },
  { id: 'alwafa:central:d4d:93171132', imageUrl: 'https://cdn.d4donline.com/u/i/26/07/14/5d6658919357316ddddb3db2f673adfb.jpg' },
  { id: 'aljazera:central:d4d:93166953', imageUrl: 'https://cdn.d4donline.com/u/a/26/07/14/744c4afe3fc0fa47812df062c3003383.jpg' },
  { id: 'danube:central:d4d:93266196', imageUrl: 'https://cdn.d4donline.com/u/i/26/07/15/7784461a60c3b92c4cfe6076dcf6d08e.jpg' },
]);

if (SAMPLES.length !== 10 || new Set(SAMPLES.map((s) => s.id)).size !== 10) {
  throw new Error('Controlled validation must contain exactly 10 unique offers.');
}

const keys = loadMistralKeys();
if (!keys.length) throw new Error('No local Mistral key found.');
const keyChain = createKeyChain(keys);
mkdirSync(ASSET_DIR, { recursive: true });

function extension(contentType, url) {
  if (/png/i.test(contentType)) return '.png';
  if (/webp/i.test(contentType)) return '.webp';
  return extname(new URL(url).pathname) || '.jpg';
}

function imageDimensions(bytes, contentType) {
  const b = new Uint8Array(bytes);
  if (/png/i.test(contentType) && b.length >= 24) {
    const v = new DataView(bytes);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if ((/jpe?g/i.test(contentType) || (b[0] === 0xff && b[1] === 0xd8)) && b.length > 4) {
    let i = 2;
    while (i + 8 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
      const len = (b[i + 2] << 8) + b[i + 3];
      if (len < 2 || i + len + 2 > b.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { height: (b[i + 5] << 8) + b[i + 6], width: (b[i + 7] << 8) + b[i + 8] };
      }
      i += len + 2;
    }
  }
  return { width: null, height: null };
}

const observations = existsSync(OBSERVATIONS_FILE)
  ? JSON.parse(readFileSync(OBSERVATIONS_FILE, 'utf8'))
  : [];
if (observations.length && observations.some((r, i) => r.sample?.id !== SAMPLES[i]?.id)) {
  throw new Error('Existing observation checkpoint does not match the fixed sample manifest.');
}
for (let i = observations.length; i < SAMPLES.length; i += 1) {
  const sample = SAMPLES[i];
  const capture = {};
  process.stdout.write(`${i + 1}/10 ${sample.id} ... `);
  try {
    const observation = await observeWithFailover(
      { id: sample.id, name: null, nameAr: null, imageUrl: sample.imageUrl },
      {
        keyChain,
        maxRateRetries: 3,
        backoffMs: 2000,
        // No OCR provider exists in this validation. The model and parser receive
        // only the crop; D4D comparison data is not loaded yet.
        onCrop: async ({ contentType, bytes, cropUrl }) => {
          const file = `${String(i + 1).padStart(2, '0')}${extension(contentType, cropUrl)}`;
          writeFileSync(join(ASSET_DIR, file), new Uint8Array(bytes));
          Object.assign(capture, {
            file: `assets/${file}`,
            contentType,
            bytes: bytes.byteLength,
            ...imageDimensions(bytes, contentType),
          });
        },
      },
    );
    observations.push({ sample, capture, observation, error: null });
    writeFileSync(OBSERVATIONS_FILE, JSON.stringify(observations, null, 2), 'utf8');
    console.log(observation?.parsed ? 'observed' : 'declined');
  } catch (error) {
    observations.push({ sample, capture, observation: null, error: String(error?.message || error) });
    writeFileSync(OBSERVATIONS_FILE, JSON.stringify(observations, null, 2), 'utf8');
    console.log(`ERROR ${String(error?.message || error).slice(0, 120)}`);
  }
}

if (observations.length !== 10) throw new Error('Vision validation did not account for exactly 10 samples.');

// Human-comparison data is intentionally loaded only after all Vision requests.
// This SELECT has no writes and none of its fields can affect the observations.
const ids = SAMPLES.map((s) => `'${s.id.replace(/'/g, "''")}'`).join(',');
const sql = `SELECT o.id,o.store,o.category,o.search_text AS d4d_ocr,e.name AS previous_name,e.name_ar AS previous_name_ar,e.brand AS previous_brand,e.size AS previous_size,e.confidence AS previous_confidence,e.corroboration AS previous_corroboration,e.match_text AS previous_match_text,e.model AS previous_model,e.enriched_at AS previous_enriched_at,e.mint_verdict AS previous_mint_verdict FROM offers o LEFT JOIN offer_enrichments e ON e.id=o.id WHERE o.id IN (${ids})`;
const wranglerBin = process.platform === 'win32'
  ? join(process.env.APPDATA, 'npm', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  : join(HERE, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const d1Raw = execFileSync(
  process.execPath,
  [wranglerBin, 'd1', 'execute', 'brochure-engine', '--remote', '--json', '--command', sql],
  { cwd: HERE, encoding: 'utf8', shell: false, maxBuffer: 16 * 1024 * 1024 },
);
const comparisonRows = JSON.parse(d1Raw)[0]?.results || [];
const comparisonById = new Map(comparisonRows.map((r) => [r.id, r]));

const fields = ['name', 'name_ar', 'brand', 'size', 'confidence', 'corroboration', 'match_text', 'model'];
const records = observations.map(({ sample, capture, observation, error }, index) => {
  const previousRow = comparisonById.get(sample.id) || {};
  const parsed = observation?.parsed || {};
  const previous = {
    name: previousRow.previous_name ?? null,
    name_ar: previousRow.previous_name_ar ?? null,
    brand: previousRow.previous_brand ?? null,
    size: previousRow.previous_size ?? null,
    confidence: previousRow.previous_confidence ?? null,
    corroboration: previousRow.previous_corroboration ?? null,
    match_text: previousRow.previous_match_text ?? null,
    model: previousRow.previous_model ?? null,
    enriched_at: previousRow.previous_enriched_at ?? null,
    mint_verdict: previousRow.previous_mint_verdict ?? null,
  };
  const next = observation ? {
    name: parsed.name ?? null,
    name_ar: parsed.nameAr ?? null,
    brand: parsed.brand ?? null,
    size: parsed.size ?? null,
    confidence: parsed.confidence ?? null,
    // No OCR ran. D4D OCR is never substituted.
    corroboration: null,
    match_text: parsed ? visionMatchText({ name: parsed.name, name_ar: parsed.nameAr, brand: parsed.brand }) : null,
    model: observation.model,
    observed_at: observation.observedAt,
  } : null;
  const differences = Object.fromEntries(fields.map((field) => [field, {
    previous: previous[field] ?? null,
    next: next?.[field] ?? null,
    changed: JSON.stringify(previous[field] ?? null) !== JSON.stringify(next?.[field] ?? null),
  }]));
  return {
    index: index + 1,
    id: sample.id,
    store: previousRow.store ?? null,
    category: previousRow.category ?? null,
    crop_url: sample.imageUrl,
    crop: capture,
    raw_vision_json: observation?.rawReply ?? null,
    previous_enrichment: previous,
    new_enrichment: next,
    differences,
    d4d_ocr_human_reference_only: previousRow.d4d_ocr ?? null,
    error,
  };
});

const reportData = {
  generated_at: new Date().toISOString(),
  sample_count: records.length,
  model: DEFAULT_MODEL,
  prompt_sha256: createHash('sha256').update(VISION_PROMPT).digest('hex'),
  extraction_input_contract: ['crop image bytes'],
  ocr_used_for_extraction_or_acceptance: false,
  d4d_ocr_used_for_extraction: false,
  production_writes: 0,
  records,
};
writeFileSync(join(REPORT_DIR, 'data.json'), JSON.stringify(reportData, null, 2), 'utf8');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const display = (v) => v == null ? '<span class="null">null</span>' : `<span dir="auto">${esc(typeof v === 'object' ? JSON.stringify(v) : v)}</span>`;
const cards = records.map((r) => {
  const diffRows = fields.map((f) => `<tr class="${r.differences[f].changed ? 'changed' : ''}"><th>${esc(f)}</th><td>${display(r.differences[f].previous)}</td><td>${display(r.differences[f].next)}</td><td>${r.differences[f].changed ? 'changed' : 'same'}</td></tr>`).join('');
  return `<article class="card">
    <header><div><span class="num">${r.index}</span><strong>${esc(r.category || 'uncategorized')}</strong><div class="id">${esc(r.id)}</div></div><span class="quality">${esc(r.crop.width)}×${esc(r.crop.height)} · ${Math.round((r.crop.bytes || 0) / 1024)} KiB</span></header>
    <div class="grid"><figure><img src="${esc(r.crop.file)}" alt="Product crop ${r.index}"><figcaption>Exact crop sent to Vision</figcaption></figure>
    <section><h3>Raw Vision JSON</h3><pre dir="auto">${esc(r.raw_vision_json ?? r.error ?? 'null')}</pre></section></div>
    <h3>Field-by-field comparison</h3><table><thead><tr><th>Field</th><th>Previous</th><th>New crop-only</th><th>Status</th></tr></thead><tbody>${diffRows}</tbody></table>
    <details><summary>D4D OCR — human comparison only; loaded after Vision completed</summary><pre dir="auto">${esc(r.d4d_ocr_human_reference_only)}</pre></details>
  </article>`;
}).join('\n');

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crop-only Vision validation — 10 products</title><style>
:root{color-scheme:light;background:#f4f6fb;color:#182033;font:15px/1.5 Inter,Segoe UI,Arial,sans-serif}body{margin:0}.wrap{max-width:1180px;margin:auto;padding:32px 20px 80px}.hero,.card{background:#fff;border:1px solid #dfe4ee;border-radius:16px;box-shadow:0 4px 18px #1a2b4a0d}.hero{padding:24px;margin-bottom:22px}.hero h1{margin:0 0 8px;font-size:28px}.hero p{margin:6px 0}.ok{color:#08783f;font-weight:700}.card{padding:20px;margin:18px 0}.card header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;border-bottom:1px solid #e8ebf2;padding-bottom:14px}.num{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#235cf2;color:#fff;margin-right:10px}.id,.quality{color:#68738a;font:12px ui-monospace,Consolas,monospace}.grid{display:grid;grid-template-columns:minmax(260px,38%) 1fr;gap:20px;margin:18px 0}figure{margin:0}img{width:100%;max-height:440px;object-fit:contain;background:#f7f8fb;border:1px solid #e0e5ef;border-radius:12px}figcaption{text-align:center;color:#68738a;margin-top:6px}h3{font-size:14px;margin:16px 0 8px}pre{white-space:pre-wrap;word-break:break-word;background:#111827;color:#e5eefc;padding:14px;border-radius:10px;max-height:320px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;vertical-align:top;border:1px solid #e1e5ed;padding:8px}thead th{background:#f3f5f9}.changed td,.changed th{background:#fff8e6}.null{color:#8992a5;font-style:italic}details{margin-top:16px}summary{cursor:pointer;color:#43506a;font-weight:600}@media(max-width:760px){.grid{grid-template-columns:1fr}.card{padding:14px}.quality{display:none}table{display:block;overflow:auto}}
</style></head><body><main class="wrap"><section class="hero"><h1>Crop-only Vision validation</h1><p><strong>Exactly 10 products</strong> · multiple categories · mixed prior corroboration and crop complexity.</p><p class="ok">Production writes: 0 · Historical backfill: not started · Registry: untouched</p><p>Vision inputs were structurally limited to the prompt and crop bytes. D4D OCR and prior enrichment were queried only after all ten Mistral calls and appear solely inside the human-reference sections.</p><p>Prompt SHA-256: <code>${reportData.prompt_sha256}</code></p></section>${cards}</main></body></html>`;
writeFileSync(join(REPORT_DIR, 'index.html'), html, 'utf8');

console.log(`Report: ${join(REPORT_DIR, 'index.html')}`);
console.log(`Data:   ${join(REPORT_DIR, 'data.json')}`);
console.log('Production writes: 0. Historical backfill: not started.');
