// Bench: the Mini marts offer groups (src/minimartCategory.js) on the live
// offers, through Claude Haiku 5.5 on the PC's own Claude login (the Agent
// SDK, as the PC reader asks).
//
//   node benchmarks/minimart-category-2026-11-15/run.mjs <minimarts.json> <out.json> [batch]
//
// <minimarts.json> is a saved GET /minimarts. Pictures are fetched from the
// engine and shrunk as the reader shrinks them. Results are third-party
// offers: they stay outside the repository.
import { readFileSync, writeFileSync } from 'node:fs';
import { query } from '../../pc-reader/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import sharp from '../../pc-reader/node_modules/sharp/dist/index.mjs';
import { CATEGORY_PROMPT, parseCategories, categoryLabel } from '../../src/minimartCategory.js';

const [file, out, batchArg] = process.argv.slice(2);
if (!file || !out) throw new Error('usage: run.mjs <minimarts.json> <out.json> [batch]');
const ENGINE = 'https://brochure-engine.tamamoooo.workers.dev';
const MODEL = 'claude-haiku-5-5';
const BATCH = Number(batchArg) || 25;
const EDGE = 512;
const usage = { calls: 0, input: 0, output: 0, ms: 0 };

async function ask(content) {
  async function* message() {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } };
  }
  const t0 = Date.now();
  for await (const m of query({
    prompt: message(),
    options: {
      model: MODEL, systemPrompt: 'You sort shop offers into groups and answer with JSON only.', tools: [], settingSources: [],
      strictMcpConfig: true, mcpServers: {}, maxTurns: 1, persistSession: false, effort: 'low', thinking: { type: 'disabled' },
      env: { ...process.env, DISABLE_PROMPT_CACHING: '1', CLAUDE_CODE_DISABLE_THINKING: '1' },
    },
  })) {
    if (m.type !== 'result') continue;
    const u = m.modelUsage?.[MODEL] || {};
    Object.assign(usage, { calls: usage.calls + 1, input: usage.input + (u.inputTokens || 0), output: usage.output + (u.outputTokens || 0), ms: usage.ms + Date.now() - t0 });
    if (m.subtype !== 'success' || m.is_error) { console.error('call failed:', m.subtype, String(m.result || m.errors || '').slice(0, 300)); return null; }
    return m.result;
  }
  return null;
}

async function picture(url) {
  if (!url) return null;
  const res = await fetch(`${ENGINE}${url}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) return null;
  const bytes = Buffer.from(await res.arrayBuffer());
  return (await sharp(bytes).rotate().resize({ width: EDGE, height: EDGE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()).toString('base64');
}

const offers = JSON.parse(readFileSync(file, 'utf8')).offers;
const rows = [];
for (let i = 0; i < offers.length; i += BATCH) {
  const group = offers.slice(i, i + BATCH);
  const content = [];
  for (const [k, o] of group.entries()) {
    content.push({ type: 'text', text: categoryLabel(k + 1, o) });
    const data = await picture(o.image);
    if (data) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
    else content.push({ type: 'text', text: '(no picture)' });
  }
  content.push({ type: 'text', text: CATEGORY_PROMPT });
  const found = parseCategories(await ask(content));
  group.forEach((o, k) => rows.push({ id: o.id, shop: o.username, name: o.name, brand: o.brand, size: o.size, image: o.image, group: found.get(k + 1) || null }));
  console.error(`${Math.min(i + BATCH, offers.length)}/${offers.length}`);
}
const byGroup = rows.reduce((m, r) => ({ ...m, [r.group]: (m[r.group] || 0) + 1 }), {});
writeFileSync(out, JSON.stringify({ summary: { offers: rows.length, byGroup, usage }, rows }, null, 1));
console.log(JSON.stringify({ offers: rows.length, byGroup, usage }));
