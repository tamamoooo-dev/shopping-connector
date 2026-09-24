// Read-only: Mistral's PUBLIC docs — the documented API identifiers for
// Ministral 3 14B. No credentials, no account calls.
const pages = [
  'https://docs.mistral.ai/models',
  'https://docs.mistral.ai/getting-started/models/models_overview/',
  'https://docs.mistral.ai/getting-started/models/',
  'https://docs.mistral.ai/llms.txt',
];
for (const u of pages) {
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const t = await r.text();
    const ids = [...new Set(t.match(/\bministral[-\w.]*/gi) || [])];
    console.log(u, r.status, t.length, 'identifiers:', JSON.stringify(ids));
    for (const m of t.matchAll(/.{0,160}ministral[- ]?(?:3[- ])?14b.{0,200}/gi)) console.log('   ', m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 360));
  } catch (e) { console.log(u, 'ERR', e.message); }
}
