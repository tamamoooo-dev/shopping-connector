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
//   • NAMES ONLY, still — but by CONSTRUCTION now, not by instruction. The
//     frozen prompt (2026-07-25) DOES ask the model for current_price and
//     old_price, because the schema it was validated under includes them. Those
//     prices are stripped from every write any read path can serve
//     (preservedObservation) and survive only in the audit journal, so the
//     serving price path is still unreachable from here. They may not be USED
//     until the deterministic price guard exists — the validation measured the
//     crossed-out price returned as the selling price on 2/50 crops.
//   • GATED. needsEnrichment() admits only offers deriveNames already gave up
//     on (both names null) that still have a crop to read — ~1.1k of ~38k
//     offers (measured 2026-07-18), so a full pass is a rounding error against
//     the API's free tier.
//   • DECOUPLED. Nothing here runs inside the ingest pipeline; the caller
//     (a paced post-ingest step) decides when and how fast. Pure fetch-based,
//     Workers- and Node-compatible.
//
// Model: Mistral `mistral-medium-latest` — the FROZEN production extraction
// baseline adopted 2026-07-25 (see PRODUCTION_EXTRACTION_BASELINE below).
// Configurable — swapping models or providers is a constructor argument, not a
// code change downstream.

import { normalizeText } from '../matching.js';
import {
  createKeyChain,
  withFailover,
  classifyMistralError,
  remainingPercentage,
} from './mistralKeys.js';
import {
  DEFAULT_EXTRACTION_STRATEGY,
  EXTRACTION_PROVENANCE,
  EXTRACTION_STRATEGIES,
  finalizeValidatedExtraction,
  isSelfEvidencingProvenance,
  normalizeExtractionStrategy,
  readObservationField,
  runSmartExtraction,
} from './smartExtraction.js';
import {
  buildIdentityCandidate,
  DEFAULT_IDENTITY_NORMALIZATION_MODE,
  normalizeIdentityMode,
} from './identityBuilder.js';
import { resolveBrand } from '../lexicon/brands.js';
import { isNonGrocery } from '../lexicon/productClass.js';
import {
  COMPARABLE_QUANTITY_EVIDENCE,
  eachPriceFrom,
  resolveComparableQuantity,
  unitPriceFromReference,
} from '../lexicon/comparableQuantity.js';
import {
  BUSINESS_ACCEPTANCE_VERSION,
  MANDATORY_CONDITIONS,
  evaluateBusinessAcceptance,
} from './businessAcceptance.js';
import {
  buildArabicShadow,
  withArabicBuilderShadow,
} from '../lexicon/arabicRollout.js';
import { correctArabicProductName } from '../lexicon/arabicTypoCorrection.js';

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

// --- S5 · RECOVERY QUEUE ADMISSION (C-9) ---------------------------------------
// THE ONE ADMISSION RULE, in one place. A product enters the Recovery Queue
// whenever it fails to produce a SERVABLE CANONICAL PRODUCT. The cause is
// irrelevant to admission and is recorded as metadata only — Business
// Acceptance, the Quality Gate and any future mandatory rule all produce the
// same verdict here and differ solely in what `reasons` says.
//
// "Servable canonical product" is the CONJUNCTION of every mandatory rule:
//
//     grocery complete      = servable(canonicalRow) ∧ S4.accepted
//     non-grocery complete  = (servable(canonicalRow) ∨ accepted source name)
//                             ∧ S4.accepted
//
// `servable()` above keeps its exact meaning — the 2026-07-21 canonical-identity
// gate — and is one path rather than the whole test. This is deliberately
// NOT a redefinition of `servable()` and touches no read path: whether an
// S4-rejected offer should also vanish from Search is a separate question with
// a live production effect, and it is not settled here (C-9).
//
// A MANDATORY RULE THAT DID NOT RUN CANNOT FAIL. When `acceptance` is absent —
// the legacy drain has no verdict to give — admission degrades to the conjuncts
// that were actually evaluated rather than assuming the worst and queueing the
// whole catalogue. That keeps the rule honest under partial evidence instead of
// making "no verdict" a silent third outcome.
//
// A FUTURE MANDATORY RULE ADDS A CONJUNCT HERE and needs no queue change, no
// migration and no new status value. That is the property C-9 exists to buy.
export function recoveryAdmission({
  canonicalRow = null, acceptance = null, triggerReasons = [], offer = null,
} = {}) {
  const isServable = !!canonicalRow && servable(canonicalRow);
  const accepted = acceptance ? acceptance.accepted === true : null;
  // Named/priced non-grocery is intentionally servable AS-IS. Its source name
  // remains the read-path fallback when no canonical enrichment exists; paying
  // another model to manufacture a canonical row for a television is not
  // recovery work the user wants. Unknown categories fail safe to grocery.
  const acceptedAsIs = !!offer && isNonGrocery(offer.category)
    && accepted === true
    && [offer.name, offer.name_ar].some(
      (value) => typeof value === 'string' && value.trim().length > 0,
    );
  const complete = (isServable || acceptedAsIs) && accepted !== false;
  return {
    complete,
    // Metadata, never admission logic. Nothing reads this to decide whether the
    // offer belongs in the queue — `complete` already did.
    reasons: {
      servable: isServable,
      ...(acceptedAsIs ? { acceptedAsIs: true } : {}),
      ...(acceptance
        ? { acceptance: { version: acceptance.version, missing: [...acceptance.missing] } }
        : {}),
      ...(triggerReasons?.length ? { qualityGate: [...triggerReasons] } : {}),
    },
  };
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
  const isServable = servable(enr);
  if (isServable) {
    offer.name = enr.name;
    offer.nameAr = enr.name_ar;
    offer.enriched = true;
    offer.enrichmentModel = row?.e_model ?? null;
  }
  // The PRICE BASIS and the size it was read beside (2026-08-02). Both are
  // additive fields on the read contract and neither can change which offers
  // are returned or how they rank — `unitPrice` is a label the client would
  // otherwise have to re-derive from a name, which is exactly what it was doing
  // and exactly why per-kilo produce showed no unit price at all.
  //
  // Derived here rather than stored, following the same rule as `brand_id` and
  // the Arabic builder: the reader is pure, so the answer is recomputable from
  // columns already selected. No column, no migration.
  applyUnitPrice(offer, row, isServable);
  if (isServable) return row.e_match_text || row.search_text || '';
  return row?.search_text || '';
}

// The read-path projection of the basis. Separate and exported so the two
// mirrors can be compared field by field, and so a caller holding a row without
// enrichment columns still gets a correct (empty) answer rather than a throw.
export function applyUnitPrice(offer, row, isServable = true) {
  // Only a SERVABLE reading may contribute its size/unit: an unservable
  // enrichment is one the vision-canonical gate already refused to display, and
  // a unit price derived from a name we will not show is not evidence.
  const size = isServable ? (row?.e_size ?? null) : null;
  const unit = isServable ? (row?.e_unit ?? null) : null;
  // `offer.name` is ALREADY the canonical display name — the caller overlaid the
  // vision reading above when servable, and left the OCR name otherwise. Reading
  // it from the offer rather than re-picking a column is what keeps this
  // correct across both query shapes (`SELECT o.*` and the aliased ops query).
  const name = offer?.name ?? null;

  // v4 · ONE projection, shared with the Business Acceptance Gate. The read path
  // used to re-derive the size, the basis and the arithmetic itself, which is
  // how the gate and the pricer came to disagree about a "40's" tissue pack.
  // Asking the same question in the same place makes that class of drift
  // unrepresentable.
  const quantity = resolveComparableQuantity({
    size,
    name,
    unit,
    // The retailer's own bilingual text, where 899 live offers state the basis
    // and nothing else does.
    text: [offer?.nameAr, row?.search_text].filter(Boolean).join(' ') || null,
    nonGrocery: isNonGrocery(offer?.category ?? row?.category ?? null),
  });

  offer.size = size;
  offer.sellingMode = quantity.sellingMode;
  offer.priceBasis = quantity.evidence === COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS
    ? {
      unit: quantity.unit,
      quantity: quantity.quantity,
      // The projection prefixes its source with the evidence class
      // ("price_basis:size_field") so a stored verdict is self-describing. The
      // wire contract already says WHICH evidence in `unitPrice.source`, so the
      // prefix would be noise here — the client wants the field it was read from.
      source: String(quantity.source || '').replace(/^price_basis:/, '') || null,
    }
    : null;
  const up = unitPriceFromReference(offer.price, quantity.reference);
  // `source` lets the client tell a PRINTED unit price (the flyer stated it)
  // from a DERIVED one (we divided by a package). It never has to guess, and a
  // future ranker can prefer the printed one without re-reading any text.
  offer.unitPrice = up
    ? { ...up, source: offer.priceBasis ? 'printed' : 'derived' }
    : null;
  // The PER-ITEM price (2026-08-03) — "what does one of the six bottles cost".
  // Additive and display-only: it is a second presentation of `unitPrice`, never
  // a second comparison denominator, so nothing may rank, group, alert or sort
  // on it. Null for every offer that is not a trustworthy multipack, which is
  // most of them (17.1% of unit-priced offers pass).
  //
  // THE PACKAGE TYPE IS PASSED HERE, NOT INTO THE PROJECTION ABOVE, and that is
  // deliberate. Handing it to `resolveComparableQuantity` would make the
  // CONTAINER branch reachable on the read path for the first time, flipping
  // `offer.sellingMode` from null to 'discrete' on every magnitude-less bagged
  // offer — a real, unmeasured change to a field the client already consumes,
  // smuggled in behind an additive one. The gate needs the package type; the
  // projection does not need to change to give it one.
  offer.eachPrice = eachPriceFrom(offer.price, quantity, {
    packageType: isServable ? (row?.e_package_type ?? null) : null,
    name,
  });
  return offer.unitPrice;
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
export const DEFAULT_MODEL = 'mistral-medium-latest';
export const DEFAULT_OCR_MODEL = 'mistral-ocr-latest';

// --- the FROZEN production extraction baseline (2026-07-25) --------------------
// Adopted by engineering decision after the 50-crop production validation
// (benchmarks/mistral-medium-production-validation-50-2026-07-25/). The prompt
// below is the "Verbatim Prompt" — the exact string that was validated, byte for
// byte; PRODUCTION-PROMPT.md in that folder is its frozen record and
// production-prompt.txt its canonical copy.
//
// ⚠️ PROMPT OPTIMIZATION IS CLOSED. Do not edit, reword, reflow, merge or "tidy"
// this string, and do not run prompt experiments against it, unless the user
// explicitly asks. Replacing it requires a larger production validation plus an
// explicit decision. Quality work now belongs DOWNSTREAM of extraction (brand
// lexicon, phrase lexicon, canonicalization, product identity, search).
//
// The array-of-lines form is deliberate: joining with an explicit '\n' makes the
// string independent of this file's own line endings, so the frozen sha256 below
// cannot drift when a tool rewrites CRLF/LF. enrich.test.mjs asserts the hash.
export const VISION_PROMPT_SHA256 =
  'e643b2a1b833d12256e0e3806b04c28bc5fd042bf3a86b647b989df9be7c3557';

export const VISION_PROMPT = [
  'You are extracting one advertised product from one Saudi retail flyer crop.',
  'The pixels are the only source of truth. Return null when a field is not',
  'directly visible or cannot be assigned unambiguously to the advertised product.',
  '',
  'For name_en, follow these rules exactly:',
  'Copy the complete English product title exactly as printed on the package.',
  'Do not remove the brand.',
  'Do not remove the size.',
  'Do not normalize.',
  'Do not correct spelling.',
  'Do not abbreviate.',
  'Return the exact visible text.',
  '',
  'Arabic is an independent literal display caption, not a translation. Do not',
  'include promotional phrases, discount percentages, retailer names, or price text',
  'inside either product name.',
  '',
  'For price: current_price is the visibly promoted selling price. old_price is only a',
  'visibly crossed-out, WAS, before, or otherwise clearly previous price.',
  '',
  'Return exactly one JSON object with:',
  '{',
  '  "name_en": string|null,',
  '  "name_ar": string|null,',
  '  "brand": string|null,',
  '  "current_price": number|null,',
  '  "old_price": number|null,',
  '  "unit": string|null,',
  '  "package_size": string|null,',
  '  "quantity": string|null,',
  '  "package_type": string|null,',
  '  "attributes": string[],',
  '  "confidence": number|null',
  '}',
  '',
  'The brand and the size must ALSO be repeated in their own fields. Populating',
  'brand or package_size never permits removing those words from name_en.',
  '',
  'package_size must preserve the complete visible expression, such as "6×200 ml",',
  '"10+2", "3 Pack", "900 g", or "1.5 L". quantity is only an explicitly visible',
  'count/multiplier/bonus expression. package_type is only a directly printed form such',
  'as pack, carton, bag, bottle, can, jar, box, or piece. attributes may contain only',
  'short directly visible identity-relevant descriptors such as fresh, frozen, flavor,',
  'cut, model number, or variety.',
].join('\n');

// The request settings the baseline was validated under, kept beside the prompt
// so "the configuration" is one object rather than scattered literals. Changing
// any of these changes what was measured — treat them as frozen too.
export const PRODUCTION_EXTRACTION_BASELINE = Object.freeze({
  adoptedOn: '2026-07-25',
  model: DEFAULT_MODEL,
  promptSha256: VISION_PROMPT_SHA256,
  schema: 'expanded-json-v1',
  temperature: 0,
  topP: 1,
  reasoningEffort: 'none',
  responseFormat: 'json_object',
  ocr: false,
  requestsPerCrop: 1,
  record: 'benchmarks/mistral-medium-production-validation-50-2026-07-25/PRODUCTION-PROMPT.md',
});

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
    // Current Mistral completion headers (observed 2026-07-30). Requests and
    // tokens are separate constraints; the UI and balancer use the lower
    // percentage so a key never looks healthy when either wall is nearly hit.
    limitRequestsMinute: get('x-ratelimit-limit-req-minute') || null,
    remainingRequestsMinute: get('x-ratelimit-remaining-req-minute') || null,
    limitTokensMinute: get('x-ratelimit-limit-tokens-minute') || null,
    remainingTokensMinute: get('x-ratelimit-remaining-tokens-minute') || null,
    limitTokensMonth: get('x-ratelimit-limit-tokens-month') || null,
    remainingTokensMonth: get('x-ratelimit-remaining-tokens-month') || null,
    limitOcrPagesMinute: get('x-ratelimit-limit-ocr-pages-minute') || null,
    remainingOcrPagesMinute: get('x-ratelimit-remaining-ocr-pages-minute') || null,
    queryTokens: get('x-ratelimit-tokens-query-cost') || null,
    queryOcrPages: get('x-ratelimit-ocr-pages-query-cost') || null,
    observedAt: new Date().toISOString(),
  };
  out.remainingPct = remainingPercentage(out);
  const empty =
    out.retryAfter == null &&
    !out.limit &&
    !out.remaining &&
    !out.reset &&
    out.remainingPct == null;
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
  const name = literalField(readObservationField(obj, 'name_en'));
  const nameAr = literalField(readObservationField(obj, 'name_ar'));
  if (!name && !nameAr) return null; // nothing extracted -> no record
  return {
    name,
    nameAr,
    brand: literalField(readObservationField(obj, 'brand')),
    // Expanded JSON: package_size -> size, quantity -> pack_count. The alias
    // reader keeps legacy replies parsing identically.
    size: literalField(readObservationField(obj, 'size')),
    packCount: literalField(readObservationField(obj, 'pack_count')),
    confidence: literalConfidence(obj.confidence),
  };
}

// --- Expanded JSON: what is kept, and what is deliberately quarantined ---------
// The frozen baseline's schema returns eleven fields. Five map onto the existing
// validated extraction contract (name_en, name_ar, brand, package_size -> size,
// quantity -> pack_count) and confidence is stored as before. The rest — unit,
// package_type, attributes — are real observations that nothing consumes YET, so
// they are preserved verbatim beside the record rather than dropped; downstream
// identity/canonicalization work is expected to use them.
//
// PRICES ARE THE EXCEPTION. The side-car has never held a price and still must
// not: the validation measured a current-price ROLE INVERSION on 2/50 crops (the
// crossed-out price returned as the selling price, at 0.99+ self-reported
// confidence, identically under both prompts). A deterministic price guard is
// mandatory before any extracted price may reach a shopper and that guard does
// not exist yet, so no price may enter a row any read path can serve. The full
// unedited model reply — prices included — is still journaled per offer in
// offer_extraction_attempts.output, so nothing the model returned is lost.
export const QUARANTINED_OBSERVATION_FIELDS = Object.freeze([
  'current_price', 'old_price', 'new_price', 'price', 'prices', 'unit_price',
  'discount', 'currency',
]);

// The servable-side copy of one model observation: everything it returned except
// the quarantined price fields, with empty values dropped (the schema is fixed,
// so an absent key means the model returned null). Returns null when nothing
// survives, so the column stays NULL rather than holding an empty object.
export function preservedObservation(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null;
  const kept = {};
  for (const [key, value] of Object.entries(output)) {
    if (QUARANTINED_OBSERVATION_FIELDS.includes(key)) continue;
    if (value == null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    kept[key] = value;
  }
  return Object.keys(kept).length ? kept : null;
}

// Construct the provider payload from crop bytes only. Keeping this pure and
// exported lets tests prove no D4D/offer/registry text can enter the request.
//
// Every field here is the FROZEN baseline's validated request (2026-07-25):
// temperature 0, top_p 1, reasoning_effort 'none', json_object, exactly one
// user message carrying the prompt and one image. `image_url` is the bare
// data-URL string, which is the form the 50-crop validation actually ran — the
// OpenAI-compatible `{ url }` object is equivalent for Mistral, but only the
// string form is measured, so that is what production sends.
export function buildVisionRequest({ model = DEFAULT_MODEL, contentType = 'image/jpeg', base64 }) {
  return {
    model,
    temperature: 0,
    top_p: 1,
    reasoning_effort: 'none',
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: `data:${contentType};base64,${base64}` },
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
  return {
    body: await res.json(),
    rateLimit: readRateLimit(res),
  };
}

async function observeVisionBytes(crop, { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch } = {}) {
  const response = await postMistral(
    MISTRAL_URL,
    buildVisionRequest({ model, contentType: crop.contentType, base64: crop.base64 }),
    { apiKey, fetchImpl, stage: 'mistral' },
  );
  const body = response.body;
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
    rateLimit: response.rateLimit,
  };
}

async function observeOcrBytes(crop, { apiKey, model = DEFAULT_OCR_MODEL, fetchImpl = fetch } = {}) {
  const response = await postMistral(
    MISTRAL_OCR_URL,
    buildOcrRequest({ model, contentType: crop.contentType, base64: crop.base64 }),
    { apiKey, fetchImpl, stage: 'mistral-ocr' },
  );
  const body = response.body;
  const pages = Array.isArray(body?.pages) ? body.pages : [];
  return {
    rawOutput: pages.map((page) => page?.markdown ?? '').join('\n').trim(),
    model: body?.model || model,
    usage: body?.usage_info ?? body?.usage ?? null,
    rateLimit: response.rateLimit,
  };
}

function extractionModel(diagnostics, visionModel, ocrModel) {
  const hasVision = diagnostics?.visionAttemptPresent || diagnostics?.visionRequests;
  const hasOcr = diagnostics?.ocrAttemptPresent || diagnostics?.ocrRequests;
  if (hasVision && hasOcr) return `${visionModel}+${ocrModel}`;
  if (hasOcr) return ocrModel;
  return visionModel;
}

function canonicalExtraction(extracted) {
  if (!extracted) return extracted;
  const arabicName = correctArabicProductName({
    englishName: extracted.productName,
    arabicName: extracted.arabicName,
  });
  return arabicName === extracted.arabicName ? extracted : { ...extracted, arabicName };
}

function identityFromExtraction(result, mode, extracted = result.extraction) {
  return buildIdentityCandidate(
    { ...extracted, confidence: result.confidence },
    { mode },
  );
}

// The post-extraction lexicon layers (HISTORY §47), run over ONE observation.
//
// English-primary by directive: the structured record is built from `name_en`,
// and the Arabic name is GENERATED from that structure — the observed Arabic
// OCR text is a fallback source, never an input. Everything here is pure, so
// like the Brand Lexicon (§45) it is derivable on read and nothing is
// persisted; `enrichStore` binds columns explicitly, so it cannot reach D1.
//
// `name_ar` below carries the canonical extraction Arabic: normally byte-for-
// byte observed text, or one explicitly reviewed typo token when the English
// name proves the intended word. The untouched model output remains in
// extraction_json for audit. The built name and its diagnostics are persisted
// there too; the global read-path policy still decides which presentation to
// expose.
export function productKnowledge(extracted, observation, commerceContext = {}) {
  extracted = canonicalExtraction(extracted);
  return buildArabicShadow({
    name_en: extracted.productName,
    name_ar: extracted.arabicName,
    brand: extracted.brand,
    size: extracted.size,
    pack_count: extracted.packCount,
    // Expanded JSON fields (§44) that until now nothing read.
    package_type: observation?.package_type ?? null,
    attributes: observation?.attributes ?? null,
    // Commerce Score reads the authoritative offer row only. Quarantined model
    // price fields never enter preservedObservation and cannot reach this path.
    price: commerceContext?.price ?? null,
    currency: commerceContext?.currency ?? null,
    // v2 · the retailer's own classification, from the offer row (C-2), so the
    // size parser knows a trailing "5G" on a phone is a radio and not five
    // grams. Threaded here rather than only at the gate because the STRUCTURED
    // PRODUCT is what search, matching and the Registry read — a gate that
    // ignored a fake size while the stored record kept it would be a fix in
    // name only.
    non_grocery: isNonGrocery(commerceContext?.category),
  });
}

export function canonicalRowFromResult(offerId, crop, result, {
  model = DEFAULT_MODEL,
  ocrModel = DEFAULT_OCR_MODEL,
  identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE,
  enrichedAt = new Date().toISOString(),
  commerceContext = {},
} = {}) {
  const extracted = canonicalExtraction(result.extraction);
  const hasName = !!(extracted.productName || extracted.arabicName);
  const identity = hasName
    ? identityFromExtraction(result, identityNormalizationMode, extracted)
    : null;
  const observation = preservedObservation(result?.diagnostics?.visionOutput);
  const knowledge = productKnowledge(extracted, observation, commerceContext);
  return {
    id: offerId,
    name: extracted.productName,
    name_ar: extracted.arabicName,
    brand: extracted.brand,
    size: extracted.size,
    confidence: result.confidence,
    corroboration: validatedExtractionCorroboration(result),
    model: extractionModel(result.diagnostics, model, ocrModel),
    crop_url: crop?.cropUrl ?? null,
    enriched_at: enrichedAt,
    // Expanded JSON fields nothing consumes yet (unit, package_type,
    // attributes, and the verbatim observed names/size), price-free.
    extraction_json: withArabicBuilderShadow(observation, knowledge.arabicBuilder),
    // Structured Product + Arabic Builder (HISTORY §47) — additive runtime
    // values; the compact rollout shadow above is persisted without a schema
    // migration.
    structured_product: knowledge.structuredProduct,
    arabic_name: knowledge.arabicName,
    arabic_builder: knowledge.arabicBuilder,
    identity_candidate: identity?.identityCandidate ?? null,
    identityDiagnostics: identity?.diagnostics ?? null,
    // Brand Lexicon (HISTORY §45): the canonical brand identity for the brand
    // the model observed. ADDITIVE and NOT PERSISTED — `brand` above still
    // stores the verbatim observation, and because resolveBrand() is pure,
    // `brand_id` is derivable from that column on read at any time. No column,
    // no migration; persistence is a later phase's denormalization decision.
    brand_identity: resolveBrand(extracted.brand),
  };
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
    [EXTRACTION_PROVENANCE.VISION]: new Set(diagnostics.validationResult?.acceptedFields || []),
    [EXTRACTION_PROVENANCE.OCR]: new Set(diagnostics.ocrValidationResult?.acceptedFields || []),
  };
  const fields = [
    ['productName', 'name_en'],
    ['arabicName', 'name_ar'],
  ];
  for (const [outputField, validationField] of fields) {
    if (!extraction[outputField]) continue;
    const source = provenance[outputField];
    // A human edit is self-evidencing (R1, C-7). Requiring validator agreement
    // here is what made a reviewed row NON-SERVABLE: `accepted.Human` did not
    // exist, so a developer-approved name failed the gate and the review tool
    // silently accomplished nothing. The reviewer looked at the crop, which is
    // strictly more evidence than any validator had.
    if (isSelfEvidencingProvenance(source)) continue;
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
  const extracted = canonicalExtraction(result.extraction);
  const identity = identityFromExtraction(result, identityNormalizationMode, extracted);
  if (!extracted.productName && !extracted.arabicName) return null;
  const observation = preservedObservation(result.diagnostics.visionOutput);
  const knowledge = productKnowledge(extracted, observation, offer);
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
    observation: withArabicBuilderShadow(observation, knowledge.arabicBuilder),
    provenance: result.provenance,
    diagnostics: result.diagnostics,
    identityCandidate: identity.identityCandidate,
    identityDiagnostics: identity.diagnostics,
    // Brand Lexicon (HISTORY §45) — additive; `brand` above stays verbatim.
    brandIdentity: resolveBrand(extracted.brand),
    // Structured Product + Arabic Builder (HISTORY §47) — additive; `nameAr`
    // above is the canonical one-token-safe Arabic. Serving selection is downstream.
    ...knowledge,
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
  const extractedAttempt = await extractWithFailover(offer, {
    keyChain,
    model,
    ocrModel,
    strategy,
    fetchImpl,
    onCrop,
    ...failover,
  });
  if (!extractedAttempt) return null;
  const { crop, result } = extractedAttempt;
  if (onDiagnostics) await onDiagnostics(result.diagnostics);
  const extracted = canonicalExtraction(result.extraction);
  const identity = identityFromExtraction(result, identityNormalizationMode, extracted);
  if (onIdentityDiagnostics) await onIdentityDiagnostics(identity.diagnostics);
  if (!extracted.productName && !extracted.arabicName) return null;
  const observation = preservedObservation(result.diagnostics.visionOutput);
  const knowledge = productKnowledge(extracted, observation, offer);
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
    observation: withArabicBuilderShadow(observation, knowledge.arabicBuilder),
    provenance: result.provenance,
    diagnostics: result.diagnostics,
    identityCandidate: identity.identityCandidate,
    identityDiagnostics: identity.diagnostics,
    // Brand Lexicon (HISTORY §45) — additive; `brand` above stays verbatim.
    brandIdentity: resolveBrand(extracted.brand),
    // Structured Product + Arabic Builder (HISTORY §47) — additive; `nameAr`
    // above is the canonical one-token-safe Arabic. Serving selection is downstream.
    ...knowledge,
  };
}

// Exported for the S5 recovery processors, which run the same extraction path
// the drains do. Additive — no caller changes, no behaviour changes.
export async function extractWithFailover(
  offer,
  {
    keyChain,
    model = DEFAULT_MODEL,
    ocrModel = DEFAULT_OCR_MODEL,
    strategy = DEFAULT_EXTRACTION_STRATEGY,
    fetchImpl = fetch,
    onCrop = null,
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
  return { crop, result };
}

function finishDrainReport(report, chain) {
  report.failedOver = chain?.failedOver?.() || false;
  report.keyUsage = chain?.snapshot?.() || [];
  const completedExtractions = report.enriched + report.declined + (report.ocrPending || 0);
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
    scanned: 0, enriched: 0, declined: 0, ocrPending: 0,
    failed: 0, pruned: 0, stored: 0, failedOver: false,
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
    // S4 Business Acceptance, per batch (R5, R6). Reported alongside queue depth
    // because queue depth alone cannot tell a well-tuned gate from one that
    // rejects everything for a single reason. `missing` is per-condition and the
    // buckets OVERLAP by design — never summarise it to a count of rejects.
    acceptance: {
      version: BUSINESS_ACCEPTANCE_VERSION,
      judged: 0,
      accepted: 0,
      rejected: 0,
      persisted: 0,
      missing: Object.fromEntries(MANDATORY_CONDITIONS.map((c) => [c, 0])),
    },
    // S5 Recovery Queue admission (C-9). `admitted` is the pipeline's verdict,
    // `queued` is what was durably written; they diverge only when the
    // migration is missing, which is the intended signal.
    recovery: { admitted: 0, queued: 0 },
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
  const recordDiagnostics = (diag, { recordReasons = true } = {}) => {
    report.extraction.visionRequests += diag?.visionRequests || 0;
    report.extraction.ocrRequests += diag?.ocrRequests || 0;
    report.extraction.ocrTriggered += diag?.ocrTriggered ? 1 : 0;
    report.extraction.processingTimeMs += diag?.processingTimeMs || 0;
    if (recordReasons) {
      for (const reason of diag?.triggerReason || []) {
        report.extraction.triggerReasons[reason] = (report.extraction.triggerReasons[reason] || 0) + 1;
      }
    }
  };
  // Per-condition tallies, straight off the verdict (R6). No aggregation into a
  // single "reasons" count: `missing.comparable_quantity = 40` is a decision an
  // operator can act on, `rejected = 40` is not.
  const recordAcceptance = (verdict) => {
    report.acceptance.judged += 1;
    if (verdict.accepted) report.acceptance.accepted += 1;
    else report.acceptance.rejected += 1;
    for (const condition of verdict.missing) {
      report.acceptance.missing[condition] = (report.acceptance.missing[condition] || 0) + 1;
    }
  };
  const recordIdentityDiagnostics = (diag) => {
    report.identityBuilder.built += 1;
    report.identityBuilder.valid += diag?.validationResult?.valid ? 1 : 0;
    report.identityBuilder.withRejections += diag?.rejectedFields?.length ? 1 : 0;
    report.identityBuilder.unresolvedFields += diag?.unresolvedFields?.length || 0;
    report.identityBuilder.processingTimeMs += diag?.processingTimeMs || 0;
  };

  // Production Vision First is deliberately two-stage. This drain performs
  // exactly one Vision request per offer and never calls OCR. Quality Gate
  // failures are durably marked ocr_pending for the independent OCR drain.
  if (selectedStrategy === EXTRACTION_STRATEGIES.VISION_FIRST) {
    if (typeof enrichStore.saveVisionOutcome !== 'function') {
      throw new Error('Vision-first queue migration is not applied (saveVisionOutcome unavailable)');
    }
    for (const d of debris) {
      try {
        const observed = await extractWithFailover(
          { id: d.id, name: null, nameAr: null, imageUrl: d.image_url },
          {
            keyChain: chain,
            model,
            strategy: EXTRACTION_STRATEGIES.VISION_ONLY,
            fetchImpl,
            maxRateRetries,
          },
        );
        if (!observed) throw new Error('Offer crop was unavailable');
        const { crop, result } = observed;
        recordDiagnostics(result.diagnostics, { recordReasons: false });
        const validation = result.diagnostics.validationResult;
        const passed = !validation.ocrRequired;
        const attemptedAt = new Date().toISOString();
        const canonicalRow = passed
          ? canonicalRowFromResult(d.id, crop, result, {
              model,
              ocrModel,
              identityNormalizationMode: selectedIdentityMode,
              enrichedAt: attemptedAt,
              commerceContext: d,
            })
          : null;
        if (canonicalRow?.identityDiagnostics) recordIdentityDiagnostics(canonicalRow.identityDiagnostics);
        // S4 runs on EVERY extraction, not only the ones that cleared the
        // Quality Gate (R5). The two branches differ only in where Comparable
        // Quantity comes from: a passed row already has a Structured Product,
        // while a rejected one has none — so the gate falls back to the
        // preserved observation, which is precisely why that fallback exists.
        // Skipping rejects here would hide the population most in need of
        // calibration, since a Quality Gate reject is the likeliest S4 reject.
        const acceptance = evaluateBusinessAcceptance({
          offer: d,
          acceptedFields: validation.acceptedFields || [],
          structured: canonicalRow?.structured_product ?? null,
          observation: canonicalRow
            ? null
            : preservedObservation(result.diagnostics.visionOutput),
        });
        recordAcceptance(acceptance);
        // S5 admission (C-9), decided HERE because the rule needs both
        // conjuncts — `servable()` and the S4 verdict — and must have exactly
        // one definition. The store commits the decision; it never re-derives it.
        const recovery = recoveryAdmission({
          canonicalRow,
          acceptance,
          triggerReasons: validation.triggerReasons || [],
          offer: d,
        });
        const outcome = await enrichStore.saveVisionOutcome({
          attempt: {
            offerId: d.id,
            source: 'vision',
            output: result.diagnostics.visionOutput,
            validation,
            confidence: result.confidence,
            model,
            cropUrl: crop.cropUrl,
            accepted: passed,
            attemptedAt,
          },
          canonicalRow,
          triggerReasons: validation.triggerReasons || [],
          acceptance,
          recovery,
        });
        // Distinguishes "the gate judged it" from "the judgement was stored".
        // Before the migration is applied the two diverge, and an operator
        // reading a zero here should see the cause is a missing table, not a
        // gate that stopped running.
        if (outcome?.verdictStored) report.acceptance.persisted += 1;
        // Separates "the pipeline judged it incomplete" from "a queue row was
        // written", exactly as `judged` vs `persisted` does for the verdict.
        // Before the migration the two diverge, and an operator reading a zero
        // should see a missing table rather than a queue that stopped filling.
        if (!recovery.complete) report.recovery.admitted += 1;
        if (outcome?.recoveryQueued) report.recovery.queued += 1;
        report.stored += 1;
        if (passed) report.enriched += 1;
        else {
          report.ocrPending += 1;
          report.extraction.ocrTriggered += 1;
          for (const reason of validation.triggerReasons || []) {
            report.extraction.triggerReasons[reason] = (report.extraction.triggerReasons[reason] || 0) + 1;
          }
        }
      } catch (err) {
        report.failed += 1;
        report.errors.push(String(err.message).slice(0, 200));
        if (err.rateLimit) report.providerLimit = err.rateLimit;
        const kind = classifyMistralError(err);
        if (kind === 'auth' || kind === 'rate' || kind === 'transient') break;
      }
    }
    return finishDrainReport(report, chain);
  }

  // LEGACY / OCR-first drain. Reached only by a runtime `strategy` override or a
  // changed EXTRACTION_STRATEGY — production is `vision-first` above.
  //
  // ⚠️ SCOPE BOUNDARY, recorded rather than left to be discovered: S4 verdicts
  // are NOT persisted on this path (R5 covers the vision-first drain only). This
  // path commits through `upsertMany`, which has no atomic attempt+verdict batch
  // to join — the property that makes the verdict write safe above. Wiring it
  // here means restructuring a legacy write path, which is a larger and riskier
  // change than this increment should make silently, so it is left for the S5
  // Recovery Queue work that will touch this area deliberately (C-8).
  //
  // Consequence while this stands: if an operator overrides the strategy, the
  // batch enriches normally but contributes no calibration data. It is visible,
  // not silent — `report.acceptance.judged` stays 0 for such a batch.
  for (const d of debris) {
    try {
      const rec = await enrichWithFailover(
        {
          id: d.id,
          name: null,
          nameAr: null,
          imageUrl: d.image_url,
          price: d.price,
          currency: d.currency,
        },
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
        // Expanded JSON fields nothing consumes yet, price-free (see
        // preservedObservation): the legacy write path preserves them too.
        extraction_json: rec.observation,
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
  return finishDrainReport(report, chain);
}

// Independent OCR escalation drain. It consumes only persisted Quality Gate
// rejects, never invokes Vision, and leaves failures as ocr_pending with a
// bounded retry delay. Canonical output is written only after OCR validation
// and the existing immutable-Vision merge have completed.
export async function drainOcrEnrichment(
  { enrichStore, mistralOcrKey, mistralOcrKeyBackup, keyChain },
  {
    limit = 5,
    currentOn,
    model = DEFAULT_MODEL,
    ocrModel = DEFAULT_OCR_MODEL,
    identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE,
    fetchImpl = fetch,
    maxRateRetries = 0,
  } = {},
) {
  const startedAt = new Date().toISOString();
  const report = {
    startedAt,
    scanned: 0,
    completed: 0,
    failed: 0,
    pending: await enrichStore.countPendingOcr(currentOn),
    ocrRequests: 0,
    failedOver: false,
    providerLimit: null,
    errors: [],
  };
  const chain = keyChain || createKeyChain([mistralOcrKey, mistralOcrKeyBackup]);
  if (!chain.hasKeys()) {
    report.unavailable = true;
    report.keyUsage = [];
    report.finishedAt = new Date().toISOString();
    return report;
  }
  const selectedIdentityMode = normalizeIdentityMode(identityNormalizationMode);
  const pending = await enrichStore.listPendingOcr({ currentOn, limit });
  report.scanned = pending.length;
  for (const d of pending) {
    try {
      const observed = await extractWithFailover(
        { id: d.id, name: null, nameAr: null, imageUrl: d.image_url },
        {
          keyChain: chain,
          ocrModel,
          strategy: EXTRACTION_STRATEGIES.OCR_ONLY,
          fetchImpl,
          maxRateRetries,
        },
      );
      if (!observed) throw new Error('Offer crop was unavailable');
      const { crop, result: ocrResult } = observed;
      report.ocrRequests += ocrResult.diagnostics.ocrRequests || 0;
      const result = finalizeValidatedExtraction({
        strategy: EXTRACTION_STRATEGIES.VISION_FIRST,
        visionOutput: d.vision_output,
        visionValidation: d.vision_validation,
        ocrOutput: ocrResult.diagnostics.ocrOutput,
        ocrValidation: ocrResult.diagnostics.ocrValidationResult,
        visionRequests: 0,
        ocrRequests: ocrResult.diagnostics.ocrRequests || 0,
        visionAttemptPresent: true,
        ocrAttemptPresent: true,
        processingTimeMs: ocrResult.diagnostics.processingTimeMs,
      });
      const attemptedAt = new Date().toISOString();
      const canonicalRow = canonicalRowFromResult(d.id, crop, result, {
        model: d.vision_model || model,
        ocrModel,
        identityNormalizationMode: selectedIdentityMode,
        enrichedAt: attemptedAt,
        commerceContext: d,
      });
      await enrichStore.saveOcrOutcome({
        attempt: {
          offerId: d.id,
          source: 'ocr',
          output: ocrResult.diagnostics.ocrOutput,
          validation: ocrResult.diagnostics.ocrValidationResult,
          confidence: ocrResult.confidence,
          model: ocrModel,
          cropUrl: crop.cropUrl,
          accepted: ocrResult.diagnostics.ocrValidationResult.acceptedFields.length > 0,
          attemptedAt,
        },
        canonicalRow,
      });
      report.completed += 1;
    } catch (err) {
      report.failed += 1;
      report.errors.push(String(err.message).slice(0, 200));
      if (err.rateLimit) report.providerLimit = err.rateLimit;
      const attempts = Number(d.attempts) || 0;
      const retryMinutes = Math.min(360, 2 ** Math.min(attempts, 8));
      const retryAt = new Date(Date.now() + retryMinutes * 60_000).toISOString();
      await enrichStore.markOcrPending(d.id, err.message, { retryAt });
      const kind = classifyMistralError(err);
      if (kind === 'auth' || kind === 'rate' || kind === 'transient') break;
    }
  }
  report.failedOver = chain.failedOver();
  report.keyUsage = chain.snapshot?.() || [];
  report.remaining = await enrichStore.countPendingOcr(currentOn);
  report.finishedAt = new Date().toISOString();
  return report;
}
