// monitor.js — Price Monitoring (the Keepa-inspired Personal Alerts feature).
//
// A WATCH is a target price the user sets on something they want to buy:
//   • kind 'product'  — a directly-identifiable product (e.g. an Amazon ASIN):
//                       the monitor re-finds THAT product by its stable id in
//                       the store's live search results and reads its price.
//   • kind 'grocery'  — a staple (milk, eggs, …): the monitor sweeps EVERY
//                       supported source — all live online stores via the
//                       search connector AND the current structured flyer
//                       offers — and takes the best trustworthy price.
//
// TRUST RULES (what keeps unattended alerts honest):
//   1. Relevance gate: a candidate only counts when its NAME genuinely matches
//      the watched query (word-boundary + bilingual synonyms, matching.js) —
//      never raw substrings, so "milk" can't alert on a milk-chocolate biscuit.
//   2. Size gate: a grocery watch remembers the watched product's size when
//      known; a candidate only counts when its parsed size is comparable
//      (same unit family, total within ±25%) — a 200 ml milk can never trigger
//      a 2 L milk watch. Without a reference size, relevance alone decides.
//   3. Flyer offers must be NAME-tier matches (OCR-text-only hits are too weak
//      to act on unattended) and are labelled source 'flyer' in the alert so
//      the user knows to verify on the flyer.
//   4. Crossing semantics: an alert fires when the price CROSSES down to the
//      target (above → at/below), not on every check while it stays below —
//      one drop, one alert. When the price rises back above target the watch
//      re-arms automatically.
//   5. The SHARED gate ladder (matching.js resolveJourneyPool, 'alert' tier):
//      stage band → family → type → fresh-produce, the SAME interpretation the
//      frontend Shopping Summary reasons over — a watch never alerts on a
//      product the Summary would refuse to recommend from the same pool
//      ("كلوروكس ليمون" under a ليمون watch, a frozen strawberry under a
//      فراولة watch). Rules 1–3 are the alert tier's DECLARED extras; they
//      only ever narrow that shared pool.
//
// The monitor runs on a DAILY cron (index.js), fanned out through the same
// SELF service-binding mechanism as the weekly ingest so each batch of watches
// gets its own Free-plan subrequest budget. Store-agnostic: providers to sweep
// are config below; everything else reasons over ids.

import {
  isRelevantName,
  parseSize,
  sizeComparable,
  productFamily,
  offerFamily,
  productType,
  matchStage,
  resolveJourneyPool,
} from './matching.js';
import {
  rowToOffer,
  offerRelevance,
  isNameMatch,
  queryTokens,
} from './offers/contract.js';

// The live search providers a grocery watch sweeps (search-connector ids),
// most reliable first. Best-effort stores (amazon, noon) are included — a
// failed sweep of one store never blocks the others.
export const MONITOR_PROVIDERS = ['panda', 'tamimi', 'danube', 'lulu', 'ninja', 'amazon', 'noon'];

// Caps (production stability): the watch-list write API refuses beyond
// MAX_WATCHES active watches PER PROFILE (each browser's local profile is an
// independent user), and the cron checks watches in batches of CHECK_BATCH
// per child invocation (a grocery watch costs ~7 connector subrequests, so
// 3 watches ≈ 21 of the 50-subrequest child budget).
// MAX_WATCHES_TOTAL is the global backstop that protects the daily cron's
// Free-plan budget across ALL profiles: the fan-out spends 1 + ⌈total/3⌉ of
// the 32-invocations-per-event cap, so 90 total keeps it at ≤31.
export const MAX_WATCHES = 24;
export const MAX_WATCHES_TOTAL = 90;
export const CHECK_BATCH = 3;

// The relevance floor for unattended alerting — stricter than display ranking:
// a compound look-alike ("milk chocolate", whole-word hit 100 × 0.45 penalty =
// 45) must stay BELOW this gate, while a genuine word-start match (70) passes.
const REL_FLOOR = 50;

const EPS = 1e-9;
const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;

// --- validation (the open write API's gate) -----------------------------------
// Returns { watch } or { error }. Everything is length- and range-bounded; the
// watch id and bookkeeping fields are always server-generated.
export function buildWatch(body) {
  const b = body && typeof body === 'object' ? body : {};

  // The owning local profile (the frontend's per-browser profile.js id) —
  // the isolation boundary of the whole monitoring API. Every watch belongs
  // to exactly one profile; browsers never see each other's watches.
  const profileId = String(b.profileId || '').trim().slice(0, 64);
  if (profileId.length < 8) return { error: 'profileId is required (8-64 characters)' };

  const kind = b.kind === 'product' ? 'product' : b.kind === 'grocery' ? 'grocery' : null;
  if (!kind) return { error: "kind must be 'product' or 'grocery'" };

  const query = String(b.query || '').trim().slice(0, 80);
  if (query.length < 2) return { error: 'query must be at least 2 characters' };

  const targetPrice = Number(b.targetPrice);
  if (!Number.isFinite(targetPrice) || targetPrice <= 0 || targetPrice > 100000) {
    return { error: 'targetPrice must be a positive number' };
  }

  const provider = String(b.provider || '').trim().slice(0, 30) || null;
  const productId = String(b.productId || '').trim().slice(0, 80) || null;
  if (kind === 'product') {
    if (!provider || !MONITOR_PROVIDERS.includes(provider)) {
      return { error: `product watches need a provider (one of: ${MONITOR_PROVIDERS.join(', ')})` };
    }
    if (!productId) return { error: 'product watches need a productId' };
  }

  const url = (v) => {
    const s = String(v || '').trim().slice(0, 400);
    return /^https?:\/\//.test(s) ? s : null;
  };

  // Reference size for the grocery size gate: taken from the watched product's
  // name/size when the client provides them (it knows what the user was
  // looking at). Parsed server-side — the client never sends raw numbers.
  let sizeUnit = null;
  let sizeTotal = null;
  if (kind === 'grocery') {
    const sz = parseSize(String(b.sizeText || b.label || '').slice(0, 160), '');
    if (sz.unit && sz.total) {
      sizeUnit = sz.unit;
      sizeTotal = sz.total;
    }
  }

  return {
    watch: {
      id: newId('w'),
      profileId,
      kind,
      label: String(b.label || '').trim().slice(0, 120) || query,
      query,
      provider: kind === 'product' ? provider : null,
      productId: kind === 'product' ? productId : null,
      link: url(b.link),
      image: url(b.image),
      targetPrice: Math.round(targetPrice * 100) / 100,
      currency: 'SAR',
      sizeUnit,
      sizeTotal,
      active: true,
      isBelow: false,
      createdAt: new Date().toISOString(),
    },
  };
}

// --- evaluation ----------------------------------------------------------------
// The best trustworthy current price for a watch across its sources, or null.
// Returns { price, currency, store, source: 'online'|'flyer', name, link }.

function refSize(watch) {
  return watch.sizeUnit && watch.sizeTotal
    ? { unit: watch.sizeUnit, total: watch.sizeTotal }
    : null;
}

// kind 'grocery': sweep every online store + the current flyer offers, then
// resolve the pool through the SHARED gate ladder (matching.js
// resolveJourneyPool, HISTORY §34) at the 'alert' tier — the same stage →
// family → type → fresh-produce interpretation the Shopping Summary reasons
// over, so a watch can only ever act on a product the Summary would recommend
// from the same candidates. What stays alert-ONLY (declared here, and it only
// ever narrows): the stricter relevance floor (REL_FLOOR 50), the reference-
// size ±25% comparability gate, flyer NAME-tier matches only, and an emptied
// pool meaning silence (JOURNEY_POLICY.alert.neverEmpty = false).
async function evaluateGrocery(ctx, watch, notes) {
  const candidates = [];
  const ref = refSize(watch);

  // Online stores (via the search connector). Per-store failures are noted,
  // never fatal — monitoring degrades gracefully with flaky stores. Every
  // passing result joins the pool: the ladder needs the whole pool to know
  // the best match band present.
  if (ctx.searchClient) {
    await Promise.all(
      MONITOR_PROVIDERS.map(async (provider) => {
        try {
          const results = await ctx.searchClient.search(provider, watch.query);
          for (const r of results || []) {
            const price = Number(r.price);
            if (!Number.isFinite(price) || price <= 0) continue;
            if (!isRelevantName(r.name, watch.query, REL_FLOOR)) continue;
            if (ref) {
              const sz = parseSize(r.name, r.size);
              if (!sizeComparable(ref, sz)) continue; // wrong/unknown size
            }
            candidates.push({
              price, currency: r.currency || 'SAR', store: provider, source: 'online', name: r.name, link: r.link || null,
              // Interpretation for the ladder — same fields, same texts as the
              // Summary's onlineListing (compare.js).
              stage: matchStage({ name: r.name, brand: r.brand }, watch.query),
              family: productFamily(r.name),
              type: productType(r.name),
              text: `${r.name || ''} ${r.brand || ''}`,
            });
          }
        } catch (err) {
          notes.push(`${provider}: ${err.message}`);
        }
      }),
    );
  } else {
    notes.push('no search client (CONNECTOR binding missing)');
  }

  // Current flyer offers (already in D1 — zero subrequests). NAME-tier matches
  // only: OCR-text-only hits are too weak for unattended alerts.
  if (ctx.offerStore) {
    try {
      const rows = await ctx.offerStore.search({
        q: watch.query,
        currentOn: new Date().toISOString().slice(0, 10),
        limit: 100,
      });
      const tokens = queryTokens(watch.query);
      for (const row of rows) {
        const offer = rowToOffer(row);
        const rel = offerRelevance(offer, tokens, row.search_text || '');
        if (!isNameMatch(rel)) continue;
        const display = offer.name || offer.nameAr;
        if (!display || !isRelevantName(display, watch.query, REL_FLOOR)) continue;
        if (ref) {
          const sz = parseSize(`${offer.name || ''} ${offer.nameAr || ''}`, '');
          if (!sizeComparable(ref, sz)) continue;
        }
        const price = Number(offer.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        const bilingual = `${offer.name || ''} ${offer.nameAr || ''}`;
        candidates.push({
          price, currency: offer.currency || 'SAR', store: offer.store, source: 'flyer', name: display, link: offer.sourceUrl || null,
          // Interpretation over BOTH derived names, exactly as the Summary's
          // flyerListing probes (the product word often lands in one language).
          stage: matchStage({ name: bilingual }, watch.query),
          family: offerFamily(offer),
          type: productType(bilingual),
          text: bilingual,
        });
      }
    } catch (err) {
      notes.push(`offers: ${err.message}`);
    }
  }

  if (!candidates.length) return null;
  const pool = resolveJourneyPool(candidates, watch.query, 'alert');
  if (!pool.kept.length) return null; // silence over a wrong product
  const best = pool.kept.reduce((a, b) => (b.price < a.price ? b : a));
  return { price: best.price, currency: best.currency, store: best.store, source: best.source, name: best.name, link: best.link };
}

// kind 'product': re-find the EXACT product by its stable id in the store's
// live results (id match first, then a link containing the id).
async function evaluateProduct(ctx, watch, notes) {
  if (!ctx.searchClient) {
    notes.push('no search client (CONNECTOR binding missing)');
    return null;
  }
  let results;
  try {
    results = await ctx.searchClient.search(watch.provider, watch.query);
  } catch (err) {
    notes.push(`${watch.provider}: ${err.message}`);
    return null;
  }
  const id = String(watch.productId);
  const hit =
    (results || []).find((r) => String(r.id) === id) ||
    (results || []).find((r) => r.link && r.link.includes(id));
  if (!hit) {
    notes.push('product not found in current results');
    return null;
  }
  const price = Number(hit.price);
  if (!Number.isFinite(price) || price <= 0) {
    notes.push('product found but carries no price');
    return null;
  }
  return { price, currency: hit.currency || 'SAR', store: watch.provider, source: 'online', name: hit.name, link: hit.link || null };
}

export async function evaluateWatch(ctx, watch, notes = []) {
  return watch.kind === 'product'
    ? evaluateProduct(ctx, watch, notes)
    : evaluateGrocery(ctx, watch, notes);
}

// --- the check (evaluate + crossing + alert + notify) ---------------------------
export async function checkWatch(ctx, watch) {
  const line = { id: watch.id, label: watch.label, status: 'no-data', price: null, alerted: false, notes: [] };
  const best = await evaluateWatch(ctx, watch, line.notes);
  const now = new Date().toISOString();

  if (!best) {
    // Nothing trustworthy found this run: record the check, keep the arming
    // state (a flaky store must not re-arm a below-target watch).
    await ctx.watchStore.updateState(watch.id, { checkedAt: now });
    return line;
  }

  line.price = best.price;
  const hit = best.price <= watch.targetPrice + EPS;
  line.status = hit ? 'below-target' : 'above-target';

  if (hit && !watch.isBelow) {
    const alert = {
      id: newId('a'),
      watchId: watch.id,
      price: best.price,
      targetPrice: watch.targetPrice,
      currency: best.currency,
      store: best.store,
      source: best.source,
      name: best.name,
      link: best.link,
      observedAt: now,
    };
    await ctx.watchStore.insertAlert(alert);
    line.alerted = true;
    if (ctx.notifier) {
      try {
        await ctx.notifier.send({
          title: `${watch.label}: ${best.price.toFixed(2)} ${best.currency} at ${best.store}`,
          body:
            `Target ${watch.targetPrice.toFixed(2)} reached — ${best.name || watch.query}` +
            (best.source === 'flyer' ? ' (flyer price — verify on the flyer)' : ''),
          link: best.link,
        });
      } catch (err) {
        line.notes.push(`notify: ${err.message}`);
      }
    }
  }

  await ctx.watchStore.updateState(watch.id, {
    isBelow: hit,
    checkedAt: now,
    lastPrice: best.price,
    lastStore: best.store,
    lastSource: best.source,
    lastName: best.name,
    lastLink: best.link,
  });
  return line;
}

// Check a set of watches (all active ones, or an explicit id list — the cron
// fan-out children pass batches of ids). Sequential per watch: each grocery
// check already parallelizes its store sweep internally.
export async function checkWatches(ctx, { ids } = {}) {
  const report = { startedAt: new Date().toISOString(), checked: 0, alerted: 0, lines: [] };
  let watches;
  if (ids && ids.length) {
    watches = (await Promise.all(ids.map((id) => ctx.watchStore.get(id)))).filter(
      (w) => w && w.active,
    );
  } else {
    watches = await ctx.watchStore.list({ activeOnly: true });
  }
  for (const watch of watches) {
    const line = await checkWatch(ctx, watch);
    report.checked += 1;
    if (line.alerted) report.alerted += 1;
    report.lines.push(line);
  }
  report.finishedAt = new Date().toISOString();
  return report;
}

// --- push notification (optional, free) ------------------------------------------
// ntfy.sh: a free, no-account push service — the user installs the ntfy app and
// subscribes to their private topic; the engine POSTs one message per alert.
// Configured entirely by the NTFY_TOPIC secret (absent -> in-app alerts only).
export function createNtfyNotifier({ topic, server = 'https://ntfy.sh' }) {
  if (!topic) return null;
  const url = `${server.replace(/\/$/, '')}/${encodeURIComponent(topic)}`;
  return {
    async send({ title, body, link }) {
      // HTTP header values must be Latin-1; Arabic titles go into the body
      // instead of the Title header (ntfy renders the first line prominently).
      const asciiTitle = title && /^[\x20-\x7e]*$/.test(title) ? title : null;
      const headers = { Title: asciiTitle || 'Souq price alert', Tags: 'bell,moneybag' };
      if (link && /^[\x20-\x7e]*$/.test(link)) headers.Click = link;
      const text = asciiTitle ? body || '' : [title, body].filter(Boolean).join('\n');
      const res = await fetch(url, { method: 'POST', headers, body: text });
      if (!res.ok) throw new Error(`ntfy -> HTTP ${res.status}`);
    },
  };
}
