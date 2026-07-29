// Emits review.html — the human-adjudication page. Embeds the crop images as
// data URIs so the reviewer can inspect the pixels the models saw.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { summary, rows } = JSON.parse(await readFile(join(HERE, 'routing-table.json'), 'utf8'));
const sample = JSON.parse(await readFile(join(HERE, 'sample-30.json'), 'utf8'));
const sampleBy = new Map(sample.samples.map((s) => [s.index, s]));
const d4dRows = JSON.parse(await readFile(
  'C:/Users/majed/AppData/Local/Temp/claude/C--Users-majed-Desktop-claude/9d200ae2-562d-422c-83ad-1c36abb5adc6/scratchpad/d4d50.json', 'utf8'))[0].results;
const d4dBy = new Map(d4dRows.map((r) => [r.id, r]));

const VERDICT = {"2":"Tie","4":"Medium","5":"Tie","6":"Tie","7":"Tie","8":"Small","9":"Tie","11":"Tie","12":"Tie","20":"Tie","21":"Tie","22":"Tie","23":"Medium","24":"Tie","25":"Tie","26":"Tie","27":"Tie","29":"Tie","30":"Tie","31":"Tie","33":"Medium","34":"Tie","36":"Tie","39":"Medium","40":"Tie","41":"Tie","45":"Tie","46":"Medium","49":"Tie","50":"Tie"};
const esc = (v) => String(v ?? '—')
  .replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
const dash = (v) => (v == null || v === '' ? '—' : v);

const imgs = new Map();
for (const r of rows) {
  const s = sampleBy.get(r.index);
  const bytes = await readFile(join(HERE, s.file));
  imgs.set(r.index, `data:${s.content_type};base64,${bytes.toString('base64')}`);
}

const REG_LABEL = {
  absent: 'no registry sighting',
  circular: 'registry circular — product seen once, and that once is this crop',
  'no-size': 'registry has no size',
  usable: 'registry size usable',
};

function noteFor(r) {
  const bits = [];
  if (r.reg_state !== 'usable') bits.push(REG_LABEL[r.reg_state]);
  if (!r.d4d_canon) bits.push('D4D missing value');
  if (!r.models_agree) bits.push(`size conflict — Small ${dash(r.small_canon)} vs Medium ${dash(r.medium_canon)}`);
  if ((r.small_brand || '') !== (r.medium_brand || '')) bits.push('brand differs');
  if (r.small_price !== r.medium_price) bits.push('current price differs');
  if (!bits.length) bits.push('both models agree on every compared field');
  return bits.join('; ');
}

const cards = rows.map((r) => {
  const d = d4dBy.get(sampleBy.get(r.index).id);
  const d4dText = [d?.name, d?.name_ar].filter(Boolean).join(' ') || null;
  const divergent = !r.models_agree
    || (r.small_name || '') !== (r.medium_name || '')
    || (r.small_brand || '') !== (r.medium_brand || '')
    || r.small_price !== r.medium_price;
  return `
<article class="crop${divergent ? ' crop--split' : ''}" id="crop-${r.index}">
  <header class="crop__head">
    <span class="crop__n">${r.index}</span>
    <span class="crop__store">${esc(r.store)}</span>
    <span class="crop__cat">${esc(r.category)}</span>
    ${divergent ? '<span class="tag tag--differ">models differ</span>' : '<span class="tag tag--agree">models agree</span>'}
  </header>
  <div class="crop__body">
    <figure class="shot">
      <img src="${imgs.get(r.index)}" alt="Brochure crop ${r.index} from ${esc(r.store)}" loading="lazy" />
      <figcaption>click to enlarge</figcaption>
    </figure>
    <div class="panel">
      <table class="cmp">
        <thead><tr><th>source</th><th>as returned</th><th>canonical</th></tr></thead>
        <tbody>
          <tr class="cmp__val"><th>D4D</th><td class="txt">${esc(d4dText ? d4dText.slice(0, 120) : null)}</td><td class="mono">${esc(dash(r.d4d_canon))}</td></tr>
          <tr class="cmp__val"><th>Registry</th><td class="txt">${esc(REG_LABEL[r.reg_state])}</td><td class="mono">${esc(dash(r.reg_canon))}</td></tr>
          <tr class="cmp__s"><th>Small</th><td class="txt">${esc(r.small_raw)}</td><td class="mono">${esc(dash(r.small_canon))}</td></tr>
          <tr class="cmp__m"><th>Medium</th><td class="txt">${esc(r.medium_raw)}</td><td class="mono">${esc(dash(r.medium_canon))}</td></tr>
        </tbody>
      </table>
      <dl class="fields">
        <div><dt>name — Small</dt><dd>${esc(dash(r.small_name))}</dd></div>
        <div><dt>name — Medium</dt><dd>${esc(dash(r.medium_name))}</dd></div>
        <div><dt>brand</dt><dd>S ${esc(dash(r.small_brand))} · M ${esc(dash(r.medium_brand))}</dd></div>
        <div><dt>price</dt><dd>S ${esc(dash(r.small_price))} · M ${esc(dash(r.medium_price))}</dd></div>
      </dl>
      <p class="gate">
        <span class="chip chip--${r.reg.match === 'YES' ? 'ok' : r.reg.match === 'NO' ? 'no' : 'blind'}">registry gate: ${esc(r.reg.why)}</span>
        <span class="chip chip--${r.d4d.match === 'YES' ? 'ok' : r.d4d.match === 'NO' ? 'no' : 'blind'}">D4D gate: ${esc(r.d4d.why)}</span>
        <span class="chip chip--esc">escalated: ${esc(r.reg.esc)}</span>
      </p>
      <p class="note">${esc(noteFor(r))}</p>
      <fieldset class="verdict" data-index="${r.index}">
        <legend>your call</legend>
        <label><input type="radio" name="v${r.index}" value="Small" /> Small</label>
        <label><input type="radio" name="v${r.index}" value="Medium" /> Medium</label>
        <label><input type="radio" name="v${r.index}" value="Tie" /> Tie / both fine</label>
        <label><input type="radio" name="v${r.index}" value="Both wrong" /> Both wrong</label>
      </fieldset>
    </div>
  </div>
</article>`;
}).join('\n');

const tableRows = rows.map((r) => `<tr>
  <td class="mono">${r.index}</td>
  <td>${esc(r.store)}</td>
  <td class="mono">${esc(dash(r.d4d_canon))}</td>
  <td class="mono">${esc(dash(r.small_canon))}</td>
  <td class="mono">${esc(r.reg.match)}</td>
  <td class="mono">${esc(r.reg.esc)}</td>
  <td class="mono">${esc(dash(r.medium_canon))}</td>
  <td class="mono verdict-cell" data-for="${r.index}">${esc(VERDICT[r.index]||"—")}</td>
  <td class="txt">${esc(noteFor(r))}</td>
</tr>`).join('\n');

const g = summary.registry_gate;
const d = summary.d4d_gate;
const m = summary.models;

const html = `<title>Small-first routing — 30-crop review</title>
<style>
:root{
  --ground:#f4f6f7; --panel:#fff; --ink:#141a1e; --ink2:#54626c; --rule:#dbe1e5;
  --accent:#0d6a72; --agree:#2c6e4a; --differ:#a8412c; --blind:#8a6d1f; --shade:#eaeef0;
  --serif:"Iowan Old Style",Georgia,"Times New Roman",serif;
  --ui:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --ground:#0e1214; --panel:#161d21; --ink:#e5eaed; --ink2:#93a2ab; --rule:#263137;
  --accent:#4fb3ba; --agree:#5aab7c; --differ:#e08063; --blind:#c9a94a; --shade:#1c252a;
}}
:root[data-theme="dark"]{
  --ground:#0e1214; --panel:#161d21; --ink:#e5eaed; --ink2:#93a2ab; --rule:#263137;
  --accent:#4fb3ba; --agree:#5aab7c; --differ:#e08063; --blind:#c9a94a; --shade:#1c252a;
}
:root[data-theme="light"]{
  --ground:#f4f6f7; --panel:#fff; --ink:#141a1e; --ink2:#54626c; --rule:#dbe1e5;
  --accent:#0d6a72; --agree:#2c6e4a; --differ:#a8412c; --blind:#8a6d1f; --shade:#eaeef0;
}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--ui);
  font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:40px 20px 96px;display:flex;flex-direction:column;gap:34px}
h1{font-family:var(--serif);font-weight:600;font-size:clamp(26px,4vw,38px);line-height:1.15;
  letter-spacing:-.015em;margin:0;text-wrap:balance}
.lede{margin:0;color:var(--ink2);max-width:64ch}
.eyebrow{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--accent);
  font-weight:650;margin:0 0 10px}
.finding{border:1px solid var(--rule);border-left:3px solid var(--blind);background:var(--panel);
  padding:18px 20px;border-radius:3px}
.finding h2{font-family:var(--serif);font-size:19px;margin:0 0 8px;font-weight:600}
.finding p{margin:0 0 8px;color:var(--ink2)}
.finding p:last-child{margin-bottom:0}
.finding b{color:var(--ink);font-weight:650}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;
  background:var(--rule);border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.tile{background:var(--panel);padding:14px 16px}
.tile b{display:block;font-family:var(--mono);font-size:25px;font-variant-numeric:tabular-nums;
  letter-spacing:-.02em}
.tile span{font-size:11.5px;color:var(--ink2);letter-spacing:.04em}
.tile--warn b{color:var(--blind)} .tile--ok b{color:var(--agree)} .tile--no b{color:var(--differ)}
.crop{background:var(--panel);border:1px solid var(--rule);border-radius:3px;overflow:hidden}
.crop--split{border-left:3px solid var(--differ)}
.crop__head{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--rule);
  background:var(--shade);flex-wrap:wrap}
.crop__n{font-family:var(--mono);font-weight:700;font-size:13px;color:var(--accent)}
.crop__store{font-weight:640;font-size:13.5px}
.crop__cat{font-size:12px;color:var(--ink2);font-family:var(--mono)}
.tag{margin-left:auto;font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;
  padding:3px 8px;border-radius:2px;font-weight:650}
.tag--differ{background:color-mix(in srgb,var(--differ) 15%,transparent);color:var(--differ)}
.tag--agree{background:color-mix(in srgb,var(--agree) 15%,transparent);color:var(--agree)}
.crop__body{display:grid;grid-template-columns:290px 1fr;gap:20px;padding:18px 16px}
@media(max-width:760px){.crop__body{grid-template-columns:1fr}}
.shot{margin:0}
.shot img{width:100%;border:1px solid var(--rule);border-radius:2px;display:block;cursor:zoom-in;
  background:#fff}
.shot img.big{position:fixed;inset:3vh 3vw;width:auto;height:94vh;max-width:94vw;margin:auto;
  z-index:50;cursor:zoom-out;object-fit:contain;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.shot figcaption{font-size:11px;color:var(--ink2);margin-top:5px;letter-spacing:.03em}
.panel{min-width:0;display:flex;flex-direction:column;gap:12px}
.cmp{width:100%;border-collapse:collapse;font-size:13px}
.cmp th,.cmp td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--rule);vertical-align:top}
.cmp thead th{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--ink2);font-weight:600}
.cmp tbody th{white-space:nowrap;font-weight:650;width:76px}
.cmp__s tbody th,.cmp__s>th{color:var(--accent)}
.cmp__val>th{color:var(--ink2);font-weight:600}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:12.5px}
.txt{color:var(--ink2);word-break:break-word}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:2px 16px;margin:0;font-size:12.5px}
.fields dt{font-size:10.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink2)}
.fields dd{margin:0 0 6px;word-break:break-word}
.gate{display:flex;flex-wrap:wrap;gap:6px;margin:0}
.chip{font-size:11px;padding:3px 8px;border-radius:2px;border:1px solid var(--rule);
  font-family:var(--mono);color:var(--ink2)}
.chip--blind{border-color:var(--blind);color:var(--blind)}
.chip--ok{border-color:var(--agree);color:var(--agree)}
.chip--no{border-color:var(--differ);color:var(--differ)}
.note{margin:0;font-size:12.5px;color:var(--ink2);border-left:2px solid var(--rule);padding-left:10px}
.verdict{border:1px dashed var(--rule);border-radius:2px;padding:8px 12px;display:flex;
  flex-wrap:wrap;gap:14px;align-items:center;margin:0}
.verdict legend{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:var(--accent);
  font-weight:650;padding:0 5px}
.verdict label{font-size:12.5px;display:flex;align-items:center;gap:5px;cursor:pointer}
.verdict input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.tablewrap{overflow-x:auto;border:1px solid var(--rule);border-radius:3px;background:var(--panel)}
table.full{width:100%;border-collapse:collapse;font-size:12.5px;min-width:900px}
table.full th,table.full td{padding:7px 10px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}
table.full thead th{background:var(--shade);font-size:10.5px;text-transform:uppercase;
  letter-spacing:.07em;color:var(--ink2);position:sticky;top:0}
.bar{position:sticky;bottom:0;background:var(--panel);border-top:1px solid var(--rule);
  padding:10px 20px;display:flex;gap:14px;align-items:center;font-size:13px;z-index:20}
.bar button{font:inherit;font-size:12.5px;padding:5px 12px;border:1px solid var(--accent);
  background:transparent;color:var(--accent);border-radius:2px;cursor:pointer}
.bar button:hover{background:var(--accent);color:var(--panel)}
.bar output{font-family:var(--mono);color:var(--ink2)}
h2.sec{font-family:var(--serif);font-size:21px;margin:0 0 4px;font-weight:600}
.sub{color:var(--ink2);font-size:13px;margin:0}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
</style>

<div class="wrap">
  <header>
    <p class="eyebrow">Routing experiment · 30 crops · 2026-07-25</p>
    <h1>Small-first routing, gated on package size</h1>
    <p class="lede">Same frozen prompt, same parser, same canonicalizer — only the model changes.
    <span class="mono">mistral-small-2603</span> against the frozen
    <span class="mono">mistral-medium-3.5</span> arm, on 30 crops drawn at random from the frozen 50.</p>
  </header>

  <div class="finding">
    <h2>The gate almost never fires</h2>
    <p>The proposed pipeline escalates when Small's package size conflicts with an independent source.
    On this sample it escalated <b>0 times out of 30</b> — not because Small agreed, but because
    no validator had a value to disagree with.</p>
    <p>D4D publishes <b>no structured size field</b>; the only text it returns is an OCR description that
    canonicalizes to a size on 20% of the corpus. The registry is better covered across products
    (84%) but is <b>absent for 21 of these 30 offers</b> and circular for 6 more — the routing
    decision happens at ingest, before resolution has run.</p>
    <p>Meanwhile the two models genuinely diverge: <b>${m.size_differ} size conflicts,
    ${m.name_differ} name differences, ${m.brand_differ} brand differences, ${m.price_differ} price
    differences</b>. The gate caught none of them, including crop 33, where Small returned
    <span class="mono">10 KG</span> for a bag printed <span class="mono">5kg</span>.</p>
  </div>

  <div class="finding" style="border-left-color:var(--differ)">
    <h2>Result after adjudication — 30/30 reviewed</h2>
    <p>Human verdicts: <b>Medium better on 5, Small better on 1, tie on 24</b>. Because nothing
    escalated, all 5 Medium wins ship as defects — crops <span class="mono">4, 23, 33, 39, 46</span>.</p>
    <p>Cost falls <b>91.1%</b> ($0.002046 → $0.000182 per crop, measured tokens) and the
    <b>defect rate is 16.7%</b>, 95% CI [7.3%, 33.6%]. The routing logic contributed nothing to
    either number: with a 0% escalation rate this is simply always-Small.</p>
    <p>Design ceiling worth noting — only 3 of the 5 defects (33, 39, 46) are size errors. Crops 4
    and 23 are brand errors, which a size gate cannot see <em>even with a perfect oracle</em>.</p>
  </div>

  <section>
    <h2 class="sec">Gate coverage</h2>
    <p class="sub">How often each validator could form an opinion at all.</p>
    <div class="tiles" style="margin-top:12px">
      <div class="tile tile--ok"><b>${g.usable}</b><span>registry usable</span></div>
      <div class="tile tile--warn"><b>${g.absent}</b><span>registry absent</span></div>
      <div class="tile tile--warn"><b>${g.circular}</b><span>registry circular</span></div>
      <div class="tile tile--warn"><b>${d.blind}</b><span>D4D blind</span></div>
      <div class="tile tile--no"><b>${g.escalated}</b><span>escalations fired</span></div>
    </div>
  </section>

  <section>
    <h2 class="sec">Per-crop review</h2>
    <p class="sub">Rows marked <em>models differ</em> are the ones that need your eye. Record a verdict
    on each; the bar at the bottom copies them back to me.</p>
  </section>

  ${cards}

  <section>
    <h2 class="sec">Summary table</h2>
    <p class="sub">Final Winner stays blank until you adjudicate — it fills in from your verdicts above.</p>
    <div class="tablewrap" style="margin-top:12px">
      <table class="full">
        <thead><tr><th>#</th><th>Store</th><th>D4D</th><th>Small</th><th>Match?</th>
        <th>Escalated?</th><th>Medium</th><th>Final winner</th><th>Notes</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  </section>
</div>

<div class="bar">
  <output id="tally">0 / 30 adjudicated</output>
  <button type="button" id="copy">Copy verdicts</button>
</div>

<script>
document.querySelectorAll('.shot img').forEach(function(img){
  img.addEventListener('click', function(){ img.classList.toggle('big'); });
});
var total = ${rows.length};
function refresh(){
  var done = 0;
  document.querySelectorAll('.verdict').forEach(function(fs){
    var idx = fs.getAttribute('data-index');
    var sel = fs.querySelector('input:checked');
    var cell = document.querySelector('.verdict-cell[data-for="' + idx + '"]');
    if (sel) { done++; if (cell) cell.textContent = sel.value; }
    else if (cell) { cell.textContent = '—'; }
  });
  document.getElementById('tally').textContent = done + ' / ' + total + ' adjudicated';
}
document.addEventListener('change', function(e){
  if (e.target && e.target.type === 'radio') refresh();
});
document.getElementById('copy').addEventListener('click', function(){
  var lines = [];
  document.querySelectorAll('.verdict').forEach(function(fs){
    var sel = fs.querySelector('input:checked');
    lines.push('crop ' + fs.getAttribute('data-index') + ': ' + (sel ? sel.value : 'unreviewed'));
  });
  var text = lines.join('\\n');
  navigator.clipboard.writeText(text).then(function(){
    var b = document.getElementById('copy');
    b.textContent = 'Copied'; setTimeout(function(){ b.textContent = 'Copy verdicts'; }, 1400);
  });
});
refresh();
</script>
`;

await writeFile(join(HERE, 'review.html'), html, 'utf8');
console.log('review.html written:', (Buffer.byteLength(html) / 1024 / 1024).toFixed(2), 'MB');
