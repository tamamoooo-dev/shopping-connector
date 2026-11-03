// Score results_<method>_<tag>.json against labels.json.
//   node score.mjs results_rules_a.json [results_...]
// A "match" on a NOT is a false alert risk; a "reject" on a SAME is a missed
// deal; "pending" is neither (the sweep asks again) but costs coverage.
import { readFileSync } from 'node:fs';
const labels = JSON.parse(readFileSync(new URL('labels.json', import.meta.url), 'utf8'));
for (const file of process.argv.slice(2)) {
  const { out, stats } = JSON.parse(readFileSync(file, 'utf8'));
  const t = { tp: 0, fp: 0, fn: 0, tn: 0, pendSame: 0, pendNot: 0 };
  const fps = []; const fns = []; const pends = [];
  const perRef = {};
  for (const [key, label] of Object.entries(labels)) {
    if (label === 'ambig') continue;
    const v = out[key]?.verdict || 'missing';
    const ref = key.split('|')[0];
    perRef[ref] ||= { same: 0, found: 0, fp: 0 };
    if (label === 'same') perRef[ref].same += 1;
    if (v === 'match') { if (label === 'same') { t.tp += 1; perRef[ref].found += 1; } else { t.fp += 1; perRef[ref].fp += 1; fps.push(`${key} [${out[key].by}] ${out[key].reason || ''}`); } }
    else if (v === 'reject') { if (label === 'same') { t.fn += 1; fns.push(`${key} [${out[key].by}] ${out[key].reason || ''}`); } else t.tn += 1; }
    else { if (label === 'same') { t.pendSame += 1; pends.push(`${key} [${out[key]?.by}] ${out[key]?.reason || ''}`); } else t.pendNot += 1; }
  }
  const sameN = t.tp + t.fn + t.pendSame;
  console.log(`\n== ${file}  ${stats ? `calls ${stats.calls} ${Math.round(stats.ms / 1000)}s tokens ${stats.promptTokens}+${stats.completionTokens}` : ''}`);
  console.log(`  SAME found ${t.tp}/${sameN} (recall ${(t.tp / sameN * 100).toFixed(1)}%), missed-by-reject ${t.fn}, pending ${t.pendSame}`);
  console.log(`  FALSE matches ${t.fp} (precision ${(t.tp / Math.max(1, t.tp + t.fp) * 100).toFixed(1)}%), NOT pending ${t.pendNot}, NOT rejected ${t.tn}`);
  console.log('  per ref:', Object.entries(perRef).map(([r, v]) => `${r.split('-')[0]} ${v.found}/${v.same}${v.fp ? ` fp${v.fp}` : ''}`).join('  '));
  if (process.env.V) {
    if (fps.length) console.log('  FP:\n    ' + fps.join('\n    '));
    if (fns.length) console.log('  FN:\n    ' + fns.join('\n    '));
    if (pends.length) console.log('  PENDING SAME:\n    ' + pends.join('\n    '));
  }
}
