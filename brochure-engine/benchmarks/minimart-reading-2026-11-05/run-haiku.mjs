// Mini marts reading benchmark with Claude Haiku 5.5 as the reader (the
// 2026-11-05 study): same pictures, truth and scoring as run.mjs. Haiku is
// called through the Claude Agent SDK on the owner's Claude login, with no API
// key. The SDK is not an engine dependency; install it first:
//
//   npm install --no-save @anthropic-ai/claude-agent-sdk@0.3.309
//   node benchmarks/minimart-reading-2026-11-05/run-haiku.mjs <media dir> [label] [batch|pipeline]
//
// mode "batch" (the study's pick): BATCH pictures in one call (default 28),
//   each labelled "Picture n"; the reply copies each picture's printed lines
//   and lists its offers. COPIES=2 (default) reads everything twice, grouped
//   differently, and the engine's offersFromCopies decides (the PC reader's
//   rules): an offer stands only when both copies list its price, and a name
//   or size is shown only when its words are printed in both copies of the
//   text. BATCH=1 is one call a picture. The study passed the pictures
//   shrunk to 1092 px on the long edge.
// mode "pipeline": the engine's readSnap as is, Haiku in Mistral's place.
//
// Claude Code's own system prompt, tools, MCP servers, settings and prompt
// caching are turned off, so a call carries only the pictures, the prompt and
// the answer. Thinking can't be turned off through the SDK (it's asked for, and
// ~300 thinking tokens a picture still come back); effort is "low". Each
// call's tokens and the SDK's list-price cost estimate are recorded.
import { readFileSync, writeFileSync } from 'node:fs';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as mm from '../../src/minimarts.js';

const MODEL = 'claude-haiku-5-5';
const [, , mediaDir, label = 'haiku', mode = 'batch'] = process.argv;
if (!mediaDir) throw new Error('usage: run-haiku.mjs <media dir> [label] [batch|pipeline]');
const BATCH = Number(process.env.BATCH || 28);
const COPIES = Number(process.env.COPIES || 2);
if (![1, 2].includes(COPIES)) throw new Error('COPIES is 1 or 2');
const HERE = new URL('./', import.meta.url);
const truth = JSON.parse(readFileSync(new URL('truth.json', HERE), 'utf8'));
const samePrice = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.005;
const picture = (snap) => new Uint8Array(readFileSync(`${mediaDir}/${snap.snapId}.jpg`));

// The engine's own batch prompt and rules (minimarts.js BATCH_READ_PROMPT,
// offersFromCopies), so the bench measures what the PC reader runs: a price
// counts only when the copy's lines print it, both copies must list it (one to
// one), and a name or size shows only when its words are printed in both.
const BATCH_PROMPT = mm.BATCH_READ_PROMPT;
const entryOf = (entry) => ({ lines: Array.isArray(entry?.lines) ? entry.lines : [], offers: Array.isArray(entry?.offers) ? entry.offers : [] });

// Every copy of one picture -> the offers shown (one copy agrees with itself).
function shown(copies) {
  const two = copies.length === 1 ? [copies[0], copies[0]] : copies;
  return mm.offersFromCopies([{ ref: 'photo', copies: two }])
    .map((o) => ({ ...o, shownSize: o.sizePrinted ? o.size : '' }));
}

const usage = { calls: 0, failed: 0, input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0 };
const imageBlock = (bytes) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(bytes).toString('base64') } });

async function askOnce(content) {
  async function* message() {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } };
  }
  let reply = null;
  for await (const m of query({
    prompt: message(),
    options: {
      model: MODEL,
      systemPrompt: 'You read shop offer pictures and answer with JSON only.',
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      maxTurns: 1,
      persistSession: false,
      effort: 'low',
      thinking: { type: 'disabled' },
      env: { ...process.env, DISABLE_PROMPT_CACHING: '1', CLAUDE_CODE_DISABLE_THINKING: '1' },
    },
  })) {
    if (m.type !== 'result') continue;
    const u = m.modelUsage?.[MODEL] || Object.values(m.modelUsage || {})[0] || {};
    usage.calls += 1;
    usage.input += u.inputTokens || 0;
    usage.output += u.outputTokens || 0;
    usage.thinking += u.thinkingTokens || 0;
    usage.cacheRead += u.cacheReadInputTokens || 0;
    usage.cacheWrite += u.cacheCreationInputTokens || 0;
    usage.costUSD += m.total_cost_usd || 0;
    if (m.subtype !== 'success') throw new Error(`haiku ${m.subtype}`);
    reply = m.result;
  }
  return reply;
}

async function ask(content) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await askOnce(content);
    } catch (err) {
      usage.failed += 1;
      console.error('retry', attempt + 1, String(err?.message || err).slice(0, 120));
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('haiku: three failures');
}

const jsonOf = (raw) => { try { return JSON.parse(/\{[\s\S]*\}/.exec(raw)[0]); } catch { return null; } };

// The second copy reads the pictures in reverse order, so each picture sits in
// a different group, at a different place.
async function readBatches() {
  const jobs = [];
  for (let copy = 0; copy < COPIES; copy += 1) {
    const order = copy ? [...truth].reverse() : truth;
    for (let i = 0; i < order.length; i += BATCH) jobs.push({ copy, snaps: order.slice(i, i + BATCH) });
  }
  const copies = new Map(truth.map((s) => [s.n, []]));
  const calls = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const content = job.snaps.flatMap((s, i) => [{ type: 'text', text: `Picture ${i + 1}` }, imageBlock(picture(s))]);
      content.push({ type: 'text', text: BATCH_PROMPT });
      const raw = await ask(content);
      calls.push({ copy: job.copy, snaps: job.snaps.map((s) => s.n), raw });
      const entries = jsonOf(raw)?.pictures;
      job.snaps.forEach((s, i) => {
        const entry = Array.isArray(entries) ? entries.find((e) => Number(e?.picture) === i + 1) : null;
        copies.get(s.n)[job.copy] = entryOf(entry);
      });
      process.stderr.write('.');
    }
  };
  await Promise.all([worker(), worker()]);
  return { results: truth.map((s) => ({ ...s, copies: copies.get(s.n), offers: shown(copies.get(s.n)) })), calls };
}

async function readPipeline() {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < truth.length) {
      const snap = truth[next++];
      const bytes = picture(snap);
      const fetchImpl = async () => new Response(bytes, { headers: { 'Content-Type': 'image/jpeg' } });
      const haiku = (text, image) => ask([imageBlock(image.bytes), { type: 'text', text }]);
      const { offers } = await mm.readSnap({ snapId: snap.snapId, mediaType: 'image', mediaUrl: 'local:' }, { ask: haiku, fetchImpl, report: {} });
      results.push({ ...snap, offers: offers.map(({ image, ...o }) => o) });
      process.stderr.write('.');
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { results: results.sort((a, b) => a.n - b.n), calls: [] };
}

const started = Date.now();
const { results, calls } = mode === 'pipeline' ? await readPipeline() : await readBatches();

const score = { right: 0, count: 0, false: 0, missed: 0, priced: 0, namesShown: 0, namesHidden: 0 };
const lines = [];
for (const r of results) {
  score.priced += r.expected.length;
  const used = new Set();
  const marks = [];
  for (const o of r.offers) {
    if (o.shownName) score.namesShown += 1;
    else score.namesHidden += 1;
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
  const names = r.offers.map((o) => `${o.shownName || '(no name)'}${o.shownSize ? ` · ${o.shownSize}` : ''}`).join(' | ');
  lines.push(`${String(r.n).padStart(2)} ${r.shop.padEnd(9)} ${marks.join(' | ') || '(nothing, nothing printed)'}${names ? `   ${names}` : ''}`);
}
console.log(`\n${lines.join('\n')}`);
const perPicture = { calls: +(usage.calls / results.length).toFixed(2), costUSD: +(usage.costUSD / results.length).toFixed(6), input: Math.round(usage.input / results.length), output: Math.round(usage.output / results.length) };
console.log(label, mode, mode === 'batch' ? { BATCH, COPIES } : {}, score, { usage, perPicture, wallMin: +((Date.now() - started) / 60000).toFixed(1) });
writeFileSync(new URL(`result-${label}.json`, HERE), JSON.stringify({ label, mode, BATCH, COPIES, score, usage, perPicture, results, calls }, null, 1));
