#!/usr/bin/env node
// matcher-parity.mjs — the matcher mirrors' golden vectors.
//
// The frontend's src/match.js and this engine's src/matching.js are MIRRORS:
// the same functions must give the same answers, or Search, Summary and the
// watch alerts disagree about which products match. src/matcherParity.vectors.json
// (byte-identical in both repos) pins their outputs on real flyer names and
// queries; each repo's matcherParity.test.mjs runs its own copy against it.
// A case stored as { $diverge: { frontend, engine } } is a KNOWN divergence,
// pinned so it cannot drift further. Fixing one means changing BOTH mirrors.
//
// Regenerate after a deliberate change to both mirrors (re-runs both over the
// stored inputs and rewrites only the outputs):
//
//   node matcher-parity.mjs ../../live-shopping-assistant/src/match.js --write
//   cp src/matcherParity.vectors.json ../../live-shopping-assistant/src/
//
// Without --write it reports what would change and exits 1 on any difference.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const VECTORS_FILE = 'matcherParity.vectors.json';

// Plain JSON with Sets/Maps flattened and undefined as null, so both sides
// compare structurally.
export function normalize(value) {
  return JSON.parse(JSON.stringify(value === undefined ? null : value, (key, v) => (
    v instanceof Set ? [...v] : v instanceof Map ? Object.fromEntries(v) : v === undefined ? null : v
  )));
}

// Decode one stored case and run it on one side's module.
//   matchStage   [itemIndex, query]
//   offerFamily  [itemIndex]
//   resolveJourneyPool [[[itemIndex, stage, family, type], ...], query, tier]
//   JOURNEY_POLICY []          (a constant, compared as a value)
//   anything else: the args as stored
export function runCase(side, fn, args, items) {
  if (fn === 'JOURNEY_POLICY') return normalize(side.JOURNEY_POLICY);
  if (fn === 'matchStage') return normalize(side.matchStage(items[args[0]], args[1]));
  if (fn === 'offerFamily') return normalize(side.offerFamily(items[args[0]]));
  if (fn === 'resolveJourneyPool') {
    const candidates = args[0].map(([i, stage, family, type]) => ({ i, stage, family, type, text: items[i].name }));
    const out = side.resolveJourneyPool(candidates, args[1], args[2]);
    return normalize({ ...out, kept: out.kept.map((c) => c.i) });
  }
  return normalize(side[fn](...args));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function rebuild(vectors, frontend, engine) {
  const cases = {};
  const divergences = {};
  let changed = 0;
  for (const [fn, list] of Object.entries(vectors.cases)) {
    cases[fn] = list.map(([args, before]) => {
      const f = runCase(frontend, fn, args, vectors.items);
      const e = runCase(engine, fn, args, vectors.items);
      const after = same(f, e) ? f : { $diverge: { frontend: f, engine: e } };
      if (!same(after, before)) changed += 1;
      if (!same(f, e)) divergences[fn] = (divergences[fn] || 0) + 1;
      return [args, after];
    });
  }
  return { vectors: { ...vectors, divergences, cases }, changed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const [frontPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!frontPath) {
    console.error('usage: node matcher-parity.mjs <frontend src/match.js> [--write]');
    process.exit(2);
  }
  const file = join(here, 'src', VECTORS_FILE);
  const vectors = JSON.parse(readFileSync(file, 'utf8'));
  const frontend = await import(pathToFileURL(resolve(frontPath)).href);
  const engine = await import(pathToFileURL(join(here, 'src', 'matching.js')).href);
  const { vectors: next, changed } = rebuild(vectors, frontend, engine);
  console.log(`${changed} case(s) changed; divergences now`, next.divergences);
  if (process.argv.includes('--write')) {
    writeFileSync(file, `${JSON.stringify(next)}\n`);
    console.log(`wrote ${file} — copy it to the frontend's src/ too`);
  } else if (changed) {
    process.exit(1);
  }
}
