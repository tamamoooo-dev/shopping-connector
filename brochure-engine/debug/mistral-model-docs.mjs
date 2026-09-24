// Read-only: the Ministral 3 14B model page on Mistral's PUBLIC docs.
for (const u of ['https://docs.mistral.ai/models/ministral-3-14b-25-12']) {
  const t = await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } })).text();
  const plain = t.replace(/\\"/g, '"').replace(/<[^>]+>/g, ' ');
  console.log(u, t.length);
  console.log('identifier-like tokens:', JSON.stringify([...new Set(plain.match(/\bministral-[a-z0-9.\-]+/gi) || [])]));
  for (const k of ['API', 'Endpoint', 'endpoint', 'Model ID', 'model_id', 'Vision', 'vision', 'Input', 'Deprecation', 'Retirement', 'Free', 'Price', 'price']) {
    for (const m of plain.matchAll(new RegExp('.{0,120}' + k + '.{0,160}', 'g'))) { const s = m[0].replace(/\s+/g, ' '); if (/ministral|14b|image|\$|endpoint/i.test(s)) { console.log(`[${k}]`, s.slice(0, 280)); } }
  }
}
