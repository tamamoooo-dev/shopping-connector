// Tiny Mistral client for the benchmark: every local key round-robin, a fixed
// per-key pace (30 requests / key / minute), retries on 429/5xx. Keys are read
// by the engine's local-secrets loader and never printed.
const { loadMistralPools } = await import(new URL('../../local-secrets.mjs', import.meta.url).href);
const pools = loadMistralPools();
const keys = [...new Set([...(pools.medium || []), ...(pools.small || [])])];
if (!keys.length) throw new Error('no Mistral keys');
let next = 0;
const lastUse = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, body) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const key = keys[next++ % keys.length];
    const wait = (lastUse.get(key) || 0) + 2100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastUse.set(key, Date.now());
    const t0 = Date.now();
    const res = await fetch(`https://api.mistral.ai/v1/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) {
      const json = JSON.parse(text);
      return { json, ms: Date.now() - t0 };
    }
    if (res.status === 429 || res.status >= 500) { await sleep(1500 * (attempt + 1)); continue; }
    throw new Error(`mistral ${path} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  throw new Error(`mistral ${path}: retries exhausted`);
}

export async function chat(body) {
  const { json, ms } = await call('chat/completions', body);
  return { content: json.choices?.[0]?.message?.content ?? null, finish: json.choices?.[0]?.finish_reason ?? null, usage: json.usage, ms };
}

export async function embed(inputs, model = 'mistral-embed') {
  const out = [];
  for (let i = 0; i < inputs.length; i += 64) {
    const { json } = await call('embeddings', { model, input: inputs.slice(i, i + 64) });
    for (const d of json.data) out.push(d.embedding);
  }
  return out;
}

export const keyCount = keys.length;
