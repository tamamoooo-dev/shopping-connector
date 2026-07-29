// Deterministic scorer for the Mistral Medium production validation.
// Scores exactly five fields: name_en, brand, current_price, old_price, quantity.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Optional argv lets a second run be scored by the SAME code path; defaults
// reproduce the original invocation exactly.
const RESULTS_FILE = process.argv[2] || 'model-results.json';
const METRICS_FILE = process.argv[3] || 'benchmark-metrics.json';

const results = JSON.parse(await readFile(join(HERE, RESULTS_FILE), 'utf8'));
const truth = JSON.parse(await readFile(join(HERE, 'human-canonical.json'), 'utf8'));

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

const metrics = {
  schema_version: 'mistral-medium-production-validation-metrics-v1',
  scored_at: new Date().toISOString(),
  model: results.model,
  strategy: results.strategy,
  sample_digest: results.sample_digest,
  crops: rows.length,
  api_failures: results.samples.filter((item) => !item.ok).length,
  json_parse_rate: `${results.samples.filter((item) => item.json_parsed).length}/${results.samples.length}`,
  accuracy_all_adjudicable: Object.fromEntries(FIELDS.map((field) => [field, tally(field)])),
  accuracy_field_present_only: Object.fromEntries(FIELDS.map((field) => [field, tally(field, { requirePresent: true })])),
  per_image: rows,
};

await writeFile(join(HERE, METRICS_FILE), `${JSON.stringify(metrics, null, 2)}\n`, 'utf8');

const header = ['field', 'all adjudicable', 'field-present only'];
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
