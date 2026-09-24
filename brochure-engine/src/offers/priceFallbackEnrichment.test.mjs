// priceFallbackEnrichment.test.mjs — every reading yields everything it can
// (user directive 2026-09-24). The price fallback's readings use the SAME full
// extraction prompt as Stage 1; when a price is accepted, the agreeing reading
// is committed through the normal Stage-1 path, so the product gets its name,
// brand and size with NO extra Vision call, and is queued for the Stage-2
// re-check. Price is the only must; brand and size never block. Real SQL.

import assert from 'node:assert/strict';
import { drainPriceFallback } from './priceFallback.js';
import { drainEnrichment, MISTRAL_URL } from './enrich.js';
import { pricePendingRow } from './contract.js';
import { buildMistralPools, createKeyChain } from './mistralKeys.js';
import { createD1OfferStore } from '../storage/offerStore.js';
import { createD1EnrichStore } from '../storage/enrichStore.js';
import { createSqliteD1 } from '../storage/testSqliteD1.mjs';

const today = new Date().toISOString().slice(0, 10);
const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const CROP = (id) => `https://cdn.test/${id}.jpg`;

// Two products: one full reading (brand + size), one with neither.
const replies = {
  97714464: {
    name_en: 'Sadia Frozen Chicken Breast 900 g', name_ar: 'صدور دجاج ساديا المجمدة',
    brand: 'Sadia', current_price: 21.95, old_price: 27.5, unit: 'g',
    package_size: '900 g', quantity: null, package_type: 'pack', attributes: ['frozen'], confidence: 0.99,
  },
  97714467: {
    name_en: 'Tilapia Fish', name_ar: 'سمك بلطي',
    brand: null, current_price: 19.96, old_price: null, unit: null,
    package_size: null, quantity: null, package_type: null, attributes: [], confidence: 0.9,
  },
};
const descriptions = {
  97714464: 'sadia frozen chicken breast 900g صدور دجاج ساديا 27.50 21.95',
  97714467: 'tilapia fish سمك بلطي 19.96',
};

let visionCalls = 0;
const fetchImpl = async (url, init) => {
  if (String(url).startsWith('https://cdn.test/')) {
    return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  }
  assert.equal(url, MISTRAL_URL);
  visionCalls += 1;
  const body = JSON.parse(init.body);
  const b64 = body.messages[0].content[1].image_url.split(',')[1];
  assert.ok(b64, 'the crop rides in the request');
  // Which product: the harness serves one item per drain call.
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(replies[current]) } }] }), {
    headers: { 'content-type': 'application/json' },
  });
};
let current = null;

const { db, raw, close } = createSqliteD1(['schema.sql']);
const offerStore = createD1OfferStore(db);
const enrichStore = createD1EnrichStore(db);
const keyChain = createKeyChain(buildMistralPools({ MINISTRAL_14B_API_KEY_1: 'k1' }).ministral14, { log: () => {} });

for (const id of Object.keys(replies)) {
  await offerStore.upsertPricePending([pricePendingRow({
    offerId: id, flyerRef: '776709', pageRef: 'p1', price: '0.000', wasPrice: '0.000',
    description: descriptions[id], imageUrl: CROP(id), validFrom: today, validTo: nextWeek, storeWords: ['Aljazera'],
  }, { store: 'aljazera', region: 'central', source: 'd4d', detectedAt: `${today}T06:00:00.000Z` })]);
}

const enriched = {};
for (const id of Object.keys(replies)) {
  current = id;
  const before = visionCalls;
  const report = await drainPriceFallback({ offerStore, keyChain }, {
    model: 'ministral-14b-2512', currentOn: today, limit: 1, fetchImpl, failover: { sleepImpl: async () => {} },
  });
  assert.equal(report.accepted, 1, `${id}: price accepted`);
  const readingsForPrice = visionCalls - before;
  assert.ok(Object.keys(report.observations).length === 1, 'the agreeing reading is handed over');
  assert.ok(!('observations' in JSON.parse(JSON.stringify(report))), 'never serialized into the route response');

  // The route's composition (engine.js POST /price-fallback).
  const e = await drainEnrichment({ enrichStore, keyChain }, {
    limit: 1, currentOn: today, queueOfferIds: Object.keys(report.observations),
    observations: report.observations, strategy: 'vision-first', model: 'ministral-14b-2512', fetchImpl,
  });
  assert.equal(visionCalls - before, readingsForPrice, `${id}: NO extra Vision call for the name, brand and size`);
  assert.equal(e.enriched, 1, `${id}: enriched from the price reading`);
  enriched[id] = raw.prepare('SELECT name, brand, size FROM offer_enrichments WHERE id = ?').get(`aljazera:central:d4d:${id}`);
}

// Name + price are the must; brand and size come along when the reading has them.
assert.deepEqual([enriched[97714464].name, enriched[97714464].brand, enriched[97714464].size],
  ['Sadia Frozen Chicken Breast 900 g', 'Sadia', '900 g']);
assert.equal(enriched[97714467].name, 'Tilapia Fish', 'published with no brand and no size');
assert.equal(enriched[97714467].brand, null);
assert.equal(enriched[97714467].size, null);

// Stage 1 will not read these crops again, and Stage 2 re-checks them later.
const attempts = raw.prepare(`SELECT COUNT(*) n FROM offer_extraction_attempts WHERE source = 'vision'`).get().n;
assert.equal(attempts, 2, 'a Vision attempt is recorded, so Stage 1 skips these offers');
assert.equal((await enrichStore.listDebris({ currentOn: today, limit: 50 })).length, 0, 'nothing left for Stage 1');
const queued = raw.prepare(`SELECT COUNT(*) n FROM offer_vision_verification_queue WHERE status = 'queued'`).get().n;
assert.equal(queued, 2, 'both queued for the Stage-2 re-check');
close();

console.log('priceFallbackEnrichment.test: all passed');
