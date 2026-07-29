// Generates the visual A/B report. Design tokens and card structure are carried
// over from the 50-crop Medium validation artifact so the two are comparable.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, '..', 'mistral-medium-production-validation-50-2026-07-25');
const OUT = process.argv[2] || join(HERE, 'REPORT.html');

const read = async (p) => JSON.parse(await readFile(p, 'utf8'));
const manifest = await read(join(HERE, 'sample-10.json'));
const truth = await read(join(BASE, 'human-canonical.json'));
const medRun = await read(join(BASE, 'verbatim-results.json'));
const smlRun = await read(join(HERE, 'small-results.json'));
const medM = await read(join(HERE, 'medium-10-metrics.json'));
const smlM = await read(join(HERE, 'small-metrics.json'));
const med50 = await read(join(HERE, 'equivalence-check-50.json'));

const FIELDS = [
  ['name_en', 'English name'],
  ['brand', 'Brand'],
  ['current_price', 'Current price'],
  ['old_price', 'Previous price'],
  ['quantity', 'Package size'],
];

// Per-crop commentary. Every mismatch claim below was checked against the
// original-resolution crop by direct inspection before it was written.
const NOTES = {
  8: {
    verdict: 'tie',
    head: 'Both models invert the price roles. Small keeps the misprint, Medium repairs it.',
    med: 'Returned <b>44.99</b> — the small upper figure — as the current price and nothing as the previous, on a crop whose selling price is the large <b>30</b> marked "now". Also rewrote the printed <b>Jmbo</b> to <b>Jumbo</b>, which the prompt forbids, and leaked the price <b>30</b> into <code>quantity</code>.',
    sml: 'Identical price-role inversion, identical confidence. It did <b>preserve</b> the printed misprint <b>Jmbo</b> — better prompt obedience than Medium — but broke the caption\'s spacing (<b>Diaper 5 Maxi</b> for a printed <b>Diaper5Maxi</b>), so the name still scores wrong.',
    causes: ['price-role assignment (both)', 'normalization (Medium)', 'transcription spacing (Small)'],
  },
  10: {
    verdict: 'medium',
    head: 'Small misreads a large, high-contrast struck-through price.',
    med: 'All five fields correct.',
    sml: 'Returned <b>11.95</b> where the crop plainly prints <b>17.95</b> in red strikethrough at full size. Nothing about this figure is small or ambiguous — the 7 was read as a 1. Everything else on the crop is correct.',
    causes: ['perception (digit misread)'],
  },
  13: {
    verdict: 'medium',
    head: 'One hallucinated letter takes down two fields at once.',
    med: 'All five fields correct.',
    sml: 'Transcribed the brand as <b>REEEM</b> — three E\'s — where both the caption and the can logo read <b>REEM</b>. Because the prompt requires the brand to be repeated in its own field, the single perception error propagates into <code>brand</code> as well, costing two fields from one mistake. It also called a visibly cylindrical steel can a <b>jar</b>.',
    causes: ['perception (letter duplication)', 'error propagation into brand'],
  },
  19: {
    verdict: 'medium',
    head: 'Small folds the on-pack sub-brand into the product name.',
    med: 'All five correct, and it filed the on-pack <b>Break 3</b> where it belongs — in <code>attributes</code>.',
    sml: 'Returned <b>Loacker Break Wafer 4x19g</b>, inserting the pack\'s large <b>Break 3</b> lockup into the middle of a caption that reads <b>Loacker Wafer 4x19g</b>. Milder than the failure that sank the original prompt, but the same instinct: on-pack marketing treated as product identity.',
    causes: ['prompt following (over-inclusion)'],
  },
  26: {
    verdict: 'tie',
    head: 'Both miss the per-piece basis; Small adds an attribute that is not printed.',
    med: 'Put <b>PC</b> in <code>package_type</code> but left both size fields empty, so the scorer\'s bare-unit rule counts no quantity. Attributes correctly empty.',
    sml: 'Same empty size fields, and additionally dropped <code>package_type</code>. It also returned the attribute <b>fresh</b>, a word that appears nowhere on the crop — an inferred property, where the prompt allows only directly visible descriptors.',
    causes: ['package parsing (both)', 'unprompted inference (Small)'],
  },
  30: {
    verdict: 'medium',
    head: 'Shared price blindness; Small additionally loses half the brand.',
    med: 'Missed the caption by prepending the brand, and returned <b>null</b> for both prices — the large badge price and the small struck-through figure alike. Brand <b>St Michel</b> read correctly.',
    sml: 'The same three failures, plus the brand came back as <b>Michel</b>: the superscript <b>St</b> in the pack logo was dropped. On a corpus where the brand is the Browse slug, a truncated brand silently creates a second, competing brand.',
    causes: ['price recall (both)', 'perception of small glyphs (Small)'],
  },
  33: {
    verdict: 'medium',
    head: 'The most damaging error in the run: Small doubles the pack size.',
    med: 'Reported the full on-pack copy instead of the caption, so the name scores wrong — but every structured field is right, including <b>5kg</b>.',
    sml: 'Returned <code>package_size: "10 KG"</code>. The crop shows a 5 kg bag; the caption reads <b>5kg</b> and the Arabic reads <b>٥ كيلو</b>. There is no <b>10</b> anywhere on the image. It also rendered the variety code <b>1121</b> as <b>100%</b>. This is not a misread of a hard glyph — it is a plausible-looking pack size invented whole, at 0.98 confidence, on a staple where price-per-kilo is exactly what shoppers compare.',
    causes: ['hallucination (fabricated size)', 'perception (1121 → 100%)'],
  },
  40: {
    verdict: 'medium',
    head: 'Null discipline holds on both sides; Small rewrites the caption.',
    med: 'All five correct. Crucially it returned <b>null</b> for the previous price on the one crop in this sample that has none, and kept <b>6x250ml</b> in <code>package_size</code> where it belongs.',
    sml: 'Also correctly invented no previous price — the false-positive risk did not materialise. But it returned <b>Pepsi 6×250 ml Bottles</b>, splicing the pack-graphic size into the middle of a caption that reads <b>Pepsi Bottles</b>. Every token is real and present on the crop; the word order is not. This is the softest failure in the run.',
    causes: ['prompt following (interpolation)'],
  },
  44: {
    verdict: 'small',
    head: 'Small\'s one outright win — and it is a genuine perception win.',
    med: 'Read the struck-through price as <b>45.5</b>, dropping the trailing digit of a printed <b>45.51</b>.',
    sml: 'Read <b>45.51</b> exactly, on the same small red strikethrough, and matched Medium on the hardest pack expression in the sample — <b>(2 X 1.5 LTR + 500 ML)</b> — in both the name and the size field.',
    causes: ['none — Small correct where Medium was not'],
  },
  48: {
    verdict: 'tie',
    head: 'Both models clean on a long comma-separated caption with a size range.',
    med: 'All five correct.',
    sml: 'All five correct, including the size expressed as a range rather than a value (<b>68 - 114 GRAMS</b>) and the retailer\'s comma-heavy caption style reproduced exactly.',
    causes: [],
  },
};

const esc = (s) => String(s).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
const val = (v) => (v === null || v === undefined || v === '' ? '<span class="nul">null</span>' : esc(v));
const pct = (t) => `${t.correct}/${t.total} <small>(${t.pct}%)</small>`;

const cards = [];
for (const sample of manifest.samples) {
  const i = sample.index;
  const t = truth.samples.find((x) => x.index === i);
  const M = medRun.samples.find((x) => x.index === i).structured;
  const S = smlRun.samples.find((x) => x.index === i).structured;
  const mf = medM.per_image.find((x) => x.index === i).fields;
  const sf = smlM.per_image.find((x) => x.index === i).fields;
  const note = NOTES[i];
  const bytes = await readFile(join(BASE, 'assets', `${String(i).padStart(2, '0')}.jpg`));
  const img = `data:image/jpeg;base64,${bytes.toString('base64')}`;

  const size = (o) => [o.package_size, o.quantity].filter(Boolean).join(' · ') || null;
  const rows = FIELDS.map(([key, label]) => {
    const tv = key === 'quantity' ? t.quantity.accepted[0] : t[key].accepted[0];
    const mv = key === 'quantity' ? size(M) : M[key];
    const sv = key === 'quantity' ? size(S) : S[key];
    return `<tr>
      <th scope="row">${label}</th>
      <td class="tv">${val(tv)}</td>
      <td class="mv ${mf[key].status}">${val(mv)}</td>
      <td class="mv ${sf[key].status}">${val(sv)}</td>
    </tr>`;
  }).join('\n');

  const dots = (f) => FIELDS.map(([key, label]) =>
    `<span class="fld" title="${label}"><span class="m m--${f[key].status === 'correct' ? 'y' : 'x'}"></span><b>${label.split(' ')[0].slice(0, 4)}</b></span>`).join('');

  const chip = { medium: ['chip--fixed', 'Medium ahead'], small: ['chip--gain', 'Small ahead'], tie: ['chip--flat', 'No difference'] }[note.verdict];
  const mWrong = FIELDS.filter(([k]) => mf[k].status === 'wrong').length;
  const sWrong = FIELDS.filter(([k]) => sf[k].status === 'wrong').length;

  cards.push(`
<article class="spec spec--${note.verdict}">
  <div class="spec__evidence">
    <img src="${img}" alt="Crop ${i} — ${esc(sample.store)}, ${esc(sample.category || 'uncategorised')}">
    <p class="spec__src"><span>Crop ${i}</span><span>${esc(sample.store)}</span></p>
    <p class="spec__cat">${esc(sample.category || '—')}</p>
    <p class="spec__cat spec__why-picked"><b>${esc(sample.rationale.split('.')[0])}</b> &mdash; ${esc(sample.rationale.split('. ').slice(1).join('. ').split('.')[0])}.</p>
  </div>
  <div class="spec__body">
    <p class="spec__verdict">
      <span class="chip ${chip[0]}">${chip[1]}</span>
      <span class="chip chip--count">Medium ${5 - mWrong}/5</span>
      <span class="chip chip--count">Small ${5 - sWrong}/5</span>
    </p>
    <p class="spec__head">${note.head}</p>
    <div class="tbl">
      <table class="fields">
        <thead><tr><th scope="col">Field</th><th scope="col">Ground truth</th><th scope="col">Medium</th><th scope="col">Small</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <dl class="slips">
      <div class="slip slip--med"><dt>Medium</dt><dd>${note.med}</dd></div>
      <div class="slip slip--sml"><dt>Small</dt><dd>${note.sml}</dd></div>
    </dl>
    ${note.causes.length ? `<p class="causes">${note.causes.map((c) => `<span class="cause">${esc(c)}</span>`).join('')}</p>` : ''}
    <div class="strip">
      <span class="strip__lbl">Medium</span>${dots(mf)}
    </div>
    <div class="strip">
      <span class="strip__lbl">Small</span>${dots(sf)}
    </div>
  </div>
</article>`);
}

const u = (m) => m.usage;
const money = (n) => `$${n.toFixed(6)}`;

const usageRows = manifest.samples.map((s) => {
  const m = u(medM).per_crop.find((x) => x.index === s.index);
  const l = u(smlM).per_crop.find((x) => x.index === s.index);
  return `<tr><th scope="row">${s.index} <small>${esc(s.store)}</small></th>
    <td>${m.prompt_tokens}</td><td>${m.completion_tokens}</td><td>${m.total_tokens}</td><td>${Math.round(m.latency_ms)}</td><td>${money(m.cost_usd)}</td>
    <td>${l.prompt_tokens}</td><td>${l.completion_tokens}</td><td>${l.total_tokens}</td><td>${Math.round(l.latency_ms)}</td><td>${money(l.cost_usd)}</td></tr>`;
}).join('\n');

const accRow = ([key, label]) => {
  const m = medM.accuracy_all_adjudicable[key];
  const s = smlM.accuracy_all_adjudicable[key];
  const d = s.correct - m.correct;
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  return `<tr><th scope="row">${label}</th><td>${pct(med50.accuracy_all_adjudicable[key])}</td><td>${pct(m)}</td><td>${pct(s)}</td><td class="${cls}">${d > 0 ? `+${d}` : d === 0 ? '—' : d}</td></tr>`;
};

const html = `<title>Mistral Small vs Medium — 10-crop economic A/B</title>
<style>
  :root{
    --paper:#F7F6F3; --card:#FFFFFF; --ink:#1A1C1F; --muted:#71757E;
    --rule:#E2E0DA; --accent:#35507A; --pass:#2C6A4A; --fail:#99402F;
    --pass-bg:#E7F0EA; --fail-bg:#F6E7E3; --slip:#F2F1EC; --na:#B9B7B0;
    --econ:#8A6A2F; --econ-bg:#F3EEE2;
  }
  @media (prefers-color-scheme:dark){
    :root{ --paper:#131518; --card:#1A1D22; --ink:#E7E8EA; --muted:#969BA5;
      --rule:#2A2E35; --accent:#7EA0CE; --pass:#6FB98F; --fail:#D98878;
      --pass-bg:#1B2B22; --fail-bg:#2E1F1B; --slip:#212429; --na:#4A4E56;
      --econ:#C9A961; --econ-bg:#2A2418; }
  }
  :root[data-theme="dark"]{ --paper:#131518; --card:#1A1D22; --ink:#E7E8EA; --muted:#969BA5;
    --rule:#2A2E35; --accent:#7EA0CE; --pass:#6FB98F; --fail:#D98878;
    --pass-bg:#1B2B22; --fail-bg:#2E1F1B; --slip:#212429; --na:#4A4E56;
    --econ:#C9A961; --econ-bg:#2A2418; }
  :root[data-theme="light"]{ --paper:#F7F6F3; --card:#FFFFFF; --ink:#1A1C1F; --muted:#71757E;
    --rule:#E2E0DA; --accent:#35507A; --pass:#2C6A4A; --fail:#99402F;
    --pass-bg:#E7F0EA; --fail-bg:#F6E7E3; --slip:#F2F1EC; --na:#B9B7B0;
    --econ:#8A6A2F; --econ-bg:#F3EEE2; }

  body{ background:var(--paper); color:var(--ink); margin:0;
    font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; line-height:1.55;
    -webkit-font-smoothing:antialiased; }
  .wrap{ max-width:64rem; margin:0 auto; padding:clamp(1.75rem,5vw,4rem) clamp(1.1rem,4vw,2rem) 5rem; }

  .eyebrow{ font-size:.7rem; letter-spacing:.14em; text-transform:uppercase;
    color:var(--accent); font-weight:650; margin:0 0 .9rem; }
  h1{ font-family:Georgia,"Iowan Old Style","Times New Roman",serif; font-weight:400;
    font-size:clamp(1.9rem,4.6vw,2.9rem); line-height:1.15; margin:0 0 .7rem;
    text-wrap:balance; letter-spacing:-.01em; }
  .lede{ color:var(--muted); max-width:62ch; margin:0; font-size:1.02rem; }
  .control{ margin:2rem 0 0; padding:.9rem 1.1rem; border-left:2px solid var(--accent);
    background:var(--card); color:var(--muted); font-size:.88rem; max-width:64ch; }
  .control b{ color:var(--ink); font-weight:600; }
  .control code{ font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace; font-size:.85em; }

  .tally{ display:flex; flex-wrap:wrap; gap:1px; margin:2.5rem 0 0;
    background:var(--rule); border:1px solid var(--rule); }
  .tally__cell{ flex:1 1 9rem; background:var(--card); padding:1rem 1.15rem; }
  .tally__k{ font-size:.68rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin:0 0 .35rem; }
  .tally__v{ font-family:Georgia,"Iowan Old Style",serif; font-size:1.85rem; line-height:1;
    font-variant-numeric:tabular-nums; margin:0; }
  .tally__v small{ font-size:.95rem; color:var(--muted); }
  .tally__cell--best .tally__v{ color:var(--pass); }
  .tally__cell--econ .tally__v{ color:var(--econ); }
  .tally__cell--bad .tally__v{ color:var(--fail); }

  h2{ font-family:Georgia,"Iowan Old Style",serif; font-weight:400; font-size:1.3rem;
    margin:3.25rem 0 .3rem; letter-spacing:-.005em; }
  .h2note{ color:var(--muted); font-size:.86rem; margin:0 0 1.4rem; max-width:64ch; }

  .spec{ display:grid; grid-template-columns:minmax(0,15rem) minmax(0,1fr); gap:1.5rem;
    background:var(--card); border:1px solid var(--rule); border-left:3px solid var(--rule);
    padding:1.35rem; margin-bottom:1rem; }
  .spec--medium{ border-left-color:var(--accent); }
  .spec--small{ border-left-color:var(--pass); }
  .spec--tie{ border-left-color:var(--na); }
  @media (max-width:720px){ .spec{ grid-template-columns:1fr; gap:1.1rem; } }

  .spec__evidence img{ display:block; width:100%; height:auto; border:1px solid var(--rule); background:#fff; }
  .spec__src{ display:flex; justify-content:space-between; gap:.75rem; font-size:.68rem;
    letter-spacing:.1em; text-transform:uppercase; color:var(--muted); margin:.55rem 0 0; }
  .spec__cat{ font-size:.72rem; color:var(--muted); margin:.2rem 0 0; }
  .spec__why-picked{ margin-top:.5rem; padding-top:.5rem; border-top:1px solid var(--rule);
    line-height:1.45; }
  .spec__why-picked b{ color:var(--ink); font-weight:650; letter-spacing:.06em; }

  .spec__verdict{ margin:0 0 .7rem; display:flex; gap:.4rem; flex-wrap:wrap; }
  .chip{ display:inline-block; font-size:.68rem; letter-spacing:.09em; text-transform:uppercase;
    font-weight:650; padding:.28rem .6rem; border-radius:2px; }
  .chip--fixed{ color:var(--accent); background:var(--pass-bg); }
  .chip--gain{ color:var(--pass); background:var(--pass-bg); }
  .chip--flat{ color:var(--muted); background:var(--slip); }
  .chip--count{ color:var(--muted); background:transparent; border:1px solid var(--rule); }
  .spec__head{ margin:0 0 1rem; font-size:.95rem; max-width:60ch; }

  .tbl{ overflow-x:auto; }
  table{ border-collapse:collapse; width:100%; font-size:.86rem; }
  th,td{ padding:.45rem .6rem; border-bottom:1px solid var(--rule); text-align:left;
    font-variant-numeric:tabular-nums; vertical-align:top; }
  thead th{ font-size:.66rem; letter-spacing:.1em; text-transform:uppercase; color:var(--muted); font-weight:650; }
  tbody tr:last-child td, tbody tr:last-child th{ border-bottom:none; }
  .fields th[scope="row"]{ font-weight:600; font-size:.78rem; color:var(--muted); white-space:nowrap; }
  .fields .tv{ box-shadow:inset 2px 0 0 var(--accent); }
  .fields td{ font-family:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
    font-size:.8rem; background:var(--slip); word-break:break-word; }
  .fields td.correct{ box-shadow:inset 2px 0 0 var(--pass); }
  .fields td.wrong{ box-shadow:inset 2px 0 0 var(--fail); color:var(--fail); }
  .nul{ color:var(--muted); font-style:italic; }

  .slips{ margin:1rem 0 0; display:flex; flex-direction:column; gap:.6rem; }
  .slip dt{ font-size:.66rem; letter-spacing:.11em; text-transform:uppercase; color:var(--muted); margin-bottom:.25rem; }
  .slip dd{ margin:0; padding:.5rem .65rem; background:var(--slip); font-size:.855rem; line-height:1.5; }
  .slip--med dd{ box-shadow:inset 2px 0 0 var(--accent); }
  .slip--sml dd{ box-shadow:inset 2px 0 0 var(--econ); }
  .slip b{ font-weight:650; }
  .slip code{ font-family:ui-monospace,Menlo,Consolas,monospace; font-size:.85em; color:var(--muted); }

  .causes{ margin:.8rem 0 0; display:flex; flex-wrap:wrap; gap:.35rem; }
  .cause{ font-size:.68rem; letter-spacing:.04em; color:var(--muted);
    border:1px solid var(--rule); padding:.2rem .5rem; border-radius:2px; }

  .strip{ display:flex; flex-wrap:wrap; align-items:center; gap:.85rem;
    margin-top:.7rem; padding-top:.6rem; border-top:1px solid var(--rule); }
  .strip__lbl{ font-size:.63rem; letter-spacing:.1em; text-transform:uppercase;
    color:var(--muted); font-weight:650; min-width:4rem; }
  .fld{ display:inline-flex; align-items:center; gap:.28rem; font-size:.68rem; color:var(--muted); }
  .fld b{ font-weight:600; letter-spacing:.05em; text-transform:uppercase; }
  .m{ width:.5rem; height:.5rem; border-radius:50%; display:inline-block; }
  .m--y{ background:var(--pass); }
  .m--x{ background:var(--fail); }

  .summary{ margin-top:3.5rem; }
  .summary table{ font-size:.92rem; }
  .summary th,.summary td{ padding:.6rem .8rem; text-align:right; }
  .summary th:first-child,.summary td:first-child{ text-align:left; }
  .summary td.up{ color:var(--pass); font-weight:650; }
  .summary td.down{ color:var(--fail); font-weight:650; }
  .summary td.flat{ color:var(--muted); }
  .summary td small{ color:var(--muted); }
  caption{ text-align:left; color:var(--muted); font-size:.86rem; padding-bottom:.7rem; }
  .usage th[scope="row"]{ white-space:nowrap; }
  .usage small{ color:var(--muted); font-weight:400; }
  .grp{ border-left:1px solid var(--rule); }

  .close{ margin-top:3rem; padding-top:1.5rem; border-top:1px solid var(--rule); }
  .close h3{ font-family:Georgia,"Iowan Old Style",serif; font-weight:400; font-size:1.05rem; margin:1.6rem 0 .4rem; }
  .close p,.close li{ color:var(--muted); font-size:.9rem; max-width:64ch; }
  .close b{ color:var(--ink); font-weight:600; }
  .verdict{ margin-top:2rem; padding:1.35rem 1.5rem; background:var(--card);
    border:1px solid var(--rule); border-left:3px solid var(--econ); }
  .verdict h3{ margin-top:0; }
  .verdict p{ color:var(--ink); }
  .opt{ font-size:.68rem; letter-spacing:.12em; text-transform:uppercase; color:var(--econ); font-weight:650; }
</style>

<div class="wrap">
  <p class="eyebrow">Mistral Small vs Medium &middot; economic A/B &middot; 25 July 2026</p>
  <h1>Is Medium worth 11&times; Small?</h1>
  <p class="lede">Ten crops lifted unchanged out of the frozen 50-crop benchmark, run through the
    frozen production configuration twice. The only thing that changed between the two runs is the
    model string. Everything below is measured, not estimated.</p>

  <p class="control">Controls: identical frozen bytes (sha256-verified per crop against
    <code>frozen-sample.json</code>), identical Verbatim prompt read out of the same source file
    (sha256 <code>e643b2a1&hellip;</code>), temperature 0, top_p 1, <code>reasoning_effort: none</code>,
    <code>json_object</code>, no OCR, one request per crop, identical parser, identical scorer,
    identical ground truth. The scorer was proved equivalent by re-scoring the full 50-crop Medium
    run through it and diffing against the published metrics &mdash; <b>byte-identical</b>.
    Small: 10/10 valid JSON, zero retries, zero failures, every response confirmed
    <code>mistral-small-latest</code>. <b>No production code, model or data was changed.</b></p>

  <div class="tally">
    <div class="tally__cell"><p class="tally__k">Fields correct &mdash; Medium</p><p class="tally__v">41<small>/50</small></p></div>
    <div class="tally__cell tally__cell--bad"><p class="tally__k">Fields correct &mdash; Small</p><p class="tally__v">35<small>/50</small></p></div>
    <div class="tally__cell tally__cell--econ"><p class="tally__k">Cost per crop</p><p class="tally__v">11.4&times;<small> cheaper</small></p></div>
    <div class="tally__cell"><p class="tally__k">Head-to-head</p><p class="tally__v">7<small> : 1</small></p></div>
  </div>
  <p class="h2note" style="margin-top:.6rem">Field cells are 10 crops &times; 5 scored fields. Head-to-head counts
    fields where exactly one model was correct &mdash; Medium won 7, Small won 1, and 8 cells were
    wrong for both.</p>

  <h2>The sample</h2>
  <p class="h2note">Ten crops, ten retailers, ten categories &mdash; five that Medium scored clean on
    the 50-crop run and five where it already had at least one miss, so the set is not stacked toward
    either outcome. Selection is <b>purposive, not random</b>: it was chosen to span easy and hard
    products, English captions, prices and package sizes, exactly as briefed. No new images were
    introduced. Each card notes why that crop is in the set.</p>

  ${cards.join('\n')}

  <section class="summary">
    <h2>Field accuracy</h2>
    <p class="h2note">Medium@50 is the published frozen-baseline figure, shown for context only.
      The A/B is the two right-hand columns: same ten crops, same scorer, same truth.
      &Delta; is Small minus Medium in crops correct, out of 10.</p>
    <div class="tbl">
      <table>
        <thead><tr><th scope="col">Field</th><th scope="col">Medium @50 <small>(context)</small></th><th scope="col">Medium @10</th><th scope="col">Small @10</th><th scope="col">&Delta;</th></tr></thead>
        <tbody>${FIELDS.map(accRow).join('\n')}</tbody>
      </table>
    </div>
    <p class="h2note" style="margin-top:.8rem">&ldquo;Package size&rdquo; is scored exactly as the frozen
      benchmark scores it: <code>package_size</code> and <code>quantity</code> are pooled into one
      judgement, since either field may legitimately carry the printed expression.</p>

    <h2>Tokens, latency and cost</h2>
    <p class="h2note">Per-crop figures as reported by the API. Pricing is the basis already used by
      this project's benchmarks: Small $0.15/M input and $0.60/M output, Medium $1.50/M and $7.50/M
      &mdash; a flat 10&times; on rate, which lands at 11.4&times; in practice because Medium also emits
      more completion tokens.</p>
    <div class="tbl">
      <table class="usage">
        <caption>Medium and Small on the same ten crops. Latency in milliseconds.</caption>
        <thead>
          <tr><th scope="col" rowspan="2">Crop</th><th scope="col" colspan="5">Mistral Medium</th><th scope="col" colspan="5" class="grp">Mistral Small</th></tr>
          <tr><th scope="col">In</th><th scope="col">Out</th><th scope="col">Total</th><th scope="col">ms</th><th scope="col">Cost</th>
              <th scope="col" class="grp">In</th><th scope="col">Out</th><th scope="col">Total</th><th scope="col">ms</th><th scope="col">Cost</th></tr>
        </thead>
        <tbody>${usageRows}</tbody>
        <tfoot>
          <tr><th scope="row">Average</th>
            <td>${u(medM).avg_prompt_tokens.toFixed(1)}</td><td>${u(medM).avg_completion_tokens.toFixed(1)}</td><td>${u(medM).avg_total_tokens.toFixed(1)}</td><td>${Math.round(u(medM).avg_latency_ms)}</td><td>${money(u(medM).avg_cost_usd)}</td>
            <td class="grp">${u(smlM).avg_prompt_tokens.toFixed(1)}</td><td>${u(smlM).avg_completion_tokens.toFixed(1)}</td><td>${u(smlM).avg_total_tokens.toFixed(1)}</td><td>${Math.round(u(smlM).avg_latency_ms)}</td><td>${money(u(smlM).avg_cost_usd)}</td></tr>
        </tfoot>
      </table>
    </div>

    <h2>Head-to-head summary</h2>
    <div class="tbl">
      <table>
        <thead><tr><th scope="col">Metric</th><th scope="col">Medium</th><th scope="col">Small</th></tr></thead>
        <tbody>
          ${FIELDS.map(([k, l]) => `<tr><th scope="row">${l}</th><td>${pct(medM.accuracy_all_adjudicable[k])}</td><td>${pct(smlM.accuracy_all_adjudicable[k])}</td></tr>`).join('\n')}
          <tr><th scope="row">Package type <small>(not adjudicated)</small></th><td>9/10 populated</td><td>8/10 populated</td></tr>
          <tr><th scope="row">Attributes <small>(not adjudicated)</small></th><td>8/10 populated</td><td>9/10 populated</td></tr>
          <tr><th scope="row">Average prompt tokens</th><td>${u(medM).avg_prompt_tokens.toFixed(1)}</td><td>${u(smlM).avg_prompt_tokens.toFixed(1)}</td></tr>
          <tr><th scope="row">Average completion tokens</th><td>${u(medM).avg_completion_tokens.toFixed(1)}</td><td>${u(smlM).avg_completion_tokens.toFixed(1)}</td></tr>
          <tr><th scope="row">Average total tokens</th><td>${u(medM).avg_total_tokens.toFixed(1)}</td><td>${u(smlM).avg_total_tokens.toFixed(1)}</td></tr>
          <tr><th scope="row">Average latency</th><td>${(u(medM).avg_latency_ms / 1000).toFixed(2)} s <small>(median ${(u(medM).median_latency_ms / 1000).toFixed(2)})</small></td><td>${(u(smlM).avg_latency_ms / 1000).toFixed(2)} s <small>(median ${(u(smlM).median_latency_ms / 1000).toFixed(2)})</small></td></tr>
          <tr><th scope="row">Average cost per crop</th><td>${money(u(medM).avg_cost_usd)}</td><td class="up">${money(u(smlM).avg_cost_usd)}</td></tr>
          <tr><th scope="row">Cost for 10 crops</th><td>$${u(medM).cost_usd.toFixed(5)}</td><td class="up">$${u(smlM).cost_usd.toFixed(5)}</td></tr>
          <tr><th scope="row">Valid JSON</th><td>10/10</td><td>10/10</td></tr>
        </tbody>
      </table>
    </div>
    <p class="h2note" style="margin-top:.8rem">Medium's average latency here is pulled up by a single
      5.68 s outlier; its median on these ten crops is 1.28 s and its published 50-crop average is
      1.83 s. The honest read is that Small is roughly <b>25&ndash;30% faster</b>, not 1.5&times;.
      Package type and attributes have <b>no adjudicated ground truth</b> in this benchmark, so they
      are reported as populated-rate only and are excluded from every accuracy claim.</p>
  </section>

  <section class="close">
    <h2>What the failures actually are</h2>

    <h3>Where Medium succeeds and Small fails &mdash; 7 field cells, 6 crops</h3>
    <p>Almost all of it is <b>perception</b>, not reasoning. Small misread a large red
      <b>17.95</b> as <b>11.95</b> (crop 10), duplicated a letter to produce <b>REEEM</b> from a
      clearly printed <b>REEM</b> (crop 13), and dropped the superscript <b>St</b> from
      <b>St Michel</b> (crop 30). None of these are hard crops; Medium read all three correctly.
      Two further cells are <b>prompt following</b>: Small folded the on-pack <b>Break</b> lockup into
      the caption (crop 19) and spliced <b>6&times;250 ml</b> into the middle of <b>Pepsi Bottles</b>
      (crop 40). The remaining cell is the serious one &mdash; see below.</p>

    <h3>The one that should decide this</h3>
    <p>On crop 33 Small returned <code>package_size: "10 KG"</code> for a bag that prints
      <b>5kg</b> in the caption and <b>٥ كيلو</b> in Arabic. Ten does not appear on the image.
      That is <b>hallucination</b>, not misreading: a well-formed, plausible, confidently-stated
      pack size that is exactly double the truth, on a staple where price-per-kilo is the entire
      basis of comparison. Medium got it right. A shopper-facing price engine that doubles a pack
      size is worse than one that returns nothing. Small also attached the attribute <b>fresh</b>
      to a pineapple crop that never prints the word (crop 26) &mdash; the same tendency, lower stakes.</p>

    <h3>Where Small succeeds and Medium fails &mdash; 1 field cell</h3>
    <p>Crop 44: Small read the struck-through <b>45.51</b> exactly; Medium truncated it to
      <b>45.5</b>. A real perception win on a small figure, and worth recording &mdash; but one cell
      against seven. Small also earned an unscored point on crop 8, where it <b>preserved</b> the
      brochure's printed misprint <b>Jmbo</b> while Medium silently corrected it to <b>Jumbo</b>,
      which the frozen prompt explicitly forbids. Small lost that crop anyway on caption spacing.</p>

    <h3>Where both fail identically</h3>
    <p>Eight cells, and they are all <b>already-known Medium constraints</b>, not new information.
      Crop 8 reproduces the documented current-price role inversion &mdash; both models returned the
      crossed-out <b>44.99</b> as the selling price on a crop whose price is a large <b>30</b> marked
      "now". Crop 30 is a shared silent null on both prices. Crop 26 is the documented per-piece
      convention. Switching model does not fix any of them, and the deterministic price guard that is
      already owed would catch crop 8 under either model: two prices are printed, one was returned.</p>

    <h3>Confidence remains noise</h3>
    <p>Small reported 0.98 on the fabricated <b>10 KG</b>, 0.98 on <b>REEEM</b>, and 0.98 on the
      inverted price &mdash; the same 0.98 it reported on its clean crops. Medium's uncalibrated
      confidence carries over to Small unchanged. Nothing here should ever gate acceptance.</p>

    <h3>What this sample can and cannot support</h3>
    <p>Ten crops is enough to expose failure <i>modes</i> and to compare the two models against each
      other on identical inputs. It is <b>not</b> enough for a precise accuracy rate: at n=10 a
      single crop moves any field by 10 points, and the sample was deliberately balanced rather than
      drawn at random, so neither column estimates a 50-crop rate. The 7:1 head-to-head split is not
      statistically significant on its own (exact binomial p &asymp; 0.07). The cost measurement,
      by contrast, is exact &mdash; it is arithmetic on reported token counts, and it will hold at
      any sample size.</p>
  </section>

  <div class="verdict">
    <p class="opt">Recommendation &mdash; Option A</p>
    <h3>Keep Medium in production. Do not document Small as an economical mode.</h3>
    <p>Small is genuinely 11.4&times; cheaper and about 25&ndash;30% faster, with identical JSON
      reliability &mdash; the operational case is real. But it lost 6 of 50 field cells to Medium and
      won 1, and the losses are concentrated in exactly the fields this product sells on: it
      fabricated a pack size at double the truth, corrupted a brand token that doubles as the Browse
      slug, and misread a plainly legible previous price. At $0.00205 per crop, Medium's absolute
      cost is not the constraint on this system; the saving is roughly $0.0019 per offer.</p>
    <p>Option C was considered and rejected on the measured evidence. An &ldquo;economical mode&rdquo;
      is only safe if its failures are quieter than the primary model's, and Small's are louder:
      hallucinated sizes and corrupted brands are silent, well-formed and confident, so they would
      enter the corpus indistinguishable from good rows. Documenting Small as a supported mode would
      mean accepting that class of error somewhere in the pipeline. If cost ever does become the
      binding constraint, the measured place to revisit this is a Small-first / Medium-escalation
      split gated on a deterministic validator &mdash; which needs the price guard built first, and a
      larger sample than this one to size the escalation rate.</p>
  </div>
</div>
`;

await writeFile(OUT, html, 'utf8');
process.stdout.write(`wrote ${OUT} (${(html.length / 1024).toFixed(0)} KB)\n`);
