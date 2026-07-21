// enrich.test.mjs — offline, dependency-free tests for Vision Enrichment
// (offers/enrich.js + the /offers overlay). Run with:
//   node brochure-engine/src/enrich.test.mjs   (repo root)
//
// Guards the milestone's promises:
//  • the gate admits only deriveNames-defeated offers that still have a crop,
//  • the parser survives fenced/garbage replies and STRIPS price fragments,
//  • corroboration separates readings from hallucinations (spike-calibrated),
//  • servable() enforces the corroboration floor, never model confidence,
//  • the drain stores every verdict (including declines), stops the batch on
//    transport errors WITHOUT storing the failed offer, and prunes orphans,
//  • /offers overlays servable names (they feed ranking + display, flagged
//    `enriched`) and never serves uncorroborated ones.

import {
  needsEnrichment,
  parseEnrichReply,
  corroboration,
  servable,
  drainEnrichment,
  enrichOffer,
  applyEnrichment,
  CORROBORATION_FLOOR,
} from './offers/enrich.js';
import { handleRequest } from './engine.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

// --- gate ----------------------------------------------------------------------
console.log('gate:');
check('debris + crop -> true', needsEnrichment({ name: null, nameAr: null, imageUrl: 'http://x/i.jpg' }));
check('named (en) -> false', !needsEnrichment({ name: 'Milk', nameAr: null, imageUrl: 'http://x/i.jpg' }));
check('named (ar) -> false', !needsEnrichment({ name: null, nameAr: 'حليب', imageUrl: 'http://x/i.jpg' }));
check('no crop -> false', !needsEnrichment({ name: null, nameAr: null, imageUrl: null }));

// --- parser --------------------------------------------------------------------
console.log('parser:');
const good = parseEnrichReply('{"name_en":"Halah Sunflower Oil","name_ar":"زيت هالة","brand":"Halah","size":"1.5L","confidence":0.9}');
check('plain JSON parses', good && good.name === 'Halah Sunflower Oil' && good.size === '1.5L');
const fenced = parseEnrichReply('```json\n{"name_en":"Milk","name_ar":null,"brand":null,"size":null,"confidence":0.5}\n```');
check('fenced JSON parses', fenced && fenced.name === 'Milk' && fenced.nameAr === null);
check('garbage -> null', parseEnrichReply('sorry, I cannot') === null);
check('both names null -> null', parseEnrichReply('{"name_en":null,"name_ar":null,"confidence":1}') === null);
const priced = parseEnrichReply('{"name_en":"Rice 5kg SAR 19.99","name_ar":"ارز 19.99 ريال","brand":null,"size":"5kg","confidence":1}');
check('price fragments stripped (en)', priced && !/19|sar/i.test(priced.name));
check('price fragments stripped (ar)', priced && !/19|ريال/.test(priced.nameAr));
check('confidence clamped', parseEnrichReply('{"name_en":"X y z","confidence":7}').confidence === 1);

// --- corroboration + servable --------------------------------------------------
console.log('corroboration:');
const ocr = 'fresh kg 499 379 خروف تنزاني كامل tanzanian mutton whole 7 to9 kg nesto';
const read = { name: 'Tanzanian Mutton', nameAr: 'خروف تنزاني', brand: null };
check('real reading corroborates', corroboration(read, ocr) >= CORROBORATION_FLOOR);
const halluc = { name: 'Cucumber', nameAr: 'خيار', brand: null };
check('hallucination scores 0', corroboration(halluc, ocr) === 0);
check('empty OCR -> 0 (never a free pass)', corroboration(read, '') === 0);
check('servable above floor', servable({ name: 'X', name_ar: null, corroboration: 0.5 }));
check('not servable below floor', !servable({ name: 'X', name_ar: null, corroboration: 0.1 }));
check('not servable without names', !servable({ name: null, name_ar: null, corroboration: 1 }));
check('high confidence alone never serves', !servable({ name: 'X', name_ar: null, confidence: 0.98, corroboration: 0 }));

// --- in-memory twins -----------------------------------------------------------
function memEnrichStore(seed = []) {
  const rows = new Map(seed.map((r) => [r.id, r]));
  let debris = [];
  return {
    rows,
    setDebris(d) {
      debris = d;
    },
    async listDebris({ limit = 15 } = {}) {
      return debris.filter((d) => !rows.has(d.id)).slice(0, limit);
    },
    async countDebris() {
      return debris.filter((d) => !rows.has(d.id)).length;
    },
    async upsertMany(list) {
      for (const r of list) rows.set(r.id, r);
      return { stored: list.length };
    },
    async getForIds(ids) {
      const m = new Map();
      for (const id of ids) if (rows.has(id)) m.set(id, rows.get(id));
      return m;
    },
    async pruneOrphans() {
      return 0;
    },
  };
}

// A fake fetch: image URLs yield bytes; the Mistral URL yields the scripted
// reply for the offer whose crop was fetched last (calls are sequential).
function fakeFetch(replies) {
  let lastImg = null;
  const calls = { images: 0, api: 0 };
  const impl = async (url) => {
    if (String(url).startsWith('https://api.mistral.ai/')) {
      calls.api += 1;
      const r = replies[lastImg];
      if (r === 'TRANSPORT') return { ok: false, status: 429, text: async () => 'rate limited' };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: r } }] }),
      };
    }
    calls.images += 1;
    lastImg = String(url);
    return {
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };
  impl.calls = calls;
  return impl;
}

// --- drain ---------------------------------------------------------------------
console.log('drain:');
{
  const store = memEnrichStore();
  store.setDebris([
    { id: 'a:1', image_url: 'http://cdn/a.jpg', search_text: 'tanzanian mutton whole kg' },
    { id: 'a:2', image_url: 'http://cdn/b.jpg', search_text: 'debris only' },
  ]);
  const replies = {
    'http://cdn/a.jpg': '{"name_en":"Tanzanian Mutton","name_ar":"خروف تنزاني","brand":null,"size":"7-9kg","confidence":0.98}',
    'http://cdn/b.jpg': '{"name_en":null,"name_ar":null,"confidence":0}',
  };
  const f = fakeFetch(replies);
  globalThis.fetch = f; // drain -> enrichOffer uses global fetch by default
  const report = await drainEnrichment(
    { enrichStore: store, mistralKey: 'k' },
    { currentOn: '2026-07-18', limit: 15 },
  );
  check('one enriched, one declined', report.enriched === 1 && report.declined === 1);
  check('both verdicts stored', store.rows.size === 2);
  check('enriched row corroborated', store.rows.get('a:1').corroboration >= CORROBORATION_FLOOR);
  check('declined row has null names', store.rows.get('a:2').name == null && store.rows.get('a:2').name_ar == null);
  const again = await drainEnrichment({ enrichStore: store, mistralKey: 'k' }, { currentOn: '2026-07-18' });
  check('attempted offers never re-drain (incl. declines)', again.scanned === 0 && f.calls.api === 2);
}
{
  const store = memEnrichStore();
  store.setDebris([
    { id: 'b:1', image_url: 'http://cdn/x.jpg', search_text: 'x' },
    { id: 'b:2', image_url: 'http://cdn/y.jpg', search_text: 'y' },
  ]);
  globalThis.fetch = fakeFetch({ 'http://cdn/x.jpg': 'TRANSPORT' });
  // maxRateRetries:0 exhausts the single key immediately (no real backoff sleeps
  // in the test) — a PERSISTENT 429 with no standby stops the batch, exactly the
  // production wall the resilient drain still stops on.
  const report = await drainEnrichment({ enrichStore: store, mistralKey: 'k' }, { currentOn: '2026-07-18', maxRateRetries: 0 });
  check('persistent 429 stops the batch', report.failed === 1 && report.scanned === 2);
  check('failed offer NOT stored (retries later)', store.rows.size === 0);
  check('provider rate-limit signal captured', report.providerLimit && report.providerLimit.status === 429);
}
// Resilient drain (Vision M2 §3): an ISOLATED per-offer error (bad crop) is
// skipped and the batch CONTINUES — one bad tile never strands the rest.
{
  const store = memEnrichStore();
  store.setDebris([
    { id: 'c:1', image_url: 'http://cdn/bad.jpg', search_text: 'x' },
    { id: 'c:2', image_url: 'http://cdn/ok.jpg', search_text: 'tanzanian mutton whole kg' },
  ]);
  const impl = async (url) => {
    const u = String(url);
    if (u === 'http://cdn/bad.jpg') return { ok: false, status: 404, text: async () => 'gone', headers: { get: () => null } };
    if (u.startsWith('https://api.mistral.ai/')) {
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"name_en":"Tanzanian Mutton","name_ar":"خروف تنزاني","confidence":0.9}' } }] }) };
    }
    return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  globalThis.fetch = impl;
  const report = await drainEnrichment({ enrichStore: store, mistralKey: 'k' }, { currentOn: '2026-07-18' });
  check('isolated crop failure is skipped, batch continues', report.failed === 1 && report.enriched === 1);
  check('good offer after a bad one still stored', store.rows.has('c:2') && !store.rows.has('c:1'));
}

// --- enrichOffer respects the gate --------------------------------------------
{
  const res = await enrichOffer({ id: 'x', name: 'Named', nameAr: null, imageUrl: 'http://c/i.jpg' }, { apiKey: 'k' });
  check('enrichOffer refuses non-debris offers', res === null);
}

// --- applyEnrichment (the ONE shared overlay) -----------------------------------
console.log('applyEnrichment:');
{
  const row = (over = {}) => ({
    search_text: 'ocr haystack', e_name: 'Vision Name', e_name_ar: 'اسم',
    e_corroboration: 0.8, e_match_text: 'vision haystack', ...over,
  });
  const o1 = { name: null, nameAr: null };
  check('servable: overlays names, flags, returns vision haystack',
    applyEnrichment(o1, row()) === 'vision haystack' &&
    o1.name === 'Vision Name' && o1.nameAr === 'اسم' && o1.enriched === true);
  const o2 = { name: 'OCR Name', nameAr: null };
  check('below-floor: OCR kept, OCR haystack returned',
    applyEnrichment(o2, row({ e_corroboration: 0.1 })) === 'ocr haystack' &&
    o2.name === 'OCR Name' && !o2.enriched);
  const o3 = { name: 'OCR Name' };
  check('no enrichment columns: pure OCR fallback',
    applyEnrichment(o3, row({ e_name: null, e_name_ar: null, e_corroboration: null, e_match_text: null })) === 'ocr haystack' &&
    o3.name === 'OCR Name' && !o3.enriched);
  const o4 = { name: null };
  check('servable but legacy NULL match_text: names overlay, OCR haystack',
    applyEnrichment(o4, row({ e_match_text: null })) === 'ocr haystack' && o4.enriched === true);
}

// --- /offers overlay (end-to-end through handleRequest) ------------------------
console.log('overlay:');
{
  const offerRow = (id, over = {}) => ({
    id, store: 's', region: 'central', source: 'd4d', offer_id: id,
    flyer_ref: null, page_ref: null, edition: null, name: null, name_ar: null,
    price: 9.99, old_price: null, currency: 'SAR', category_id: null,
    category: null, image_url: 'http://c/i.jpg', source_url: null,
    valid_from: null, valid_to: '2099-01-01', detected_at: 'now',
    search_text: 'tanzanian mutton whole kg', identity: null, brand_slug: null,
    ...over,
  });
  // Rows as the vision-canonical offerStore.search returns them: the aliased
  // e_* enrichment columns ride each row (ENRICH_ROW_COLS).
  const rows = [
    offerRow('e:good', {
      e_name: 'Tanzanian Mutton', e_name_ar: 'خروف تنزاني',
      e_corroboration: 0.8, e_match_text: 'tanzanian mutton',
    }),
    offerRow('e:bad', {
      e_name: 'Cucumber', e_name_ar: 'خيار',
      e_corroboration: 0, e_match_text: 'cucumber',
    }),
  ];
  const ctx = {
    registry: {},
    offerStore: { search: async () => rows },
  };
  const res = await handleRequest(new Request('http://x/offers?q=mutton'), ctx);
  const body = await res.json();
  const good = body.offers.find((o) => o.id === 'e:good');
  const bad = body.offers.find((o) => o.id === 'e:bad');
  check('servable enrichment overlays name + flag', good && good.name === 'Tanzanian Mutton' && good.enriched === true);
  check('enriched name reaches ranking (name match outranks)', body.offers[0].id === 'e:good');
  check('uncorroborated enrichment never serves a name', !bad || (bad.name == null && !bad.enriched));
  const noEnrich = await handleRequest(new Request('http://x/offers?q=mutton'), {
    ...ctx,
    offerStore: { search: async () => rows.map((r) => ({ ...r, e_name: null, e_name_ar: null, e_match_text: null, e_corroboration: null })) },
  });
  const nb = await noEnrich.json();
  check('no enrichment rows -> exact OCR fallback behavior', nb.offers.every((o) => o.name == null && !o.enriched));
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll enrichment tests passed.');
