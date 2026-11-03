// The engine's conflictWith (flavour rule now inside it): labels, twins, and
// how many R1–R8 candidates it settles.
import { readFileSync } from 'node:fs';
const V = await import(new URL('../../src/watchValue.js', import.meta.url).href);
const data = JSON.parse(readFileSync(new URL('candidates.json', import.meta.url), 'utf8'));
const labels = JSON.parse(readFileSync(new URL('labels.json', import.meta.url), 'utf8'));
let fl = 0, bad = 0;
for (const d of data) for (const c of d.candidates) {
  const why = V.conflictWith(c.listing, d.reference);
  if (why && labels[`${d.key}|${c.store}|${c.listing.id}`] === 'same') { bad += 1; console.log('BAD', d.key, c.listing.id, why); }
  if (why?.startsWith('flavour')) fl += 1;
}
const byId = new Map();
for (const d of data) for (const c of d.candidates) byId.set(`${c.store}|${c.listing.id}`, c);
const byCode = new Map();
for (const [k, c] of byId) for (const b of V.barcodesOf(c.listing)) { if (!byCode.has(b)) byCode.set(b, []); byCode.get(b).push(k); }
let pairs = 0, twinBad = 0;
for (const keys of byCode.values()) for (const a of keys) for (const b of keys) {
  if (a === b || a.split('|')[0] === b.split('|')[0]) continue;
  const A = byId.get(a).listing; pairs += 1;
  const ref = V.buildValueReference({ listing: { ...A, provider: a.split('|')[0] }, label: A.fullName || A.name, query: A.name, targetPrice: 10 });
  const why = V.conflictWith(byId.get(b).listing, ref);
  if (why) { twinBad += 1; console.log('TWIN', a, b, why); }
}
console.log(`flavour vetoes ${fl}; conflicts on SAME ${bad}; twin pairs ${pairs}, false conflicts ${twinBad}`);
