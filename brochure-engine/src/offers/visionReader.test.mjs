// visionReader.test.mjs — Haiku on the PC reads Stage-1 Vision, Mistral is
// the backup, ONE reading a crop (owner, 2026-11-19). Real SQL for the saving
// path: a posted reading goes through the Stage-1 drain without any crop
// fetch or Mistral call, and Stage 2 never re-reads it.
import assert from 'node:assert/strict';
import {
  DEFAULT_VISION_READER, HAIKU_VISION_MODEL, VISION_READER_BATCH_TEMPLATE, VISION_READER_HOLD_MAX_MS,
  VISION_READER_ON_MS, createVisionReaderState, normalizeVisionReader, observationsFromReadings,
  oneReadingStatements, readVisionReaderSetting, setVisionReaderLimit, visionReaderGate,
  visionReaderPrompt, whoReadsVision, writeVisionReaderSetting,
} from './visionReader.js';
import { ENRICHMENT_VISION_PROMPT } from './enrichmentPrompt.js';
import { drainEnrichment } from './enrich.js';
import { handleRequest } from '../engine.js';
import { buildOffer, offerToRow } from './contract.js';
import { createKeyChain } from './mistralKeys.js';
import { createD1OfferStore } from '../storage/offerStore.js';
import { createD1EnrichStore } from '../storage/enrichStore.js';
import { STAGE_TWO_MAX_ATTEMPTS } from '../storage/visionVerificationStore.js';
import { createSqliteD1 } from '../storage/testSqliteD1.mjs';

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed += 1; console.log(`  ok  ${msg}`); };

console.log('who reads Stage 1:');
{
  const now = new Date('2026-11-19T12:00:00.000Z');
  const ago = (ms) => new Date(now.getTime() - ms).toISOString();
  const ahead = (ms) => new Date(now.getTime() + ms).toISOString();
  ok(DEFAULT_VISION_READER === 'haiku', 'Haiku is the default (owner)');
  ok(whoReadsVision({ mode: 'mistral', pc: { seen_at: ago(1000) }, now }).reader === 'mistral', 'the switch on Mistral: Mistral, even with the PC on');
  ok(whoReadsVision({ mode: 'haiku', pc: null, now }).why === 'pc-off', 'Haiku chosen, PC never seen: Mistral reads (pc-off)');
  ok(whoReadsVision({ mode: 'haiku', pc: { seen_at: ago(VISION_READER_ON_MS + 1000) }, now }).reader === 'mistral', 'PC silent past the window: Mistral reads');
  ok(whoReadsVision({ mode: 'haiku', pc: { seen_at: ago(60_000) }, now }).reader === 'haiku', 'PC asking: Haiku reads');
  const limited = whoReadsVision({ mode: 'haiku', pc: { seen_at: ago(60_000), limited_until: ahead(VISION_READER_HOLD_MAX_MS + 60_000) }, now });
  ok(limited.reader === 'mistral' && limited.why === 'pc-limited', 'Claude limit over 2 h away: Mistral reads');
  const holding = whoReadsVision({ mode: 'haiku', pc: { seen_at: ago(60_000), limited_until: ahead(30 * 60_000) }, now });
  ok(holding.reader === 'haiku' && holding.why === 'pc-holding', 'Claude limit within 2 h: crops wait for Haiku');
  ok(whoReadsVision({ mode: 'haiku', pc: { seen_at: ago(60_000), limited_until: ago(60_000) }, now }).why === 'pc-on', 'a limit already past: Haiku reads');
  ok(normalizeVisionReader(' Mistral ') === 'mistral' && normalizeVisionReader('gpt') === null, 'only haiku | mistral');
}

console.log('the ops switch:');
{
  const objects = new Map();
  const objectStore = {
    async get(key) { return objects.has(key) ? { bytes: objects.get(key) } : null; },
    async put(key, bytes) { objects.set(key, bytes); },
  };
  ok((await readVisionReaderSetting(objectStore)).source === 'default', 'nothing stored: default');
  await writeVisionReaderSetting(objectStore, 'mistral', { by: 'ops', now: new Date('2026-11-19T10:00:00Z') });
  const s = await readVisionReaderSetting(objectStore);
  ok(s.mode === 'mistral' && s.selectedBy === 'ops' && s.source === 'stored', 'a stored choice is read back');
  await assert.rejects(() => writeVisionReaderSetting(objectStore, 'gpt'));
  ok(true, 'an unknown reader is refused');
  objects.set('ops/settings/vision-reader.json', new TextEncoder().encode('{"mode":"other"}'));
  ok((await readVisionReaderSetting(objectStore)).mode === DEFAULT_VISION_READER, 'a damaged record falls back to the default');
}

console.log('the prompt:');
{
  ok(visionReaderPrompt(1) === ENRICHMENT_VISION_PROMPT, 'one crop: the production prompt unchanged');
  const ten = visionReaderPrompt(10);
  ok(ten.includes(ENRICHMENT_VISION_PROMPT) && ten.startsWith('Above are 10 separate flyer crops'), 'ten crops: the same prompt, framed');
  ok(VISION_READER_BATCH_TEMPLATE.replaceAll('{n}', '10') === ten, 'the template the PC fills is the same text');
}

console.log('readings in:');
{
  const obs = observationsFromReadings([
    { id: 'a', reading: { crop: 3, name_en: 'Fairy Lemon', current_price: 5.95 } },
    { id: 'b', reading: 'not an object' },
    { id: '', reading: { name_en: 'x' } },
    { id: 'c', reading: [] },
  ]);
  ok(Object.keys(obs).join() === 'a', 'only readings with an id and one reading object');
  ok(obs.a.model === HAIKU_VISION_MODEL && obs.a.parsed?.name === 'Fairy Lemon', 'a reading becomes a Haiku observation');
  ok(!('crop' in obs.a.parsedObject), 'the batch label is not a reading field');
}

console.log('saving, one reading (real SQL):');
{
  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const { db, raw, close } = createSqliteD1(['schema.sql']);
  const offerStore = createD1OfferStore(db);
  const enrichStore = createD1EnrichStore(db);
  const ids = {};
  for (const [n, desc, price] of [['101', 'fairy lemon 400ml 5.95', 5.95], ['102', 'mixed promo text 9.99', 9.99], ['103', 'cutey cat food 1.5kg 28.99', 28.99]]) {
    const offer = buildOffer({
      offerId: n, flyerRef: 'f1', pageRef: 'p1', price, wasPrice: null, description: desc,
      imageUrl: `https://cdn.test/${n}.jpg`, validFrom: today, validTo: nextWeek, storeWords: ['Makkah'],
    }, { store: 'makkah', region: 'central', source: 'd4d', detectedAt: `${today}T06:00:00.000Z` });
    await offerStore.upsertMany([offerToRow(offer)]);
    ids[n] = offer.id;
  }
  ok((await enrichStore.listDebris({ currentOn: today, limit: 50 })).length === 3, 'three offers wait for Stage 1');

  let fetches = 0;
  const fetchImpl = async () => { fetches += 1; throw new Error('no fetch expected'); };
  const observations = observationsFromReadings([
    { id: ids['101'], reading: { crop: 1, name_en: 'Fairy Lemon Dishwashing Liquid', name_ar: 'فيري ليمون', brand: 'Fairy', current_price: 5.95, package_size: '400ml', attributes: [], confidence: 0.95 } },
    { id: ids['102'], reading: {} }, // no answer twice: an empty reading
  ]);
  const report = await drainEnrichment({ enrichStore, keyChain: createKeyChain([]) }, {
    limit: 2, currentOn: today, queueOfferIds: Object.keys(observations), observations,
    strategy: 'vision-first', model: HAIKU_VISION_MODEL, fetchImpl,
  });
  ok(fetches === 0, 'no crop fetch and no Mistral call for a posted reading');
  ok(report.stored === 2 && report.enriched === 1, 'both saved; the named one published');
  const row = raw.prepare('SELECT name, brand, model, extraction_json FROM offer_enrichments WHERE id = ?').get(ids['101']);
  ok(row?.name === 'Fairy Lemon Dishwashing Liquid' && row.brand === 'Fairy', 'name and brand on the card');
  ok(row.model === HAIKU_VISION_MODEL, 'the card records that Haiku read it');
  ok(!/"crop"/.test(String(row.extraction_json || '')), 'no batch label in the stored reading');

  await db.batch(oneReadingStatements(db, Object.keys(observations), new Date().toISOString()));
  const q = raw.prepare('SELECT offer_id, attempts FROM offer_vision_verification_queue ORDER BY offer_id').all();
  ok(q.length === 2 && q.every((r) => r.attempts === STAGE_TWO_MAX_ATTEMPTS), 'ONE READING: Stage 2 will not re-read either');
  const left = await enrichStore.listDebris({ currentOn: today, limit: 50 });
  ok(left.length === 1 && left[0].id === ids['103'], 'only the unread offer is left for the next call');

  // A second post of the same reading changes nothing (already read).
  const again = await drainEnrichment({ enrichStore, keyChain: createKeyChain([]) }, {
    limit: 1, currentOn: today, queueOfferIds: [ids['101']], observations: { [ids['101']]: observations[ids['101']] },
    strategy: 'vision-first', model: HAIKU_VISION_MODEL, fetchImpl,
  });
  ok(again.scanned === 0, 'a reading posted twice is saved once');

  console.log('the PC reader\'s state:');
  const state = createVisionReaderState(db);
  ok((await state.get()) === null, 'no row before the PC first asks');
  const t0 = new Date();
  await state.note(t0.toISOString());
  await state.noteRun(t0.toISOString(), { published: 9, readings: 10 });
  const pc = await state.get();
  ok(pc.seen_at === t0.toISOString() && pc.last_run?.published === 9, 'heartbeat and last run kept');
  const soon = await setVisionReaderLimit(state, { until: new Date(t0.getTime() + 3600_000).toISOString(), now: t0 });
  ok(soon.reads === 'haiku', 'a limit within 2 h: crops wait for Haiku');
  const late = await setVisionReaderLimit(state, { until: new Date(t0.getTime() + 5 * 3600_000).toISOString(), now: t0 });
  ok(late.reads === 'mistral', 'a limit over 2 h away: Mistral reads');
  ok((await setVisionReaderLimit(state, { until: 'soon', now: t0 })) === null, 'an unreadable time is refused');
  const minimarts = raw.prepare("SELECT COUNT(*) n FROM minimart_reader WHERE name = 'pc'").get().n;
  ok(minimarts === 0, 'the Mini marts reader row is untouched');

  const gate = await visionReaderGate({ objectStore: null, db, now: t0 });
  ok(gate.reader === 'mistral' && gate.why === 'pc-limited', 'the gate reads the switch, the PC and its limit together');

  console.log('the routes:');
  const audits = [];
  const ctx = {
    ingestSecret: 's3cret', db, enrichStore, objectStore: null, extractionStrategy: 'vision-first',
    opsStore: { async record(row) { audits.push(row); } },
  };
  const call = (path, init = {}) => handleRequest(new Request(`https://engine.test${path}`, {
    ...init, headers: { 'X-Ingest-Secret': 's3cret', 'content-type': 'application/json', ...(init.headers || {}) },
  }), ctx);
  ok((await call('/vision/reader/status', { headers: { 'X-Ingest-Secret': 'wrong' } })).status === 403, 'no ingest secret, no access');
  const queue = await (await call('/vision/reader/queue?crops=5')).json();
  ok(queue.mode === 'haiku' && queue.offers.length === 1 && queue.offers[0].id === ids['103'], 'the queue hands out only unread crops');
  ok(queue.prompt === ENRICHMENT_VISION_PROMPT && queue.batchPrompt === VISION_READER_BATCH_TEMPLATE, 'with the prompts the PC fills');
  const posted = await (await call('/vision/reader/readings', {
    method: 'POST',
    body: JSON.stringify({ readings: [{ id: ids['103'], reading: { name_en: 'Cutey Cat Food', brand: 'Cutey', package_size: '1.5kg', current_price: 28.99 } }] }),
  })).json();
  ok(posted.run.saved === 1 && posted.run.published === 1, 'a call\'s readings: saved and published counts back to the PC');
  await call('/vision/reader/readings', {
    method: 'POST',
    body: JSON.stringify({ readings: [], final: true, run: { reader: 'haiku', crops: 3, readings: 3, saved: 3, published: 3, ms: 4000, errors: [] } }),
  });
  const last = (await state.get()).last_run;
  ok(last.published === 3 && last.readings === 3 && last.failed === 0, 'the final post keeps the PC\'s run totals (not this post\'s zeros)');
  const audit = audits.find((a) => a.action === 'reader:vision');
  ok(audit?.offers === 3 && audit.ok === true && audit.elapsed_ms === 4000, 'one audit row for the run, with its totals');
  close();
}

console.log(`\nAll ${passed} Vision reader checks passed.`);
