// Read-only probe of the DEPLOYED engine's public, non-secret configuration.
// Never prints secret values: any string that looks like a credential is
// redacted, and only field names + model/tier-like values are shown.
const ENGINE = 'https://brochure-engine.tamamoooo.workers.dev';
const looksSecret = (v) => typeof v === 'string' && /^[A-Za-z0-9_\-]{24,}$/.test(v) && !/mistral|ministral|medium|small|ocr|latest|\d{4}/i.test(v);
const redact = (o) => JSON.parse(JSON.stringify(o, (k, v) => (looksSecret(v) || /key|token|secret/i.test(k) && typeof v === 'string' ? '[redacted]' : v)));
async function get(path) {
  const r = await fetch(`${ENGINE}${path}${path.includes('?') ? '&' : '?'}cb=${Date.now()}`);
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { status: r.status, body, bytes: text.length };
}
const h = await get('/health');
console.log('/health', h.status, 'keys:', h.body ? Object.keys(h.body).join(',') : '-');
const hs = JSON.stringify(h.body || {});
console.log('  mentions of models in /health:', JSON.stringify([...new Set(hs.match(/(?:mini|mag)?stral[\w.\-]*/gi) || [])]));
for (const key of [
  'ops/settings/vision-model.json', 'ops/settings/recovery-policy.json', 'ops/settings/registry-merge.json',
  'ops/settings/mistral-pools.json', 'ops/settings/models.json', 'ops/settings/price-fallback.json',
]) {
  const r = await get(`/asset/${key}`);
  console.log(`/asset/${key}`, r.status, r.body ? JSON.stringify(redact(r.body)).slice(0, 1500) : '');
}
