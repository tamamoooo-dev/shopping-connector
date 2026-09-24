// enrich.test.mjs — offline, dependency-free tests for Vision Enrichment
// (offers/enrich.js + the /offers overlay). Run with:
//   node brochure-engine/src/enrich.test.mjs   (repo root)
//
// Guards the milestone's promises:
//  • the FROZEN production baseline (2026-07-25) is what production actually
//    sends — model, prompt bytes/sha256, and request settings — checked against
//    the benchmark's own frozen record so the two cannot drift apart,
//  • the Expanded JSON schema maps onto the stored contract (package_size ->
//    size, quantity -> pack_count), preserves the fields nothing consumes yet,
//    and lets NO price into the enrichment side-car,
//  • the gate admits only deriveNames-defeated offers that still have a crop,
//  • the parser survives fenced/garbage replies and rejects contaminated fields
//    without editing the model's literal observation,
//  • request construction and acceptance contain only the prompt + crop,
//  • servable() enforces the corroboration floor, never model confidence,
//  • the drain stores every verdict (including declines), stops the batch on
//    transport errors WITHOUT storing the failed offer, and prunes orphans,
//  • /offers overlays servable names (they feed ranking + display, flagged
//    `enriched`) and never serves uncorroborated ones.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  needsEnrichment,
  parseEnrichReply,
  buildVisionRequest,
  corroboration,
  servable,
  drainEnrichment,
  drainOcrEnrichment,
  enrichOffer,
  applyEnrichment,
  preservedObservation,
  CORROBORATION_FLOOR,
  DEFAULT_MODEL,
  PRODUCTION_EXTRACTION_BASELINE,
  QUARANTINED_OBSERVATION_FIELDS,
  VISION_PROMPT,
  VISION_PROMPT_SHA256,
} from './offers/enrich.js';
import { validateVisionOutput } from './offers/smartExtraction.js';
import { BUSINESS_ACCEPTANCE_VERSION } from './offers/businessAcceptance.js';
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
const good = parseEnrichReply('{"name_en":"Halah Sunflower Oil","name_ar":"زيت هالة","brand":"Halah","size":"1.5L","pack_count":"6×","confidence":0.9}');
check('plain JSON parses', good && good.name === 'Halah Sunflower Oil' && good.size === '1.5L' && good.packCount === '6×');
const fenced = parseEnrichReply('```json\n{"name_en":"Milk","name_ar":null,"brand":null,"size":null,"confidence":0.5}\n```');
check('fenced JSON parses', fenced && fenced.name === 'Milk' && fenced.nameAr === null);
check('garbage -> null', parseEnrichReply('sorry, I cannot') === null);
check('both names null -> null', parseEnrichReply('{"name_en":null,"name_ar":null,"confidence":1}') === null);
const priced = parseEnrichReply('{"name_en":"Rice 5kg SAR 19.99","name_ar":"ارز 19.99 ريال","brand":null,"size":"5kg","confidence":1}');
check('price-contaminated fields rejected instead of edited', priced === null);
check('out-of-range confidence becomes null', parseEnrichReply('{"name_en":"X y z","confidence":7}').confidence === null);
const literal = parseEnrichReply('{"name_en":"Brand  original   spelling","name_ar":null,"confidence":0.7}');
check('internal literal spacing is preserved', literal?.name === 'Brand  original   spelling');

// --- crop-only request contract ------------------------------------------------
console.log('crop-only request:');
{
  const req = buildVisionRequest({ contentType: 'image/jpeg', base64: 'AQID' });
  check('one user message, one image', req.messages.length === 1 && req.messages[0].content.filter((x) => x.type === 'image_url').length === 1);
  check('complete observer prompt is present', req.messages[0].content[0].text === VISION_PROMPT && /only source of truth/.test(VISION_PROMPT));
  check('request has no metadata-bearing fields',
    // Ministral 14B (the one model since 2026-09-24) rejects reasoning_effort.
    Object.keys(req).sort().join(',') === 'messages,model,response_format,temperature,top_p' &&
    Object.keys(req.messages[0]).sort().join(',') === 'content,role');
  check('crop rides as a bare data-URL string, exactly as validated',
    req.messages[0].content[1].image_url === 'data:image/jpeg;base64,AQID');
}

// --- the FROZEN production baseline (2026-07-25) -------------------------------
// These assertions exist so the adopted configuration cannot drift silently.
// The prompt is compared against its own frozen record on disk, not against a
// copy in this file, so a reworded prompt fails here even if someone updates
// both the source and a restated expectation.
console.log('frozen baseline:');
{
  const frozen = readFileSync(
    new URL('../benchmarks/mistral-medium-production-validation-50-2026-07-25/production-prompt.txt', import.meta.url),
    'utf8',
  );
  // 2026-09-24: one model, Ministral 14B; every older model is retired. The
  // prompt below stays byte-frozen — only the model moved.
  check('production model is ministral-14b-2512 (the one model)', DEFAULT_MODEL === 'ministral-14b-2512');
  check('prompt is byte-identical to the frozen record', VISION_PROMPT === frozen);
  check('prompt sha256 matches the frozen decision',
    createHash('sha256').update(VISION_PROMPT).digest('hex') === VISION_PROMPT_SHA256 &&
    VISION_PROMPT_SHA256 === 'e643b2a1b833d12256e0e3806b04c28bc5fd042bf3a86b647b989df9be7c3557');
  const req = buildVisionRequest({ contentType: 'image/jpeg', base64: 'AQID' });
  check('validated settings are what production sends',
    req.model === 'ministral-14b-2512' && req.temperature === 0 && req.top_p === 1 &&
    !('reasoning_effort' in req) && req.response_format.type === 'json_object');
  check('the baseline record matches the code it describes',
    PRODUCTION_EXTRACTION_BASELINE.model === DEFAULT_MODEL &&
    PRODUCTION_EXTRACTION_BASELINE.promptSha256 === VISION_PROMPT_SHA256 &&
    PRODUCTION_EXTRACTION_BASELINE.requestsPerCrop === 1);
}

// --- Expanded JSON -> stored schema mapping ------------------------------------
console.log('expanded JSON:');
{
  const expanded = JSON.stringify({
    name_en: 'Almarai Fresh Laban 1.5 L', name_ar: 'لبن المراعي الطازج',
    brand: 'Almarai', current_price: 6.95, old_price: 8.5, unit: 'L',
    package_size: '1.5 L', quantity: '2 Pack', package_type: 'bottle',
    attributes: ['fresh'], confidence: 0.98,
  });
  const rec = parseEnrichReply(expanded);
  check('package_size maps onto size', rec.size === '1.5 L');
  check('quantity maps onto pack_count', rec.packCount === '2 Pack');
  check('names, brand and confidence are unchanged',
    rec.name === 'Almarai Fresh Laban 1.5 L' && rec.brand === 'Almarai' && rec.confidence === 0.98);
  const legacy = parseEnrichReply('{"name_en":"Milk 1 L","name_ar":"حليب","brand":"Nadec","size":"1 L","pack_count":"6×","confidence":0.9}');
  check('the legacy 6-field reply still parses identically',
    legacy.size === '1 L' && legacy.packCount === '6×');

  const validated = validateVisionOutput(JSON.parse(expanded));
  check('the validator accepts Expanded JSON through the same rules',
    validated.fields.size.value === '1.5 L' && validated.fields.name_en.value === 'Almarai Fresh Laban 1.5 L');

  // Prices are observed, never carried into anything servable.
  const kept = preservedObservation(JSON.parse(expanded));
  check('unit, package_type and attributes are preserved',
    kept.unit === 'L' && kept.package_type === 'bottle' && kept.attributes[0] === 'fresh');
  check('preserved observation keeps the verbatim names the model reported',
    kept.name_en === 'Almarai Fresh Laban 1.5 L' && kept.package_size === '1.5 L' && kept.quantity === '2 Pack');
  check('no price field survives into the preserved observation',
    QUARANTINED_OBSERVATION_FIELDS.every((f) => !(f in kept)) &&
    !JSON.stringify(kept).includes('6.95') && !JSON.stringify(kept).includes('8.5'));
  check('an all-empty observation stores NULL rather than {}',
    preservedObservation({ name_en: null, attributes: [] }) === null && preservedObservation(null) === null);
}

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
  const attempts = new Map();
  const queue = new Map();
  const verdicts = new Map(); // offer_id -> S4 verdict (R5)
  let debris = [];
  return {
    rows,
    attempts,
    queue,
    verdicts,
    setDebris(d) {
      debris = d;
    },
    async listDebris({ limit = 15 } = {}) {
      return debris.filter((d) => !rows.has(d.id) && !attempts.has(`${d.id}:vision`)).slice(0, limit);
    },
    async listSelected({ ids } = {}) {
      const selected = new Set(ids || []);
      return debris.filter((d) => selected.has(d.id));
    },
    async countDebris() {
      return debris.filter((d) => !rows.has(d.id) && !attempts.has(`${d.id}:vision`)).length;
    },
    async upsertMany(list) {
      for (const r of list) rows.set(r.id, r);
      return { stored: list.length };
    },
    async saveVisionOutcome({ attempt, canonicalRow, triggerReasons, acceptance = null }) {
      attempts.set(`${attempt.offerId}:vision`, attempt);
      if (canonicalRow) {
        rows.set(attempt.offerId, canonicalRow);
        queue.delete(attempt.offerId);
      } else {
        queue.set(attempt.offerId, {
          status: 'ocr_pending', attempts: 0, trigger_reasons: triggerReasons,
        });
      }
      // Mirrors the D1 store: the verdict is recorded for accepted AND rejected
      // rows alike (R5), and `verdictStored` reports whether it landed.
      if (acceptance) verdicts.set(attempt.offerId, acceptance);
      return { stored: 1, queued: canonicalRow ? 0 : 1, verdictStored: !!acceptance };
    },
    async listPendingOcr({ limit = 10 } = {}) {
      return debris.filter((d) => queue.get(d.id)?.status === 'ocr_pending' && !rows.has(d.id))
        .slice(0, limit)
        .map((d) => {
          const vision = attempts.get(`${d.id}:vision`);
          return {
            ...d,
            attempts: queue.get(d.id).attempts,
            trigger_reasons: queue.get(d.id).trigger_reasons,
            vision_output: vision.output,
            vision_validation: vision.validation,
            vision_confidence: vision.confidence,
            vision_model: vision.model,
            vision_crop_url: vision.cropUrl,
          };
        });
    },
    async countPendingOcr() {
      return [...queue.values()].filter((q) => q.status === 'ocr_pending').length;
    },
    async saveOcrOutcome({ attempt, canonicalRow }) {
      attempts.set(`${attempt.offerId}:ocr`, attempt);
      rows.set(attempt.offerId, canonicalRow);
      const q = queue.get(attempt.offerId);
      queue.set(attempt.offerId, { ...q, status: 'completed', attempts: (q?.attempts || 0) + 1 });
      return { stored: 1 };
    },
    async markOcrPending(id, error) {
      const q = queue.get(id);
      queue.set(id, { ...q, status: 'ocr_pending', attempts: (q?.attempts || 0) + 1, last_error: error });
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

// A fake fetch: image URLs yield bytes; Vision gets the scripted JSON reply and
// OCR gets optional deterministic markdown for the same crop.
function fakeFetch(replies) {
  let lastImg = null;
  const calls = { images: 0, api: 0 };
  const impl = async (url) => {
    if (String(url).startsWith('https://api.mistral.ai/')) {
      calls.api += 1;
      const r = replies[lastImg];
      if (r === 'TRANSPORT') {
        const headers = {
          'x-ratelimit-limit-req-minute': '0',
          'x-ratelimit-remaining-req-minute': '0',
          'x-kong-request-id': 'test-request-id',
        };
        return {
          ok: false,
          status: 429,
          headers: { get: (name) => headers[String(name).toLowerCase()] || null },
          text: async () =>
            '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300","raw_status_code":429}',
        };
      }
      if (String(url).endsWith('/ocr')) {
        const markdown = r && typeof r === 'object' ? r.ocr || '' : '';
        return { ok: true, json: async () => ({ pages: markdown ? [{ markdown }] : [] }) };
      }
      const vision = r && typeof r === 'object' ? r.vision : r;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: vision } }] }),
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
    { id: 'a:1', image_url: 'http://cdn/a.jpg', search_text: 'D4D TEXT MUST BE IGNORED' },
    { id: 'a:2', image_url: 'http://cdn/b.jpg', search_text: 'D4D TEXT MUST BE IGNORED' },
  ]);
  const replies = {
    'http://cdn/a.jpg': '{"name_en":"Tanzanian Mutton","name_ar":"خروف تنزاني","brand":"Nesto","size":"7-9kg","confidence":0.98}',
    'http://cdn/b.jpg': { vision: '{"name_en":null,"name_ar":null,"confidence":0}', ocr: '# Sadia Chicken\n# دجاج ساديا\n900 g' },
  };
  const f = fakeFetch(replies);
  globalThis.fetch = f; // drain -> enrichOffer uses global fetch by default
  const report = await drainEnrichment(
    { enrichStore: store, mistralKey: 'k' },
    { currentOn: '2026-07-18', limit: 15 },
  );
  check('one Vision PASS and one asynchronous OCR escalation', report.enriched === 1 && report.ocrPending === 1);
  check('Vision and queue state are stored without a premature canonical reject',
    store.rows.size === 1 && store.attempts.size === 2 && store.queue.get('a:2')?.status === 'ocr_pending');
  check('drain reports extraction request diagnostics',
    report.extraction.strategy === 'vision-first' &&
    report.extraction.visionRequests === 2 && report.extraction.ocrRequests === 0 &&
    report.extraction.averageRequestsPerOffer === 1);
  check('drain persists the already-built candidate for the Registry invocation',
    report.identityBuilder.mode === 'strict' && report.identityBuilder.built === 1
      && store.rows.get('a:1').identity_candidate?.family === 'Lamb');
  check('validated crop extraction clears the canonical serving gate', store.rows.get('a:1').corroboration === 1);
  const ocrReport = await drainOcrEnrichment(
    { enrichStore: store, mistralOcrKey: 'ocr-key' },
    { currentOn: '2026-07-18' },
  );
  check('OCR worker finalizes only the queued reject',
    ocrReport.completed === 1 && store.rows.get('a:2')?.name === 'Sadia Chicken');
  check('both source attempts remain separately auditable',
    store.attempts.has('a:2:vision') && store.attempts.has('a:2:ocr'));
  const again = await drainEnrichment({ enrichStore: store, mistralKey: 'k' }, { currentOn: '2026-07-18' });
  check('attempted offers never re-drain', again.scanned === 0 && f.calls.api === 3);
}

// --- S4 Business Acceptance in the drain (R5, R6) -----------------------------
// The gate must judge EVERY extraction, not only the ones that cleared the
// Quality Gate. A Quality Gate reject is the likeliest S4 reject, so scoring
// only the passes would blind the calibration data to the population that
// matters most. Both branches are exercised here in one drain.
console.log('S4 acceptance in the drain:');
{
  const store = memEnrichStore();
  store.setDebris([
    // Passes the Quality Gate AND all three mandatory conditions.
    { id: 's4:pass', image_url: 'http://cdn/pass.jpg', price: 5.99, currency: 'SAR' },
    // FAILS the Quality Gate (no names) — must still receive a verdict.
    { id: 's4:reject', image_url: 'http://cdn/reject.jpg', price: 7.5, currency: 'SAR' },
    // Passes the Quality Gate but has NO usable price, so S4 must reject it on
    // exactly one condition. (Post-R4 the SQL queue would not surface this
    // offer at all; the fake store is deliberately permissive so the gate's own
    // behaviour is observable here.)
    { id: 's4:noprice', image_url: 'http://cdn/noprice.jpg', price: 0, currency: 'SAR' },
  ]);
  globalThis.fetch = fakeFetch({
    'http://cdn/pass.jpg': '{"name_en":"Arwa Water","name_ar":"مياه أروى","brand":"Arwa","size":"330 ml","confidence":0.9}',
    'http://cdn/reject.jpg': { vision: '{"name_en":null,"name_ar":null,"confidence":0}', ocr: '# x' },
    'http://cdn/noprice.jpg': '{"name_en":"Nadec Milk","name_ar":"حليب نادك","brand":"Nadec","size":"1 L","confidence":0.9}',
  });
  const report = await drainEnrichment(
    { enrichStore: store, mistralKey: 'k' },
    { currentOn: '2026-07-18', limit: 15 },
  );

  check('every extraction is judged, passes and Quality Gate rejects alike',
    report.acceptance.judged === 3 && store.verdicts.size === 3);
  check('the verdict for a Quality Gate REJECT is persisted (R5)',
    store.verdicts.has('s4:reject') && store.verdicts.get('s4:reject').accepted === false);
  check('a fully-resolved priced offer is ACCEPTED',
    store.verdicts.get('s4:pass').accepted === true &&
    store.verdicts.get('s4:pass').missing.length === 0);
  check('the drain report tallies acceptance both ways',
    report.acceptance.accepted === 1 && report.acceptance.rejected === 2);
  check('a missing price is named as the ONLY failed condition (R6)',
    store.verdicts.get('s4:noprice').accepted === false &&
    store.verdicts.get('s4:noprice').missing.length === 1 &&
    store.verdicts.get('s4:noprice').missing[0] === 'price');
  // s4:noprice fails on price alone; s4:reject fails on the two fields the
  // Quality Gate reject left unresolved. Three rejected conditions across two
  // offers — which a single "rejected: 2" could never have told an operator.
  check('per-condition tallies are reported, never a bare reject count (R6)',
    report.acceptance.missing.price === 1 &&
    report.acceptance.missing.english_name === 1);
  // R3: a verdict must be attributable to the rule that produced it. Asserted
  // against the EXPORTED constant rather than a literal — pinning the literal
  // makes every legitimate version bump look like a regression, while the
  // property being defended is that the report and the stored row agree with
  // each other and with the gate. The literal moved v1 -> v2 on 2026-07-30
  // (product-class-aware M2) and would have to move again next time.
  check('the verdict carries the gate version it was produced by (R3)',
    report.acceptance.version === BUSINESS_ACCEPTANCE_VERSION &&
    store.verdicts.get('s4:pass').version === BUSINESS_ACCEPTANCE_VERSION);
  check('persisted count tracks verdicts that actually landed',
    report.acceptance.persisted === 3);
  check('S4 changes no existing outcome: the same rows enrich and escalate',
    report.enriched === 2 && report.ocrPending === 1 && store.rows.size === 2);
}

// End-to-end under the FROZEN baseline: an Expanded JSON reply drains into the
// stored row with package_size/quantity mapped, the unconsumed fields preserved,
// and both prices absent from everything the row exposes.
{
  const store = memEnrichStore();
  store.setDebris([{
    id: 'exp:1',
    image_url: 'http://cdn/expanded.jpg',
    price: 19.95,
    currency: 'SAR',
  }]);
  globalThis.fetch = fakeFetch({
    'http://cdn/expanded.jpg': JSON.stringify({
      name_en: 'Sadia Frozen Chicken Breast 900 g', name_ar: 'صدور دجاج ساديا المجمدة',
      brand: 'Sadia', current_price: 21.95, old_price: 27.5, unit: 'g',
      package_size: '900 g', quantity: null, package_type: 'pack',
      attributes: ['frozen'], confidence: 0.99,
    }),
  });
  const report = await drainEnrichment(
    { enrichStore: store, mistralKey: 'k' },
    { currentOn: '2026-07-18' },
  );
  const row = store.rows.get('exp:1');
  check('Expanded JSON drains to a servable canonical row',
    report.enriched === 1 && row.name === 'Sadia Frozen Chicken Breast 900 g' &&
    row.size === '900 g' && row.corroboration === 1);
  check('stored row preserves the unconsumed Expanded JSON fields',
    row.extraction_json.unit === 'g' && row.extraction_json.package_type === 'pack' &&
    row.extraction_json.attributes[0] === 'frozen');
  check('shadow mode stores observed and built Arabic with rollout metadata',
    row.name_ar === row.extraction_json._arabic_builder.observed_arabic &&
    row.extraction_json._arabic_builder.built_arabic &&
    row.extraction_json._arabic_builder.status === 'BUILT' &&
    row.extraction_json._arabic_builder.path === 'BUILT_CANDIDATE' &&
    row.extraction_json._arabic_builder.lexicon_version &&
    row.extraction_json._arabic_builder.builder_score_version === 'builder-score-v1' &&
    typeof row.extraction_json._arabic_builder.builder_score === 'number' &&
    row.extraction_json._arabic_builder.commerce_score_version === 'commerce-score-v1' &&
    row.extraction_json._arabic_builder.commerce_score_breakdown.price.resolved === true &&
    row.extraction_json._arabic_builder.commerce_score_breakdown.price.source === 'authoritative_offer' &&
    typeof row.extraction_json._arabic_builder.coverage_score === 'number');
  check('NO price reaches the enrichment side-car',
    !JSON.stringify(row).includes('19.95') &&
    !JSON.stringify(row).includes('21.95') &&
    !JSON.stringify(row).includes('27.5'));
  check('the full reply INCLUDING prices stays auditable in the attempt journal',
    store.attempts.get('exp:1:vision').output.current_price === 21.95 &&
    store.attempts.get('exp:1:vision').output.old_price === 27.5);
}

// OCR quota/rate failure is isolated from the Vision critical path.
{
  const store = memEnrichStore();
  store.setDebris([{ id: 'async:reject', image_url: 'http://cdn/reject.jpg' }]);
  globalThis.fetch = fakeFetch({
    'http://cdn/reject.jpg': { vision: '{"name_en":"Milk","name_ar":null,"brand":null,"size":"1 l"}' },
  });
  const vision = await drainEnrichment(
    { enrichStore: store, mistralKey: 'vision-key' },
    { currentOn: '2026-07-18', maxRateRetries: 0 },
  );
  check('missing optional Arabic and brand do not block Vision ingestion',
    vision.failed === 0 && vision.enriched === 1 && vision.ocrPending === 0 && store.rows.has('async:reject'));

  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/ocr')) {
      return { ok: false, status: 429, text: async () => 'quota exhausted', headers: { get: () => null } };
    }
    return {
      ok: true,
      headers: { get: () => 'image/jpeg' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    };
  };
  const ocr = await drainOcrEnrichment(
    { enrichStore: store, mistralOcrKey: 'ocr-key' },
    { currentOn: '2026-07-18', maxRateRetries: 0 },
  );
  check('no OCR escalation is created for optional Arabic or brand',
    ocr.failed === 0 && store.rows.has('async:reject') && !store.queue.has('async:reject'));

  store.setDebris([
    { id: 'async:reject', image_url: 'http://cdn/reject.jpg' },
    { id: 'async:pass', image_url: 'http://cdn/pass.jpg' },
  ]);
  globalThis.fetch = fakeFetch({
    'http://cdn/pass.jpg': '{"name_en":"Fresh Milk","name_ar":"حليب طازج","brand":"Nadec","size":"1 l","confidence":0.9}',
  });
  const continued = await drainEnrichment(
    { enrichStore: store, mistralKey: 'vision-key' },
    { currentOn: '2026-07-18' },
  );
  check('new Vision PASS continues beside the accepted English-only result',
    continued.enriched === 1 && store.rows.has('async:pass') && store.rows.has('async:reject'));
}

// Runtime strategy integration: the guarded production route can override the
// environment policy without changing code, and the stored row contract stays
// exactly the same.
{
  const store = memEnrichStore();
  store.setDebris([{ id: 'strategy:1', image_url: 'http://cdn/strategy.jpg' }]);
  globalThis.fetch = fakeFetch({
    'http://cdn/strategy.jpg': {
      vision: '{"name_en":"must not run","name_ar":null,"brand":null,"size":null}',
      ocr: '# Sadia Chicken\n# دجاج ساديا\n900 g',
    },
  });
  const response = await handleRequest(new Request('http://x/enrich?strategy=ocr-only&identityMode=relaxed', {
    method: 'POST',
    headers: { 'X-Ingest-Secret': 'secret' },
  }), {
    ingestSecret: 'secret',
    enrichStore: store,
    mistralKey: 'k',
    extractionStrategy: 'vision-only',
  });
  const body = await response.json();
  check('guarded /enrich accepts a runtime strategy override',
    response.status === 200 && body.extraction.strategy === 'ocr-only' &&
    body.extraction.visionRequests === 0 && body.extraction.ocrRequests === 1);
  check('guarded /enrich accepts runtime Identity Builder mode',
    body.identityBuilder.mode === 'relaxed' && body.identityBuilder.built === 1);
  check('OCR-only route preserves legacy fields and adds the candidate contract',
    store.rows.get('strategy:1')?.name === 'Sadia Chicken' &&
    store.rows.get('strategy:1')?.brand === 'Sadia' &&
    store.rows.get('strategy:1')?.identity_candidate?.family === 'Chicken');
}
{
  const store = memEnrichStore();
  store.setDebris([{ id: 'ocr-first:1', image_url: 'http://cdn/ocr-first.jpg' }]);
  const calls = { crop: 0, ocr: 0, vision: 0 };
  globalThis.fetch = async (url) => {
    const value = String(url);
    if (value === 'http://cdn/ocr-first.jpg') {
      calls.crop += 1;
      return {
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      };
    }
    if (value.endsWith('/ocr')) {
      calls.ocr += 1;
      return { ok: true, json: async () => ({ pages: [{ markdown: '# Sadia Chicken\n# دجاج ساديا\n900 g' }] }) };
    }
    calls.vision += 1;
    throw new Error('complete Vision outage');
  };
  const response = await handleRequest(new Request('http://x/enrich?strategy=ocr-first', {
    method: 'POST',
    headers: { 'X-Ingest-Secret': 'secret' },
  }), {
    ingestSecret: 'secret',
    enrichStore: store,
    mistralKey: 'k',
    extractionStrategy: 'vision-first',
  });
  const body = await response.json();
  const row = store.rows.get('ocr-first:1');
  check('OCR-first production route succeeds during a complete Vision outage',
    response.status === 200 && calls.crop === 1 && calls.ocr === 1 && calls.vision === 0 && body.enriched === 1);
  check('OCR-first production diagnostics report exactly one OCR request',
    body.extraction.strategy === 'ocr-first' && body.extraction.visionRequests === 0 && body.extraction.ocrRequests === 1);
  check('OCR-first stored contract is OCR-sourced, servable, and Registry-ready',
    row?.model === 'mistral-ocr-latest' && Number(row?.confidence) > 0 && Number(row?.confidence) <= 1 && row?.corroboration === 1
      && row?.identity_candidate?.family === 'Chicken');
}
{
  const store = memEnrichStore();
  store.setDebris([{ id: 'a:no-ocr', image_url: 'http://cdn/no-ocr.jpg', search_text: 'halah oil' }]);
  globalThis.fetch = fakeFetch({
    'http://cdn/no-ocr.jpg': '{"name_en":"Halah Oil","name_ar":"زيت هالة","brand":"Halah","confidence":0.9}',
  });
  await drainEnrichment({ enrichStore: store, mistralKey: 'k' }, { currentOn: '2026-07-18' });
  check('D4D OCR cannot influence validated serving eligibility',
    store.rows.get('a:no-ocr').corroboration === 1);
}
{
  const store = memEnrichStore([{ id: 'historical:1', name: 'Old Name', corroboration: 1 }]);
  store.setDebris([{ id: 'historical:1', image_url: 'http://cdn/historical.jpg' }]);
  globalThis.fetch = fakeFetch({
    'http://cdn/historical.jpg': '{"name_en":"Sadia Chicken Breast","name_ar":"صدور دجاج ساديا","brand":"Sadia","size":"900 g","confidence":0.9}',
  });
  const report = await drainEnrichment(
    { enrichStore: store, mistralKey: 'k' },
    { currentOn: '2026-07-18', offerIds: ['historical:1'], strategy: 'vision-only' },
  );
  check('selective historical re-enrichment is explicit-ID only',
    report.scanned === 1 && store.rows.get('historical:1').name === 'Sadia Chicken Breast');
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
  check('zero request allowance is distinguished from monthly usage exhaustion',
    report.providerLimit?.category === 'request_allowance_zero' &&
    report.providerLimit?.limitRequestsMinute === '0');
  check('complete Mistral body, code, model, request id, and attempted key are retained',
    report.providerError?.responseBody ===
      '{"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300","raw_status_code":429}' &&
    report.providerError?.error?.code === '1300' &&
    report.providerError?.model === 'ministral-14b-2512' &&
    report.providerError?.headers?.requestId === 'test-request-id' &&
    report.providerError?.attempts?.[0]?.keyId === 'key-1');
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
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"name_en":"Tanzanian Mutton","name_ar":"خروف تنزاني","brand":"Nesto","size":"7 kg","confidence":0.9}' } }] }) };
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
{
  const fetchImpl = fakeFetch({
    'http://c/identity.jpg': '{"name_en":"Fresh Chicken Breast","name_ar":"صدور دجاج طازجة","brand":"Sadia","size":"900g","confidence":0.9}',
  });
  const res = await enrichOffer(
    { id: 'identity', name: null, nameAr: null, imageUrl: 'http://c/identity.jpg' },
    { apiKey: 'k', fetchImpl, identityNormalizationMode: 'strict' },
  );
  check('production enrichment returns an internal Identity Candidate',
    res.identityCandidate.family === 'Chicken' && res.identityCandidate.cut === 'Breast' &&
    res.identityCandidate.processing === 'Fresh' && res.identityCandidate.size.value === 900);
  check('Identity Candidate is diagnostic-only beside the unchanged enrichment fields',
    res.name === 'Fresh Chicken Breast' && res.nameAr === 'صدور دجاج طازجة' &&
    res.identityDiagnostics.extractionInput.productName === 'Fresh Chicken Breast');
  // Brand Lexicon (HISTORY §45): resolution rides along with the observation
  // and never replaces it — `brand` stays the model's verbatim string.
  check('production enrichment carries the canonical brand identity',
    res.brandIdentity.brand_id === 'sadia' && res.brandIdentity.canonical_brand === 'Sadia' &&
    res.brandIdentity.display_ar === 'ساديا');
  check('the observed brand is preserved untouched beside it',
    res.brand === 'Sadia' && res.brandIdentity.observed_brand === 'Sadia');
}
{
  // An unknown brand must reach the record unresolved rather than guessed at.
  const fetchImpl = fakeFetch({
    'http://c/unknown.jpg': '{"name_en":"Instant Coffee","name_ar":"قهوة سريعة الذوبان","brand":"NAJJAR","size":"190g","confidence":0.9}',
  });
  const res = await enrichOffer(
    { id: 'unknown', name: null, nameAr: null, imageUrl: 'http://c/unknown.jpg' },
    { apiKey: 'k', fetchImpl },
  );
  check('an unknown brand stays unresolved and unmodified',
    res.brand === 'NAJJAR' && res.brandIdentity.brand_id === null &&
    res.brandIdentity.canonical_brand === 'NAJJAR' && res.brandIdentity.status === 'unknown');
  // Structured Product + Arabic Builder (HISTORY §47): built from the ENGLISH
  // name, additive, and never replacing the observed Arabic.
  check('the structured product is built from the English name',
    res.structuredProduct.source === 'english' && res.structuredProduct.category.id === 'instant-coffee');
  check('the Arabic name is GENERATED, not the observed OCR Arabic',
    res.arabicName.status === 'built' && res.arabicName.name === 'قهوة سريعة التحضير 190 جم');
  check('the observed Arabic is still what the record carries as nameAr',
    res.nameAr === 'قهوة سريعة الذوبان' && res.structuredProduct.observed.name_ar === 'قهوة سريعة الذوبان');
  check('the in-memory record carries the same persisted shadow contract',
    res.observation._arabic_builder.status === 'BUILT' &&
    res.observation._arabic_builder.observed_arabic === res.nameAr &&
    res.observation._arabic_builder.built_arabic === res.arabicName.name);
}
{
  // The Arabic Builder must refuse rather than name a product it cannot read.
  const fetchImpl = fakeFetch({
    'http://c/opaque.jpg': '{"name_en":"Keqiwear KW86 3in1","name_ar":"كيكيوير","brand":"Keqiwear","confidence":0.9}',
  });
  const res = await enrichOffer(
    { id: 'opaque', name: null, nameAr: null, imageUrl: 'http://c/opaque.jpg' },
    { apiKey: 'k', fetchImpl },
  );
  check('an unrecognised product yields no built Arabic name, never a guess',
    res.arabicName.status === 'no_category' && res.arabicName.name === null);
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

// --- the unit price on the read contract (2026-08-02) ---------------------------
// The last mile of the price-basis work: a per-kilo price that resolves in the
// projection but never reaches `rowToOffer` is still invisible to a shopper,
// which is exactly where this bug lived for the frontend half.
console.log('applyEnrichment · unit price:');
{
  const row = (over = {}) => ({
    search_text: 'ocr haystack', e_name: 'Vision Name', e_name_ar: 'اسم',
    e_corroboration: 0.8, e_match_text: 'vision haystack',
    e_size: null, e_unit: null, ...over,
  });

  const basisOffer = { name: null, nameAr: null, price: 7.99 };
  applyEnrichment(basisOffer, row({ e_name: 'Apple Royal Gala Brazil', e_size: 'Per Kg' }));
  check('a per-kilo price reaches the contract as a PRINTED unit price',
    basisOffer.unitPrice?.value === 7.99 && basisOffer.unitPrice.unit === 'kg'
    && basisOffer.unitPrice.source === 'printed');
  check('the basis itself is exposed, with its provenance',
    basisOffer.priceBasis?.unit === 'kg' && basisOffer.priceBasis.source === 'size_field');
  check('the printed size string reaches the contract too',
    basisOffer.size === 'Per Kg');

  const unitFieldOffer = { name: null, nameAr: null, price: 39.99 };
  applyEnrichment(unitFieldOffer, row({ e_name: 'FRESH VEAL - BONE IN', e_unit: 'KILO' }));
  check('the extractor `unit` field — preserved since §44, consumed since now',
    unitFieldOffer.unitPrice?.value === 39.99 && unitFieldOffer.priceBasis?.source === 'unit_field');

  const arabicOffer = { name: null, nameAr: null, price: 12.99 };
  applyEnrichment(arabicOffer, row({
    e_name: 'Yellow Banana', e_name_ar: 'موز اصغر للكيلو',
    search_text: 'موز اصغر للكيلو yellow banana per kg',
  }));
  check('the retailer Arabic channel resolves a basis nothing else states',
    arabicOffer.unitPrice?.value === 12.99 && arabicOffer.unitPrice.unit === 'kg');

  const packOffer = { name: null, nameAr: null, price: 12.5 };
  applyEnrichment(packOffer, row({ e_name: 'Almarai Milk 2 L', e_size: '2 L' }));
  check('a pack price is still DERIVED by division, and says so',
    packOffer.unitPrice?.value === 6.25 && packOffer.unitPrice.unit === 'l'
    && packOffer.unitPrice.source === 'derived' && packOffer.priceBasis === null);

  const noneOffer = { name: null, nameAr: null, price: 30 };
  applyEnrichment(noneOffer, row({ e_name: 'Nebo Makeup Kit -9090', search_text: 'nebo makeup kit' }));
  check('no size and no basis stays null — never a fabricated unit price',
    noneOffer.unitPrice === null && noneOffer.priceBasis === null);

  // An unservable reading is one the vision-canonical gate refused to display.
  // Deriving a unit price from a name we will not show would smuggle it back in.
  const unservable = { name: 'OCR Name', nameAr: null, price: 7.99 };
  applyEnrichment(unservable, row({
    e_name: 'Apple Royal Gala Brazil', e_size: 'Per Kg', e_corroboration: 0.1,
  }));
  check('an UNSERVABLE enrichment contributes no size, unit or basis',
    unservable.size === null && unservable.priceBasis === null);

  const priceless = { name: null, nameAr: null, price: null };
  applyEnrichment(priceless, row({ e_name: 'Apple Royal Gala Brazil', e_size: 'Per Kg' }));
  check('a priceless offer yields no unit price and does not throw',
    priceless.unitPrice === null);
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
      e_corroboration: 0.8, e_match_text: 'tanzanian mutton', e_model: 'mistral-medium-latest',
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
  check('servable enrichment exposes its model', good && good.enrichmentModel === 'mistral-medium-latest');
  check('enriched name reaches ranking (name match outranks)', body.offers[0].id === 'e:good');
  check('uncorroborated enrichment never serves a name', !bad || (bad.name == null && !bad.enriched));
  const noEnrich = await handleRequest(new Request('http://x/offers?q=mutton'), {
    ...ctx,
    offerStore: { search: async () => rows.map((r) => ({ ...r, e_name: null, e_name_ar: null, e_match_text: null, e_corroboration: null })) },
  });
  const nb = await noEnrich.json();
  check('no enrichment rows -> exact OCR fallback behavior', nb.offers.every((o) => o.name == null && !o.enriched));

  // The unit price must survive all the way into the JSON a client parses.
  // Everything upstream of this can be correct and the shopper still sees
  // nothing, which is precisely how the per-kilo gap survived so long.
  const freshRes = await handleRequest(new Request('http://x/offers?q=apple'), {
    registry: {},
    offerStore: {
      search: async () => [offerRow('e:apple', {
        price: 7.99, category: 'fresh-fruits',
        name_ar: 'تفاح رويال جالا برازيلي للكيلو',
        search_text: 'تفاح رويال جالا برازيلي للكيلو apple royal gala brazil per kg',
        e_name: 'Apple Royal Gala Brazil', e_name_ar: 'تفاح رويال جالا برازيلي',
        e_size: 'Per Kg', e_unit: null,
        e_corroboration: 0.8, e_match_text: 'apple royal gala brazil',
      })],
    },
  });
  const apple = (await freshRes.json()).offers.find((o) => o.id === 'e:apple');
  check('/offers serves the per-kilo unit price on the wire',
    apple?.unitPrice?.value === 7.99 && apple.unitPrice.unit === 'kg'
    && apple.unitPrice.source === 'printed');
  check('/offers serves the basis and the printed size beside it',
    apple?.priceBasis?.unit === 'kg' && apple.size === 'Per Kg');
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll enrichment tests passed.');
