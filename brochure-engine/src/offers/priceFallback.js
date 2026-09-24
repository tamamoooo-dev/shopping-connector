// offers/priceFallback.js — the VISION PRICE FALLBACK for source records that
// arrive without a usable price.
//
// WHY. Since 2026-09-22 D4D publishes new flyers' per-product records with
// price/was_price "0.000" (verified live 2026-09-24: Othaim, Tamimi and Prime
// 0/500 priced; City Flower's 09-15 flyers still priced, its 09-22 flyer 0/228).
// buildOffer's price gate drops them, so current flyers had no offers at all.
//
// THE CONTRACT (each rule is load-bearing):
//   • A D4D price is authoritative whenever it exists. Only unpriced records
//     reach this module, and an offer row D4D has priced is never touched.
//   • One reader: Ministral 3 14B (mistralKeys.js `ministral14` pool). Never
//     Medium, Small or OCR.
//   • A single reading is never enough. The same crop is read repeatedly until
//     TWO CONSECUTIVE readings return the same current price (±0.01), up to a
//     bounded maximum. No agreement -> rejected, never guessed.
//   • Agreement alone is not enough either. Measured 2026-09-24 over 226
//     historical readings: the model returns the CROSSED-OUT price as the
//     current one consistently (crop 8: 44.99 on 5/5 readings, true price 30),
//     so repeated agreement accepted both known swaps. The candidate must
//     therefore be supported by D4D's own OCR description of the product, and
//     the description must not show a lower price that would make the
//     candidate the WAS price. Offline simulation over 446 real priced D4D
//     items: wrong prices accepted 3.5-9.4% without this check, 0.03-0.18%
//     with it; ~97% of simulated swaps rejected.
//   • An accepted price becomes a NORMAL offer with price_source='vision'.
//   • Every item is decided once. Transient failures retry a bounded number of
//     drain attempts, then the item is rejected; nothing loops forever.

import { buildOffer, offerToRow } from './contract.js';
import { buildVisionRequest, MISTRAL_URL, postMistral, toBase64, visionObservationFromReply } from './enrich.js';
import { withFailover, classifyMistralError } from './mistralKeys.js';
import { deriveIdentity } from '../priceHistory.js';
import { detectBrand } from '../browse/brands.js';

export const PRICE_FALLBACK_DEFAULTS = Object.freeze({
  // Simulation (446 items x 25 runs): acceptance levels off at 4-5 readings and
  // wrong acceptances stay flat at every bound; 6 leaves headroom for a
  // model that disagrees more often. Overridable per deployment.
  maxReadings: 6,
  // Consecutive agreement is only evidence when readings can differ: at
  // temperature 0 the second reading repeats the first by construction.
  // Safety was insensitive to temperature in simulation (the description
  // check carries it); a moderate value lets a wrong first read be outvoted.
  temperature: 0.3,
  // Drain attempts that may end in a TRANSIENT error before the item is rejected.
  maxDrainAttempts: 3,
  // External subrequests one invocation may spend (crop fetches + readings).
  subrequestBudget: 45,
});

const eq = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.01;

// --- one reading -----------------------------------------------------------------
// A model reply -> { current, old } or null. The single-reading safety rules:
// current positive and finite; an old price, when given, must be higher.
// Anything else is an INVALID reading and breaks a consecutive run.
export function priceReading(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const current = Number(parsed.current_price);
  if (parsed.current_price == null || !Number.isFinite(current) || current <= 0) return null;
  let old = parsed.old_price == null || parsed.old_price === '' ? null : Number(parsed.old_price);
  if (old != null && !(Number.isFinite(old) && old > current)) return null;
  return { current: round2(current), old: old == null ? null : round2(old) };
}
const round2 = (n) => Math.round(n * 100) / 100;

// --- consecutive agreement ---------------------------------------------------------
// Readings (as priceReading returns them, null for invalid) -> the agreed
// candidate or null. The old price survives only if BOTH agreeing readings
// report the same one; otherwise it is dropped, never picked.
export function consecutiveAgreement(readings) {
  for (let i = 1; i < readings.length; i += 1) {
    const a = readings[i - 1];
    const b = readings[i];
    if (a && b && eq(a.current, b.current)) {
      return { current: b.current, old: eq(a.old, b.old) ? b.old : null, at: i + 1 };
    }
  }
  return null;
}

// --- D4D description evidence --------------------------------------------------------
const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const UNIT_AFTER = /^\s*(?:kg|g|gm|gms|gr|ml|l|lt|ltr|ltrs|litre|liter|pcs|pc|x|%|'s|s\b|كجم|كج|كغ|كيلو|غ|غم|غرام|جم|مل|لتر|حبة|قطعة|×)/i;

function normalizeDigits(text) {
  return String(text || '')
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/٫/g, '.');
}

// Price-like numbers printed in the description: every number not followed by
// a pack/size unit. `decimalsOnly` keeps only 12.95-shaped ones (the shape a
// competing price has; bare integers are too often sizes and counts).
export function descriptionNumbers(description, { decimalsOnly = false } = {}) {
  const text = normalizeDigits(description);
  const out = [];
  for (const m of text.matchAll(/\d{1,5}(?:[.,]\d{1,2})?/g)) {
    const token = m[0];
    if (UNIT_AFTER.test(text.slice(m.index + token.length))) continue;
    if (decimalsOnly && !/[.,]\d/.test(token)) continue;
    const value = Number(token.replace(',', '.'));
    if (value > 0) out.push(value);
  }
  return out;
}

// The agreed candidate against D4D's own description -> { ok, current, old,
// reason }. The candidate current price must be printed there. An agreed old
// price is kept only if it is printed too (else dropped). With no old price
// kept, a LOWER printed price means the candidate may be the crossed-out one:
// rejected.
export function checkAgainstDescription(description, candidate) {
  const all = descriptionNumbers(description);
  if (!all.some((n) => eq(n, candidate.current))) {
    return { ok: false, reason: 'current_not_in_description' };
  }
  if (candidate.old != null && all.some((n) => eq(n, candidate.old))) {
    return { ok: true, current: candidate.current, old: candidate.old };
  }
  const lower = descriptionNumbers(description, { decimalsOnly: true })
    .some((n) => n < candidate.current - 0.01 && n >= 0.4 * candidate.current);
  if (lower) return { ok: false, reason: 'lower_price_in_description' };
  return { ok: true, current: candidate.current, old: null };
}

// --- the decision --------------------------------------------------------------------
// Readings + description -> { status: 'accepted'|'rejected', price, oldPrice, reason }.
export function decidePrice(readings, description) {
  const agreed = consecutiveAgreement(readings);
  if (!agreed) return { status: 'rejected', reason: 'no_agreement' };
  const checked = checkAgainstDescription(description, agreed);
  if (!checked.ok) return { status: 'rejected', reason: checked.reason, candidate: agreed.current };
  return { status: 'accepted', price: checked.current, oldPrice: checked.old };
}

// --- the drain ------------------------------------------------------------------------
async function fetchCrop(url, fetchImpl) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    const err = new Error(`crop fetch ${res.status}: ${url}`);
    err.stage = 'crop';
    err.status = res.status;
    throw err;
  }
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  return { contentType, base64: toBase64(await res.arrayBuffer()) };
}

async function readOnce(crop, { apiKey, model, temperature, fetchImpl }) {
  const body = { ...buildVisionRequest({ model, contentType: crop.contentType, base64: crop.base64 }), temperature };
  const response = await postMistral(MISTRAL_URL, body, { apiKey, fetchImpl, stage: 'mistral' });
  const raw = response.body?.choices?.[0]?.message?.content ?? null;
  let parsed = null;
  try {
    const match = /\{[\s\S]*\}/.exec(String(raw || ''));
    parsed = JSON.parse(match ? match[0] : raw);
  } catch {
    parsed = null; // an unparsable reply is an invalid reading, not an error
  }
  // The reply is kept: it is the full extraction (same prompt as Stage 1), so an
  // accepted price's agreeing reading also yields the name, brand and size.
  return { reading: priceReading(parsed), raw, rateLimit: response.rateLimit };
}

// The accepted price -> a normal offer, stamped exactly as the ingest stamps one.
export function offerFromAcceptedPrice(raw, { store, region, source, detectedAt, price, oldPrice }) {
  const offer = buildOffer({ ...raw, price, wasPrice: oldPrice }, { store, region, source, detectedAt });
  if (!offer) return null;
  const ident = deriveIdentity(offer);
  offer.identity = ident ? ident.id : null;
  offer.brandSlug = detectBrand(offer);
  offer.priceSource = 'vision';
  return offer;
}

// Drain pending rows: { offerStore, keyChain } + options -> report.
export async function drainPriceFallback(
  { offerStore, keyChain },
  {
    model,
    currentOn,
    limit = 10,
    // Parallel drains (2026-09-24): shard k of n takes only offer ids with
    // id % n == k, so concurrent drains never read the same item. Scheduling
    // only — model, readings, agreement and description check are unchanged.
    shard = 0,
    shards = 1,
    maxReadings = PRICE_FALLBACK_DEFAULTS.maxReadings,
    temperature = PRICE_FALLBACK_DEFAULTS.temperature,
    maxDrainAttempts = PRICE_FALLBACK_DEFAULTS.maxDrainAttempts,
    subrequestBudget = PRICE_FALLBACK_DEFAULTS.subrequestBudget,
    fetchImpl = fetch,
    now = () => new Date().toISOString(),
    failover = {},
  } = {},
) {
  const report = {
    startedAt: now(),
    model,
    scanned: 0,
    accepted: 0,
    rejected: 0,
    superseded: 0,
    deferred: 0,
    readings: 0,
    subrequests: 0,
    reasons: {},
    errors: [],
  };
  // Accepted items' agreeing replies, as Vision observations the caller feeds
  // to the normal Stage-1 commit (engine.js). Not enumerable: never serialized.
  Object.defineProperty(report, 'observations', { value: {}, enumerable: false, writable: true });
  const bump = (reason) => { report.reasons[reason] = (report.reasons[reason] || 0) + 1; };
  if (!model) {
    report.skipped = 'no_model';
    report.finishedAt = now();
    return report;
  }
  const rows = await offerStore.listPricePending({ currentOn, limit, shard, shards });
  report.scanned = rows.length;

  for (const row of rows) {
    // Never start an item the invocation cannot finish (crop + max readings).
    if (report.subrequests + 1 + maxReadings > subrequestBudget) break;
    const raw = JSON.parse(row.raw_json);
    const readings = [];
    const replies = [];
    let decision = null;
    try {
      report.subrequests += 1;
      const crop = await fetchCrop(row.image_url, fetchImpl);
      while (readings.length < maxReadings) {
        report.subrequests += 1;
        const { reading, raw: reply } = await withFailover(
          keyChain,
          (apiKey) => readOnce(crop, { apiKey, model, temperature, fetchImpl }),
          failover,
        );
        readings.push(reading);
        replies.push(reply);
        report.readings += 1;
        if (consecutiveAgreement(readings)) break;
      }
      decision = decidePrice(readings, raw.description);
    } catch (err) {
      // A crop the CDN no longer has is permanent; a bad model name or dead
      // keys stop the whole drain (nothing to gain by burning the queue);
      // anything else is transient and retried on a later drain, boundedly.
      if (err?.stage === 'crop' && (err.status === 404 || err.status === 410)) {
        decision = { status: 'rejected', reason: 'crop_missing' };
      } else if (err?.status === 400 || err?.status === 404 || classifyMistralError(err) === 'auth') {
        report.errors.push(err?.message || String(err));
        report.stopped = 'model_or_keys_unavailable';
        break;
      } else if (/no API key available|all API keys exhausted/.test(String(err?.message))) {
        report.errors.push(err.message);
        report.stopped = 'keys_exhausted';
        break;
      } else {
        const exhausted = Number(row.attempts || 0) + 1 >= maxDrainAttempts;
        await offerStore.markPricePendingAttempt(row.id, {
          reason: `transient: ${String(err?.message || err).slice(0, 120)}`,
          reject: exhausted,
          at: now(),
        });
        if (exhausted) { report.rejected += 1; bump('transient_exhausted'); } else { report.deferred += 1; }
        continue;
      }
    }

    const audit = { readings: readings.map((r) => (r ? [r.current, r.old] : null)), model, temperature };
    if (decision.status === 'accepted') {
      // D4D wins: if the source has priced this product meanwhile, keep its row.
      const existing = await offerStore.getById(row.id);
      if (existing && existing.price_source == null) {
        await offerStore.resolvePricePending(row.id, { status: 'superseded', reason: 'd4d_priced', audit, at: now() });
        report.superseded += 1;
        continue;
      }
      const offer = offerFromAcceptedPrice(raw, {
        store: row.store,
        region: row.region,
        source: row.source,
        detectedAt: row.detected_at,
        price: decision.price,
        oldPrice: decision.oldPrice,
      });
      if (!offer) {
        await offerStore.resolvePricePending(row.id, { status: 'rejected', reason: 'unbuildable', audit, at: now() });
        report.rejected += 1;
        bump('unbuildable');
        continue;
      }
      await offerStore.upsertMany([offerToRow(offer)]);
      await offerStore.resolvePricePending(row.id, {
        status: 'accepted',
        price: decision.price,
        oldPrice: decision.oldPrice,
        audit,
        at: now(),
      });
      report.accepted += 1;
      // The reading that completed the agreement IS a full extraction: keep it.
      const agreed = consecutiveAgreement(readings);
      const reply = replies[(agreed?.at || replies.length) - 1];
      if (reply != null) report.observations[row.id] = visionObservationFromReply(reply, { model });
    } else {
      await offerStore.resolvePricePending(row.id, { status: 'rejected', reason: decision.reason, audit, at: now() });
      report.rejected += 1;
      bump(decision.reason);
    }
  }
  report.keyUsage = keyChain?.snapshot?.() || []; // masked: ids + status, never key material
  report.finishedAt = now();
  return report;
}
