// debug/offers-shortfall-census.mjs — WHY does production D1 hold only ~64
// offers for Al Madina flyer 742356 when the geometry references 462, and the
// D4D API serves 462? Investigation only — no fixes. NOT part of the Worker.
//
// Discriminates the six hypotheses by MEASURING the surviving rows and
// cross-referencing the live source:
//   1 early termination  -> survivors are a CONTIGUOUS low-id prefix
//   2 API returned few    -> D4D now returns few (measurable now) / survivors == what's priced
//   3 retention pruned     -> RULED OUT by code: pruneExpiredBefore cutoff is
//                             today-180d (retention.js:73); these expire 2026-07-14
//   4 exception mid-insert -> survivors align to a batch boundary (chunks of 40)
//   5 subrequest/CPU/time  -> survivors truncated WITHIN one flyer while OTHER
//                             flyers (same company-wide pull) are FULL
//   6 ingested pre-publish  -> survivors == the subset that had a PRICE at ingest;
//                             missing ids now carry prices in D4D; one detectedAt
//
// Signals measured:
//   A. production per-flyer stored counts (742356 / 742491 / 743796)
//   B. the 64 survivors: id ordering (prefix vs scattered), detectedAt set,
//      validTo set, page_ref spread
//   C. live D4D now: per-flyer count, how many carry a price (buildOffer would
//      keep), which of 742356's ids are missing from production and whether
//      those missing ids are priced now
//
// Usage (needs egress to BOTH the prod worker and d4donline -> run in CI):
//   node debug/offers-shortfall-census.mjs [--flyer 742356] [--brochure almadina:central:2026-W28]

import { createD4dOffersSource } from '../src/offers/d4dOffers.js';
import { buildOffer } from '../src/offers/contract.js';

const PROD = 'https://brochure-engine.tamamoooo.workers.dev';
const COMPANY = '212';
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const FLYER = opt('flyer', '742356');
const BROCHURE = opt('brochure', 'almadina:central:2026-W28');

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  return r.json();
}
const hist = (arr) => { const m = new Map(); for (const v of arr) m.set(v, (m.get(v) || 0) + 1); return m; };
const showHist = (m) => [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).map(([k, v]) => `${k}:${v}`).join('  ');

// Are these ids a contiguous prefix of the sorted full set? (paging/budget cut)
function prefixTest(survivorIds, fullIdsSorted) {
  const surv = new Set(survivorIds.map(String));
  let prefixLen = 0;
  for (const id of fullIdsSorted) { if (surv.has(String(id))) prefixLen++; else break; }
  return { prefixLen, isPrefix: prefixLen === surv.size };
}

async function main() {
  console.log(`prod: ${PROD}\nflyer: ${FLYER}  brochure: ${BROCHURE}\n`);

  // --- B: the surviving offers for this flyer (authoritative, un-currency-filtered) ---
  const hs = await getJson(`${PROD}/brochures/hotspots?id=${encodeURIComponent(BROCHURE)}`);
  const survivors = Object.values(hs.offers || {});
  const survivorIds = survivors.map((o) => String(o.offerId));
  console.log(`=== PRODUCTION stored offers for flyer ${FLYER} (byFlyer) ===`);
  console.log(`  count: ${survivors.length}`);
  console.log(`  detectedAt set: ${showHist(hist(survivors.map((o) => o.detectedAt)))}`);
  console.log(`  validTo set:    ${showHist(hist(survivors.map((o) => o.validTo)))}`);
  console.log(`  price<=0 or null among survivors: ${survivors.filter((o) => !(Number(o.price) > 0)).length}`);
  console.log(`  pageRef distinct: ${new Set(survivors.map((o) => o.pageRef)).size}`);
  const idsNum = survivorIds.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  console.log(`  offerId range: ${idsNum[0]} .. ${idsNum[idsNum.length - 1]}`);

  // --- A: production per-flyer coverage (current offers) ---
  let prodOffers = [];
  try {
    const off = await getJson(`${PROD}/offers?store=almadina&region=central&limit=300`);
    prodOffers = off.offers || [];
  } catch (e) { console.log(`  (/offers read failed: ${e.message})`); }
  console.log(`\n=== PRODUCTION current offers for almadina (/offers, currency-filtered) ===`);
  console.log(`  returned: ${prodOffers.length}`);
  console.log(`  per flyer_ref: ${showHist(hist(prodOffers.map((o) => o.flyerRef)))}`);
  try {
    const health = await getJson(`${PROD}/`);
    console.log(`  engine offers counts: ${JSON.stringify(health.offers)}`);
  } catch { /* ignore */ }

  // --- C: live D4D now, per flyer + price availability + buildOffer survival ---
  console.log(`\n=== LIVE D4D products/search for company ${COMPANY} (now) ===`);
  const src = createD4dOffersSource();
  const raws = await src.listOffers(COMPANY, { city: 'riyadh', storePageSlug: 'al-madina-hypermarket-212' });
  console.log(`  total product records: ${raws.length}`);
  const byFlyerRaw = new Map();
  for (const r of raws) {
    const f = String(r.flyerRef);
    if (!byFlyerRaw.has(f)) byFlyerRaw.set(f, []);
    byFlyerRaw.get(f).push(r);
  }
  console.log('  per flyer_ref | records  priced(now)  buildOffer-survives  valid_to');
  for (const [f, list] of [...byFlyerRaw.entries()].sort()) {
    const priced = list.filter((r) => Number(r.price) > 0).length;
    const built = list.filter((r) => buildOffer(r, { store: 'almadina', region: 'central', source: 'd4d', detectedAt: 'x' })).length;
    const vt = showHist(hist(list.map((r) => (r.validTo || '').slice(0, 10))));
    console.log(`  ${f.padEnd(8)} | ${String(list.length).padStart(7)} ${String(priced).padStart(11)} ${String(built).padStart(19)}  ${vt}`);
  }

  // --- cross-reference for THIS flyer ---
  const flyerRaws = byFlyerRaw.get(FLYER) || [];
  const d4dIds = flyerRaws.map((r) => String(r.offerId));
  const d4dIdsSorted = d4dIds.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const survSet = new Set(survivorIds);
  const missing = d4dIds.filter((id) => !survSet.has(id));
  const missingPricedNow = flyerRaws.filter((r) => !survSet.has(String(r.offerId)) && Number(r.price) > 0).length;
  const pt = prefixTest(survivorIds, d4dIdsSorted);

  console.log(`\n=== CROSS-REFERENCE flyer ${FLYER} ===`);
  console.log(`  D4D ids now: ${d4dIds.length} · production stored: ${survivors.length} · missing from prod: ${missing.length}`);
  console.log(`  are survivors a CONTIGUOUS low-id prefix of D4D's sorted ids?  ${pt.isPrefix ? 'YES' : 'NO'} (leading run of survivors = ${pt.prefixLen} of ${survivors.length})`);
  console.log(`  of the ${missing.length} missing ids, how many are PRICED in D4D now: ${missingPricedNow}`);
  console.log(`  survivors that are ALSO in D4D now: ${survivorIds.filter((id) => new Set(d4dIds).has(id)).length} of ${survivors.length}`);

  console.log(`\n=== READING ===`);
  console.log(`  H3 retention: RULED OUT by code — pruneExpiredBefore cutoff = today-180d (retention.js:73); these offers valid_to ${[...new Set(survivors.map((o) => o.validTo))].join('/')}.`);
  if (pt.isPrefix) console.log('  survivors ARE a contiguous prefix -> consistent with H1/H5 (paging/budget truncation).');
  else console.log('  survivors are SCATTERED (not a prefix) -> AGAINST H1 (clean paging cutoff).');
  const otherFlyersFull = [...byFlyerRaw.keys()].filter((f) => f !== FLYER)
    .every((f) => (prodOffers.filter((o) => o.flyerRef === f).length) >= byFlyerRaw.get(f).filter((r) => buildOffer(r, { store: 'a', region: 'c', source: 'd', detectedAt: 'x' }) && (r.validTo || '') >= new Date().toISOString().slice(0, 10)).length * 0.9);
  console.log(`  other current flyers appear ${otherFlyersFull ? 'FULL' : 'ALSO PARTIAL'} in production (H5 truncation-within-one-flyer ${otherFlyersFull ? 'plausible' : 'less likely'}).`);
  console.log(`  detectedAt uniformity: ${new Set(survivors.map((o) => o.detectedAt)).size} distinct -> ${new Set(survivors.map((o) => o.detectedAt)).size === 1 ? 'ONE ingest run first-inserted all survivors' : 'multiple runs'}.`);
  console.log(`  missing-priced-now=${missingPricedNow}: if high, D4D now prices ids that prod lacks -> H6 (ingested before D4D finished publishing/pricing) OR a truncated write.`);
}

main().catch((e) => { console.error(`shortfall census failed: ${e.message}`); console.error(e.stack); process.exit(1); });
