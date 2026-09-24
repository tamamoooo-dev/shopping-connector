// watchPlan.js — the user-visible contract for price-monitoring v3.
//
// There are exactly two tracks:
//   amazon_exact  — a selected Amazon ASIN, checked only on Amazon.
//   market_general — anything else, generalized to brand + product class and
//                    checked across every online source (including Amazon).
//
// This module is pure. Scheduling, D1 and network access live elsewhere.

import { listingIdentityCandidate } from './identity/listingCandidate.js';
import { specFromListing, validateSpec } from './identity/spec.js';
import { structuredSearchQuery } from './structuredSearchQuery.js';
import { stripSizes } from './matching.js';

export const WATCH_TRACK = Object.freeze({
  AMAZON_EXACT: 'amazon_exact',
  MARKET_GENERAL: 'market_general',
});

export const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
export const WATCH_SLOT_HOURS = Object.freeze([7, 19]);

export function isAmazonAsin(value) {
  return /^B[A-Z0-9]{9}$/i.test(String(value || '').trim());
}

export function watchTrack(input = {}) {
  if (Object.values(WATCH_TRACK).includes(input.watchTrack)) return input.watchTrack;
  return String(input.provider || '').toLowerCase() === 'amazon' &&
    isAmazonAsin(input.productId) && input.kind === 'product'
    ? WATCH_TRACK.AMAZON_EXACT
    // Production rows are backfilled with an explicit v3 track. Keeping a
    // null fallback lets rollback/legacy tooling still identify older rows.
    : null;
}

const cleanQuery = (value) => String(value || '')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, 120);

// The default non-Amazon meaning is intentionally GENERAL: brand, family and
// physical form/cut stay pinned; size, pack count and marketing variety do not.
export function generalWatchSpec(listing = {}) {
  const candidate = listingIdentityCandidate(listing);
  if (!candidate) return null;
  const spec = specFromListing(candidate, {
    matchBrand: true,
    matchSize: false,
    matchVariant: false,
  });
  return validateSpec(spec).valid ? spec : null;
}

export function generalSystemQuery(listing = {}, fallback = '') {
  const spec = generalWatchSpec(listing);
  const structured = spec ? structuredSearchQuery({ spec }) : '';
  const lexical = cleanQuery(stripSizes(
    [listing.name, listing.nameAr, listing.brand].filter(Boolean).join(' ') || fallback,
  ));
  // `fish` is a taxonomy bucket, not a useful shelf product name: tuna,
  // salmon and sardines are not interchangeable. Keep the selected listing's
  // own size-free wording for that bucket instead of inventing "Fish <brand>".
  if (spec?.family === 'fish' && lexical) return lexical;
  return cleanQuery(structured || lexical || fallback);
}

export function customSearchQuery(value) {
  return cleanQuery(value);
}

export function effectiveSearchQuery(watch = {}, anchor = null, product = null) {
  const custom = customSearchQuery(watch.customSearchQuery);
  if (custom) return custom;
  const system = cleanQuery(watch.systemSearchQuery);
  if (system) return system;
  if (watchTrack(watch) === WATCH_TRACK.AMAZON_EXACT) {
    return String(watch.productId || '').trim().slice(0, 80);
  }
  const source = (() => {
    try { return JSON.parse(watch.sourceSnapshot || '{}'); } catch { return {}; }
  })();
  const generated = generalSystemQuery(source, watch.query || watch.label || '');
  if (generated) return generated;
  return cleanQuery(product?.display_name || anchor?.snapshot?.name || watch.query || watch.label);
}

const pad = (n) => String(n).padStart(2, '0');

// Latest Riyadh slot that is due at `nowMs`. A watch created after that slot is
// not eligible; its first run is the next 07:00/19:00 boundary.
export function latestRiyadhSlot(nowMs = Date.now()) {
  const local = new Date(nowMs + RIYADH_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const hour = local.getUTCHours();
  let slotHour;
  let slotDay = day;
  if (hour >= WATCH_SLOT_HOURS[1]) slotHour = WATCH_SLOT_HOURS[1];
  else if (hour >= WATCH_SLOT_HOURS[0]) slotHour = WATCH_SLOT_HOURS[0];
  else {
    slotHour = WATCH_SLOT_HOURS[1];
    slotDay -= 1;
  }
  const scheduledMs = Date.UTC(year, month, slotDay, slotHour, 0, 0) - RIYADH_OFFSET_MS;
  const scheduled = new Date(scheduledMs);
  const localDay = new Date(scheduledMs + RIYADH_OFFSET_MS);
  const dateKey = `${localDay.getUTCFullYear()}-${pad(localDay.getUTCMonth() + 1)}-${pad(localDay.getUTCDate())}`;
  const period = slotHour === WATCH_SLOT_HOURS[0] ? 'AM' : 'PM';
  return {
    key: `${dateKey}-${period}`,
    period,
    localHour: slotHour,
    scheduledAt: scheduled.toISOString(),
    scheduledMs,
  };
}

export function nextRiyadhSlot(nowMs = Date.now()) {
  const latest = latestRiyadhSlot(nowMs);
  const step = latest.period === 'AM' ? 12 : 12;
  return latestRiyadhSlot(latest.scheduledMs + step * 60 * 60 * 1000 + 1);
}
