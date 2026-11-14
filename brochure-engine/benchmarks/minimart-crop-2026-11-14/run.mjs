// Bench: the Mini marts product crop (src/minimartCrop.js, pc-reader/crop.mjs)
// on a folder of frames, through Claude Haiku 5.5 on the PC's own Claude
// login (the Agent SDK, as the PC reader asks).
//
//   node benchmarks/minimart-crop-2026-11-14/run.mjs <frames dir> <out dir> [label]
//
// Writes <out dir>/crop-<frame>.jpg for every crop chosen and
// <out dir>/result-<label>.json. Frames and results are third-party pictures:
// they stay outside the repository.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { query } from '../../pc-reader/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import { cropOffers } from '../../pc-reader/crop.mjs';

const [dir, out, tag = 'run'] = process.argv.slice(2);
if (!dir || !out) throw new Error('usage: run.mjs <frames dir> <out dir> [label]');
mkdirSync(out, { recursive: true });
const MODEL = 'claude-haiku-5-5';
const usage = { calls: 0, input: 0, output: 0, ms: 0 };

async function ask(content) {
  async function* message() {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } };
  }
  const t0 = Date.now();
  for await (const m of query({
    prompt: message(),
    options: {
      model: MODEL, systemPrompt: 'You read shop offer pictures and answer with JSON only.', tools: [], settingSources: [],
      strictMcpConfig: true, mcpServers: {}, maxTurns: 1, persistSession: false, effort: 'low', thinking: { type: 'disabled' },
      env: { ...process.env, DISABLE_PROMPT_CACHING: '1', CLAUDE_CODE_DISABLE_THINKING: '1' },
    },
  })) {
    if (m.type !== 'result') continue;
    const u = m.modelUsage?.[MODEL] || {};
    Object.assign(usage, { calls: usage.calls + 1, input: usage.input + (u.inputTokens || 0), output: usage.output + (u.outputTokens || 0), ms: usage.ms + Date.now() - t0 });
    if (m.subtype !== "success" || m.is_error) { console.error("call failed:", m.subtype, String(m.result || m.errors || "").slice(0, 300)); return null; }
    return m.result;
  }
  return null;
}

const files = readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort();
const jobs = files.map((f) => ({ id: f, name: process.env.OFFER_NAME || '', bytes: readFileSync(join(dir, f)) }));
const found = await cropOffers(jobs, { ask });
const rows = [];
for (const job of jobs) {
  const r = found.get(job.id);
  if (r?.image) writeFileSync(join(out, `crop-${job.id.replace(/\.jpe?g$/i, '')}.jpg`), r.image);
  rows.push({ frame: job.id, kind: r?.kind || null, stage: r?.stage ?? null, none: r?.none || (r ? null : 'not answered'), box: r?.box || null, rect: r?.rect || null, tries: r?.tries || null });
}
const summary = {
  frames: jobs.length,
  cropped: rows.filter((r) => r.kind).length,
  byKind: rows.reduce((m, r) => ({ ...m, [r.kind || r.none]: (m[r.kind || r.none] || 0) + 1 }), {}),
  usage,
};
writeFileSync(join(out, `result-${tag}.json`), JSON.stringify({ summary, rows }, null, 1));
console.log(JSON.stringify(summary));
