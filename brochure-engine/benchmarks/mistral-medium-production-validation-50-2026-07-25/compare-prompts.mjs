// Paired comparison of the baseline and verbatim runs over the SAME 50 crops.
// Both arms are scored by score-benchmark.mjs against the same human-canonical
// truth, so every crop is a matched pair and McNemar's exact test applies.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = JSON.parse(await readFile(join(HERE, 'benchmark-metrics.json'), 'utf8'));
const verb = JSON.parse(await readFile(join(HERE, 'verbatim-metrics.json'), 'utf8'));

const FIELDS = ['name_en', 'brand', 'current_price', 'old_price', 'quantity'];
const LABEL = {
  name_en: 'English name',
  brand: 'Brand',
  current_price: 'Current price',
  old_price: 'Previous price',
  quantity: 'Quantity / size / weight / count',
};

function choose(n, k) {
  let out = 1;
  for (let i = 1; i <= k; i += 1) out = (out * (n - k + i)) / i;
  return out;
}

// Two-sided exact McNemar (binomial sign test on the discordant pairs).
function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const hi = Math.max(b, c);
  let tail = 0;
  for (let k = hi; k <= n; k += 1) tail += choose(n, k) * 0.5 ** n;
  return Math.min(1, 2 * tail);
}

const report = { schema_version: 'prompt-ab-comparison-v1', compared_at: new Date().toISOString(), fields: {} };

for (const field of FIELDS) {
  let b = 0; // baseline correct -> verbatim wrong  (regressions)
  let c = 0; // baseline wrong  -> verbatim correct (gains)
  const regressed = [];
  const gained = [];
  for (const row of base.per_image) {
    const before = row.fields[field];
    const after = verb.per_image.find((x) => x.index === row.index).fields[field];
    if (before.status === 'unadjudicable' || after.status === 'unadjudicable') continue;
    const okB = before.status === 'correct';
    const okA = after.status === 'correct';
    if (okB && !okA) { b += 1; regressed.push(row.index); }
    if (!okB && okA) { c += 1; gained.push(row.index); }
  }
  report.fields[field] = {
    label: LABEL[field],
    baseline: base.accuracy_all_adjudicable[field],
    verbatim: verb.accuracy_all_adjudicable[field],
    gained: c,
    regressed: b,
    gained_crops: gained,
    regressed_crops: regressed,
    p_value: Number(mcnemarExact(b, c).toPrecision(3)),
  };
}

await writeFile(join(HERE, 'prompt-comparison.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

process.stdout.write('field                 original   verbatim   gained  regressed   McNemar p\n');
for (const field of FIELDS) {
  const r = report.fields[field];
  process.stdout.write(
    `${r.label.padEnd(21)} ${`${r.baseline.correct}/${r.baseline.total}`.padEnd(10)} `
    + `${`${r.verbatim.correct}/${r.verbatim.total}`.padEnd(10)} ${String(r.gained).padStart(5)} `
    + `${String(r.regressed).padStart(10)}   ${r.p_value}\n`,
  );
}
process.stdout.write('\nregressions by field:\n');
for (const field of FIELDS) {
  const r = report.fields[field];
  process.stdout.write(`  ${r.label}: ${r.regressed_crops.length ? r.regressed_crops.join(', ') : 'none'}\n`);
}
