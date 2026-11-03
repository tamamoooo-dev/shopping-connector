// The engine's conflictWith (flavour rule now inside it) and assortmentOf
// (a hold, not a veto): labels, twins, and how many R1–R8 candidates each settles.
import { readFileSync } from 'node:fs';
const V = await import(new URL('../../src/watchValue.js', import.meta.url).href);
const data = JSON.parse(readFileSync(new URL('candidates.json', import.meta.url), 'utf8'));
const labels = JSON.parse(readFileSync(new URL('labels.json', import.meta.url), 'utf8'));
let fl = 0, bad = 0, asst = 0, asstSame = 0;
for (const d of data) for (const c of d.candidates) {
  if (V.assortmentOf(c.listing, d.reference)) {
    asst += 1;
    if (labels[`${d.key}|${c.store}|${c.listing.id}`] === 'same') { asstSame += 1; console.log('HELD SAME', d.key, c.listing.id); }
  }
  const why = V.conflictWith(c.listing, d.reference);
  if (why && labels[`${d.key}|${c.store}|${c.listing.id}`] === 'same') { bad += 1; console.log('BAD', d.key, c.listing.id, why); }
  if (why?.startsWith('flavour')) fl += 1;
}
const byId = new Map();
for (const d of data) for (const c of d.candidates) byId.set(`${c.store}|${c.listing.id}`, c);
const byCode = new Map();
for (const [k, c] of byId) for (const b of V.barcodesOf(c.listing)) { if (!byCode.has(b)) byCode.set(b, []); byCode.get(b).push(k); }
let pairs = 0, twinBad = 0, twinHeld = 0;
for (const keys of byCode.values()) for (const a of keys) for (const b of keys) {
  if (a === b || a.split('|')[0] === b.split('|')[0]) continue;
  const A = byId.get(a).listing; pairs += 1;
  const ref = V.buildValueReference({ listing: { ...A, provider: a.split('|')[0] }, label: A.fullName || A.name, query: A.name, targetPrice: 10 });
  const why = V.conflictWith(byId.get(b).listing, ref);
  if (why) { twinBad += 1; console.log('TWIN', a, b, why); }
  if (V.assortmentOf(byId.get(b).listing, ref)) twinHeld += 1;
}
console.log(`flavour vetoes ${fl}; conflicts on SAME ${bad}; twin pairs ${pairs}, false conflicts ${twinBad}`);
console.log(`assortment holds ${asst} (on SAME ${asstSame}); twin pairs held ${twinHeld}`);
