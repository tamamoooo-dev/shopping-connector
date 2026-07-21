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
// names. Spike-calibrated: the one hallucination scored 0.00, every verified
// reading 0.40–1.00 — 0.3 splits the two with margin on both sides.
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
export const DEFAULT_MODEL = 'mistral-small-latest';

// English-first LITERAL-EXTRACTION contract (Vision Milestone 2, 2026-07-19).
// Vision is an EXTRACTION engine, not an editor: it copies what the tile prints,
// verbatim, and does NOT normalize, translate, infer, or "improve" anything —
// the Registry owns all normalization / identity / matching downstream. English
// is the canonical identity (Vision reads it far more reliably than Arabic);
// Arabic is an INDEPENDENT literal extraction that never modifies English and is
// never translated to fill a gap. Product-boundary isolation stops the model
// borrowing words from adjacent tiles. Output schema is UNCHANGED (name_en,
// name_ar, brand, size, confidence) so nothing downstream is affected.
const PROMPT = [
  'This image is ONE product tile cropped from a Saudi supermarket flyer.',
  'You are a literal EXTRACTION engine, not an editor. Copy what is printed.',
  'Reply with ONLY a JSON object:',
  '{"name_en": string|null, "name_ar": string|null, "brand": string|null,',
  ' "size": string|null, "confidence": number}',
  '',
  'ENGLISH is the canonical product identity. Copy the printed English product',
  'name into name_en VERBATIM. Do NOT rewrite, normalize, summarize, translate,',
  'reorder words, expand abbreviations, correct spelling, or infer missing words.',
  'If several English names appear, choose the one for the product actually sold.',
  '',
  'ARABIC is an independent literal extraction. Copy the printed Arabic product',
  'name into name_ar VERBATIM. Do NOT paraphrase, rewrite, summarize, translate,',
  'normalize, or replace words with synonyms.',
  '',
  'The two languages are INDEPENDENT: never translate between them and never',
  '"repair" one language using the other. If one language is absent, set it null',
  '(never translate the other language to fill it).',
  '',
  'PRODUCT BOUNDARIES: treat this tile as one isolated product. Never combine or',
  'borrow text from a different product, and never complete a name using text',
  'from an adjacent offer. Every field must belong to THIS tile only.',
  '',
  '- brand: the brand name exactly as printed, or null if unbranded/unclear.',
  '  Do not guess a brand that is not visible. Null beats a guess.',
  '- size: pack size as printed, e.g. "1.5L", "400g", "2pcs", or null.',
  '- confidence: 0..1, your certainty in the identification overall.',
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

// Strip any price-looking fragments the model emitted despite instructions —
// the names-only rule is enforced in code, not just in the prompt.
function stripPrices(text) {
  if (typeof text !== 'string') return null;
  // NB: no \b around the currency words — JS \b is ASCII-only and never
  // matches next to Arabic letters; explicit whitespace/edge anchors instead.
  const cleaned = text
    .replace(/(?:^|\s)(?:sar|sr|ريال|رس)\.?\s*\d+(?:[.,]\d+)?/gi, ' ')
    .replace(/\d+(?:[.,]\d+)?\s*(?:sar|sr|ريال|رس)(?=\s|[.,;:]|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || null;
}

const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

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
  const name = stripPrices(obj.name_en);
  const nameAr = stripPrices(obj.name_ar);
  if (!name && !nameAr) return null; // nothing extracted -> no record
  return {
    name,
    nameAr,
    brand: stripPrices(obj.brand),
    size: typeof obj.size === 'string' && obj.size.trim() ? obj.size.trim() : null,
    confidence: clamp01(Number(obj.confidence)),
  };
}

// Read one offer's crop and return an Enrichment record, or null when the
// model can't identify the product (a null is a fine, honest outcome — the
// offer simply stays as it is today). Throws on transport/auth errors so the
// caller's pacing layer can distinguish "unidentifiable" from "retry later".
export async function enrichOffer(offer, { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error('enrichOffer: apiKey is required');
  if (!needsEnrichment(offer)) return null;

  const imgRes = await fetchImpl(offer.imageUrl);
  if (!imgRes.ok) {
    // A crop-fetch failure is NEVER a key problem (CDN, not the model) — tag
    // it so the failover classifier never burns a key on it.
    const err = new Error(`crop fetch ${imgRes.status}: ${offer.imageUrl}`);
    err.stage = 'crop';
    err.status = imgRes.status;
    throw err;
  }
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
  const b64 = toBase64(await imgRes.arrayBuffer());

  const res = await fetchImpl(MISTRAL_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${contentType};base64,${b64}` } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) {
    // Model-stage failure — tag with the HTTP status so the failover
    // classifier can tell auth (401/403) from rate/quota (429) from transient
    // (5xx). These are the ONLY errors that can retire a key. On a 429 the
    // provider's own rate-limit headers are the ground truth about the limit —
    // attach them so the drain report and the Ops Center can surface it, and
    // expose retryAfterMs so withFailover waits the exact window (§3).
    const err = new Error(`mistral ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.stage = 'mistral';
    err.status = res.status;
    err.rateLimit = readRateLimit(res);
    if (err.rateLimit?.retryAfter != null) err.retryAfterMs = err.rateLimit.retryAfter * 1000;
    throw err;
  }
  const body = await res.json();
  const parsed = parseEnrichReply(body?.choices?.[0]?.message?.content);
  if (!parsed) return null;

  return {
    offerId: offer.id,
    ...parsed,
    source: 'vision',
    model,
    cropUrl: offer.imageUrl,
    enrichedAt: new Date().toISOString(),
  };
}

// enrichOffer with cold-standby key failover (offers/mistralKeys.js). Every
// vision caller — the Worker drain below AND the local backfill script — goes
// through THIS, so failover is implemented exactly once. `keyChain` is a
// createKeyChain over the caller's ordered keys; on an unusable primary the
// call transparently retries on the standby and logs the switch.
export async function enrichWithFailover(offer, { keyChain, model = DEFAULT_MODEL, fetchImpl = fetch, ...failover } = {}) {
  return withFailover(keyChain, (apiKey) => enrichOffer(offer, { apiKey, model, fetchImpl }), failover);
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
  { limit = 15, currentOn, model = DEFAULT_MODEL, scope = 'all', maxRateRetries = 3 } = {},
) {
  const report = {
    startedAt: new Date().toISOString(),
    scanned: 0, enriched: 0, declined: 0, failed: 0, pruned: 0, failedOver: false,
    // The provider rate-limit signal observed this batch (429 headers), or null.
    // Surfaced so the Operations Center shows the real limit/usage/reset instead
    // of a silent stall (Vision Milestone 2 §3).
    providerLimit: null, errors: [],
  };
  // Cold-standby key chain: primary then optional backup (MISTRAL_API_KEY /
  // MISTRAL_API_KEY_BACKUP in the Worker). A single-key chain = today's exact
  // behavior. maxRateRetries kept low in the Worker: a persistent 429 with no
  // standby simply stops the batch and retries next fire, as before.
  const chain = keyChain || createKeyChain([mistralKey, mistralKeyBackup]);
  // Follow the offers table first: expired/re-extracted offers take their
  // enrichments with them (D1-only, costs no subrequest budget).
  report.pruned = await enrichStore.pruneOrphans();

  const debris = await enrichStore.listDebris({ currentOn, limit, scope });
  report.scanned = debris.length;
  const rows = [];
  for (const d of debris) {
    try {
      const rec = await enrichWithFailover(
        { id: d.id, name: null, nameAr: null, imageUrl: d.image_url },
        { keyChain: chain, model, maxRateRetries },
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
        corroboration: corroboration(rec, d.search_text),
        model: rec.model,
        crop_url: rec.cropUrl,
        enriched_at: rec.enrichedAt,
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
  report.finishedAt = new Date().toISOString();
  return report;
}
