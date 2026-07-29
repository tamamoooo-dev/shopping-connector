// Builds the routing-decision table. Decides NOTHING about which model is
// correct — it reports both models' values, both candidate validators, and
// whether the gate could fire. Adjudication is the human's.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSize } from '../../src/matching.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, '..', 'mistral-medium-production-validation-50-2026-07-25');
const SCRATCH = process.env.ROUTING_SCRATCH
  || 'C:/Users/majed/AppData/Local/Temp/claude/C--Users-majed-Desktop-claude/9d200ae2-562d-422c-83ad-1c36abb5adc6/scratchpad';

const rd = async (p) => JSON.parse(await readFile(p, 'utf8'));

const sample = (await rd(join(HERE, 'sample-30.json'))).samples;
const small = (await rd(join(HERE, 'small-30-results.json'))).samples;
const medium = (await rd(join(BASE, 'verbatim-results.json'))).samples;
const d4dRows = (await rd(join(SCRATCH, 'd4d50.json')))[0].results;
const regRows = (await rd(join(SCRATCH, 'reg50.json')))[0].results;

const smallBy = new Map(small.map((r) => [r.index, r]));
const mediumBy = new Map(medium.map((r) => [r.index, r]));
const d4dBy = new Map(d4dRows.map((r) => [r.id, r]));
const regBy = new Map(regRows.map((r) => [r.offer_id, r]));

// canonical size signature via the PRODUCTION canonicalizer, untouched.
const canon = (text) => {
  const p = parseSize('', text || '');
  if (!p || !p.unit || !Number.isFinite(p.total)) return null;
  return `${p.total}${p.unit}`;
};
// model side: truth convention credits package_size OR quantity OR both.
const modelCanon = (s) => (s ? canon([s.package_size, s.quantity].filter(Boolean).join(' ')) : null);
const modelRaw = (s) =>
  (s ? [s.package_size, s.quantity].filter(Boolean).join(' / ') : '') || '—';

// registry side: size_total/size_unit/size_pack is already canonical.
const regCanon = (r) => {
  if (!r || r.size_total == null || !r.size_unit) return null;
  const pack = r.size_pack && r.size_pack > 1 ? r.size_pack : 1;
  return `${r.size_total * pack}${r.size_unit}`;
};

const rows = [];
for (const s of sample) {
  const sm = smallBy.get(s.index)?.structured ?? null;
  const md = mediumBy.get(s.index)?.structured ?? null;
  const d4dRow = d4dBy.get(s.id);
  const regRow = regBy.get(s.id);

  const smallC = modelCanon(sm);
  const mediumC = modelCanon(md);
  const d4dC = canon([d4dRow?.name, d4dRow?.name_ar].filter(Boolean).join(' '));
  const regC = regCanon(regRow);
  // circular if the product's only sighting IS this offer
  const regCircular = Boolean(regRow) && Number(regRow.sightings) <= 1;

  const gate = (validatorC, blindNote) => {
    if (!smallC) return { match: 'n/a', esc: 'NO', why: 'Small returned no size' };
    if (!validatorC) return { match: 'n/a', esc: 'NO', why: blindNote };
    if (validatorC === smallC) return { match: 'YES', esc: 'NO', why: 'canonical values agree' };
    return { match: 'NO', esc: 'YES', why: `canonical conflict ${smallC} vs ${validatorC}` };
  };

  const gD4d = gate(d4dC, 'D4D missing value');
  const gReg = gate(
    regCircular ? null : regC,
    !regRow ? 'no registry sighting' : regCircular ? 'registry circular (1 sighting)' : 'registry has no size',
  );

  rows.push({
    index: s.index,
    store: s.store,
    category: s.category,
    file: s.file,
    small_raw: modelRaw(sm),
    medium_raw: modelRaw(md),
    small_canon: smallC,
    medium_canon: mediumC,
    d4d_canon: d4dC,
    reg_canon: regCircular ? null : regC,
    reg_state: !regRow ? 'absent' : regCircular ? 'circular' : regC ? 'usable' : 'no-size',
    d4d: gD4d,
    reg: gReg,
    models_agree: smallC === mediumC,
    small_name: sm?.name_en ?? null,
    medium_name: md?.name_en ?? null,
    small_brand: sm?.brand ?? null,
    medium_brand: md?.brand ?? null,
    small_price: sm?.current_price ?? null,
    medium_price: md?.current_price ?? null,
  });
}

// ---- summary ---------------------------------------------------------------
const n = rows.length;
const cnt = (f) => rows.filter(f).length;
const summary = {
  n,
  registry_gate: {
    usable: cnt((r) => r.reg_state === 'usable'),
    absent: cnt((r) => r.reg_state === 'absent'),
    circular: cnt((r) => r.reg_state === 'circular'),
    no_size: cnt((r) => r.reg_state === 'no-size'),
    escalated: cnt((r) => r.reg.esc === 'YES'),
    accepted: cnt((r) => r.reg.esc === 'NO'),
  },
  d4d_gate: {
    fired: cnt((r) => r.d4d.match !== 'n/a'),
    blind: cnt((r) => r.d4d.match === 'n/a'),
    escalated: cnt((r) => r.d4d.esc === 'YES'),
  },
  models: {
    size_agree: cnt((r) => r.models_agree),
    size_differ: cnt((r) => !r.models_agree),
    name_differ: cnt((r) => (r.small_name || '') !== (r.medium_name || '')),
    brand_differ: cnt((r) => (r.small_brand || '') !== (r.medium_brand || '')),
    price_differ: cnt((r) => r.small_price !== r.medium_price),
  },
};

await writeFile(join(HERE, 'routing-table.json'), `${JSON.stringify({ summary, rows }, null, 2)}\n`, 'utf8');

console.log('=== GATE COVERAGE (n=%d) ===', n);
console.log('REGISTRY gate  usable %d | absent %d | circular %d | no-size %d  => escalated %d',
  summary.registry_gate.usable, summary.registry_gate.absent, summary.registry_gate.circular,
  summary.registry_gate.no_size, summary.registry_gate.escalated);
console.log('D4D gate       fired  %d | blind %d                             => escalated %d',
  summary.d4d_gate.fired, summary.d4d_gate.blind, summary.d4d_gate.escalated);
console.log('\n=== MODEL DISAGREEMENT (needs your adjudication) ===');
console.log('size differ %d | name differ %d | brand differ %d | price differ %d',
  summary.models.size_differ, summary.models.name_differ,
  summary.models.brand_differ, summary.models.price_differ);
