// offers/enrich.js — VISION ENRICHMENT for debris-name offers (spike, 2026-07-18).
//
// ~3% of ingested offers arrive with OCR text so mangled that deriveNames
// (offers/contract.js) refuses to produce a display name for EITHER language —
// CJK smears, Malayalam signage, interleaved fragments. Those offers still
// carry `imageUrl`: the product's own flyer crop on the aggregator's CDN. This
// module sends THAT crop to a vision model and gets back what the OCR lost:
// a clean bilingual product name, brand, and pack size.
//
// DISCIPLINE (mirrors the D4D "flyer prevails" honesty contract):
//   • SIDE-CAR, never a mutation. Enrichment is a separate record keyed by
//     offer id; the offer row's own fields are never overwritten. Deleting
//     enrichments restores today's behavior exactly.
//   • NAMES ONLY. The model is instructed not to read prices, and no price
//     field exists in the record — the price path cannot be touched from here.
//   • GATED. needsEnrichment() admits only offers deriveNames already gave up
//     on (both names null) that still have a crop to read — ~1.1k of ~38k
//     offers (measured 2026-07-18), so a full pass is a rounding error against
//     the API's free tier.
//   • DECOUPLED. Nothing here runs inside the ingest pipeline; the caller
//     (a paced post-ingest step) decides when and how fast. Pure fetch-based,
//     Workers- and Node-compatible.
//
// Model: Mistral `mistral-small-latest` (vision-capable, free Experiment tier).
// Configurable — swapping models or providers is a constructor argument, not a
// code change downstream.

import { normalizeText } from '../matching.js';
import { createKeyChain, withFailover, classifyMistralError } from './mistralKeys.js';
import {
  DEFAULT_EXTRACTION_STRATEGY,
  normalizeExtractionStrategy,
  runSmartExtraction,
} from './smartExtraction.js';
import {
  buildIdentityCandidate,
  DEFAULT_IDENTITY_NORMALIZATION_MODE,
  normalizeIdentityMode,
} from './identityBuilder.js';

// --- the enrichment record -----------------------------------------------------
// Enrichment:
//   { offerId, name, nameAr, brand, size, confidence,
//     source, model, cropUrl, enrichedAt }
//
// `offerId` is the FULL offer id (`store:region:source:offerId`) so the record
// joins 1:1 with the offers row. `confidence` is the model's own 0..1 estimate,
// kept for AUDIT ONLY — the serving gate is corroboration (below). `cropUrl`
// keeps the record auditable — the image the model read is one click away,
// same spirit as the offer's own sourceUrl.

// The corroboration a record must clear before any read path may serve its
// names. Historical rows used D4D OCR here. New crop-only extraction does not
// compute an OCR score at all; corroboration remains NULL pending a separate,
// explicitly approved post-validation design decision.
export const CORROBORATION_FLOOR = 0.3;

// True when a stored enrichment row's names may be shown/matched.
export function servable(row) {
  return !!row && (row.name != null || row.name_ar != null) &&
    Number(row.corroboration) >= CORROBORATION_FLOOR;
}

// --- the ONE canonical-identity gate, JS side -----------------------------------
// Vision-canonical directive (2026-07-21): every feature that turns a search
// row into a served offer goes through THIS overlay — Search (engine.js
// /offers) and Watches (monitor.js) alike. `row` is an offerStore.search()
// result carrying the aliased enrichment columns (ENRICH_ROW_COLS in
// storage/enrichStore.js); the gate is `servable()` above — no caller may
// implement its own corroboration or fallback logic.
//
// When the vision reading is servable, the offer's display names become the
// vision names (offer.enriched = true); returns the match haystack the caller
// must score relevance against — the vision match_text when servable (mirroring
// what SQL retrieval matched via CANON_HAYSTACK_SQL), else the OCR search_text.
export function applyEnrichment(offer, row) {
  const enr = {
    name: row?.e_name ?? null,
    name_ar: row?.e_name_ar ?? null,
    corroboration: row?.e_corroboration,
  };
  if (servable(enr)) {
    offer.name = enr.name;
    offer.nameAr = enr.name_ar;
    offer.enriched = true;
    return row.e_match_text || row.search_text || '';
  }
  return row?.search_text || '';
}

// --- corroboration -------------------------------------------------------------
// MEASURED (spike, 2026-07-18, 8 production debris crops): the model reports
// confidence 0.98 on EVERY tile, including one it misread — self-reported
// confidence cannot gate anything. The honest signal is corroboration: what
// fraction of the extracted name/brand tokens also appear in the offer's own
// raw OCR searchText. The OCR is mangled, not absent — a real reading usually
// re-finds its words there ("tanzanian mutton" does; a hallucinated "Cucumber"
// on a tile that prints "Vellery" does not). 0 = uncorroborated (crop-only
// evidence, treat with suspicion), 1 = every token re-found.
// Pure lexical agreement primitive retained for historical diagnostics. New
// writes must call localOcrCorroboration() below, which enforces provenance.
export function corroboration(rec, searchText) {
  const hay = new Set(
    normalizeText(String(searchText || '')).split(' ').filter((w) => w.length > 2),
  );
  const toks = normalizeText([rec?.name, rec?.nameAr, rec?.brand].filter(Boolean).join(' '))
    .split(' ')
    .filter((w) => w.length > 2);
  if (!toks.length || !hay.size) return 0;
  let hit = 0;
  for (const t of toks) if (hay.has(t)) hit += 1;
  return hit / toks.length;
}

// --- the gate ------------------------------------------------------------------
// True only for offers whose OCR names are beyond repair AND that carry a crop
// to read. Deliberately reuses deriveNames' own verdict (name/nameAr null)
// rather than inventing a second "is this garbage?" heuristic — the two layers
// must agree on what debris is.
export function needsEnrichment(offer) {
  if (!offer || !offer.imageUrl) return false;
  return offer.name == null && offer.nameAr == null;
}

// --- the vision call -----------------------------------------------------------

const MISTRAL_URL = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_OCR_URL = 'https://api.mistral.ai/v1/ocr';
export const DEFAULT_MODEL = 'mistral-small-latest';
export const DEFAULT_OCR_MODEL = 'mistral-ocr-latest';

// English-first LITERAL-EXTRACTION contract (Vision Milestone 2, 2026-07-19).
// Vision is an EXTRACTION engine, not an editor: it copies what the tile prints,
// verbatim, and does NOT normalize, translate, infer, or "improve" anything —
// the Registry owns all normalization / identity / matching downstream. English
// is the canonical identity (Vision reads it far more reliably than Arabic);
// Arabic is an INDEPENDENT literal extraction that never modifies English and is
// never translated to fill a gap. Product-boundary isolation stops the model
// borrowing words from adjacent tiles. `pack_count` is an additive extraction
// observation and is kept inside the enrichment/identity boundary, so existing
// public offer fields and downstream APIs remain unchanged.
export const VISION_PROMPT = [
  'This image is ONE product tile cropped from a Saudi supermarket flyer.',
  'The pixels in the attached crop are your ONLY source of truth.',
  'You have no product title, OCR, description, category, brand metadata, prior',
  'enrichment, registry record, or previously extracted fields. Do not use or',
  'assume any external context.',
  '',
  'You are a literal visual OBSERVER, not an editor. Copy only directly visible',
  'text exactly as printed in this crop.',
  'Reply with ONLY a JSON object:',
  '{"name_en": string|null, "name_ar": string|null, "brand": string|null,',
  ' "size": string|null, "pack_count": string|null, "confidence": number}',
  '',
  'ENGLISH: Copy the directly visible printed English product',
  'name into name_en VERBATIM. Do NOT rewrite, normalize, summarize, translate,',
  'transliterate, reorder words, expand abbreviations, correct spelling, infer',
  'missing words, repair OCR-like spelling, or replace words with synonyms.',
  'If several English names appear, choose the one for the product actually sold.',
  'If that cannot be determined from the crop alone, set name_en to null.',
  '',
  'ARABIC is an independent literal extraction. Copy the printed Arabic product',
  'name into name_ar VERBATIM. Do NOT paraphrase, rewrite, summarize, translate,',
  'transliterate, normalize, repair spelling, or replace words with synonyms.',
  '',
  'The two languages are INDEPENDENT: never translate between them and never',
  '"repair" one language using the other. If one language is absent, set it null',
  '(never translate the other language to fill it).',
  '',
  'FIELD INDEPENDENCE: Observe every field independently from pixels. Never use',
  'name_en to fill name_ar, name_ar to fill name_en, a product name to guess the',
  'brand or size, or brand/size to complete a product name. If a field is not',
  'directly legible in the crop, set that field to null.',
  '',
  'PRODUCT BOUNDARIES: treat this tile as one isolated product. Never combine or',
  'borrow text from a different product, and never complete a name using text',
  'from an adjacent offer. Every field must belong to THIS tile only.',
  '',
  '- brand: the brand name exactly as printed, or null if unbranded/unclear.',
  '  Do not guess a brand that is not visible. Null beats a guess.',
  '- size: pack size as printed, e.g. "1.5L", "400g", "2pcs", or null.',
  '- pack_count: copy the directly visible count-bearing package expression,',
  '  e.g. "6×", "X24", "10+2", "3 Pack", "30s", or "Buy 2 Get 1".',
  '  Inspect the entire product caption for a multiplier on either side of the',
  '  size (for example "6×200 ml", "360mlX24", or "90g*8pcs"). Observe this',
  '  field independently even when size is already populated. Keep it null when',
  '  no multiplier, bonus, or explicit package count is directly visible.',
  '  A price, model number, power/dimension, or usage duration such as "30 NIGHTS"',
  '  is not a package count. Never copy or reinterpret those as pack_count.',
  '- confidence: 0..1, based only on direct visual legibility in this crop.',
  '- NEVER include prices, discounts, or currency anywhere in any field.',
  '- Literal wording is always preferred over interpretation. When uncertain,',
  '  keep the printed wording as seen or leave the field null — never invent,',
  '  hallucinate, or generate marketing language.',
].join('\n');

// bytes -> base64 without Buffer (Workers-safe; chunked to dodge arg limits).
function toBase64(bytes) {
  let bin = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i += 0x8000) {
    bin += String.fromCharCode(...arr.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// A literal observer must never edit a returned field into looking valid. If a
// model violates the no-price contract, reject that whole field rather than
// deleting fragments and silently changing what it said it observed.
const PRICE_IN_FIELD = /(?:^|\s)(?:sar|sr|ريال|رس)\.?\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*(?:sar|sr|ريال|رس)(?=\s|[.,;:]|$)/i;

function literalField(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim(); // JSON-edge whitespace only; preserve internal text verbatim.
  if (!text || PRICE_IN_FIELD.test(text)) return null;
  return text;
}

function literalConfidence(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

// Capture whatever rate-limit signal a Mistral response carries. The free
// "Experiment" tier's exact numbers are ACCOUNT-SPECIFIC and unpublished, so
// the only reliable limit signal is what the provider returns at runtime — we
// surface it verbatim so the Operations Center can show the real limit, usage,
// and reset time (Vision Milestone 2 §3). Returns null when a response carries
// no rate-limit signal at all (the common ok-response case).
export function readRateLimit(res) {
  const h = res && res.headers;
  const get = (k) => (h && typeof h.get === 'function' ? h.get(k) : null);
  const retryAfterRaw = get('retry-after');
  const retryAfter = retryAfterRaw != null && retryAfterRaw !== '' ? Number(retryAfterRaw) : null;
  const out = {
    status: res?.status ?? null,
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : null,
    // Mistral has used both x-ratelimit-* and ratelimitbysize-* over time; read
    // either so the panel keeps working across provider header renames.
    limit: get('x-ratelimit-limit') || get('ratelimitbysize-limit') || null,
    remaining: get('x-ratelimit-remaining') || get('ratelimitbysize-remaining') || null,
    reset: get('x-ratelimit-reset') || get('ratelimitbysize-reset') || null,
    observedAt: new Date().toISOString(),
  };
  const empty = out.retryAfter == null && !out.limit && !out.remaining && !out.reset;
  // On a non-ok response (a 429), always return a signal (at least the status)
  // so the wall is surfaced; only suppress an all-empty capture on an ok body.
  if (empty && res?.ok) return null;
  return out;
}

// Model reply -> a validated partial record, or null when unusable.
export function parseEnrichReply(text) {
  let obj;
  try {
    // Tolerate a fenced or prefixed reply; grab the outermost JSON object.
    const m = /\{[\s\S]*\}/.exec(String(text || ''));
    obj = JSON.parse(m ? m[0] : text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const name = literalField(obj.name_en);
  const nameAr = literalField(obj.name_ar);
  if (!name && !nameAr) return null; // nothing extracted -> no record
  return {
    name,
    nameAr,
    brand: literalField(obj.brand),
    size: literalField(obj.size),
    packCount: literalField(obj.pack_count ?? obj.packCount),
    confidence: literalConfidence(obj.confidence),
  };
}

// Construct the provider payload from crop bytes only. Keeping this pure and
// exported lets tests prove no D4D/offer/registry text can enter the request.
export function buildVisionRequest({ model = DEFAULT_MODEL, contentType = 'image/jpeg', base64 }) {
  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: `data:${contentType};base64,${base64}` } },
        ],
      },
    ],
  };
}

export function buildOcrRequest({ model = DEFAULT_OCR_MODEL, contentType = 'image/jpeg', base64 }) {
  return {
    model,
    document: { type: 'image_url', image_url: `data:${contentType};base64,${base64}` },
  };
}

async function fetchOfferCrop(offer, { fetchImpl = fetch, onCrop = null } = {}) {
  if (!needsEnrichment(offer)) return null;
  const imgRes = await fetchImpl(offer.imageUrl);
  if (!imgRes.ok) {
    const err = new Error(`crop fetch ${imgRes.status}: ${offer.imageUrl}`);
    err.stage = 'crop';
    err.status = imgRes.status;
    throw err;
  }
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
  const bytes = await imgRes.arrayBuffer();
  if (onCrop) await onCrop({ offerId: offer.id, cropUrl: offer.imageUrl, contentType, bytes });
  return { contentType, bytes, base64: toBase64(bytes), cropUrl: offer.imageUrl };
}

async function postMistral(url, body, { apiKey, fetchImpl, stage }) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = new Error(`mistral ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.stage = stage;
    err.status = res.status;
    err.rateLimit = readRateLimit(res);
    if (err.rateLimit?.retryAfter != null) err.retryAfterMs = err.rateLimit.retryAfter * 1000;
    throw err;
  }
  return res.json();
}

async function observeVisionBytes(crop, { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch } = {}) {
  const body = await postMistral(
    MISTRAL_URL,
    buildVisionRequest({ model, contentType: crop.contentType, base64: crop.base64 }),
    { apiKey, fetchImpl, stage: 'mistral' },
  );
  const rawReply = body?.choices?.[0]?.message?.content ?? null;
  let parsedObject = null;
  try {
    const match = /\{[\s\S]*\}/.exec(String(rawReply || ''));
    const candidate = JSON.parse(match ? match[0] : rawReply);
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) parsedObject = candidate;
  } catch {
    // The Smart Vision validator records malformed JSON and decides on OCR.
  }
  return {
    rawReply,
    parsedObject,
    parsed: parseEnrichReply(rawReply),
    model,
    cropUrl: crop.cropUrl,
    observedAt: new Date().toISOString(),
  };
}

async function observeOcrBytes(crop, { apiKey, model = DEFAULT_OCR_MODEL, fetchImpl = fetch } = {}) {
  const body = await postMistral(
    MISTRAL_OCR_URL,
    buildOcrRequest({ model, contentType: crop.contentType, base64: crop.base64 }),
    { apiKey, fetchImpl, stage: 'mistral-ocr' },
  );
  const pages = Array.isArray(body?.pages) ? body.pages : [];
  return {
    rawOutput: pages.map((page) => page?.markdown ?? '').join('\n').trim(),
    model: body?.model || model,
    usage: body?.usage_info ?? body?.usage ?? null,
  };
}

function extractionModel(diagnostics, visionModel, ocrModel) {
  if (diagnostics?.visionRequests && diagnostics?.ocrRequests) return `${visionModel}+${ocrModel}`;
  if (diagnostics?.ocrRequests) return ocrModel;
  return visionModel;
}

function identityFromExtraction(result, mode) {
  return buildIdentityCandidate(
    { ...result.extraction, confidence: result.confidence },
    { mode },
  );
}

// The serving gate historically stored OCR-overlap corroboration. Smart
// Extraction instead has a stronger source-local invariant: every populated
// final field must have passed the validator for the source recorded in its
// provenance. This gate is deliberately source-neutral so OCR-primary strategies
// do not depend on Vision diagnostics.
// Encode that completed validation with the existing numeric gate so all
// downstream SQL/API contracts remain unchanged.
export function validatedExtractionCorroboration(result) {
  const extraction = result?.extraction || {};
  const provenance = result?.provenance || {};
  const diagnostics = result?.diagnostics || {};
  if (!extraction.productName && !extraction.arabicName) return null;
  if (diagnostics.visionRequests > 0 && diagnostics.acceptedVisionFieldsOverwritten !== 0) return null;
  const accepted = {
    Vision: new Set(diagnostics.validationResult?.acceptedFields || []),
    OCR: new Set(diagnostics.ocrValidationResult?.acceptedFields || []),
  };
  const fields = [
    ['productName', 'name_en'],
    ['arabicName', 'name_ar'],
  ];
  for (const [outputField, validationField] of fields) {
    if (!extraction[outputField]) continue;
    const source = provenance[outputField];
    if (!accepted[source]?.has(validationField)) return null;
  }
  return 1;
}

function extractionSource(result) {
  const diagnostics = result?.diagnostics || {};
  if (diagnostics.ocrRequests > 0 && diagnostics.visionRequests === 0) return 'ocr';
  return result?.provenance?.productName === 'OCR' && result?.provenance?.arabicName !== 'Vision'
    ? 'ocr'
    : 'vision';
}

// One auditable provider observation. Unlike enrichOffer(), this preserves the
// raw message content for a controlled validation report even when parsing
// declines it. Raw content remains transient and is never written to D1.
export async function observeOfferCrop(
  offer,
  { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch, onCrop = null } = {},
) {
  if (!apiKey) throw new Error('observeOfferCrop: apiKey is required');
  const crop = await fetchOfferCrop(offer, { fetchImpl, onCrop });
  return crop ? observeVisionBytes(crop, { apiKey, model, fetchImpl }) : null;
}

// Read one offer's crop and return an Enrichment record, or null when the
// model can't identify the product (a null is a fine, honest outcome — the
// offer simply stays as it is today). Throws on transport/auth errors so the
// caller's pacing layer can distinguish "unidentifiable" from "retry later".
export async function enrichOffer(
  offer,
  {
    apiKey,
    model = DEFAULT_MODEL,
    ocrModel = DEFAULT_OCR_MODEL,
    strategy = DEFAULT_EXTRACTION_STRATEGY,
    identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE,
    fetchImpl = fetch,
    onCrop = null,
  } = {},
) {
  if (!apiKey) throw new Error('enrichOffer: apiKey is required');
  const crop = await fetchOfferCrop(offer, { fetchImpl, onCrop });
  if (!crop) return null;
  const result = await runSmartExtraction({
    strategy,
    runVision: () => observeVisionBytes(crop, { apiKey, model, fetchImpl }),
    runOcr: () => observeOcrBytes(crop, { apiKey, model: ocrModel, fetchImpl }),
  });
  const identity = identityFromExtraction(result, identityNormalizationMode);
  const extracted = result.extraction;
  if (!extracted.productName && !extracted.arabicName) return null;
  return {
    offerId: offer.id,
    name: extracted.productName,
    nameAr: extracted.arabicName,
    brand: extracted.brand,
    size: extracted.size,
    confidence: result.confidence,
    corroboration: validatedExtractionCorroboration(result),
    source: extractionSource(result),
    model: extractionModel(result.diagnostics, model, ocrModel),
    cropUrl: crop.cropUrl,
    enrichedAt: new Date().toISOString(),
    provenance: result.provenance,
    diagnostics: result.diagnostics,
    identityCandidate: identity.identityCandidate,
    identityDiagnostics: identity.diagnostics,
  };
}

// enrichOffer with cold-standby key failover (offers/mistralKeys.js). Every
// vision caller — the Worker drain below AND the local backfill script — goes
// through THIS, so failover is implemented exactly once. `keyChain` is a
// createKeyChain over the caller's ordered keys; on an unusable primary the
// call transparently retries on the standby and logs the switch.
export async function observeWithFailover(
  offer,
  { keyChain, model = DEFAULT_MODEL, fetchImpl = fetch, onCrop = null, ...failover } = {},
) {
  return withFailover(
    keyChain,
    (apiKey) => observeOfferCrop(offer, { apiKey, model, fetchImpl, onCrop }),
    failover,
  );
}

export async function enrichWithFailover(
  offer,
  {
    keyChain,
    model = DEFAULT_MODEL,
    ocrModel = DEFAULT_OCR_MODEL,
    strategy = DEFAULT_EXTRACTION_STRATEGY,
    identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE,
    fetchImpl = fetch,
    onCrop = null,
    onDiagnostics = null,
    onIdentityDiagnostics = null,
    ...failover
  } = {},
) {
  const crop = await fetchOfferCrop(offer, { fetchImpl, onCrop });
  if (!crop) return null;
  const result = await runSmartExtraction({
    strategy,
    runVision: () => withFailover(
      keyChain,
      (apiKey) => observeVisionBytes(crop, { apiKey, model, fetchImpl }),
      failover,
    ),
    runOcr: () => withFailover(
      keyChain,
      (apiKey) => observeOcrBytes(crop, { apiKey, model: ocrModel, fetchImpl }),
      failover,
    ),
  });
  if (onDiagnostics) await onDiagnostics(result.diagnostics);
  const identity = identityFromExtraction(result, identityNormalizationMode);
  if (onIdentityDiagnostics) await onIdentityDiagnostics(identity.diagnostics);
  const extracted = result.extraction;
  if (!extracted.productName && !extracted.arabicName) return null;
  return {
    offerId: offer.id,
    name: extracted.productName,
    nameAr: extracted.arabicName,
    brand: extracted.brand,
    size: extracted.size,
    confidence: result.confidence,
    corroboration: validatedExtractionCorroboration(result),
    source: extractionSource(result),
    model: extractionModel(result.diagnostics, model, ocrModel),
    cropUrl: crop.cropUrl,
    enrichedAt: new Date().toISOString(),
    provenance: result.provenance,
    diagnostics: result.diagnostics,
    identityCandidate: identity.identityCandidate,
    identityDiagnostics: identity.diagnostics,
  };
}

// --- the drain -----------------------------------------------------------------
// One PACED enrichment pass: read up to `limit` unattempted debris offers,
// enrich each SEQUENTIALLY (flat call rate — the free tier's per-minute cap is
// the real constraint, not volume), store every verdict. Called by the guarded
// POST /enrich route; the daily cron dispatches a few such children (each with
// its own fresh subrequest budget: ~2 external fetches per offer, so limit 15
// uses ~30 of 50). A transport/auth error stops the batch and stores nothing
// for the failed offer — it retries naturally on a later drain; a "declined"
// verdict IS stored (as a NULL-names row) so a hopeless crop is never paid
// for twice.
export async function drainEnrichment(
  { enrichStore, mistralKey, mistralKeyBackup, keyChain },
  {
    limit = 15,
    currentOn,
    model = DEFAULT_MODEL,
    ocrModel = DEFAULT_OCR_MODEL,
    strategy = DEFAULT_EXTRACTION_STRATEGY,
    identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE,
    fetchImpl = fetch,
    scope = 'all',
    maxRateRetries = 3,
    offerIds = null,
  } = {},
) {
  const selectedStrategy = normalizeExtractionStrategy(strategy);
  const selectedIdentityMode = normalizeIdentityMode(identityNormalizationMode);
  const report = {
    startedAt: new Date().toISOString(),
    scanned: 0, enriched: 0, declined: 0, failed: 0, pruned: 0, failedOver: false,
    // The provider rate-limit signal observed this batch (429 headers), or null.
    // Surfaced so the Operations Center shows the real limit/usage/reset instead
    // of a silent stall (Vision Milestone 2 §3).
    providerLimit: null, errors: [],
    extraction: {
      strategy: selectedStrategy,
      visionRequests: 0,
      ocrRequests: 0,
      ocrTriggered: 0,
      triggerReasons: {},
      processingTimeMs: 0,
    },
    identityBuilder: {
      mode: selectedIdentityMode,
      built: 0,
      valid: 0,
      withRejections: 0,
      unresolvedFields: 0,
      processingTimeMs: 0,
    },
  };
  // Cold-standby key chain: primary then optional backup (MISTRAL_API_KEY /
  // MISTRAL_API_KEY_BACKUP in the Worker). A single-key chain = today's exact
  // behavior. maxRateRetries kept low in the Worker: a persistent 429 with no
  // standby simply stops the batch and retries next fire, as before.
  const chain = keyChain || createKeyChain([mistralKey, mistralKeyBackup]);
  // Follow the offers table first: expired/re-extracted offers take their
  // enrichments with them (D1-only, costs no subrequest budget).
  report.pruned = await enrichStore.pruneOrphans();

  const debris = Array.isArray(offerIds) && offerIds.length
    ? await enrichStore.listSelected({ ids: offerIds, currentOn })
    : await enrichStore.listDebris({ currentOn, limit, scope });
  report.scanned = debris.length;
  const rows = [];
  const recordDiagnostics = (diag) => {
    report.extraction.visionRequests += diag?.visionRequests || 0;
    report.extraction.ocrRequests += diag?.ocrRequests || 0;
    report.extraction.ocrTriggered += diag?.ocrTriggered ? 1 : 0;
    report.extraction.processingTimeMs += diag?.processingTimeMs || 0;
    for (const reason of diag?.triggerReason || []) {
      report.extraction.triggerReasons[reason] = (report.extraction.triggerReasons[reason] || 0) + 1;
    }
  };
  const recordIdentityDiagnostics = (diag) => {
    report.identityBuilder.built += 1;
    report.identityBuilder.valid += diag?.validationResult?.valid ? 1 : 0;
    report.identityBuilder.withRejections += diag?.rejectedFields?.length ? 1 : 0;
    report.identityBuilder.unresolvedFields += diag?.unresolvedFields?.length || 0;
    report.identityBuilder.processingTimeMs += diag?.processingTimeMs || 0;
  };
  for (const d of debris) {
    try {
      const rec = await enrichWithFailover(
        { id: d.id, name: null, nameAr: null, imageUrl: d.image_url },
        {
          keyChain: chain,
          model,
          ocrModel,
          strategy: selectedStrategy,
          identityNormalizationMode: selectedIdentityMode,
          fetchImpl,
          maxRateRetries,
          onDiagnostics: recordDiagnostics,
          onIdentityDiagnostics: recordIdentityDiagnostics,
        },
      );
      if (!rec) {
        report.declined += 1;
        rows.push({ id: d.id, model, crop_url: d.image_url, enriched_at: new Date().toISOString() });
        continue;
      }
      report.enriched += 1;
      rows.push({
        id: d.id,
        name: rec.name,
        name_ar: rec.nameAr,
        brand: rec.brand,
        size: rec.size,
        confidence: rec.confidence,
        // Compatibility carrier for the existing canonical-serving gate. It
        // is non-null only when Smart Extraction accepted each served name
        // from its recorded Vision/OCR source.
        corroboration: rec.corroboration,
        model: rec.model,
        crop_url: rec.cropUrl,
        enriched_at: rec.enrichedAt,
        // Persist the already-built contract because extraction and Registry
        // resolution run in separate Worker invocations. Registry never
        // reconstructs it from these raw observation columns.
        identity_candidate: rec.identityCandidate,
      });
    } catch (err) {
      // Vision Milestone 2 §3 — resilient drain. The OLD behavior aborted the
      // WHOLE batch on the first error, so a single bad crop or a transient 429
      // stranded the rest of the queue behind it (the "~15 batches then it
      // stops" symptom). Now: an ISOLATED per-offer failure (crop 4xx/parse ⇒
      // classify 'other') is recorded and we CONTINUE — one bad tile never
      // blocks the queue. Only a wall that would fail every subsequent offer
      // identically — auth-exhausted keys, a PERSISTENT 429 (failover gave up),
      // or provider 5xx/network trouble ('transient') — stops the batch, which
      // resumes cleanly on the next drain/hop.
      report.failed += 1;
      report.errors.push(String(err.message).slice(0, 200));
      if (err.rateLimit) report.providerLimit = err.rateLimit;
      const kind = classifyMistralError(err);
      if (kind === 'auth' || kind === 'rate' || kind === 'transient') break;
      // 'other' (crop fetch / parse): isolated to this offer — skip it and go on.
    }
  }
  if (rows.length) await enrichStore.upsertMany(rows);
  report.stored = rows.length;
  report.failedOver = chain.failedOver();
  const completedExtractions = report.enriched + report.declined;
  report.extraction.averageProcessingTimeMs = completedExtractions
    ? Math.round((report.extraction.processingTimeMs / completedExtractions) * 100) / 100
    : 0;
  report.extraction.averageRequestsPerOffer = completedExtractions
    ? Math.round(((report.extraction.visionRequests + report.extraction.ocrRequests) / completedExtractions) * 1000) / 1000
    : 0;
  report.identityBuilder.averageProcessingTimeMs = report.identityBuilder.built
    ? Math.round((report.identityBuilder.processingTimeMs / report.identityBuilder.built) * 1000) / 1000
    : 0;
  report.finishedAt = new Date().toISOString();
  return report;
}
