// pc-reader/reader.mjs — the Mini marts PC reader (2026-11-05, owner: "Build
// PC reader"). Claude Haiku 5.5 reads the offer pictures shops post on their
// Snapchat story, on the owner's PC, through the Claude Agent SDK on the
// owner's Claude login (no API key: no money per call, the calls count
// against the plan's limits). The Worker can't run the SDK, so the engine
// prepares each snap (pictures in R2, a video cut into frames) and this
// claims them, reads them and posts the readings back; the engine turns them
// into offers (minimarts.js offersFromCopies). Mistral reads whenever this is
// off, and takes any snap this leaves for an hour.
//
//   node reader.mjs            claim, read and post until the queue is empty (≤10 rounds)
//   node reader.mjs --once     one round
//
// Task Scheduler runs it every 15 min, with no window (install-task.ps1 →
// run-hidden.vbs). Asking for work is the heartbeat: while it asks, the
// engine leaves new snaps to it.
//
// How it reads (measured on the 55-snap bench, HISTORY §69 addendum 5):
// pictures shrunk to 1092 px on the long edge, 28 in one call, each labelled
// "Picture n"; everything read TWICE, the second copy in reverse order so
// each picture sits in another group. 47/0/1/0 right/count/false/missed vs
// Mistral's 43/2/0/2, ~$0.0007 a picture at list price. Claude Code's own
// prompt, tools, MCP servers, settings and prompt cache are turned off, so a
// call carries only the pictures, the prompt and the answer.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import sharp from 'sharp';
import { loadIngestSecret } from '../local-secrets.mjs';

const ENGINE = process.env.ENGINE_URL || 'https://brochure-engine.tamamoooo.workers.dev';
const MODEL = 'claude-haiku-5-5';
const BATCH = 28;
const LONG_EDGE = 1092;
const WORKERS = 2;
const MAX_ROUNDS = process.argv.includes('--once') ? 1 : 10;
const CALL_TIMEOUT_MS = 5 * 60 * 1000;
const LOG_DIR = fileURLToPath(new URL('./logs/', import.meta.url));
const LOG_MAX_BYTES = 1024 * 1024;

const secret = loadIngestSecret();
if (!secret) throw new Error('no ingest secret (.ingest.secret)');

function log(entry) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  process.stdout.write(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const file = `${LOG_DIR}reader.log`;
    try {
      if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${LOG_DIR}reader.old.log`);
    } catch {
      /* no log yet */
    }
    appendFileSync(file, line);
  } catch {
    /* logging never stops a run */
  }
}

async function engine(path, init = {}) {
  const res = await fetch(`${ENGINE}${path}`, {
    ...init,
    headers: { 'X-Ingest-Secret': secret, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`engine ${path.split('?')[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// One prepared picture, shrunk for reading (the engine keeps the original).
async function picture(url) {
  const res = await fetch(`${ENGINE}${url}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`picture HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const small = await sharp(bytes).rotate().resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  return small.toString('base64');
}

const usage = { calls: 0, failed: 0, input: 0, output: 0, thinking: 0, costUSD: 0 };

async function askOnce(content) {
  async function* message() {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } };
  }
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), CALL_TIMEOUT_MS);
  let reply = null;
  try {
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
        // Asked for; through the SDK ~300 thinking tokens a picture still come back.
        thinking: { type: 'disabled' },
        abortController,
        env: { ...process.env, DISABLE_PROMPT_CACHING: '1', CLAUDE_CODE_DISABLE_THINKING: '1' },
      },
    })) {
      if (m.type !== 'result') continue;
      const u = m.modelUsage?.[MODEL] || Object.values(m.modelUsage || {})[0] || {};
      usage.calls += 1;
      usage.input += u.inputTokens || 0;
      usage.output += u.outputTokens || 0;
      usage.thinking += u.thinkingTokens || 0;
      usage.costUSD += m.total_cost_usd || 0;
      if (m.subtype !== 'success') throw new Error(`haiku ${m.subtype}: ${String(m.result || '').slice(0, 160)}`);
      reply = m.result;
    }
  } finally {
    clearTimeout(timer);
  }
  return reply;
}

async function ask(content, errors) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await askOnce(content);
    } catch (err) {
      usage.failed += 1;
      errors.push(String(err?.message || err).slice(0, 200));
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  return null;
}

function entriesOf(raw) {
  try {
    const parsed = JSON.parse(/\{[\s\S]*\}/.exec(String(raw))[0]);
    return Array.isArray(parsed?.pictures) ? parsed.pictures : [];
  } catch {
    return [];
  }
}

// Reads `items` ([{ id, data }]) in batches, `copy` -> Map id -> entry.
async function readCopy(items, prompt, errors) {
  const groups = [];
  for (let i = 0; i < items.length; i += BATCH) groups.push(items.slice(i, i + BATCH));
  const found = new Map();
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      const group = groups[next++];
      const content = group.flatMap((item, i) => [
        { type: 'text', text: `Picture ${i + 1}` },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: item.data } },
      ]);
      content.push({ type: 'text', text: prompt });
      const entries = entriesOf(await ask(content, errors));
      group.forEach((item, i) => {
        const entry = entries.find((e) => Number(e?.picture) === i + 1);
        if (entry) found.set(item.id, { lines: entry.lines ?? [], offers: entry.offers ?? [] });
      });
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  return found;
}

// One round: claim, read every picture twice, post. -> snaps claimed.
async function round() {
  const started = Date.now();
  const queue = await engine(`/minimarts/reader/queue?pictures=112`);
  if (!queue.snaps.length) return 0;
  const errors = [];
  const items = [];
  const broken = new Set();
  let next = 0;
  const flat = queue.snaps.flatMap((s) => s.pictures.map((p) => ({ snap: s.snapId, ref: p.ref, url: p.url })));
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < flat.length) {
      const p = flat[next++];
      try {
        items.push({ id: `${p.snap}\n${p.ref}`, snap: p.snap, data: await picture(p.url) });
      } catch (err) {
        broken.add(p.snap);
        errors.push(`${p.snap} ${p.ref}: ${String(err?.message || err).slice(0, 120)}`);
      }
    }
  }));
  const order = flat.map((p) => `${p.snap}\n${p.ref}`);
  const readable = order.map((id) => items.find((i) => i.id === id)).filter((i) => i && !broken.has(i.snap));

  // Two copies, the second in reverse order; a picture a reply left out is
  // asked once more on its own group.
  const copies = [];
  for (const list of [readable, [...readable].reverse()]) {
    const found = await readCopy(list, queue.prompt, errors);
    const missing = list.filter((i) => !found.has(i.id));
    if (missing.length) for (const [id, entry] of await readCopy(missing, queue.prompt, errors)) found.set(id, entry);
    copies.push(found);
  }

  // A snap is posted only with both copies of every picture; else its claim
  // simply expires (read again next round, or Mistral's after an hour).
  const snaps = [];
  for (const s of queue.snaps) {
    if (broken.has(s.snapId)) continue;
    const pictures = s.pictures.map((p) => {
      const id = `${s.snapId}\n${p.ref}`;
      return { ref: p.ref, copies: copies.map((c) => c.get(id)).filter(Boolean) };
    });
    if (pictures.every((p) => p.copies.length === 2)) snaps.push({ snapId: s.snapId, pictures });
  }
  const run = {
    model: MODEL, claimed: queue.snaps.length, posted: snaps.length, pictures: readable.length,
    ...usage, costUSD: Math.round(usage.costUSD * 1e6) / 1e6, ms: Date.now() - started, errors: errors.slice(0, 5),
  };
  const out = await engine('/minimarts/reader/readings', { method: 'POST', body: JSON.stringify({ snaps, run }) });
  log({ ...out.run, results: out.results.filter((r) => r.status !== 'read' || r.reread).slice(0, 20) });
  Object.assign(usage, { calls: 0, failed: 0, input: 0, output: 0, thinking: 0, costUSD: 0 });
  return queue.snaps.length;
}

try {
  for (let i = 0; i < MAX_ROUNDS; i += 1) {
    if (!(await round())) break;
  }
} catch (err) {
  log({ error: String(err?.message || err).slice(0, 300) });
  process.exitCode = 1;
}
