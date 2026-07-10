// debug/hotspot-api-census.mjs — measures the API READ stage of the hotspot
// runtime path (D1/KV -> getHotspotsDoc -> GET /brochures/hotspots), using the
// REAL route handler and the REAL storage round-trip. NOT part of the Worker.
//
// The join census (debug/hotspot-join-census.mjs) proved the join is lossless
// at INGEST time. This harness proves whether the READ PATH — stored
// hotspots.json in KV -> JSON round-trip -> byFlyer join -> engine.js route ->
// JSON response body — preserves those counts, by exercising it end to end:
//
//   1. real ingest (pipeline.js) of the live Al Madina flyers into a local
//      ObjectStore (fs) + MetadataStore (mem) -> writes real hotspots.json to KV
//   2. real offers ingest (offers/ingest.js) into a local OfferStore (mem)
//   3. GET /brochures/hotspots?id=<held id> through the REAL handleRequest
//      (engine.js) -> parse the Response BODY the viewer would receive
//   4. for page 6 report: spots the API returned, offers in the map, and how
//      many of those spots have a matching offer (== clickable-capable)
//
// The local stores mirror the D1/R2 interfaces byte-for-byte (getById, byFlyer,
// objectStore.get) so the ONLY thing not-production here is that the stored
// snapshot is FRESH (a clean ingest), not production's possibly-stale KV/D1.
// That is exactly the point: a fresh, healthy snapshot shows what the API
// SHOULD return, isolating any production shortfall to stale stored state.
//
// Usage (needs egress to d4donline.com -> run in CI):
//   node debug/hotspot-api-census.mjs [--store almadina] [--page 6]

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest, ingestAll } from '../src/engine.js';
import { createPipeline } from '../src/pipeline.js';
import { ingestOffers } from '../src/offers/ingest.js';
import { createD4dOffersSource } from '../src/offers/d4dOffers.js';
import {
  createFsObjectStore,
  createMemoryMetadataStore,
  createMemoryOfferStore,
  createMemoryHistoryStore,
} from '../src/storage/local.js';
import { d4dStoreProviders } from '../src/providers/d4dStores.js';

const args = process.argv.slice(2);
const opt = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] != null ? args[i + 1] : d; };
const storeId = opt('store', 'almadina');
const detailPage = Number(opt('page', '6')); // 1-based
const region = 'central';

const provider = d4dStoreProviders.find((p) => p.id === storeId);
if (!provider) { console.error(`unknown store '${storeId}'`); process.exit(2); }

const DATA_DIR = mkdtempSync(join(tmpdir(), 'hotspot-api-'));
const objectStore = createFsObjectStore(DATA_DIR);
const metadataStore = createMemoryMetadataStore();
const offerStore = createMemoryOfferStore();
const ctx = {
  registry: { [storeId]: provider },
  objectStore,
  metadataStore,
  pipeline: createPipeline({ objectStore, metadataStore }),
  offerStore,
  offersSource: createD4dOffersSource(),
  historyStore: createMemoryHistoryStore(),
  ingestSecret: 'dev',
};

async function main() {
  // 1. brochure ingest — paced convergence (per-run page budget is 36, the
  //    32-page flyer plus siblings won't all fit one run; the cron fires days
  //    apart, so a few paced runs mirror steady state).
  console.log(`ingesting brochures for ${storeId} (paced convergence) ...`);
  for (let i = 1; i <= 6; i++) {
    const r = await ingestAll(ctx, { store: storeId });
    const t = r.totals;
    console.log(`  run ${i}: new=${t.new} deduped=${t.deduped} failed=${t.failed} detected=${t.detected}`);
    if (t.failed && r.targets[0]?.errors?.length) console.log(`    errors: ${JSON.stringify(r.targets[0].errors)}`);
    if (t.new === 0 && t.detected > 0 && t.deduped === t.detected) break;
    await new Promise((res) => setTimeout(res, 2500));
  }

  // 2. offers ingest (one company-wide pull, like production) — now ATOMIC
  //    (stage -> validate -> promote). With no subrequest limit locally it
  //    completes and promotes the whole set; a partial write could never become
  //    visible (see src/offers-atomic.test.mjs).
  const offRep = await ingestOffers(ctx, { store: storeId });
  console.log(`offers ingest: ${JSON.stringify(offRep.totals)}`);
  if (offRep.totals.failed) {
    console.error('offers ingest reported a failure — aborting verification');
    process.exit(1);
  }

  // 3. every held images brochure -> real GET /brochures/hotspots
  const held = await metadataStore.getCurrent(storeId, region);
  console.log(`\nheld current brochures for ${storeId}/${region}: ${held.length}`);
  for (const row of held) {
    if (row.source_type !== 'images') continue;
    const res = await handleRequest(new Request(`http://local/brochures/hotspots?id=${encodeURIComponent(row.id)}`), ctx);
    const doc = await res.json();
    const pages = doc.pages || [];
    const offerKeys = new Set(Object.keys(doc.offers || {}));
    const totalSpots = pages.reduce((n, p) => n + (p.spots?.length || 0), 0);
    const totalClickable = pages.reduce(
      (n, p) => n + (p.spots || []).filter((s) => offerKeys.has(String(s.offerId))).length, 0);

    console.log(`\n=== ${row.id}`);
    console.log(`    source_url=${row.source_url}`);
    console.log(`    HTTP ${res.status} · flyerRef=${doc.flyerRef} · pages=${pages.length} · offers in map=${offerKeys.size}`);
    console.log(`    API total spots=${totalSpots} · with-matching-offer=${totalClickable}`);

    const pg = pages.find((p) => p.index === detailPage - 1);
    if (pg) {
      const withOffer = pg.spots.filter((s) => offerKeys.has(String(s.offerId))).length;
      console.log(`    >>> PAGE ${detailPage} (ordinal ${detailPage - 1}): API returned ${pg.spots.length} spots, ${withOffer} have a matching offer, ${pg.spots.length - withOffer} do not`);
      // list any spot the API returned WITHOUT an offer (the would-be inert ones)
      const orphans = pg.spots.filter((s) => !offerKeys.has(String(s.offerId)));
      if (orphans.length) console.log(`        orphan spot offerIds (returned but no offer): ${orphans.map((s) => s.offerId).join(', ')}`);
    } else {
      console.log(`    >>> PAGE ${detailPage}: not present in this brochure`);
    }
  }
  console.log('\nNOTE: storage here is a FRESH ingest, not production KV/D1. These are the counts the API');
  console.log('      SHOULD return for a healthy snapshot; a production shortfall = stale stored state.');
}

main().catch((e) => { console.error(`api census failed: ${e.message}`); console.error(e.stack); process.exit(1); });
