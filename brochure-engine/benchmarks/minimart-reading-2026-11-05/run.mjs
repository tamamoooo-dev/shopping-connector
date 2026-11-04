// Mini marts reading benchmark: the engine's own readSnap() over saved snap
// pictures, scored against truth.json (what each picture prints, checked by
// eye). The pictures are Snapchat content and are NOT committed; pass the
// folder they were saved to (<snap_id>.jpg).
//
//   node benchmarks/minimart-reading-2026-11-05/run.mjs <media dir> [label]
//
// Scores: right = a printed price with a printed count; count = right price,
// wrong count; false = a price the picture does not print as a selling price;
// missed = a printed price no offer carries.
import { readFileSync, writeFileSync } from 'node:fs';
import { readSnap, SNAP_READ_PROMPT } from '../../src/minimarts.js';
import { loadMistralKeys } from '../../local-secrets.mjs';

const [, , mediaDir, label = 'run'] = process.argv;
if (!mediaDir) throw new Error('usage: run.mjs <media dir> [label]');
const HERE = new URL('./', import.meta.url);
const truth = JSON.parse(readFileSync(new URL('truth.json', HERE), 'utf8'));
const keys = [...new Set([...loadMistralKeys('medium'), ...loadMistralKeys('small')])];
if (!keys.length) throw new Error('no Mistral key found');

let turn = 0;
async function ask(text, image, temperature) {
  const body = JSON.stringify({
    model: 'ministral-14b-2512',
    temperature,
    top_p: 1,
    response_format: { type: 'json_object' },
    messages: [{ role: 'user', content: [
      { type: 'text', text },
      { type: 'image_url', image_url: `data:image/jpeg;base64,${Buffer.from(image.bytes).toString('base64')}` },
    ] }],
  });
  for (let attempt = 0; attempt < keys.length * 3; attempt += 1) {
    const key = keys[turn++ % keys.length];
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body,
    });
    if (res.ok) return (await res.json()).choices?.[0]?.message?.content ?? null;
    if (res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }
    throw new Error(`mistral ${res.status}`);
  }
  throw new Error('mistral: every key refused');
}

const samePrice = (a, b) => Math.abs(a - b) <= 0.005;
const results = [];
let next = 0;
async function worker() {
  while (next < truth.length) {
    const snap = truth[next++];
    const bytes = new Uint8Array(readFileSync(`${mediaDir}/${snap.snapId}.jpg`));
    const calls = [];
    const logged = async (text, image, temperature) => {
      const raw = await ask(text, image, temperature);
      calls.push({ kind: text === SNAP_READ_PROMPT ? 'read' : 'check', raw });
      return raw;
    };
    const fetchImpl = async () => new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } });
    const report = {};
    const { offers } = await readSnap({ snapId: snap.snapId, mediaType: 'image', mediaUrl: 'local:' }, { ask: logged, fetchImpl, report });
    results.push({ ...snap, offers: offers.map(({ image, ...o }) => o), calls });
  }
}
await Promise.all([worker(), worker(), worker()]);
results.sort((a, b) => a.n - b.n);

const score = { right: 0, count: 0, false: 0, missed: 0, priced: 0, calls: 0 };
const lines = [];
for (const r of results) {
  score.calls += r.calls.length;
  score.priced += r.expected.length;
  const used = new Set();
  const marks = [];
  for (const o of r.offers) {
    const i = r.expected.findIndex((e, k) => !used.has(k) && samePrice(e.price, o.price));
    if (i < 0) {
      score.false += 1;
      marks.push(`FALSE ${o.price}x${o.count}`);
      continue;
    }
    used.add(i);
    if (r.expected[i].counts.includes(o.count)) {
      score.right += 1;
      marks.push(`ok ${o.price}x${o.count}`);
    } else {
      score.count += 1;
      marks.push(`COUNT ${o.price}x${o.count} (printed x${r.expected[i].counts.join('/')})`);
    }
  }
  r.expected.forEach((e, k) => {
    if (!used.has(k)) {
      score.missed += 1;
      marks.push(`MISSED ${e.price}`);
    }
  });
  lines.push(`${String(r.n).padStart(2)} ${r.shop.padEnd(9)} ${marks.join(' | ') || '(nothing, nothing printed)'}`);
}
console.log(lines.join('\n'));
console.log(label, score);
writeFileSync(new URL(`result-${label}.json`, HERE), JSON.stringify({ label, score, results }, null, 1));
