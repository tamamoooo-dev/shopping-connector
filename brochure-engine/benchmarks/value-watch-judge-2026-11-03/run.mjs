// Production path end to end: the engine's buildWatch → sweepValueWatch (rules,
// conflicts, twins, per-product judging, size check) with the live 14B judge,
// each store answering with the reference's recorded candidates. Index sweeps
// repeat until nothing is pending (production re-judges on later sweeps).
//   TAG=r1 node run.mjs   → results_e2e_r1.json, then: node score.mjs results_e2e_r1.json
import { readFileSync, writeFileSync } from 'node:fs';
import { chat } from './mistral.mjs';
const E = new URL('../../src/', import.meta.url).href;
const V = await import(E + 'watchValue.js');
const { sweepValueWatch, watchReference } = await import(E + 'watchIndex.js');
const { buildWatch } = await import(E + 'monitor.js');
const { createMemoryWatchListingStore } = await import(E + 'storage/watchListingStore.js');
const tag = process.env.TAG || 'e1';
const data = JSON.parse(readFileSync(new URL('candidates.json', import.meta.url), 'utf8'));
const out = {};
const raws = [];
const stats = { calls: 0, ms: 0, promptTokens: 0, completionTokens: 0, sweeps: {} };
for (const d of data) {
  const L = d.refListing;
  const { watch, error } = buildWatch({
    profileId: 'bench-profile-1', kind: 'product', provider: L.provider, productId: String(L.id),
    query: L.fullName || L.name, label: L.fullName || L.name, targetPrice: 10, listing: L, brand: L.brand || null,
  });
  if (error) throw new Error(`${d.key}: ${error}`);
  const byStore = {};
  for (const c of d.candidates) (byStore[c.store] ||= []).push(c.listing);
  // The sweep keeps 50 per query: page each store's candidates over its queries.
  const asked = {};
  const searchClient = { async search(store, query) {
    const qs = (asked[store] ||= []);
    if (!qs.includes(query)) qs.push(query);
    const page = qs.indexOf(query);
    return (byStore[store] || []).slice(page * 50, page * 50 + 50).map((l) => ({ ...l }));
  } };
  const maxPerStore = Math.max(...Object.values(byStore).map((v) => v.length));
  if (maxPerStore > 50 * watchReference(watch).queries.length) console.log(`
${d.key}: ${maxPerStore} in one store > ${watchReference(watch).queries.length} pages`);
  const watchJudge = async (reference, candidates) => {
    const body = V.buildJudgeRequest(reference, candidates, { model: 'ministral-14b-2512' });
    const reply = await chat(body);
    stats.calls += 1; stats.ms += reply.ms;
    stats.promptTokens += reply.usage?.prompt_tokens || 0; stats.completionTokens += reply.usage?.completion_tokens || 0;
    const parsed = V.parseJudgeReply(reply.content, candidates.length);
    raws.push({ ref: d.key, finish: reply.finish, items: candidates.map((c, i) => ({ store: c.store, id: c.listing.id, name: c.listing.fullName || c.listing.name, size: c.listing.size, answer: parsed.results[i] })) });
    return parsed;
  };
  const ctx = { watchListingStore: createMemoryWatchListingStore(), searchClient, watchJudge };
  let sweeps = 0; let res;
  do {
    res = await sweepValueWatch(ctx, watch, { mode: 'index', includeFlyers: false, now: new Date(Date.now() + sweeps * 60000) });
    sweeps += 1;
    process.stdout.write(`${d.key.split('-')[0]}:${res.counts.pending} `);
    // Pending by 'ai' is the checker's kept "unsure"; only no-answer rows (by null) are asked again.
    var open = (await ctx.watchListingStore.list(watch.id)).filter((r) => r.verdict === 'pending' && !r.verdictBy).length;
  } while (open > 0 && sweeps < 12);
  stats.sweeps[d.key] = sweeps;
  for (const row of await ctx.watchListingStore.list(watch.id)) {
    out[`${d.key}|${row.store}|${row.listingId}`] = { verdict: row.verdict, by: row.verdictBy, reason: row.verdictReason };
  }
}
writeFileSync(`raw_e2e_${tag}.json`, JSON.stringify(raws, null, 1));
writeFileSync(`results_e2e_${tag}.json`, JSON.stringify({ stats, out }, null, 1));
console.log(`\ne2e/${tag}: ${Object.keys(out).length} decisions, ${stats.calls} calls, ${stats.ms} ms, sweeps ${JSON.stringify(stats.sweeps)}`);
