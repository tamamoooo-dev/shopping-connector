// debug/hotspot-join-census.mjs — measures the HOTSPOT -> OFFER JOIN, the stage
// AFTER parsing, page by page. NOT part of the deployed Worker.
//
// Parsing is settled (debug/hotspot-census.mjs): page 6 imports ~20-28 spots.
// This harness answers the next question with MEASUREMENT, not inference:
// of those spots, how many join to an offers row and become clickable, and
// for every one that does NOT, WHY.
//
// It reproduces the runtime join EXACTLY, using the same production modules:
//
//   spot.offerId            = id_product from data-coords-json   (hotspots.js)
//   offers[r.offer_id]      = String(idoffer_special)            (d4dOffers/contract)
//   loaded set = byFlyer(store, region, flyerRefFromUrl(source_url))
//              = offers WHERE flyer_ref == leaflet-id-from-URL
//   flyer_ref (stored)      = String(idoffer_company)            (d4dOffers.js toRaw)
//   a spot is CLICKABLE iff offers[spot.offerId] exists          (getHotspotsDoc)
//
// So a spot fails the join for exactly one measurable reason, and this harness
// classifies each failure into the taxonomy the investigation asked for:
//
//   different-flyer_ref   its offer exists but idoffer_company != this leaflet
//                         id -> byFlyer never loads it (edition/flyer mismatch)
//   dropped-buildOffer    its offer exists on THIS flyer but buildOffer returned
//                         null (price gate) -> never written to D1
//   absent-from-source    its id_product is in no offers-API record at all
//   normalization         present & would-store, but string/space coercion makes
//                         the key not equal (measured by exact-string compare)
//   OK                    joins -> clickable
//
// Usage (needs egress to d4donline.com — run in CI, not the sandbox):
//   node debug/hotspot-join-census.mjs --store al-madina-hypermarket-212 [--city riyadh] [--page 6]
//   node debug/hotspot-join-census.mjs --leaflet <url> --company 212 [--page 6]

import { parseHotspots, remapHotspotPages, flyerRefFromUrl } from '../src/hotspots.js';
import { extractOffers, parseLeaflet } from '../src/collectors/adapters/d4d.js';
import { createD4dOffersSource } from '../src/offers/d4dOffers.js';
import { buildOffer, offerToRow } from '../src/offers/contract.js';

const HOST = 'https://d4donline.com';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
};
const store = opt('store');
const city = opt('city', 'riyadh');
const leafletUrl = opt('leaflet');
const companyArg = opt('company');
const detailPage = Number(opt('page', '6')); // 1-based

const UA = { 'User-Agent': 'BrochureEngine/0.1 (+https://github.com/tamamoooo-dev)', Accept: '*/*' };
async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// company id from a D4D store key ("al-madina-hypermarket-212" -> "212")
function companyFromStoreKey(key) {
  const m = /-(\d+)$/.exec(String(key || ''));
  return m ? m[1] : null;
}

// Build the exact D1-side picture the runtime would hold after an offers ingest:
// every raw item -> buildOffer -> offerToRow, keeping the provenance we need to
// explain a failed join (which flyer it claims, whether the price gate dropped
// it, the raw id types).
function ingestOffers(rawItems, { store: st, region }) {
  const stored = new Map(); // offer_id (string) -> row
  const droppedByGate = new Map(); // offer_id (string) -> raw (buildOffer==null)
  const rawById = new Map(); // offer_id (string) -> { flyer_ref, rawIdType, rawFlyerType }
  for (const raw of rawItems) {
    const idStr = String(raw.offerId ?? '');
    if (idStr) {
      rawById.set(idStr, {
        flyerRef: raw.flyerRef != null ? String(raw.flyerRef) : null,
        rawIdType: typeof raw.offerId,
        rawFlyerType: typeof raw.flyerRef,
        price: raw.price,
        wasPrice: raw.wasPrice,
      });
    }
    const offer = buildOffer(raw, { store: st, region, source: 'd4d', detectedAt: new Date().toISOString() });
    if (!offer) {
      if (idStr) droppedByGate.set(idStr, raw);
      continue;
    }
    stored.set(String(offer.offerId), offerToRow(offer));
  }
  return { stored, droppedByGate, rawById };
}

// The runtime's byFlyer + offers-map build (getHotspotsDoc), reproduced.
function offersForLeaflet(stored, flyerRef) {
  const offers = {};
  for (const [, r] of stored) {
    if (String(r.flyer_ref) === String(flyerRef)) offers[r.offer_id] = r;
  }
  return offers;
}

function classify(offerId, flyerRef, stored, offersForThis, droppedByGate, rawById) {
  if (Object.prototype.hasOwnProperty.call(offersForThis, offerId)) return { outcome: 'OK' };
  // Not in this leaflet's loaded set. Why?
  const storedRow = stored.get(offerId);
  if (storedRow) {
    // it IS a stored offer, just not under this flyer_ref
    return {
      outcome: 'different-flyer_ref',
      detail: `offer stored with flyer_ref=${storedRow.flyer_ref}, leaflet needs ${flyerRef}`,
    };
  }
  if (droppedByGate.has(offerId)) {
    const raw = droppedByGate.get(offerId);
    return { outcome: 'dropped-buildOffer', detail: `price=${JSON.stringify(raw.price)} was=${JSON.stringify(raw.wasPrice)} (failed price gate)` };
  }
  const rawInfo = rawById.get(offerId);
  if (rawInfo) {
    // present in raw source but neither stored nor gate-dropped — shouldn't
    // happen; surface it rather than infer
    return { outcome: 'normalization', detail: `raw present (flyer_ref=${rawInfo.flyerRef}) but not stored/dropped — key coercion?` };
  }
  return { outcome: 'absent-from-source', detail: 'id_product in no offers-API record' };
}

async function censusLeaflet(html, offer, rawItems) {
  const region = 'central';
  const brochure = parseLeaflet(html, offer);
  const flyerRef = flyerRefFromUrl(offer.url);
  const { stored, droppedByGate, rawById } = ingestOffers(rawItems, { store: store || 'store', region });
  const offersForThis = offersForLeaflet(stored, flyerRef);

  console.log(`\n=== ${offer.url}`);
  console.log(`    title="${brochure.title}"  flyerRefFromUrl=${flyerRef}`);
  console.log(`    offers-API records for company: ${rawItems.length} · survived buildOffer: ${stored.size} · dropped by price gate: ${droppedByGate.size}`);
  console.log(`    offers loaded for THIS leaflet (byFlyer flyer_ref==${flyerRef}): ${Object.keys(offersForThis).length}`);

  // distinct idoffer_company values across the offers API, so a flyer_ref
  // mismatch is visible as data, not asserted
  const flyerRefHist = new Map();
  for (const [, info] of rawById) flyerRefHist.set(info.flyerRef, (flyerRefHist.get(info.flyerRef) || 0) + 1);
  const topFlyerRefs = [...flyerRefHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`    distinct idoffer_company (stored as flyer_ref) across API: ${flyerRefHist.size} -> ${topFlyerRefs.map(([k, v]) => `${k}:${v}`).join(' ')}`);

  console.log('');
  console.log('  page(1-based) ord | hotspots  clickable  failed | failure breakdown');
  console.log('  --------------------------------------------------------------------------------');
  let tot = { spots: 0, ok: 0, fail: 0 };
  const failTax = {};
  for (const pg of brochure.hotspots) {
    const outcomes = pg.spots.map((s) => classify(String(s.offerId), flyerRef, stored, offersForThis, droppedByGate, rawById));
    const ok = outcomes.filter((o) => o.outcome === 'OK').length;
    const fail = outcomes.length - ok;
    const perPageTax = {};
    for (const o of outcomes) if (o.outcome !== 'OK') perPageTax[o.outcome] = (perPageTax[o.outcome] || 0) + 1;
    for (const [k, v] of Object.entries(perPageTax)) failTax[k] = (failTax[k] || 0) + v;
    tot.spots += outcomes.length; tot.ok += ok; tot.fail += fail;
    const marker = pg.index === detailPage - 1 ? ' <== page ' + detailPage : '';
    console.log(
      `  ${String(pg.index + 1).padStart(6)}       ${String(pg.index).padStart(3)} | ` +
      `${String(outcomes.length).padStart(8)}  ${String(ok).padStart(9)}  ${String(fail).padStart(6)} | ` +
      `${Object.entries(perPageTax).map(([k, v]) => `${k}:${v}`).join(' ')}${marker}`,
    );
  }
  console.log('  --------------------------------------------------------------------------------');
  console.log(`  TOTAL             | ${String(tot.spots).padStart(8)}  ${String(tot.ok).padStart(9)}  ${String(tot.fail).padStart(6)} | ${Object.entries(failTax).map(([k, v]) => `${k}:${v}`).join(' ')}`);

  // Follow EVERY hotspot on the page under investigation, end to end.
  const src = detailPage - 1;
  const pg = brochure.hotspots.find((p) => p.index === src);
  console.log(`\n  --- page ${detailPage} (ordinal ${src}): every hotspot followed to its offer ---`);
  if (!pg) {
    console.log('  (no hotspots on this page for this leaflet)');
  } else {
    for (const s of pg.spots) {
      const id = String(s.offerId);
      const c = classify(id, flyerRef, stored, offersForThis, droppedByGate, rawById);
      const row = offersForThis[id];
      const label = row ? ` -> "${row.name || row.name_ar || '(no name)'}" price=${row.price}` : '';
      console.log(`  spot id_product=${id}  bbox=(${s.x},${s.y},${s.w},${s.h})  ${c.outcome}${c.detail ? ` [${c.detail}]` : ''}${label}`);
    }
  }
  return { flyerRef, tot, failTax };
}

async function main() {
  const src = createD4dOffersSource();
  let leaflets = [];
  let companyId = companyArg;

  if (leafletUrl) {
    if (!companyId) { console.error('--leaflet requires --company <id>'); process.exit(2); }
    const html = await fetchText(leafletUrl);
    leaflets = [{ html, offer: { id: 0, slug: 'cli', url: leafletUrl, expiry: null } }];
  } else if (store) {
    companyId = companyId || companyFromStoreKey(store);
    const storeUrl = `${HOST}/en/saudi-arabia/${city}/offers/${store}`;
    console.log(`store page: ${storeUrl}  ·  company=${companyId}`);
    const html = await fetchText(storeUrl);
    const today = new Date().toISOString().slice(0, 10);
    const offers = extractOffers(html, store, city)
      .filter((o) => !o.expiry || o.expiry >= today)
      .sort((a, b) => b.id - a.id)
      .slice(0, 4);
    console.log(`current leaflets: ${offers.length}`);
    for (const o of offers) leaflets.push({ html: await fetchText(o.url), offer: o });
  } else {
    console.error('usage: node debug/hotspot-join-census.mjs --store <d4d-key> [--page 6]');
    process.exit(2);
  }

  // ONE offers pull for the whole company (exactly what the ingest does).
  console.log(`\nfetching offers API for company ${companyId} ...`);
  const rawItems = await src.listOffers(companyId, { city, storePageSlug: store || undefined });
  console.log(`offers API returned ${rawItems.length} product records`);

  for (const l of leaflets) await censusLeaflet(l.html, l.offer, rawItems);
}

main().catch((err) => {
  console.error(`join census failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
