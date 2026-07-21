// calibrate-registry.mjs — the §8 calibration workflow CLI (REGISTRY-DESIGN.md
// §8; logic in src/registry/calibrate.js). READ-ONLY against production D1
// (wrangler auth needed, same access pattern as backfill-enrich.mjs — this
// script never writes a remote row). Run from brochure-engine/:
//
//   node calibrate-registry.mjs export            pull the enriched corpus ->
//                                                 calibration/reads.jsonl,
//                                                 sample boundary pairs ->
//                                                 calibration/pairs.jsonl +
//                                                 calibration/labeling.html
//   (open labeling.html, adjudicate, download)  -> calibration/labels.jsonl
//   node calibrate-registry.mjs replay            score the labeled pairs
//                                                 through the production
//                                                 resolution path; ship-gate
//                                                 verdict (attach >= 95%,
//                                                 false-attach <= 0.5%)
//   node calibrate-registry.mjs sweep             threshold grid over the same
//                                                 labels; ranked report
//   node calibrate-registry.mjs measure           mint-gate verdict rates over
//                                                 the corpus (incl. the
//                                                 or_deal lock measurement)
//
// The labels file is APPEND-ONLY across sessions: re-running export with the
// same seed reproduces pair ids, and replay ignores labels for pairs it
// cannot resolve — the corpus only ever grows (§10 discipline).

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { samplePairs, replay, sweep, measureVerdicts } from './src/registry/calibrate.js';

const DIR = 'calibration';
const READS = join(DIR, 'reads.jsonl');
const PAIRS = join(DIR, 'pairs.jsonl');
const LABELS = join(DIR, 'labels.jsonl');
const PAGE = join(DIR, 'labeling.html');

function d1(sql) {
  const out = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', 'brochure-engine', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 256 * 1024 * 1024 },
  );
  const m = /\[[\s\S]*\]/.exec(out);
  return JSON.parse(m[0])[0].results;
}

const readJsonl = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const writeJsonl = (path, rows) =>
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// --- export ---------------------------------------------------------------------
function exportCorpus() {
  mkdirSync(DIR, { recursive: true });
  console.log('Pulling the enriched corpus (chunked, read-only)…');
  const rows = [];
  let cursor = '';
  for (;;) {
    const chunk = d1(
      `SELECT o.id, o.store, o.region, o.source, o.category, o.search_text,
              o.price, o.old_price, o.valid_from, o.detected_at, o.image_url,
              e.name AS e_name, e.name_ar AS e_name_ar, e.brand AS e_brand,
              e.size AS e_size, e.corroboration AS e_corroboration,
              e.crop_url AS e_crop_url
         FROM offer_enrichments e JOIN offers o ON o.id = e.id
        WHERE o.id > '${cursor.replace(/'/g, "''")}'
        ORDER BY o.id LIMIT 2000`,
    );
    if (!chunk.length) break;
    rows.push(...chunk);
    cursor = chunk[chunk.length - 1].id;
    process.stdout.write(`  ${rows.length} rows\r`);
  }
  console.log(`\n${rows.length} corpus rows -> ${READS}`);
  writeJsonl(READS, rows);

  const { pairs, counts, reads } = samplePairs(rows);
  console.log(`Reads minted: ${reads}. Pair strata:`, counts);
  writeJsonl(PAIRS, pairs);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const cards = pairs.map((p) => {
    const card = (r) => ({
      id: r.id,
      name: r.e_name,
      nameAr: r.e_name_ar,
      brand: r.e_brand,
      size: r.e_size,
      store: r.store,
      week: r.valid_from,
      price: r.price,
      crop: r.e_crop_url || r.image_url || null,
    });
    return { aId: p.aId, bId: p.bId, score: p.score, stratum: p.stratum, a: card(byId.get(p.aId)), b: card(byId.get(p.bId)) };
  });
  writeFileSync(PAGE, labelingPage(cards));
  console.log(`${pairs.length} pairs -> ${PAIRS}\nLabeling page -> ${PAGE}`);
  console.log(`Open it, adjudicate, then save the download as ${LABELS} and run replay/sweep.`);
}

// Self-contained adjudication page: Same / Different / Skip per pair, resumes
// via localStorage, exports labels.jsonl. Keyboard: s / d / space.
function labelingPage(cards) {
  return `<!doctype html><meta charset="utf-8"><title>Registry pair labeling</title>
<style>
 body{font-family:system-ui;margin:0;background:#111;color:#eee;display:flex;flex-direction:column;align-items:center}
 .pair{display:flex;gap:12px;margin:16px;flex-wrap:wrap;justify-content:center}
 .card{background:#1c1c1e;border-radius:12px;padding:12px;width:320px}
 .card img{width:100%;border-radius:8px;background:#333;min-height:160px;object-fit:contain}
 .meta{font-size:13px;line-height:1.5;margin-top:8px}
 .btns{display:flex;gap:10px;margin:8px 0 24px}
 button{font-size:16px;padding:10px 22px;border-radius:10px;border:0;cursor:pointer}
 .same{background:#2e7d32;color:#fff}.diff{background:#c62828;color:#fff}.skip{background:#444;color:#ccc}
 .bar{position:sticky;top:0;background:#111;padding:10px;width:100%;text-align:center;font-size:14px}
 a{color:#8ab4f8}
</style>
<div class="bar"><span id="prog"></span> · <a href="#" onclick="exp();return false">download labels.jsonl</a></div>
<div id="stage"></div>
<div class="btns">
 <button class="same" onclick="mark('same')">Same (s)</button>
 <button class="diff" onclick="mark('different')">Different (d)</button>
 <button class="skip" onclick="mark('skip')">Skip (space)</button>
</div>
<script>
const PAIRS=${JSON.stringify(cards)};
const KEY='registry-labels-v1';
let labels=JSON.parse(localStorage.getItem(KEY)||'{}');
let i=0;
const done=p=>labels[p.aId+'|'+p.bId];
function next(){while(i<PAIRS.length&&done(PAIRS[i]))i++;render();}
function card(c){return '<div class="card">'+(c.crop?'<img loading="lazy" src="'+c.crop+'">':'<div style="height:160px"></div>')+
 '<div class="meta"><b>'+(c.name||'')+'</b><br>'+(c.nameAr||'')+'<br>'+(c.brand||'—')+' · '+(c.size||'—')+
 '<br>'+c.store+' · '+(c.week||'')+' · '+c.price+'</div></div>';}
function render(){
 document.getElementById('prog').textContent=Object.keys(labels).length+' labeled / '+PAIRS.length+' pairs';
 const s=document.getElementById('stage');
 if(i>=PAIRS.length){s.innerHTML='<p style="margin:40px">All pairs adjudicated — download the labels.</p>';return;}
 const p=PAIRS[i];
 s.innerHTML='<div class="pair">'+card(p.a)+card(p.b)+'</div><p style="text-align:center;color:#888">score '+p.score+' · '+p.stratum+'</p>';
}
function mark(v){const p=PAIRS[i];if(!p)return;if(v!=='skip')labels[p.aId+'|'+p.bId]={aId:p.aId,bId:p.bId,label:v};
 else labels[p.aId+'|'+p.bId]={aId:p.aId,bId:p.bId,label:'skip'};
 localStorage.setItem(KEY,JSON.stringify(labels));i++;next();}
function exp(){const rows=Object.values(labels).filter(l=>l.label!=='skip').map(l=>JSON.stringify(l)).join('\\n');
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([rows+'\\n']));a.download='labels.jsonl';a.click();}
addEventListener('keydown',e=>{if(e.key==='s')mark('same');else if(e.key==='d')mark('different');else if(e.key===' '){e.preventDefault();mark('skip');}});
next();
</script>`;
}

// --- replay / sweep / measure ----------------------------------------------------
function loadCorpusAndLabels() {
  if (!existsSync(READS)) {
    console.error(`No ${READS} — run 'node calibrate-registry.mjs export' first.`);
    process.exit(1);
  }
  const rows = readJsonl(READS);
  if (!existsSync(LABELS)) {
    console.error(`No ${LABELS} — adjudicate pairs in ${PAGE} and save the download there.`);
    process.exit(1);
  }
  return { rows, labels: readJsonl(LABELS) };
}

const printMetrics = (m) => {
  const pct = (v) => (v == null ? 'n/a' : (v * 100).toFixed(2) + '%');
  console.log(
    `tAttach=${m.tuning.tAttach} tReview=${m.tuning.tReview} · products=${m.products}` +
      ` · attach=${pct(m.attachRate)} (gate >=95%) · false-attach=${pct(m.falseAttachRate)} (gate <=0.5%)` +
      ` · unresolvable=${m.unresolvable} · ${m.pass ? 'PASS' : 'FAIL'}`,
  );
};

const mode = process.argv[2];
if (mode === 'export') {
  exportCorpus();
} else if (mode === 'replay') {
  const { rows, labels } = loadCorpusAndLabels();
  const m = await replay(rows, labels);
  printMetrics(m);
  if (m.misses.length) console.log('same-labeled splits:', m.misses.slice(0, 20));
  if (m.falses.length) console.log('FALSE ATTACHES (P1):', m.falses);
  process.exit(m.pass ? 0 : 1);
} else if (mode === 'sweep') {
  const { rows, labels } = loadCorpusAndLabels();
  for (const m of await sweep(rows, labels)) printMetrics(m);
} else if (mode === 'measure') {
  if (!existsSync(READS)) {
    console.error(`No ${READS} — run export first.`);
    process.exit(1);
  }
  console.log(JSON.stringify(measureVerdicts(readJsonl(READS)), null, 2));
} else {
  console.log('Usage: node calibrate-registry.mjs export|replay|sweep|measure');
  process.exit(1);
}
