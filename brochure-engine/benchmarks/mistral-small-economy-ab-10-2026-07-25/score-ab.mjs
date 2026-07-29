// Deterministic scorer for the Small-vs-Medium economic A/B.
// Scores exactly five fields: name_en, brand, current_price, old_price, quantity.
//
// This is score-benchmark.mjs from the Medium production validation. The
// normalizers (normName / normBrand / normQty / normPrice), the UNIT_SYNONYMS
// table, candidates(), the hit rule and tally() are copied character-for-
// character. The only changes are plumbing:
//   1. truth is read from the Medium benchmark directory
//   2. truth.samples is filtered to the crops in sample-10.json (pass "all" as
//      argv[4] to disable the filter)
//   3. an extra `usage` block is emitted so cost/latency come from the same pass
// Equivalence is not asserted in prose: `npm-less` check in verify-scorer.mjs
// re-scores the full 50-crop Medium run through THIS file and diffs the result
// against the published verbatim-metrics.json.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, '..', 'mistral-medium-production-validation-50-2026-07-25');

const RESULTS_FILE = process.argv[2] || 'small-results.json';
const METRICS_FILE = process.argv[3] || 'small-metrics.json';
const SCOPE = process.argv[4] || 'ten';

const results = JSON.parse(await readFile(join(HERE, RESULTS_FILE), 'utf8'));
const truth = JSON.parse(await readFile(join(BASE, 'human-canonical.json'), 'utf8'));

if (SCOPE !== 'all') {
  const keep = new Set(JSON.parse(await readFile(join(HERE, 'sample-10.json'), 'utf8'))
    .samples.map((item) => item.index));
  truth.samples = truth.samples.filter((item) => keep.has(item.index));
}

// --- normalizers -------------------------------------------------------------

// Names: exact printed wording. Only case, whitespace and typographic variants
// of the SAME characters are folded. No word may be added, dropped or reordered.
function normName(value) {
  if (typeof value !== 'string') return null;
  const text = value
    .toLowerCase()
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/[–—]/gu, '-')
    .replace(/[×✕]/gu, 'x')
    .replace(/®|™/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([/,+])\s*/gu, ' $1 ')
    .replace(/\s+/gu, ' ')
    .replace(/[.\s]+$/u, '')
    .trim();
  return text || null;
}

// Brands: same folding as names plus removal of internal separators, so
// "St Michel" / "St.Michel" / "StMichel" are one brand.
function normBrand(value) {
  const text = normName(value);
  if (!text) return null;
  return text.replace(/[^a-z0-9]/gu, '') || null;
}

// Quantity: semantic. Unit synonyms are equivalent (including the Arabic unit
// words, since Arabic wording itself is explicitly out of scope) and spacing is
// irrelevant. Units are matched without word boundaries so that digit-attached
// forms such as "9PCS", "1Ltr" and "18GR" fold the same as "9 pcs".
const UNIT_SYNONYMS = [
  [/(grams?|gms?|grm|gr|جرام|جم|غرام|غم)/gu, 'g'],
  [/(kilograms?|kilos?|kgs?|كيلوجرام|كيلوغرام|كجم|كيلو)/gu, 'kg'],
  [/(millilit(?:re|er)s?|mls|ml|مل)/gu, 'ml'],
  [/(lit(?:re|er)s?|ltrs?|لتر)/gu, 'l'],
  [/(pieces?|pcs?|packs?|pkts?|قطعة|قطع|حبة|حبات|عبوة)/gu, 'pc'],
  [/(inch(?:es)?|in)/gu, 'in'],
];

// `side` is 'model' or 'truth'. The bare-unit collapse models what a production
// consumer would do with a unit that carries no number; it must never be applied
// to the truth list, or an accepted "pc" would silently also accept null.
function normQty(value, side = 'model') {
  if (typeof value !== 'string') return null;
  let text = value
    .toLowerCase()
    .replace(/[×✕*ـ]/gu, 'x')
    .replace(/[–—]/gu, '-')
    .replace(/\band\b/gu, '+')
    .replace(/["”]/gu, ' inch ')
    .replace(/\bper\b|\beach\b|\bfree\b|للحبة|للكيلو|للربطة/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  for (const [pattern, replacement] of UNIT_SYNONYMS) text = text.replace(pattern, replacement);
  text = text.replace(/[^a-z0-9.+x\-]/gu, '');
  // a bare unit with no number carries no quantity information, except the
  // per-kilo basis which IS the printed quantity for loose goods
  if (side === 'model' && /^(g|ml|l|pc|in)$/u.test(text)) return null;
  // "6x250ml" and "250mlx6" are the same expression
  return text.replace(/^([0-9.]+(?:g|kg|ml|l|pc|in))x([0-9]+)$/u, '$2x$1') || null;
}

function normPrice(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

const NORMALIZERS = {
  name_en: normName,
  brand: normBrand,
  quantity: normQty,
  current_price: normPrice,
  old_price: normPrice,
};

// --- candidate extraction ----------------------------------------------------

function candidates(field, output) {
  if (!output) return [];
  if (field === 'quantity') {
    const size = output.package_size;
    const qty = output.quantity;
    const list = [size, qty].filter((item) => typeof item === 'string' && item.trim());
    if (list.length === 2) list.push(`${size} ${qty}`, `${qty} ${size}`);
    // Returning nothing is a candidate ONLY when the model populated neither
    // field — otherwise a wrong value would be excused by an empty sibling.
    return list.length ? list : [null];
  }
  return [output[field] ?? null];
}

// --- scoring -----------------------------------------------------------------

const FIELDS = ['name_en', 'brand', 'current_price', 'old_price', 'quantity'];
const rows = [];

for (const expected of truth.samples) {
  const actual = results.samples.find((item) => item.index === expected.index);
  const row = { index: expected.index, store: expected.store, fields: {} };
  for (const field of FIELDS) {
    const spec = expected[field];
    if (spec?.unadjudicable) {
      row.fields[field] = { status: 'unadjudicable' };
      continue;
    }
    const normalize = NORMALIZERS[field];
    const accepted = spec.accepted.map((item) => (item === null ? null : normalize(item, 'truth')));
    const truthIsNull = accepted.length === 1 && accepted[0] === null;
    const got = candidates(field, actual?.structured);
    const normalizedGot = got.map((item) => (item === null || item === undefined ? null : normalize(item)));
    const hit = normalizedGot.some((item) => accepted.some((want) => want === item));
    row.fields[field] = {
      status: hit ? 'correct' : 'wrong',
      expected: spec.accepted[0],
      got: field === 'quantity'
        ? { package_size: actual?.structured?.package_size ?? null, quantity: actual?.structured?.quantity ?? null }
        : (actual?.structured?.[field] ?? null),
      truth_is_null: truthIsNull,
      returned_null: normalizedGot.every((item) => item === null || item === undefined),
    };
  }
  rows.push(row);
}

function tally(field, { requirePresent = false } = {}) {
  let correct = 0;
  let total = 0;
  let excluded = 0;
  for (const row of rows) {
    const cell = row.fields[field];
    if (cell.status === 'unadjudicable') {
      excluded += 1;
      continue;
    }
    if (requirePresent && cell.truth_is_null) {
      excluded += 1;
      continue;
    }
    total += 1;
    if (cell.status === 'correct') correct += 1;
  }
  return {
    correct,
    total,
    excluded,
    pct: total ? Math.round((correct / total) * 1000) / 10 : null,
  };
}

// --- usage / cost ------------------------------------------------------------
// Pricing basis is the one already used by this project's benchmarks
// (extraction-strategy-20-2026-07-23/score-benchmark.mjs lines 274-275):
//   small  $0.15/M input, $0.60/M output
//   medium $1.50/M input, $7.50/M output
const RATES = {
  'mistral-small-latest': { input: 0.15e-6, output: 0.6e-6 },
  'mistral-medium-latest': { input: 1.5e-6, output: 7.5e-6 },
};

const scored = new Set(rows.map((row) => row.index));
const used = results.samples.filter((item) => item.ok && scored.has(item.index));
const rate = RATES[results.model];
const perCrop = used.map((item) => ({
  index: item.index,
  prompt_tokens: item.usage?.prompt_tokens ?? null,
  completion_tokens: item.usage?.completion_tokens ?? null,
  total_tokens: item.usage?.total_tokens ?? null,
  latency_ms: item.latency_ms,
  cost_usd: (item.usage?.prompt_tokens ?? 0) * rate.input + (item.usage?.completion_tokens ?? 0) * rate.output,
}));
const sum = (key) => perCrop.reduce((total, item) => total + (item[key] || 0), 0);
const latencies = perCrop.map((item) => item.latency_ms).sort((a, b) => a - b);
const usage = {
  pricing_basis: `${results.model}: $${rate.input * 1e6}/M input, $${rate.output * 1e6}/M output`,
  requests: perCrop.length,
  prompt_tokens: sum('prompt_tokens'),
  completion_tokens: sum('completion_tokens'),
  total_tokens: sum('total_tokens'),
  cost_usd: sum('cost_usd'),
  avg_prompt_tokens: sum('prompt_tokens') / perCrop.length,
  avg_completion_tokens: sum('completion_tokens') / perCrop.length,
  avg_total_tokens: sum('total_tokens') / perCrop.length,
  avg_latency_ms: sum('latency_ms') / perCrop.length,
  median_latency_ms: latencies[Math.floor(latencies.length / 2)],
  max_latency_ms: latencies[latencies.length - 1],
  avg_cost_usd: sum('cost_usd') / perCrop.length,
  per_crop: perCrop,
};

const metrics = {
  schema_version: 'mistral-small-economy-ab-10-metrics-v1',
  scored_at: new Date().toISOString(),
  model: results.model,
  strategy: results.strategy,
  prompt_sha256: results.prompt_sha256,
  sample_digest: results.sample_digest,
  crops: rows.length,
  api_failures: results.samples.filter((item) => !item.ok).length,
  json_parse_rate: `${results.samples.filter((item) => item.json_parsed).length}/${results.samples.length}`,
  accuracy_all_adjudicable: Object.fromEntries(FIELDS.map((field) => [field, tally(field)])),
  accuracy_field_present_only: Object.fromEntries(FIELDS.map((field) => [field, tally(field, { requirePresent: true })])),
  usage,
  per_image: rows,
};

await writeFile(join(HERE, METRICS_FILE), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');

const header = ['field', 'all adjudicable', 'field-present only'];
process.stdout.write(`${results.model} — ${rows.length} crops\n`);
process.stdout.write(`${header.join('\t')}\n`);
for (const field of FIELDS) {
  const a = metrics.accuracy_all_adjudicable[field];
  const b = metrics.accuracy_field_present_only[field];
  process.stdout.write(`${field}\t${a.correct}/${a.total} (${a.pct}%)\t${b.correct}/${b.total} (${b.pct}%)\n`);
}
process.stdout.write('\nmisses:\n');
for (const row of rows) {
  const bad = FIELDS.filter((field) => row.fields[field].status === 'wrong');
  if (!bad.length) continue;
  process.stdout.write(`${String(row.index).padStart(2)} ${row.store.padEnd(11)} ${bad.join(', ')}\n`);
}
process.stdout.write(`\navg tokens ${usage.avg_prompt_tokens.toFixed(1)} in / ${usage.avg_completion_tokens.toFixed(1)} out, avg latency ${usage.avg_latency_ms.toFixed(0)} ms, avg cost $${usage.avg_cost_usd.toFixed(6)}\n`);
