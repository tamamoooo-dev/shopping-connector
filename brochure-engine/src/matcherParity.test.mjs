// matcherParity.test.mjs — this mirror (engine src/matching.js) against the
// shared golden vectors. The frontend runs the same file against match.js;
// see ../matcher-parity.mjs for the format and how to regenerate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as engine from './matching.js';
import { runCase, VECTORS_FILE } from '../matcher-parity.mjs';

const SIDE = 'engine';
const vectors = JSON.parse(readFileSync(new URL(`./${VECTORS_FILE}`, import.meta.url), 'utf8'));

let checked = 0;
const failures = [];
for (const [fn, list] of Object.entries(vectors.cases)) {
  for (const [args, stored] of list) {
    const expected = stored && typeof stored === 'object' && '$diverge' in stored ? stored.$diverge[SIDE] : stored;
    const actual = runCase(engine, fn, args, vectors.items);
    checked += 1;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push({ fn, args, expected, actual });
  }
}
for (const f of failures.slice(0, 10)) {
  console.error(`  DRIFT ${f.fn}(${JSON.stringify(f.args).slice(0, 120)})\n    expected ${JSON.stringify(f.expected).slice(0, 160)}\n    actual   ${JSON.stringify(f.actual).slice(0, 160)}`);
}
assert.equal(failures.length, 0, `${failures.length} matcher case(s) drifted from the shared vectors — change BOTH mirrors, then regenerate (matcher-parity.mjs)`);
console.log(`matcherParity.test: ${checked} cases match the shared vectors (${Object.values(vectors.divergences).reduce((n, v) => n + v, 0)} pinned divergences)`);
