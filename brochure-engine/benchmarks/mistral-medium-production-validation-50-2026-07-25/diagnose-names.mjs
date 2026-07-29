// Supplementary diagnostic: classify every failed English-name extraction.
// Does NOT change the headline accuracy — the headline requires the exact
// printed caption in name_en. This only explains WHY each miss happened.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const results = JSON.parse(await readFile(join(HERE, 'model-results.json'), 'utf8'));
const truth = JSON.parse(await readFile(join(HERE, 'human-canonical.json'), 'utf8'));
const metrics = JSON.parse(await readFile(join(HERE, 'benchmark-metrics.json'), 'utf8'));

function tokens(value) {
  if (typeof value !== 'string') return [];
  return value
    .toLowerCase()
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/[×✕]/gu, 'x')
    .replace(/[^a-z0-9'.]+/gu, ' ')
    .split(/\s+/u)
    .map((token) => token.replace(/^[.']+|[.']+$/gu, ''))
    .filter(Boolean)
    // unit-synonym folding so "623g" == "623gm" and "1ltr" == "1l"
    .map((token) => token
      .replace(/(\d)(grams?|gms?|gr)\b/u, '$1g')
      .replace(/(\d)(lit(?:re|er)s?|ltrs?)\b/u, '$1l')
      .replace(/(\d)(kilos?|kilograms?)\b/u, '$1kg')
      .replace(/(\d)(inch(?:es)?)\b/u, '$1in')
      .replace(/(\d)(pcs|pieces?)\b/u, '$1pc'));
}

const rows = [];
for (const expected of truth.samples) {
  const cell = metrics.per_image.find((item) => item.index === expected.index).fields.name_en;
  if (cell.status !== 'wrong') continue;
  const actual = results.samples.find((item) => item.index === expected.index).structured;
  const want = tokens(expected.name_en.accepted[0]);
  const gotName = tokens(actual.name_en);
  const union = new Set([
    ...gotName,
    ...tokens(actual.brand),
    ...tokens(actual.package_size),
    ...tokens(actual.quantity),
    ...(actual.attributes || []).flatMap(tokens),
  ]);
  const missing = want.filter((token) => !union.has(token));
  const invented = gotName.filter((token) => !new Set(want).has(token));
  let cls;
  if (missing.length === 0 && invented.length === 0) cls = 'decomposition_only';
  else if (missing.length === 0) cls = 'decomposition_plus_extra_wording';
  else if (invented.length === 0) cls = 'truncated_lost_tokens';
  else cls = 'wrong_wording';
  rows.push({
    index: expected.index,
    store: expected.store,
    classification: cls,
    expected: expected.name_en.accepted[0],
    model_name_en: actual.name_en,
    model_brand: actual.brand,
    model_package_size: actual.package_size,
    missing_tokens: missing,
    invented_tokens: invented,
  });
}

const counts = rows.reduce((acc, row) => {
  acc[row.classification] = (acc[row.classification] || 0) + 1;
  return acc;
}, {});

const exact = metrics.accuracy_all_adjudicable.name_en.correct;
const recoverable = rows.filter((row) => row.classification === 'decomposition_only').length;

const summary = {
  schema_version: 'name-failure-diagnostic-v1',
  exact_caption_matches: exact,
  failures: rows.length,
  classification_counts: counts,
  fusible_without_loss: exact + recoverable,
  fusible_without_loss_pct: Math.round(((exact + recoverable) / metrics.accuracy_all_adjudicable.name_en.total) * 1000) / 10,
  note: 'decomposition_only = every printed caption token is still present somewhere in the model output (name_en + brand + package_size + quantity + attributes), so the exact caption is reconstructible by deterministic fusion. It is still scored as a name_en failure in the headline.',
  failures_detail: rows,
};

await writeFile(join(HERE, 'name-failure-diagnostic.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

process.stdout.write(`${JSON.stringify(counts, null, 2)}\n`);
process.stdout.write(`exact ${exact}/50, fusible-without-loss ${summary.fusible_without_loss}/50 (${summary.fusible_without_loss_pct}%)\n\n`);
for (const row of rows.filter((item) => item.classification !== 'decomposition_only')) {
  process.stdout.write(`${String(row.index).padStart(2)} ${row.classification}\n   want: ${row.expected}\n   got : ${row.model_name_en} | brand=${row.model_brand} | size=${row.model_package_size}\n   missing=${JSON.stringify(row.missing_tokens)} invented=${JSON.stringify(row.invented_tokens)}\n`);
}
