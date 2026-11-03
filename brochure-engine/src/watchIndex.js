// watchIndex.js — Value Watch (price monitoring v4), the RUNTIME half.
//
// One sweep = search every store (and the current flyers) with the watch's
// queries, verify every listing not verified before, remember the verdicts in
// the watch's listing index (storage/watchListingStore.js), and price the
// verified ones per item. The same sweep serves two callers:
//
//   • the BACKGROUND INDEX pass — right after a watch is created (minute tick,
//     index.js) and again weekly: wide, up to 60 products judged;
//   • the 07:00/19:00 ROUND (watchSchedule.js): the same sweep, judging only
//     what is new (this week's flyer offers, a pack size a store just listed).
//
// Identity is decided ONCE per listing and kept: deterministic rules first
// (watchValue.js ruleVerdict, conflictWith), then the AI judge for what rules
// cannot settle — asked twice, a match needs both yeses (combineVotes) — then
// the rules again over the judge's answer (a size the listing states that
// contradicts the watched size always rejects). A verdict the user gave is never
// overwritten. Only `match` + size-verified listings can move a price or alert.
//
// Rules that keep alerts honest:
//   1. A store that did not answer told us nothing: its listings are neither
//      "missing" nor "above target", and it can block a round only if it holds
//      a verified listing (a store that never had the product cannot starve it).
//   2. A round that cannot see a deal's own store cannot end that deal.
//   3. One deal, one alert (watchValue.js decideAlert + deterministic alert ids).

import { marketDate } from './marketDate.js';
import { normalizeText } from './matching.js';
import { rowToOffer } from './offers/contract.js';
import { applyEnrichment, MISTRAL_URL, postMistral } from './offers/enrich.js';
import { createKeyChain, MISTRAL_POOL_DEFINITIONS, withFailover } from './offers/mistralKeys.js';
import {
  JUDGE_BATCH,
  MAX_JUDGED_PER_SWEEP,
  MISSING_ROUNDS_GONE,
  VERDICT,
  buildJudgeRequest,
  barcodesOf,
  buildValueReference,
  combineVotes,
  conflictWith,
  dealKey,
  decideAlert,
  expandVariants,
  formatItem,
  isAnchor,
  judgedVerdict,
  listingValue,
  parseJudgeReply,
  parseReference,
  ruleVerdict,
  sameItemSize,
  statedPack,
  tokenOverlap,
  watchQuantity,
} from './watchValue.js';
import { BROWSER_FRESH_MS, BROWSER_SOURCE, browserStateKey, stateKeyOf } from './watchObserve.js';

export const VALUE_PROVIDERS = ['panda', 'tamimi', 'danube', 'lulu', 'ninja', 'amazon', 'noon'];
// A store that refuses the connector outright (403 + blocked). Not retried
// within a round, never holds a round back; asked again next round, so it
// returns by itself the day the store lets the connector in.
const STATE_BLOCKED = 'blocked';
export const VALUE_SEARCH_LIMIT = 50;
export const VALUE_UNIT_LABEL = 'per-item';
// Rounds judge at most one batch of new listings; the index pass and a browser
// check (a whole store's results at once, asked for by the owner) up to three.
const JUDGE_BATCHES = { round: 1, index: 3, observe: 3 };
export const INDEX_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
export const INDEX_RETRY_MS = 3 * 60 * 1000;
export const INDEX_LEASE_MS = 5 * 60 * 1000;
// Rejected and undecided listings nobody has returned for this long are
// forgotten; verified matches are kept (they are the history of the watch).
const FORGET_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const json = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

const listingKeyOf = (store, id) => `${store}\u0000${id}`;

function fnv(text) {
  let h = 0x811c9dc5;
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// --- the reference --------------------------------------------------------------

// The watch's value contract. A v4 watch carries it; a migrated v3 watch gets
// one built from its creation snapshot (the listing the user picked).
export function watchReference(watch) {
  const stored = parseReference(watch.referenceJson);
  if (stored?.v) return stored;
  const snapshot = json(watch.sourceSnapshot) || {};
  const listing = {
    id: snapshot.productId ?? watch.productId ?? null,
    provider: snapshot.provider ?? watch.provider ?? null,
    name: snapshot.name || watch.label || watch.query,
    brand: snapshot.brand || null,
    size: snapshot.size && typeof snapshot.size === 'object' && snapshot.size.value
      ? `${snapshot.count > 1 ? `${snapshot.count} x ` : ''}${snapshot.size.value} ${snapshot.size.unit}`
      : snapshot.size || null,
  };
  return buildValueReference({
    listing,
    label: watch.label,
    query: watch.query,
    targetPrice: watch.targetPrice,
    customQuery: watch.customSearchQuery,
  });
}

export function valueTarget(watch, reference) {
  const value = Number(reference?.targetValue);
  return Number.isFinite(value) && value > 0 ? value : null;
}

// --- the AI judge ----------------------------------------------------------------

// A judge bound to the shared Mistral pool (the one model every Mistral use
// runs on). Returns null when no key is configured: listings then wait as
// `pending` and are never used for alerts — the rules alone still settle the
// anchor listing, exact titles and every size contradiction.
export function createWatchJudge(ctx, { fetchImpl = fetch } = {}) {
  if (ctx.watchJudge !== undefined) return ctx.watchJudge;
  const pool = ctx.mistralPools?.ministral14 || [];
  if (!pool.some((slot) => slot.key)) return null;
  const chain = createKeyChain(pool, { label: 'mistral-watch-judge', balance: true, reserve: 2 });
  const model = MISTRAL_POOL_DEFINITIONS.ministral14.model;
  return async (reference, candidates) => {
    const body = buildJudgeRequest(reference, candidates, { model });
    const { raw } = await withFailover(chain, async (apiKey) => {
      const response = await postMistral(MISTRAL_URL, body, { apiKey, fetchImpl, stage: 'watch-judge', timeoutMs: 45000 });
      return { raw: response.body?.choices?.[0]?.message?.content ?? null, rateLimit: response.rateLimit };
    }, { maxRateRetries: 1 });
    return parseJudgeReply(raw, candidates.length);
  };
}

// Barcode keys with SETTLED identity: the reference's, the anchor's and the
// user's verdicts. Never a barcode match's own other keys — stores file old
// and new codes on one listing (Tamimi's soft 185 g tin carries Goody's
// flaked-tuna code too), so learning from a barcode match would chain.
export function settledBarcodes(reference, rows = []) {
  const match = new Set(reference?.barcodes || []);
  const reject = new Set();
  for (const row of rows) {
    const keys = row.barcodes || [];
    if (!keys.length) continue;
    const settled = row.verdictBy === 'anchor' || row.verdictBy === 'user';
    if (!settled) continue;
    if (row.verdict === VERDICT.MATCH) for (const b of keys) match.add(b);
    else if (row.verdict === VERDICT.REJECT && row.verdictBy === 'user') for (const b of keys) reject.add(b);
  }
  // A key both ways (two listings sharing one photo name): trust neither.
  for (const b of [...match]) if (reject.has(b)) { match.delete(b); reject.delete(b); }
  return { match, reject };
}

// --- retrieval ----------------------------------------------------------------

function flyerListing(offer, row = {}) {
  return {
    id: `offer:${offer.id}`,
    name: offer.name || offer.nameAr || '',
    nameAr: offer.nameAr || null,
    brand: row.e_brand || null,
    // The size bound to THIS price (applyEnrichment), never the raw caption
    // size, which on a multi-size flyer tile may belong to another price.
    size: offer.size ?? null,
    price: offer.price,
    currency: offer.currency || 'SAR',
    link: offer.link || null,
    image: offer.imageUrl || null,
  };
}

// Search `stores` with every query. A store's status is `ok` when every query
// answered, `partial` when some did (or all answered with nothing), `failed`
// when none did — only `ok` lets the sweep conclude that a listing it did not
// return is missing.
async function searchStores(ctx, stores, queries, notes) {
  const status = {};
  const found = [];
  if (!ctx.searchClient) {
    for (const store of stores) status[store] = { state: 'failed', error: 'no search client' };
    return { status, found };
  }
  await Promise.all(stores.map(async (store) => {
    let answered = 0;
    let listed = 0;
    let lastError = null;
    let blocked = false;
    const ask = async (query) => {
      const results = await ctx.searchClient.search(store, query, VALUE_SEARCH_LIMIT, { wide: true });
      for (const result of (results || []).slice(0, VALUE_SEARCH_LIMIT)) {
        // A product that lists several pack sizes (Tamimi) is one listing
        // per pack, each with its own price, stock and barcode.
        for (const listing of expandVariants(result)) {
          if (listing?.id == null || !(listing.name || listing.nameEn)) continue;
          found.push({ store, source: 'online', listing, query });
          listed += 1;
        }
      }
    };
    for (const query of queries) {
      try {
        await ask(query);
        answered += 1;
      } catch (err) {
        lastError = err?.message || String(err);
        // The store refuses the connector itself (Lulu, 2026-11-03): the
        // other queries would be refused the same way.
        if (err?.blocked && !answered) {
          blocked = true;
          break;
        }
      }
    }
    // Tamimi now and then answers a search with an empty page that a retry
    // fills (measured 2026-11-03). Every query empty is asked once more; still
    // empty, it proves nothing — the store's listings are not counted missing.
    let blank = false;
    if (answered === queries.length && listed === 0) {
      try {
        await ask(queries[0]);
      } catch (err) {
        lastError = err?.message || String(err);
      }
      blank = listed === 0;
    }
    status[store] = blocked
      ? { state: STATE_BLOCKED, error: lastError }
      : blank
      ? { state: 'partial', blank: true, error: lastError || 'every search came back empty' }
      : answered === queries.length
        ? { state: 'ok' }
        : answered > 0 ? { state: 'partial', error: lastError } : { state: 'failed', error: lastError };
    if (lastError) notes.push(`${store}: ${lastError}`);
  }));
  return { status, found };
}

async function searchFlyers(ctx, queries, notes) {
  if (!ctx.offerStore?.search) return { ok: false, found: [] };
  const found = [];
  try {
    for (const query of queries) {
      const rows = await ctx.offerStore.search({ q: query, currentOn: marketDate(), limit: VALUE_SEARCH_LIMIT });
      for (const row of rows || []) {
        const offer = rowToOffer(row);
        applyEnrichment(offer, row); // the same servable gate Search serves from
        if (!(offer.name || offer.nameAr) || offer.price == null) continue;
        // A price whose package size could not be bound to it cannot be
        // compared per item.
        if (offer.quantityReviewRequired) continue;
        found.push({ store: offer.store, source: 'flyer', listing: flyerListing(offer, row), query });
      }
    }
    return { ok: true, found };
  } catch (err) {
    notes.push(`flyers: ${err?.message || String(err)}`);
    return { ok: false, found };
  }
}

// --- the sweep -------------------------------------------------------------------

// One sweep. Writes the listing index; returns what the evaluation needs.
// `supplied` = a browser check (watchObserve.js): `{ store, listings, complete }`
// read in the owner's browser, swept INSTEAD of asking the stores.
export async function sweepValueWatch(ctx, watch, {
  mode = 'round',
  reference = watchReference(watch),
  stores = VALUE_PROVIDERS,
  includeFlyers = true,
  supplied = null,
  notes = [],
  now = new Date(),
} = {}) {
  const nowIso = now.toISOString();
  const queries = (reference.queries || []).filter(Boolean);
  if (!queries.length && !supplied) {
    return { error: 'This watch has no search wording to look for.', reference, status: {}, rows: [] };
  }
  const [{ status, found }, flyers] = supplied
    ? [{
      status: { [browserStateKey(supplied.store)]: { state: supplied.complete ? 'ok' : 'partial' } },
      found: supplied.listings.map((listing) => ({
        store: supplied.store, source: BROWSER_SOURCE, listing, query: listing.query || null,
      })),
    }, { ok: false, found: [] }]
    : await Promise.all([
      searchStores(ctx, stores, queries, notes),
      includeFlyers ? searchFlyers(ctx, queries, notes) : Promise.resolve({ ok: false, found: [] }),
    ]);
  if (includeFlyers && !supplied) status.flyers = { state: flyers.ok ? 'ok' : 'failed' };

  // Dedupe: one candidate per (store, listing), remembering the first query.
  const candidates = new Map();
  for (const entry of [...found, ...flyers.found]) {
    const key = listingKeyOf(entry.store, entry.listing.id);
    if (!candidates.has(key)) candidates.set(key, entry);
  }

  const existing = new Map();
  for (const row of (await ctx.watchListingStore?.list(watch.id)) || []) {
    existing.set(listingKeyOf(row.store, row.listingId), row);
  }

  // Amazon answers exact lookups: a verified Amazon listing the search did not
  // return this time is fetched directly instead of being counted missing.
  // The listing the watch was created from is always asked for by id.
  if (ctx.searchClient?.lookupExact && (status.amazon?.state === 'ok' || status.amazon?.blank)) {
    const absent = [...existing.values()]
      .filter((r) => r.store === 'amazon' && r.verdict === VERDICT.MATCH && r.source === 'online'
        && !candidates.has(listingKeyOf('amazon', r.listingId)))
      .slice(0, 3);
    if (reference.store === 'amazon' && reference.listingId &&
        !candidates.has(listingKeyOf('amazon', reference.listingId)) &&
        !absent.some((r) => String(r.listingId) === String(reference.listingId))) {
      absent.push({ listingId: reference.listingId, query: null });
    }
    await Promise.all(absent.map(async (row) => {
      try {
        const listing = await ctx.searchClient.lookupExact('amazon', row.listingId);
        if (listing && String(listing.id) === String(row.listingId)) {
          candidates.set(listingKeyOf('amazon', row.listingId), { store: 'amazon', source: 'online', listing, query: row.query });
        }
      } catch {
        // Not returned is not evidence of anything; the row simply stays unseen.
      }
    }));
  }

  // Barcodes whose identity is settled: the reference's, the anchor's and the
  // user's verdicts. AI verdicts and barcode matches never seed more.
  const barcodes = settledBarcodes(reference, existing.values());
  for (const entry of candidates.values()) {
    if (isAnchor(entry.listing, reference, entry.store)) for (const b of barcodesOf(entry.listing)) barcodes.match.add(b);
  }
  const barcodeSets = { match: [...barcodes.match], reject: [...barcodes.reject] };
  // A conflict one listing's text proves holds for every listing with its
  // barcode (2026-11-03: Panda and Ninja sell Almarai's long-life carton as
  // "حليب كامل الدسم 1 لتر"; Danube's listing of that barcode says
  // "طويل الاجل", and the fresh-milk watch's judge had taken them as fresh).
  const twinClash = new Map();
  for (const entry of candidates.values()) {
    const why = conflictWith(entry.listing, reference);
    if (!why) continue;
    for (const b of barcodesOf(entry.listing)) if (!barcodes.match.has(b)) twinClash.set(b, why);
  }

  // Decide every candidate: the user's verdict, the anchor or a barcode, a
  // kept verdict, the other rules, or the judge.
  const decided = new Map();
  const toJudge = [];
  for (const [key, entry] of candidates) {
    const row = existing.get(key);
    const nameKey = normalizeText(entry.listing.name || entry.listing.nameEn || '').slice(0, 200);
    if (row && row.verdictBy === 'user') {
      decided.set(key, { verdict: row.verdict, by: 'user', reason: row.verdictReason, aiItems: row.aiItems });
      continue;
    }
    const rule = ruleVerdict(entry.listing, reference, { store: entry.store, barcodes: barcodeSets });
    // Deterministic identity outranks an earlier judgement (an assortment is
    // deterministically unsure, whatever the judge said before).
    if (rule && ['anchor', 'barcode', 'conflict', 'assortment'].includes(rule.by)) {
      decided.set(key, rule);
      continue;
    }
    const twin = rule ? null : barcodesOf(entry.listing).map((b) => twinClash.get(b)).find(Boolean);
    if (twin) {
      decided.set(key, { verdict: VERDICT.REJECT, by: 'conflict', reason: `${twin} (same barcode)` });
      continue;
    }
    // A kept verdict: match, reject, or the checker's own "unsure" (pending
    // by 'ai'). Only a listing with no answer yet (by null) is asked again.
    if (row && row.nameKey === nameKey && (row.verdict !== VERDICT.PENDING || row.verdictBy === 'ai')) {
      decided.set(key, { verdict: row.verdict, by: row.verdictBy, reason: row.verdictReason, aiItems: row.aiItems, aiItem: row.item });
      continue;
    }
    if (rule) decided.set(key, rule);
    else toJudge.push({ key, ...entry, overlap: tokenOverlap(entry.listing, reference) });
  }

  const judge = createWatchJudge(ctx);
  const budget = Math.min(MAX_JUDGED_PER_SWEEP, JUDGE_BATCH * (JUDGE_BATCHES[mode] || 1));
  toJudge.sort((a, b) => b.overlap - a.overlap);
  // One judgement per product: a store's pack sizes of one product (Tamimi
  // variants) share it, so they cannot be answered differently (2026-11-03:
  // the 18-pack of a Pepsi can "yes", its 6- and 12-packs "unsure").
  const packs = new Map();
  const products = [];
  for (const c of toJudge) {
    const base = `${c.store}|${c.listing.variantOf ?? c.listing.id}`;
    if (packs.has(base)) packs.get(base).push(c);
    else { packs.set(base, [c]); products.push(c); }
  }
  const judged = products.slice(0, judge ? budget : 0);
  // Two votes per product (combineVotes): the second pass takes the products
  // in stride order, backwards, so each one sits among other neighbours.
  const lanes = Math.ceil(judged.length / JUDGE_BATCH);
  const second = [];
  for (let lane = 0; lane < lanes; lane += 1) for (let i = lane; i < judged.length; i += lanes) second.push(judged[i]);
  second.reverse();
  const batches = [];
  for (const [pass, list] of [judged, second].entries()) {
    for (let i = 0; i < list.length; i += JUDGE_BATCH) batches.push({ pass, batch: list.slice(i, i + JUDGE_BATCH) });
  }
  const votes = new Map(judged.map((c) => [c.key, [null, null]]));
  let judgeCalls = 0;
  let judgeErrors = 0;
  await Promise.all(batches.map(async ({ pass, batch }) => {
    try {
      judgeCalls += 1;
      const reply = await judge({ ...reference, barcodes: barcodeSets.match }, batch.map((c) => ({ store: c.store, listing: c.listing })));
      batch.forEach((c, i) => { votes.get(c.key)[pass] = reply.results[i] || null; });
    } catch (err) {
      judgeErrors += 1;
      notes.push(`checker: ${err?.message || String(err)}`.slice(0, 200));
    }
  }));
  for (const c of judged) {
    const answer = combineVotes(...votes.get(c.key));
    for (const m of packs.get(`${c.store}|${c.listing.variantOf ?? c.listing.id}`) || [c]) {
      if (!answer) {
        decided.set(m.key, { verdict: VERDICT.PENDING, by: null, reason: judgeErrors ? 'checker unavailable — retried next sweep' : 'no answer from the checker yet' });
        continue;
      }
      // Another pack size: the judge's count and size were for the one it saw.
      const own = m === c ? answer : { ...answer, items: null, item: null };
      decided.set(m.key, judgedVerdict(m.listing, reference, own));
    }
  }
  for (const c of toJudge) {
    if (!decided.has(c.key)) {
      decided.set(c.key, {
        verdict: VERDICT.PENDING,
        by: null,
        reason: judge ? 'waiting for the checker (next sweep)' : 'checker not configured',
      });
    }
  }

  // Pack counts by barcode: one barcode is one pack, so a count another
  // listing states plainly ("4*1لتر") corroborates the same pack written as
  // "4 حبات 1 لتر" — the same check the judge's count gives.
  const twinPacks = new Map();
  for (const entry of candidates.values()) {
    const pack = statedPack(entry.listing);
    for (const b of barcodesOf(entry.listing)) {
      if (pack == null) continue;
      twinPacks.set(b, twinPacks.has(b) && twinPacks.get(b) !== pack ? 0 : pack);
    }
  }
  const twinItems = (listing) => {
    for (const b of barcodesOf(listing)) if (twinPacks.get(b) > 1) return twinPacks.get(b);
    return null;
  };

  // Price the candidates and build the rows to write.
  const writes = [];
  const seen = new Set();
  for (const [key, entry] of candidates) {
    const decision = decided.get(key);
    const row = existing.get(key);
    let verdict = decision.verdict;
    let reason = decision.reason || null;
    const aiItems = decision.aiItems ?? twinItems(entry.listing);
    const priced = listingValue(entry.listing, reference, { aiItems, aiItem: decision.aiItem });
    // A kept verdict meets a listing whose stated size changed: the size rule
    // still wins over any earlier decision except the user's.
    const statedItem = watchQuantity(entry.listing, { aiItems: decision.aiItems }).each || decision.aiItem || null;
    if (verdict === VERDICT.MATCH && decision.by !== 'user' && sameItemSize(statedItem, reference.item) === false) {
      verdict = VERDICT.REJECT;
      reason = `size per item ${formatItem(statedItem)} ≠ ${formatItem(reference.item)}`;
    }
    seen.add(key);
    writes.push({
      store: entry.store,
      listingId: String(entry.listing.id),
      source: entry.source,
      name: String(entry.listing.fullName || entry.listing.name || entry.listing.nameEn || '').slice(0, 300),
      nameKey: normalizeText(entry.listing.name || entry.listing.nameEn || '').slice(0, 200),
      brand: entry.listing.brand ? String(entry.listing.brand).slice(0, 80) : null,
      sizeText: typeof entry.listing.size === 'string' ? entry.listing.size.slice(0, 60) : null,
      link: entry.listing.link || null,
      image: entry.listing.image || null,
      item: priced?.item || null,
      pack: priced?.pack ?? null,
      verdict,
      verdictBy: decision.by || null,
      verdictReason: reason ? String(reason).slice(0, 160) : null,
      aiItems: decision.aiItems ?? null,
      sizeVerified: Boolean(priced?.sizeVerified),
      query: entry.query || row?.query || null,
      firstSeenAt: row?.firstSeenAt || nowIso,
      lastSeenAt: nowIso,
      lastCheckedAt: nowIso,
      lastPrice: priced?.purchasePrice ?? null,
      lastValue: verdict === VERDICT.MATCH ? priced?.value ?? null : null,
      missingRounds: 0,
      barcodes: barcodesOf(entry.listing),
      inStock: typeof entry.listing.inStock === 'boolean' ? entry.listing.inStock : null,
      // not persisted — carried to the evaluation
      _currency: entry.listing.currency || 'SAR',
    });
  }
  // Known listings this sweep did not return, in a store that fully answered:
  // one more round missing. A store that did not answer changes nothing.
  const forgetBefore = new Date(now.getTime() - FORGET_AFTER_MS).toISOString();
  const forget = [];
  for (const [key, row] of existing) {
    if (seen.has(key)) continue;
    const storeState = status[stateKeyOf(row)]?.state;
    if (row.verdict !== VERDICT.MATCH && row.verdictBy !== 'user' && (row.lastSeenAt || row.firstSeenAt) < forgetBefore) {
      forget.push(row);
      continue;
    }
    if (storeState !== 'ok') continue;
    writes.push({ ...row, lastCheckedAt: nowIso, missingRounds: (row.missingRounds || 0) + 1 });
  }
  if (ctx.watchListingStore) {
    await ctx.watchListingStore.upsertMany(watch.id, writes.map(({ _currency, ...doc }) => doc));
    if (forget.length && ctx.watchListingStore.forget) await ctx.watchListingStore.forget(watch.id, forget);
  }

  // Learn the size per item when the picked listing did not state it: every
  // verified listing that does state one agrees on it.
  let learned = null;
  let sizeChoices = null;
  if (!reference.item) {
    const sizes = [];
    for (const w of writes) {
      if (w.verdict !== VERDICT.MATCH || !w.item) continue;
      if (!sizes.some((s) => sameItemSize(s, w.item))) sizes.push(w.item);
    }
    if (sizes.length === 1) learned = sizes[0];
    else if (sizes.length > 1) sizeChoices = sizes.slice(0, 6);
  }

  return {
    reference,
    status,
    rows: writes,
    learned,
    sizeChoices,
    counts: {
      seen: candidates.size,
      // Asked of the checker but not answered (no key, an error, the budget).
      waiting: writes.filter((w) => seen.has(listingKeyOf(w.store, w.listingId))
        && w.verdict === VERDICT.PENDING && !w.verdictBy).length,
      matched: writes.filter((w) => w.verdict === VERDICT.MATCH).length,
      pending: writes.filter((w) => w.verdict === VERDICT.PENDING).length,
      rejected: writes.filter((w) => w.verdict === VERDICT.REJECT).length,
      judged: judged.length,
      judgeCalls,
      judgeErrors,
    },
  };
}

// --- evaluation + alerting -------------------------------------------------------

// A browser check's price stands for BROWSER_FRESH_MS and while no later
// complete check of its store missed it; every other price only this round.
const browserFresh = (row, freshIso) => Boolean(row.lastSeenAt) && row.lastSeenAt >= freshIso;

function observationOf(row, roundStartIso, freshIso) {
  if (row.verdict !== VERDICT.MATCH || !row.sizeVerified) return null;
  // A price nobody can buy is not a deal.
  if (row.inStock === false) return null;
  if (row.lastValue == null || row.lastPrice == null) return null;
  if (row.source === BROWSER_SOURCE) {
    if (!browserFresh(row, freshIso) || (row.missingRounds || 0) > 0) return null;
  } else if (!row.lastSeenAt || row.lastSeenAt < roundStartIso) return null;
  return {
    value: row.lastValue,
    purchasePrice: row.lastPrice,
    pack: row.pack || 1,
    item: row.item,
    store: row.store,
    listingId: row.listingId,
    source: row.source,
    name: row.name,
    link: row.link,
    currency: row._currency || 'SAR',
    dealKey: dealKey({ store: row.store, name: row.name, purchasePrice: row.lastPrice }),
  };
}

function dealStatusOf(deal, rowsByKey, status, target, roundStartIso, freshIso) {
  if (!deal) return null;
  const row = rowsByKey.get(listingKeyOf(deal.store, deal.listingId));
  if (!row || row.verdict !== VERDICT.MATCH) return 'gone';
  if (row.source === BROWSER_SOURCE) {
    // Nobody re-checked within BROWSER_FRESH_MS: the price is no longer known,
    // and an unknown price cannot hold a deal open (the next check that finds
    // it unchanged is not news: decideAlert keeps lastAlert).
    if (!browserFresh(row, freshIso) || (row.missingRounds || 0) >= MISSING_ROUNDS_GONE) return 'gone';
    if (row.missingRounds > 0) return 'unknown';
    return row.lastValue != null && row.lastValue > target + 1e-9 ? 'seen-above' : 'seen-below';
  }
  const storeState = status[stateKeyOf(row)]?.state;
  if (row.lastSeenAt && row.lastSeenAt >= roundStartIso) {
    return row.lastValue != null && row.lastValue > target + 1e-9 ? 'seen-above' : 'seen-below';
  }
  if (storeState === 'ok' && (row.missingRounds || 0) >= MISSING_ROUNDS_GONE) return 'gone';
  // A flyer that expired is gone the moment the next edition replaces it.
  if (row.source === 'flyer' && storeState === 'ok') return 'gone';
  return 'unknown';
}

const STATE_OK = 'ok';

// A whole check for one Value Watch: sweep, evaluate, alert, record.
// Returns the same `line` shape monitor.checkWatch returns.
//
// mode 'observe' = a browser check (`supplied`, watchObserve.js): only the
// supplied store is swept, and the round is evaluated over the index as the
// last round left it (every price seen this round, plus the browser's), so the
// best price and the alert are what a round would give with that store added.
export async function checkValueWatch(ctx, watch, {
  mode = 'round',
  roundKey = null,
  acceptPartialSweep = false,
  supplied = null,
  now = new Date(),
} = {}) {
  const observe = mode === 'observe';
  const line = {
    id: watch.id, label: watch.label, status: 'no-data', price: null,
    alerted: false, alertType: null, resolution: null, notes: [],
  };
  const nowIso = now.toISOString();
  let reference = watchReference(watch);
  const target = valueTarget(watch, reference);
  const indexInfo = json(watch.indexJson) || {};
  const deal = json(watch.dealJson) || {};

  // A retry inside the same round re-asks only the stores that failed; the
  // listings the others returned are already in the index from this round.
  const sameRound = observe || (roundKey && indexInfo.round?.key === roundKey);
  const freshIso = new Date(now.getTime() - BROWSER_FRESH_MS).toISOString();
  const lastRoundStart = indexInfo.round?.startedAt || null;
  const roundStartIso = observe
    ? (lastRoundStart && lastRoundStart >= freshIso ? lastRoundStart : freshIso)
    : sameRound ? indexInfo.round.startedAt : nowIso;
  const priorStatus = sameRound ? indexInfo.round?.status || {} : {};
  const retryStores = sameRound
    ? VALUE_PROVIDERS.filter((s) => ![STATE_OK, STATE_BLOCKED].includes(priorStatus[s]?.state))
    : VALUE_PROVIDERS;

  const sweep = await sweepValueWatch(ctx, watch, {
    mode,
    reference,
    stores: observe ? [] : retryStores,
    includeFlyers: !observe && (!sameRound || priorStatus.flyers?.state !== STATE_OK),
    supplied: observe ? supplied : null,
    notes: line.notes,
    now,
  });
  if (sweep.error) {
    line.resolution = 'unresolvable';
    line.notes.push(sweep.error);
    await recordValueState(ctx, watch, { lastResolution: 'unresolvable', reason: sweep.error, nowIso });
    return line;
  }
  const status = { ...priorStatus, ...sweep.status };
  if (sweep.learned) reference = { ...reference, item: sweep.learned, itemLearned: true };

  // The whole index as it stands after this sweep (rows of stores we did not
  // re-ask this attempt come from the store, with their round timestamps).
  const allRows = new Map();
  for (const row of (await ctx.watchListingStore?.list(watch.id)) || []) {
    allRows.set(listingKeyOf(row.store, row.listingId), row);
  }
  for (const row of sweep.rows) allRows.set(listingKeyOf(row.store, row.listingId), row);
  if (sweep.learned) {
    // Re-read the verified rows against the learned size.
    for (const [key, row] of allRows) {
      if (row.verdict !== VERDICT.MATCH) continue;
      const same = sameItemSize(row.item, reference.item);
      allRows.set(key, { ...row, sizeVerified: same === true });
    }
  }

  const observations = [];
  for (const row of allRows.values()) {
    const o = observationOf(row, roundStartIso, freshIso);
    if (o) observations.push(o);
  }
  const matchedStores = new Set([...allRows.values()]
    .filter((r) => r.verdict === VERDICT.MATCH && r.source === 'online').map((r) => r.store));
  const requiredFailed = [...matchedStores].filter((s) => status[s]?.state === 'failed');
  // Every store down (the connector itself, say) answers nothing at all.
  if (VALUE_PROVIDERS.every((s) => ['failed', STATE_BLOCKED].includes(status[s]?.state))) {
    for (const s of VALUE_PROVIDERS) if (!requiredFailed.includes(s)) requiredFailed.push(s);
  }
  // A browser check joins the round it ran in (its key and start stay).
  const roundInfo = observe && indexInfo.round
    ? { ...indexInfo.round, status }
    : { key: roundKey || `${mode}:${nowIso}`, startedAt: roundStartIso, status };
  // The verdict counts are the whole index's: a retry inside a round sweeps
  // only the stores that failed, so its own counts cover just those (the
  // 2026-11-03 07:00 round's Amazon retry read "1 verified" for 23).
  const verdictCount = (verdict) => [...allRows.values()].filter((r) => r.verdict === verdict).length;
  // The connector's stores only; a browser check is reported apart (`browser`),
  // so Lulu still reads "blocks online checks" after the owner's browser read it.
  const storeStatus = Object.entries(status).filter(([s]) => !s.startsWith(`${BROWSER_SOURCE}:`));
  const indexJson = {
    ...indexInfo,
    v: reference.v,
    lastSweepAt: observe ? indexInfo.lastSweepAt ?? null : nowIso,
    mode: observe ? indexInfo.mode ?? null : mode,
    counts: {
      ...(observe ? indexInfo.counts : sweep.counts),
      matched: verdictCount(VERDICT.MATCH),
      pending: verdictCount(VERDICT.PENDING),
      rejected: verdictCount(VERDICT.REJECT),
    },
    stores: Object.fromEntries(storeStatus.map(([s, v]) => [s, v.state])),
    storeErrors: Object.fromEntries(storeStatus.filter(([, v]) => v.error).map(([s, v]) => [s, String(v.error).slice(0, 120)])),
    sizeChoices: observe ? indexInfo.sizeChoices ?? null : sweep.sizeChoices,
    round: roundInfo,
    ...(mode === 'index' ? { indexedAt: nowIso } : {}),
  };
  if (observe) {
    const own = sweep.rows.filter((r) => r.source === BROWSER_SOURCE);
    const checked = {
      at: nowIso,
      state: sweep.status[browserStateKey(supplied.store)]?.state || 'partial',
      seen: sweep.counts.seen,
      matched: own.filter((r) => r.verdict === VERDICT.MATCH).length,
      pending: own.filter((r) => r.verdict === VERDICT.PENDING).length,
    };
    indexJson.browser = { ...(indexInfo.browser || {}), [supplied.store]: checked };
    line.observed = {
      store: supplied.store,
      ...checked,
      rejected: own.filter((r) => r.verdict === VERDICT.REJECT).length,
      judged: sweep.counts.judged,
      waiting: sweep.counts.waiting,
      // The verified listings this check found, cheapest per item first.
      matches: own
        .filter((r) => r.verdict === VERDICT.MATCH)
        .sort((a, b) => (a.lastValue ?? Infinity) - (b.lastValue ?? Infinity))
        .slice(0, 8)
        .map((r) => ({
          name: r.name, price: r.lastPrice, value: r.lastValue, pack: r.pack, item: r.item,
          sizeVerified: r.sizeVerified, inStock: r.inStock, link: r.link,
        })),
      // What still waits for the owner ("is this my product?").
      unsure: own
        .filter((r) => r.verdict === VERDICT.PENDING)
        .slice(0, 8)
        .map((r) => ({ name: r.name, price: r.lastPrice, reason: r.verdictReason })),
    };
  }

  if (requiredFailed.length && !acceptPartialSweep && !observe) {
    line.resolution = 'provider-error';
    const reason = `${requiredFailed.join(', ')} did not answer — retrying.`;
    line.notes.push(reason);
    await recordValueState(ctx, watch, {
      lastResolution: 'provider-error', reason, nowIso, indexJson, reference,
    });
    return line;
  }
  if (requiredFailed.length) {
    line.partialCoverage = { failed: requiredFailed.length, attempted: matchedStores.size };
  }

  const best = observations.length
    ? observations.reduce((a, b) => (b.value < a.value || (b.value === a.value && b.purchasePrice < a.purchasePrice) ? b : a))
    : null;
  if (!target) {
    line.resolution = 'unresolvable';
    line.notes.push('target per item unavailable');
    await recordValueState(ctx, watch, { lastResolution: 'unresolvable', reason: 'target per item unavailable', nowIso, indexJson, reference });
    return line;
  }

  const closeBoundary = watch.closeThreshold ? target * (1 + Number(watch.closeThreshold) / 100) : null;
  const dealStatus = dealStatusOf(deal.current, allRows, status, target, roundStartIso, freshIso);
  const prev = {
    isBelow: Boolean(watch.isBelow),
    isClose: Boolean(watch.isClose),
    deal: deal.current || null,
    lastAlert: deal.lastAlert || null,
    episode: deal.episode || 0,
  };
  const decision = decideAlert(prev, { best, target, closeBoundary, dealStatus });

  if (decision.alertType && best) {
    const alert = {
      // Deterministic per deal and episode: a retried round, a concurrent
      // index pass or a re-run child can never record the same deal twice.
      id: `a_${watch.id}_e${decision.episode}_${fnv(best.dealKey)}_${decision.alertType}`,
      watchId: watch.id,
      price: best.value,
      purchasePrice: best.purchasePrice,
      targetPrice: target,
      unitLabel: VALUE_UNIT_LABEL,
      alertType: decision.alertType,
      currency: best.currency,
      store: best.store,
      source: best.source,
      name: best.name,
      link: best.link,
      observedAt: nowIso,
    };
    const inserted = (await ctx.watchStore.insertAlert(alert)) !== false;
    line.alerted = inserted;
    line.alertType = decision.alertType;
    if (!inserted) line.notes.push('alert already recorded for this deal');
    if (inserted && ctx.notifier) {
      try {
        await ctx.notifier.send({
          title: `${watch.label}: ${best.value.toFixed(2)} ${best.currency} per item at ${best.store}`,
          body: `${best.pack > 1 ? `${best.pack} for ${best.purchasePrice.toFixed(2)} — ` : ''}`
            + `target ${target.toFixed(2)} per item — ${best.name}`,
          link: best.link || watch.link || null,
        });
      } catch (err) {
        line.notes.push(`notify: ${err.message}`);
      }
    }
  }

  line.price = best?.value ?? null;
  line.status = !best
    ? 'no-data'
    : decision.isBelow && best.value <= target + 1e-9 ? 'below-target'
      : decision.isClose ? 'close-target' : 'above-target';
  line.resolution = best ? 'ok' : 'not-found';
  const reason = best ? null : notFoundReason(sweep.counts, allRows);
  if (reason) line.notes.push(reason);
  await recordValueState(ctx, watch, {
    lastResolution: line.resolution,
    reason,
    nowIso,
    best,
    decision,
    deal: {
      current: decision.deal,
      lastAlert: decision.lastAlert,
      episode: decision.episode,
      best: best ? {
        value: best.value, purchasePrice: best.purchasePrice, pack: best.pack, item: best.item,
        store: best.store, source: best.source, name: best.name, link: best.link, at: nowIso,
      } : deal.best || null,
    },
    indexJson,
    reference,
  });
  return line;
}

function notFoundReason(counts, rows) {
  const matched = [...rows.values()].filter((r) => r.verdict === VERDICT.MATCH);
  const unverified = matched.filter((r) => !r.sizeVerified).length;
  if (!matched.length) {
    return counts.pending
      ? `${counts.pending} possible listing(s) waiting to be verified; none verified yet.`
      : `${counts.seen} listing(s) checked, none is this product.`;
  }
  if (unverified === matched.length) return `${matched.length} listing(s) match but none states its size per item.`;
  return `${matched.length} verified listing(s), none returned with a price this round.`;
}

async function recordValueState(ctx, watch, {
  lastResolution, reason = null, nowIso, best = null, decision = null, deal = null,
  indexJson = null, reference = null,
}) {
  const health = {
    ok: 'ok', 'not-found': 'not_found', 'provider-error': 'provider_error', unresolvable: 'anchor_unavailable',
  }[lastResolution] || 'unchecked';
  const state = {
    checkedAt: nowIso,
    lastResolution,
    lastResolutionReason: reason,
    monitoringHealth: health,
    monitoringHealthReason: reason,
  };
  if (decision) {
    state.isBelow = decision.isBelow;
    state.isClose = decision.isClose;
  }
  if (best) {
    Object.assign(state, {
      resolvedAt: nowIso,
      lastPrice: best.value,
      lastPurchasePrice: best.purchasePrice,
      lastUnitLabel: VALUE_UNIT_LABEL,
      lastStore: best.store,
      lastSource: best.source,
      lastName: best.name,
      lastLink: best.link,
    });
  }
  await ctx.watchStore.updateState(watch.id, state);
  const value = {};
  if (deal) value.dealJson = JSON.stringify(deal);
  if (indexJson) value.indexJson = JSON.stringify(indexJson);
  if (reference) {
    value.referenceJson = JSON.stringify(reference);
    if (reference.targetValue != null) {
      value.targetUnitPrice = reference.targetValue;
      value.unitLabel = VALUE_UNIT_LABEL;
    }
  }
  if (Object.keys(value).length && ctx.watchStore.updateValueState) {
    await ctx.watchStore.updateValueState(watch.id, value);
  }
}

// --- the background index pass ---------------------------------------------------

// Run the index pass for one watch (claimed by the minute tick, or called
// right after creation). Never throws: a failure schedules a retry.
export async function indexValueWatch(ctx, watch, { now = new Date() } = {}) {
  try {
    const line = await checkValueWatch(ctx, watch, {
      mode: 'index',
      roundKey: `index:${now.toISOString()}`,
      acceptPartialSweep: true,
      now,
    });
    await ctx.watchStore.updateValueState(watch.id, {
      indexState: line.resolution === 'unresolvable' ? 'failed' : 'ready',
      indexDueAt: new Date(now.getTime() + INDEX_REFRESH_MS).toISOString(),
    });
    return { ...line, indexed: true };
  } catch (err) {
    const info = json(watch.indexJson) || {};
    const failures = (info.failures || 0) + 1;
    await ctx.watchStore.updateValueState(watch.id, {
      indexState: failures >= 5 ? 'failed' : 'pending',
      indexDueAt: new Date(now.getTime() + (failures >= 5 ? 60 * 60 * 1000 : INDEX_RETRY_MS)).toISOString(),
      indexJson: JSON.stringify({ ...info, failures, lastError: String(err?.message || err).slice(0, 200) }),
    }).catch(() => {});
    return {
      id: watch.id, label: watch.label, status: 'error', indexed: false,
      resolution: 'provider-error', notes: [err?.message || String(err)], alerted: false,
    };
  }
}

// The minute tick's claim: due watches leased for INDEX_LEASE_MS, so a pass
// that dies is simply claimed again once the lease runs out.
export async function claimDueIndexes(ctx, { now = new Date(), limit = 2 } = {}) {
  if (!ctx.watchStore?.claimIndexDue) return [];
  return ctx.watchStore.claimIndexDue(now.toISOString(), {
    limit,
    leaseUntil: new Date(now.getTime() + INDEX_LEASE_MS).toISOString(),
  });
}

export async function indexDueWatches(ctx, { ids = null, now = new Date(), limit = 2 } = {}) {
  const claimed = ids?.length ? ids : await claimDueIndexes(ctx, { now, limit });
  const lines = [];
  for (const id of claimed) {
    const watch = await ctx.watchStore.get(id);
    if (!watch || !watch.active) continue;
    lines.push(await indexValueWatch(ctx, watch, { now }));
  }
  return { claimed, lines };
}

// The compact Value Watch state the watch list carries (GET /watches): the
// per-item target, the index status and the best verified value.
export function valueWatchSummary(watch) {
  const reference = watchReference(watch);
  const index = json(watch.indexJson) || {};
  const deal = json(watch.dealJson) || {};
  const stores = index.stores || {};
  return {
    item: reference.item || null,
    itemLabel: formatItem(reference.item),
    pack: reference.pack || 1,
    targetValue: reference.targetValue ?? null,
    targetPackPrice: reference.targetPackPrice ?? null,
    indexState: watch.indexState || null,
    lastSweepAt: index.lastSweepAt || null,
    matched: index.counts?.matched ?? null,
    pending: index.counts?.pending ?? null,
    storesAnswered: Object.entries(stores).filter(([s, v]) => s !== 'flyers' && v === 'ok').map(([s]) => s),
    storesFailed: Object.entries(stores).filter(([s, v]) => s !== 'flyers' && v === 'failed').map(([s]) => s),
    storesBlocked: Object.entries(stores).filter(([s, v]) => s !== 'flyers' && v === STATE_BLOCKED).map(([s]) => s),
    sizeChoices: index.sizeChoices || null,
    // The owner's browser checks, per store: { at, state, seen, matched, pending }.
    browser: index.browser || null,
    best: deal.best || null,
  };
}

// The listing index, shaped for the Alerts page ("what is this watch tracking?").
export async function watchListingsView(ctx, watch) {
  const reference = watchReference(watch);
  const rows = (await ctx.watchListingStore?.list(watch.id)) || [];
  const order = { match: 0, pending: 1, reject: 2 };
  const listings = rows
    .sort((a, b) => (order[a.verdict] - order[b.verdict])
      || ((a.lastValue ?? Infinity) - (b.lastValue ?? Infinity)))
    .slice(0, 80)
    .map((r) => ({
      store: r.store,
      listingId: r.listingId,
      source: r.source,
      name: r.name,
      link: r.link,
      image: r.image,
      pack: r.pack,
      item: r.item,
      price: r.lastPrice,
      value: r.verdict === VERDICT.MATCH ? r.lastValue : null,
      verdict: r.verdict,
      verdictBy: r.verdictBy,
      reason: r.verdictReason,
      sizeVerified: r.sizeVerified,
      lastSeenAt: r.lastSeenAt,
      missingRounds: r.missingRounds,
      inStock: r.inStock ?? null,
    }));
  return {
    reference: {
      name: reference.name, brand: reference.brand, item: reference.item, pack: reference.pack,
      targetValue: reference.targetValue, targetPackPrice: reference.targetPackPrice, queries: reference.queries,
    },
    index: json(watch.indexJson),
    deal: json(watch.dealJson),
    listings,
  };
}
