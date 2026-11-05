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
//   differently: an offer stands only when both copies list its price, and a
//   name or size is shown only when its words are printed in both copies of
//   the text. BATCH=1 is one call a picture. The study passed the pictures
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

// The reading prompt's Rules, word for word, except the name: the words
// printed for the product, never the shop's own.
const RULES = mm.SNAP_READ_PROMPT.slice(mm.SNAP_READ_PROMPT.indexOf('Rules:'), mm.SNAP_READ_PROMPT.indexOf('Return JSON only'))
  .replace(/- "name":[^\n]*\n/, '- "name": the product name in the words printed for it (caption, tag, poster or package), in the language printed. Never use the shop\'s name or slogan as the name. Never invent a brand or a word that is not printed.\n');
const BATCH_PROMPT = `Each picture above is one snap (a photo or one frame of a video) from a shop's Snapchat story, labelled "Picture 1", "Picture 2", and so on. Read every picture on its own: never move text or offers from one picture to another.
For each picture, first "lines": copy the text printed in it, word for word: captions, stickers, banners, price tags and the writing on the packages. Copy only what is actually written. Never add a word, never translate. Keep each piece of text in its own script.
Then "offers": every product whose PRICE is printed in that picture.

${RULES}
Return JSON only: one entry for every picture, in order, with numbers for count, price and was_price:
{"pictures":[{"picture":1,"lines":["..."],"offers":[{"name":"...","brand":null,"size":null,"count":1,"unit":null,"price":P,"was_price":null}]}]}
A picture with no printed price has "offers": [].`;

// A price counts only when a copied line prints it: not in the app's own text
// ("3 hrs ago", a clock) and at least once not as a weight.
const INTERFACE = /منذ|ago|ساعة|ساعات|دقيقة|دقائق|\bmin\b|\bhrs?\b|\d{1,2}:\d{2}/i;
const WEIGHT_AFTER = /^\s*(?:جرام|جم|غرام|غم|كيلو|كجم|كغ|كلغ|ملي|مل|لتر|g|gm|gr|kg|ml|l)(?![\p{L}])/iu;
function pricePrinted(lines, price) {
  return lines.some((line) => {
    const text = mm.normalizeDigits(line);
    if (INTERFACE.test(text)) return false;
    return [...text.matchAll(/\d+(?:\.\d+)?/g)].some((m) => Math.abs(Number(m[0]) - price) <= 0.005
      && !WEIGHT_AFTER.test(text.slice(m.index + m[0].length)));
  });
}

// One copy of one picture -> { offers, lines }.
function copyOf(entry) {
  const lines = Array.isArray(entry?.lines) ? entry.lines.map(String) : [];
  const read = mm.parseSnapReading(entry) || [];
  const offers = mm.dropSizeTwins(mm.dropOldPriceTwins(mm.dedupeDeals(read))).filter((o) => pricePrinted(lines, o.price));
  return { offers, lines };
}

// Two copies -> the offers both list, one to one: an offer of the second copy
// vouches for one offer of the first (the same name first, else the same
// price), so one copy's second flavour at the same price doesn't stand alone.
function agree(first, second) {
  const left = [...second];
  const out = [];
  for (const a of first) {
    let k = left.findIndex((o) => samePrice(o.price, a.price) && mm.similarNames(o.name, a.name));
    if (k < 0) k = left.findIndex((o) => samePrice(o.price, a.price));
    if (k < 0) continue;
    const [b] = left.splice(k, 1);
    out.push({ ...a, wasPrice: samePrice(a.wasPrice, b.wasPrice) ? a.wasPrice : null, votes: 2, names: [b.name] });
  }
  return mm.dropOldPriceTwins(mm.dedupeDeals(out));
}

// Every copy of one picture -> the offers shown.
function shown(copies) {
  const texts = copies.map((c) => c.lines.join('\n'));
  const offers = copies.length === 1 ? copies[0].offers : agree(copies[0].offers, copies[1].offers);
  return offers.map((o) => ({
    ...o,
    shownName: mm.printedName(o.name, texts) || '',
    shownSize: o.size && mm.sizePrintedIn(o.size, texts) ? o.size : '',
  }));
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
        copies.get(s.n)[job.copy] = copyOf(entry);
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
