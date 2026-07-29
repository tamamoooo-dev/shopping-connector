import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const results = JSON.parse(await readFile(join(HERE, 'model-results.json'), 'utf8'));
const truth = JSON.parse(await readFile(join(HERE, 'human-canonical.json'), 'utf8'));

const VARIANTS = [
  ['small_current', 'Mistral Small — current production prompt', 'small'],
  ['small_expanded_json', 'Mistral Small — expanded literal JSON', 'small'],
  ['ocr_current_parser', 'Mistral OCR — current deterministic parser', 'ocr-raw'],
  ['ocr_structured_annotation', 'Mistral OCR — structured annotation', 'ocr-annotated'],
  ['medium_expanded_json', 'Mistral Medium — expanded literal JSON', 'medium'],
];
const FIELDS = [
  'name_en', 'name_ar', 'brand', 'current_price', 'old_price',
  'unit', 'package_size', 'quantity', 'package_type',
];
const IDENTITY_WEIGHTS = {
  name_en: 25,
  name_ar: 20,
  brand: 15,
  current_price: 15,
  unit: 10,
  package_size: 10,
  quantity: 5,
};
const ARABIC_DIGITS = new Map([
  ['٠', '0'], ['١', '1'], ['٢', '2'], ['٣', '3'], ['٤', '4'],
  ['٥', '5'], ['٦', '6'], ['٧', '7'], ['٨', '8'], ['٩', '9'],
  ['۰', '0'], ['۱', '1'], ['۲', '2'], ['۳', '3'], ['۴', '4'],
  ['۵', '5'], ['۶', '6'], ['۷', '7'], ['۸', '8'], ['۹', '9'],
]);

function digits(value) {
  return [...String(value ?? '')].map((char) => ARABIC_DIGITS.get(char) ?? char).join('');
}

function normText(value) {
  return digits(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en')
    .replace(/[ىي]/gu, 'ي')
    .replace(/ک/gu, 'ك')
    .replace(/ة/gu, 'ه')
    .replace(/أ|إ|آ/gu, 'ا')
    .replace(/[\u064b-\u065f\u0670ـ]/gu, '')
    .replace(/[×*]/gu, 'x')
    .replace(/&/gu, ' and ')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .trim()
    .replace(/\s+/gu, ' ');
}

function compact(value) {
  return normText(value).replace(/\s+/gu, '');
}

function textStatus(expected, actual, aliases = []) {
  if (expected == null) return actual == null ? 'correct_null' : 'unsupported';
  if (actual == null) return 'missing';
  const expectedForms = [expected, ...aliases].map(normText);
  const got = normText(actual);
  if (expectedForms.includes(got)) return 'exact';
  if (expectedForms.some((item) => item.length >= 4 && (item.includes(got) || got.includes(item)))) {
    return 'partial';
  }
  return 'wrong';
}

function numberStatus(expected, actual, alternate) {
  if (expected == null) return actual == null ? 'correct_null' : 'unsupported';
  if (actual == null) return 'missing';
  if (Math.abs(Number(expected) - Number(actual)) < 0.001) return 'exact';
  if (alternate != null && Math.abs(Number(alternate) - Number(actual)) < 0.001) return 'role_error';
  return 'wrong';
}

function normUnit(value) {
  const raw = normText(value);
  if (!raw) return null;
  if (/^(g|gm|gr|gram|grams|جم|جرام|غرام|غم)$/u.test(raw)) return 'g';
  if (/^(kg|kgs|kilogram|kilograms|kilo|kilos|كجم|كغم|كيلو)$/u.test(raw)) return 'kg';
  if (/^(ml|milliliter|milliliters|مل)$/u.test(raw)) return 'ml';
  if (/^(l|liter|liters|litre|litres|لتر)$/u.test(raw)) return 'l';
  if (/^(pc|pcs|piece|pieces|قطعه)$/u.test(raw)) return 'pcs';
  if (/^(sheet|sheets|ورقه)$/u.test(raw)) return 'sheets';
  return raw;
}

function unitStatus(expected, actual) {
  if (expected == null) return actual == null ? 'correct_null' : 'unsupported';
  if (actual == null) return 'missing';
  return normUnit(expected) === normUnit(actual) ? 'exact' : 'wrong';
}

function normSize(value) {
  return compact(value)
    .replace(/kilograms?|kilos?|كجم|كغم|كيلو/gu, 'kg')
    .replace(/grams?|جرام|غرام|غم|جم/gu, 'g')
    .replace(/milliliters?|مل/gu, 'ml')
    .replace(/liters?|litres?|لتر/gu, 'l')
    .replace(/pieces?|pcs?|قطعه/gu, 'pcs')
    .replace(/sheets?|ورقه/gu, 'sheets')
    .replace(/,/gu, '.');
}

function sizeStatus(expected, actual) {
  if (expected == null) return actual == null ? 'correct_null' : 'unsupported';
  if (actual == null) return 'missing';
  const want = normSize(expected);
  const got = normSize(actual);
  if (want === got) return 'exact';
  if (want.length >= 2 && (want.includes(got) || got.includes(want))) return 'partial';
  return 'wrong';
}

function quantityStatus(expected, actual) {
  if (expected == null) return actual == null ? 'correct_null' : 'unsupported';
  if (actual == null) return 'missing';
  const want = digits(expected).match(/\d+/u)?.[0] ?? '';
  const raw = digits(actual).trim();
  const got = raw.match(/\d+/u)?.[0] ?? '';
  if (want === got && (/^\s*\d+\s*$/u.test(raw) || /^\s*\d+\s*(pc|pcs|pack|x)/iu.test(raw))) {
    return 'exact';
  }
  return 'wrong';
}

function packageTypeStatus(expected, actual) {
  if (expected == null) return actual == null ? 'correct_null' : 'unsupported';
  return textStatus(expected, actual);
}

function fieldStatus(field, expected, actual, sample) {
  if (field === 'brand') return textStatus(expected, actual, sample.brand_aliases);
  if (field === 'current_price') return numberStatus(expected, actual, sample.old_price);
  if (field === 'old_price') return numberStatus(expected, actual, sample.current_price);
  if (field === 'unit') return unitStatus(expected, actual);
  if (field === 'package_size') return sizeStatus(expected, actual);
  if (field === 'quantity') return quantityStatus(expected, actual);
  if (field === 'package_type') return packageTypeStatus(expected, actual);
  return textStatus(expected, actual);
}

function usefulAttributes(expected, actual) {
  const expectedNorm = expected.map(normText);
  let useful = 0;
  let unsupported = 0;
  for (const value of actual || []) {
    const got = normText(value);
    const supported = expectedNorm.some((want) => want.includes(got) || got.includes(want));
    if (supported) useful += 1;
    else unsupported += 1;
  }
  return { useful, unsupported, returned: (actual || []).length };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[index] ?? null;
}

function flattenUsage(usage) {
  if (!usage) return { input: null, output: null, total: null, pages: null };
  if (usage.pages_processed != null) {
    return { input: null, output: null, total: null, pages: usage.pages_processed };
  }
  if (usage.pass1 || usage.pass2) {
    const one = flattenUsage(usage.pass1);
    const two = flattenUsage(usage.pass2);
    return {
      input: (one.input || 0) + (two.input || 0),
      output: (one.output || 0) + (two.output || 0),
      total: (one.total || 0) + (two.total || 0),
      pages: null,
    };
  }
  return {
    input: usage.prompt_tokens ?? null,
    output: usage.completion_tokens ?? null,
    total: usage.total_tokens ?? null,
    pages: null,
  };
}

const rows = [];
const summaries = {};
for (const [id, label, pricing] of VARIANTS) {
  const summary = {
    id,
    label,
    complete: 0,
    fields: Object.fromEntries(FIELDS.map((field) => [field, {
      applicable: 0, exact: 0, partial: 0, missing: 0, wrong: 0,
      role_error: 0, correct_null: 0, unsupported: 0,
    }])),
    populated: 0,
    unsupported: 0,
    expected_present: 0,
    missing: 0,
    attributes: { useful: 0, unsupported: 0, returned: 0 },
    latencies: [],
    requests: 0,
    usage: { input: 0, output: 0, total: 0, pages: 0 },
  };
  for (const sample of truth.samples) {
    const resultRow = results.samples.find((item) => item.index === sample.index);
    const result = resultRow?.variants?.[id];
    if (!result?.ok) continue;
    summary.complete += 1;
    summary.latencies.push(result.latency_ms);
    summary.requests += result.requests ?? 1;
    const usage = flattenUsage(result.usage);
    for (const key of ['input', 'output', 'total', 'pages']) {
      summary.usage[key] += usage[key] || 0;
    }
    const statuses = {};
    let weightedEarned = 0;
    let weightedPossible = 0;
    for (const field of FIELDS) {
      const expected = sample[field] ?? null;
      const actual = result.structured?.[field] ?? null;
      const status = fieldStatus(field, expected, actual, sample);
      statuses[field] = status;
      summary.fields[field][status] += 1;
      if (expected != null) {
        summary.fields[field].applicable += 1;
        summary.expected_present += 1;
        if (status === 'missing') summary.missing += 1;
      }
      if (actual != null) {
        summary.populated += 1;
        if (status === 'wrong' || status === 'unsupported') summary.unsupported += 1;
      }
      if (IDENTITY_WEIGHTS[field] && expected != null) {
        weightedPossible += IDENTITY_WEIGHTS[field];
        if (status === 'exact') weightedEarned += IDENTITY_WEIGHTS[field];
        else if (status === 'partial') weightedEarned += IDENTITY_WEIGHTS[field] * 0.5;
      }
    }
    const attrs = usefulAttributes(sample.attributes, result.structured?.attributes);
    summary.attributes.useful += attrs.useful;
    summary.attributes.unsupported += attrs.unsupported;
    summary.attributes.returned += attrs.returned;
    rows.push({
      index: sample.index,
      store: resultRow.store,
      category: resultRow.category,
      variant: id,
      statuses,
      identity_score: weightedPossible ? weightedEarned / weightedPossible : 0,
      useful_attributes: attrs.useful,
      unsupported_attributes: attrs.unsupported,
      structured: result.structured,
    });
  }
  const fieldAccuracy = {};
  for (const field of FIELDS) {
    const value = summary.fields[field];
    fieldAccuracy[field] = {
      applicable: value.applicable,
      exact_accuracy: value.applicable ? value.exact / value.applicable : null,
      usable_accuracy: value.applicable ? (value.exact + value.partial) / value.applicable : null,
      ...value,
    };
  }
  const sampleRows = rows.filter((row) => row.variant === id);
  const avgIdentity = sampleRows.reduce((sum, row) => sum + row.identity_score, 0) / sampleRows.length;
  const avgLatency = summary.latencies.reduce((sum, value) => sum + value, 0) / summary.latencies.length;
  let estimatedCostUsd = null;
  if (pricing === 'small') estimatedCostUsd = summary.usage.input * 0.15e-6 + summary.usage.output * 0.6e-6;
  if (pricing === 'medium') estimatedCostUsd = summary.usage.input * 1.5e-6 + summary.usage.output * 7.5e-6;
  if (pricing === 'ocr-raw') estimatedCostUsd = summary.usage.pages * 0.004;
  if (pricing === 'ocr-annotated') estimatedCostUsd = summary.usage.pages * 0.005;
  summaries[id] = {
    ...summary,
    field_accuracy: fieldAccuracy,
    weighted_identity_score: avgIdentity,
    hallucination_rate: summary.populated ? summary.unsupported / summary.populated : 0,
    missing_field_rate: summary.expected_present ? summary.missing / summary.expected_present : 0,
    json_consistency: summary.complete / truth.samples.length,
    avg_latency_ms: avgLatency,
    p95_latency_ms: percentile(summary.latencies, 0.95),
    estimated_cost_usd: estimatedCostUsd,
  };
  delete summaries[id].latencies;
  delete summaries[id].fields;
}

const perImage = truth.samples.map((sample) => {
  const candidates = rows.filter((row) => row.index === sample.index)
    .sort((a, b) => b.identity_score - a.identity_score);
  return {
    index: sample.index,
    store: candidates[0]?.store,
    category: candidates[0]?.category,
    canonical: Object.fromEntries(FIELDS.map((field) => [field, sample[field] ?? null])),
    best_strategy: candidates[0]?.variant ?? null,
    strategies: Object.fromEntries(candidates.map((candidate) => [candidate.variant, {
      identity_score: candidate.identity_score,
      statuses: candidate.statuses,
      useful_attributes: candidate.useful_attributes,
      unsupported_attributes: candidate.unsupported_attributes,
    }])),
  };
});

const ranking = Object.values(summaries)
  .sort((a, b) => (
    b.weighted_identity_score - a.weighted_identity_score
    || a.hallucination_rate - b.hallucination_rate
    || a.estimated_cost_usd - b.estimated_cost_usd
  ))
  .map((item, index) => ({
    rank: index + 1,
    id: item.id,
    label: item.label,
    weighted_identity_score: item.weighted_identity_score,
    hallucination_rate: item.hallucination_rate,
    missing_field_rate: item.missing_field_rate,
    estimated_cost_usd: item.estimated_cost_usd,
    avg_latency_ms: item.avg_latency_ms,
  }));

const output = {
  schema_version: 'human-adjudicated-mistral-benchmark-results-v1',
  generated_at: new Date().toISOString(),
  sample_digest: truth.sample_digest,
  scoring_notes: {
    exact: "Case, whitespace, Unicode digit forms, Arabic alef/ya/kaf variants, and multiplication-sign formatting are ignored; visible wording must otherwise match.",
    partial: "A directly supported but incomplete/superset identity transcription. Partial receives half weight in the composite identity score but is not counted as exact field accuracy.",
    role_error: "A visible price was assigned to the wrong current/old role; it is inaccurate but not counted as invented.",
    hallucination_rate: "Wrong or unsupported populated main-field assignments divided by populated main-field assignments. Partial transcriptions and price-role errors are reported separately and are not labeled hallucinations.",
    missing_field_rate: "Null results divided by human-canonical applicable main fields.",
    weighted_identity_score: IDENTITY_WEIGHTS,
  },
  ranking,
  summaries,
  per_image: perImage,
  excluded_pilot: {
    id: 'medium_two_pass',
    reason: 'High-reasoning two-pass pilot did not complete all 20 samples and exhibited multi-minute per-crop latency; excluded from accuracy ranking.',
    successful_samples: results.samples.filter((sample) => sample.variants.medium_two_pass?.ok).length,
  },
};

await writeFile(join(HERE, 'benchmark-metrics.json'), `${JSON.stringify(output, null, 2)}\n`, 'utf8');

const csvEscape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
const csv = [
  ['image', 'store', 'category', 'best_strategy', ...VARIANTS.map(([id]) => `${id}_score`)],
  ...perImage.map((item) => [
    item.index,
    item.store,
    item.category,
    item.best_strategy,
    ...VARIANTS.map(([id]) => ((item.strategies[id]?.identity_score ?? 0) * 100).toFixed(1)),
  ]),
].map((line) => line.map(csvEscape).join(',')).join('\n');
await writeFile(join(HERE, 'per-image-comparison.csv'), `${csv}\n`, 'utf8');

console.log(JSON.stringify({ ranking, summaries: Object.fromEntries(
  Object.entries(summaries).map(([id, value]) => [id, {
    weighted_identity_score: value.weighted_identity_score,
    hallucination_rate: value.hallucination_rate,
    missing_field_rate: value.missing_field_rate,
    avg_latency_ms: value.avg_latency_ms,
    p95_latency_ms: value.p95_latency_ms,
    estimated_cost_usd: value.estimated_cost_usd,
    usage: value.usage,
    field_accuracy: value.field_accuracy,
  }]),
) }, null, 2));
