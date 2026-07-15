// browse/deals.js — deal-quality scoring for Browse (BROWSE-DESIGN.md §7.5),
// PURE and unit-tested. This module is the single source of truth for what
// Super Search calls an "exceptional deal".
//
// PRINCIPLE (the review's mandate): never rank by advertised discount alone.
// The score is a transparent sum of independent, data-backed signals; the
// history-backed signals (price_history / price_identities, joined onto the
// offer row via offers.identity) outweigh anything the flyer merely claims.
// Every point a deal earns surfaces as a BADGE the user can verify — trust is
// the feature.
//
// Input row = an offers row LEFT-JOINed with its price identity and history
// aggregates (see storage/browseStore.js):
//   { price, old_price, name, name_ar, valid_to,
//     weeks_seen, first_seen,            // price_identities (null: no history)
//     min_price, max_price, points }     // price_history aggregates
//
// Signal design notes:
//   • lowestEver — price ≤ the lowest EVER recorded, with ≥4 observed weeks of
//     depth AND ≥2 recorded price events (a product only ever seen at one
//     price is trivially "at its low" — that is no signal at all).
//   • returnLow — lowestEver with ≥3 price events: the price left its low and
//     came back (points are recorded only on CHANGE, so 3 events = at least
//     one pricier stretch in between).
//   • rare — the identity has been known ≥8 weeks but appeared in flyers in
//     ≤25% of them: this product is rarely promoted, so this promotion is an
//     opportunity. (weeks_seen counts offer-weeks; the flyer substrate only
//     observes a product WHEN it is on offer.)
//   • multibuy — a real multi-buy marker in the OCR name ("1+1", "2+1",
//     "مجانا"). Deliberately narrow: a bare English "free" is NOT a marker
//     ("fat free", "sugar free").
//   • drop — the advertised strike-through cut. Capped at +30 total so a
//     marketing claim alone can never reach the EXCEPTIONAL_MIN of 50.

export const EXCEPTIONAL_MIN = 50;

const WEEK_MS = 7 * 86400000;

// "1+1" / "2 + 1" style offers, or an Arabic "free" (مجانا/مجاناً/مجانية).
const MULTIBUY_RE = /(^|\s)\d\s*\+\s*\d(\s|$)|مجان(?:ا|اً|يه|ية)/;

// Whole weeks between two ISO dates (floored, never negative).
function weeksBetween(fromISO, toISO) {
  const from = Date.parse(fromISO);
  const to = Date.parse(toISO);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / WEEK_MS));
}

// The independent signals of one offer row (pure; today = 'YYYY-MM-DD').
export function dealSignals(row, today) {
  const price = Number(row.price);
  const oldPrice = Number(row.old_price);
  const hasDrop = Number.isFinite(oldPrice) && oldPrice > price;
  const dropPct = hasDrop ? (oldPrice - price) / oldPrice : 0;

  const weeks = Number(row.weeks_seen) || 0;
  const points = Number(row.points) || 0;
  const minPrice = row.min_price != null ? Number(row.min_price) : null;

  const lowestEver = minPrice != null && weeks >= 4 && points >= 2 && price <= minPrice;
  const returnLow = lowestEver && points >= 3;

  const age = row.first_seen ? weeksBetween(row.first_seen, today) : 0;
  const rare = age >= 8 && weeks >= 1 && weeks / age <= 0.25;

  const multibuy = MULTIBUY_RE.test(`${row.name || ''} ${row.name_ar || ''}`);

  let endsInDays = null;
  if (row.valid_to) {
    const ms = Date.parse(`${row.valid_to}T23:59:59`) - Date.parse(`${today}T00:00:00`);
    if (Number.isFinite(ms)) endsInDays = Math.max(0, Math.floor(ms / 86400000));
  }

  return { dropPct, lowestEver, returnLow, rare, multibuy, weeks, endsInDays };
}

// The transparent score (§7.5 — this table IS the documentation):
//   lowestEver +50 · drop ≥40% +30 (else ≥25% +15) · rare +20 ·
//   returnLow +15 · multibuy +10.
export function scoreDeal(signals) {
  let score = 0;
  if (signals.lowestEver) score += 50;
  if (signals.dropPct >= 0.4) score += 30;
  else if (signals.dropPct >= 0.25) score += 15;
  if (signals.rare) score += 20;
  if (signals.returnLow) score += 15;
  if (signals.multibuy) score += 10;
  return score;
}

// The card badges every Browse listing carries (a subset of the signals that
// make sense on ANY card, not only exceptional ones). Percentages are rounded
// for display; raw signals stay available to callers that need precision.
export function offerBadges(row, today) {
  const s = dealSignals(row, today);
  const badges = {};
  if (s.dropPct >= 0.05) badges.drop = Math.round(s.dropPct * 100);
  if (s.lowestEver) badges.lowestEver = { weeks: s.weeks };
  if (s.returnLow) badges.returnLow = true;
  if (s.rare) badges.rare = true;
  if (s.multibuy) badges.multibuy = true;
  if (s.endsInDays != null && s.endsInDays <= 2) badges.endsInDays = s.endsInDays;
  return badges;
}

// Score one row for the Exceptional Deals rail: null when it doesn't qualify,
// else { score, signals } (rank by score, ties by deeper drop, then cheaper).
export function exceptionalDeal(row, today) {
  const signals = dealSignals(row, today);
  const score = scoreDeal(signals);
  return score >= EXCEPTIONAL_MIN ? { score, signals } : null;
}

// Comparator for scored rows: best first.
export function compareDeals(a, b) {
  return (
    b.deal.score - a.deal.score ||
    b.deal.signals.dropPct - a.deal.signals.dropPct ||
    a.row.price - b.row.price
  );
}
