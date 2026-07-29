// Final scoring against the human verdicts. Cost uses the same pricing basis as
// every prior benchmark in this project (extraction-strategy-20 score-benchmark.mjs):
// Small $0.15/M in, $0.60/M out; Medium $1.50/M in, $7.50/M out.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, '..', 'mistral-medium-production-validation-50-2026-07-25');
const rd = async (p) => JSON.parse(await readFile(p, 'utf8'));

const VERDICTS = {
  2: 'Tie', 4: 'Medium', 5: 'Tie', 6: 'Tie', 7: 'Tie', 8: 'Small', 9: 'Tie',
  11: 'Tie', 12: 'Tie', 20: 'Tie', 21: 'Tie', 22: 'Tie', 23: 'Medium', 24: 'Tie',
  25: 'Tie', 26: 'Tie', 27: 'Tie', 29: 'Tie', 30: 'Tie', 31: 'Tie', 33: 'Medium',
  34: 'Tie', 36: 'Tie', 39: 'Medium', 40: 'Tie', 41: 'Tie', 45: 'Tie', 46: 'Medium',
  49: 'Tie', 50: 'Tie',
};

const PRICE = {
  small: { in: 0.15 / 1e6, out: 0.60 / 1e6 },
  medium: { in: 1.50 / 1e6, out: 7.50 / 1e6 },
};

const { rows } = await rd(join(HERE, 'routing-table.json'));
const small = (await rd(join(HERE, 'small-30-results.json'))).samples;
const mediumAll = (await rd(join(BASE, 'verbatim-results.json'))).samples;
const idx = new Set(rows.map((r) => r.index));
const medium = mediumAll.filter((s) => idx.has(s.index));

const n = rows.length;
const tally = { Small: 0, Medium: 0, Tie: 0, 'Both wrong': 0 };
for (const r of rows) tally[VERDICTS[r.index]] += 1;

// --- pipeline behaviour (gate = registry, as configured; D4D shown alongside) ---
const escalated = rows.filter((r) => r.reg.esc === 'YES');
const escalationRate = escalated.length / n;
const acceptedDirectly = n - escalated.length;

// Under the pipeline Medium only runs on escalated crops. Nothing escalated, so
// every crop the human awarded to Medium is a defect the pipeline SHIPS.
const shippedDefects = rows.filter((r) => VERDICTS[r.index] === 'Medium' && r.reg.esc !== 'YES');
const mediumAddedNoValue = rows.filter((r) => VERDICTS[r.index] !== 'Medium');

// --- cost ---
const usage = (arr) => arr.reduce((a, s) => {
  a.in += s.usage?.prompt_tokens ?? 0;
  a.out += s.usage?.completion_tokens ?? 0;
  a.lat += s.latency_ms ?? 0;
  return a;
}, { in: 0, out: 0, lat: 0 });

const us = usage(small);
const um = usage(medium);
const costSmall = us.in * PRICE.small.in + us.out * PRICE.small.out;
const costMedium = um.in * PRICE.medium.in + um.out * PRICE.medium.out;
// routed cost = every crop through Small + Medium only on escalations
const escSet = new Set(escalated.map((r) => r.index));
const umEsc = usage(medium.filter((s) => escSet.has(s.index)));
const costRouted = costSmall + (umEsc.in * PRICE.medium.in + umEsc.out * PRICE.medium.out);

// --- statistics: discordant pairs only ---
const discordant = tally.Small + tally.Medium;
// two-sided exact binomial, p=0.5
const C = (a, b) => { let r = 1; for (let i = 0; i < b; i += 1) r = (r * (a - i)) / (i + 1); return r; };
let pTwo = 0;
for (let k = 0; k <= discordant; k += 1) {
  const p = C(discordant, k) * 0.5 ** discordant;
  if (p <= C(discordant, tally.Medium) * 0.5 ** discordant + 1e-12) pTwo += p;
}
// Wilson 95% CI for the defect rate
const wilson = (k, m) => {
  if (!m) return [0, 0];
  const z = 1.959964; const ph = k / m; const d = 1 + (z * z) / m;
  const c = ph + (z * z) / (2 * m);
  const s = z * Math.sqrt((ph * (1 - ph)) / m + (z * z) / (4 * m * m));
  return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
};
const [lo, hi] = wilson(shippedDefects.length, n);

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const out = {
  n,
  verdicts: tally,
  pipeline: {
    small_accepted_directly: acceptedDirectly,
    small_escalated: escalated.length,
    escalation_rate: escalationRate,
    medium_corrected_small: 0,
    medium_would_have_corrected: shippedDefects.length,
    medium_added_no_value: mediumAddedNoValue.length,
    shipped_defect_crops: shippedDefects.map((r) => r.index),
  },
  cost: {
    small_30: costSmall, medium_30: costMedium, routed_30: costRouted,
    per_crop_small: costSmall / n, per_crop_medium: costMedium / n, per_crop_routed: costRouted / n,
    reduction_vs_medium: 1 - costRouted / costMedium,
    ratio: costMedium / costSmall,
  },
  latency: { small_mean_ms: us.lat / small.length, medium_mean_ms: um.lat / medium.length },
  quality: {
    defect_rate: shippedDefects.length / n,
    ci95: [lo, hi],
    discordant_pairs: discordant,
    p_two_sided: pTwo,
  },
};
await writeFile(join(HERE, 'verdict-metrics.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8');

console.log('=== HUMAN VERDICTS (n=%d) ===', n);
console.log('Medium better %d | Small better %d | Tie %d', tally.Medium, tally.Small, tally.Tie);
console.log('\n=== PIPELINE AS PROPOSED ===');
console.log('Small accepted directly : %d/%d (%s)', acceptedDirectly, n, pct(acceptedDirectly / n));
console.log('Small escalated         : %d/%d (%s)', escalated.length, n, pct(escalationRate));
console.log('Medium corrected Small  : 0  (Medium never ran)');
console.log('Medium WOULD have fixed : %d  -> shipped as defects: crops %s',
  shippedDefects.length, shippedDefects.map((r) => r.index).join(', '));
console.log('Medium added no value   : %d/%d (%s)', mediumAddedNoValue.length, n, pct(mediumAddedNoValue.length / n));
console.log('\n=== COST (measured tokens) ===');
console.log('always-Medium : $%s  ($%s/crop)', costMedium.toFixed(5), (costMedium / n).toFixed(6));
console.log('always-Small  : $%s  ($%s/crop)', costSmall.toFixed(5), (costSmall / n).toFixed(6));
console.log('routed        : $%s  ($%s/crop)', costRouted.toFixed(5), (costRouted / n).toFixed(6));
console.log('reduction vs always-Medium: %s   (Medium/Small ratio %sx)',
  pct(out.cost.reduction_vs_medium), out.cost.ratio.toFixed(1));
console.log('\n=== QUALITY ===');
console.log('defect rate %s  95%% CI [%s, %s]', pct(out.quality.defect_rate), pct(lo), pct(hi));
console.log('discordant pairs %d, two-sided exact binomial p = %s', discordant, pTwo.toFixed(3));
console.log('latency mean: small %sms | medium %sms',
  out.latency.small_mean_ms.toFixed(0), out.latency.medium_mean_ms.toFixed(0));
