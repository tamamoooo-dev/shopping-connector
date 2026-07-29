// monitor.js — Price Monitoring (the Keepa-inspired Personal Alerts feature).
//
// A WATCH is a target price on something the user wants to buy. It is anchored
// in exactly ONE of two ways, and never to retailer-side references:
//
//   STRICT   registry_product_id (pr_) — "THIS product, wherever it is sold".
//            A check verifies each candidate against that one product through
//            the shared resolver (identity/verify.js -> scoreCandidate).
//   FLEXIBLE spec — "this CLASS of product": pinned identity dimensions such
//            as {"family":"chicken","cut":"breast"} = any chicken breast, any
//            brand, any size, compared per kg (identity/spec.js).
//
// Identity is resolved ONCE, at creation, IN THE FOREGROUND (anchorWatch), so
// an ambiguous product is adjudicated by a human looking at it rather than by
// an unattended cron choosing between guessing and going quiet. A watch with
// no anchor holds an EXPLICIT waiting state (pending-migration /
// needs-confirmation / unresolvable), monitors nothing, and costs nothing.
//
// TRUST RULES (what keeps unattended alerts honest):
//   1. Identity, never text. Retrieval is still lexical — a query string is how
//      a store search endpoint finds anything — but the DECISION is the shared
//      resolver. A retailer rename, a rotated catalog id or a switch of
//      language cannot break a watch, and a recycled id cannot smuggle a
//      different product past it.
//   2. Unknown ABSTAINS for a strict watch (the resolver weighs other
//      evidence) and does NOT satisfy a pin for a flexible one (a predicate has
//      no other evidence). Both report their exclusions; neither goes silent.
//   3. Crossing semantics: an alert fires when the price CROSSES down to the
//      target (above -> at/below), not on every check while it stays below.
//      When the price rises back above target the watch re-arms.
//   4. Fail-closed: validateNotificationObservation independently re-reads the
//      price and re-runs the identity decision before any alert is written.
//   5. EVERY check records its outcome, including the ones that find nothing.
//      checked_at says a check RAN; resolved_at says it SUCCEEDED. A watch that
//      has quietly stopped resolving is therefore visible, which is the whole
//      point of the 2026-07-29 redesign.
//
// The monitor runs on a DAILY cron (index.js), fanned out through the SELF
// service binding so each batch gets its own subrequest budget. Store-agnostic:
// providers to sweep are config below; everything else reasons over ids.

import {
  offerFamily,
  productType,
  matchStage,
  normalizeText,
  resolveJourneyPool,
  stripSizes,
} from './matching.js';
import {
  rowToOffer,
  offerRelevance,
  isNameMatch,
  queryTokens,
} from './offers/contract.js';
import { applyEnrichment } from './offers/enrich.js';
import { notificationDestination } from './notificationNavigation.js';
import {
  effectivePurchasePrice,
  quantityForOffer,
  unitPriceFor,
  watchQuantity,
} from './priceWatch.js';
import { listingIdentityCandidate, productFromListing } from './identity/listingCandidate.js';
import { productForWatch, verifyListing } from './identity/verify.js';
import { resolveIdentityCandidate } from './registry/resolver.js';
import { decodeProfile, profileTokens } from './registry/model.js';
import {
  comparesByUnitPrice,
  countExclusion,
  describeExclusions,
  emptyExclusions,
  matchesSpec,
  specFromLegacyWatch,
  specFromListing,
  validateSpec,
} from './identity/spec.js';

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
// MAX_WATCHES / MAX_WATCHES_TOTAL are COMPUTE caps: they bound the daily
// cron's fan-out, so they count MONITORED watches (active AND anchored). An
// unanchored watch is skipped by the check and costs zero subrequests, so it
// must not occupy a slot — counting it would refuse a real watch to make room
// for one that does no work.
export const MAX_WATCHES = 24;
export const MAX_WATCHES_TOTAL = 90;
// MAX_WATCH_ROWS is the separate STORAGE bound. Without it, watches awaiting
// confirmation could accumulate without limit, because they are free by the
// compute cap's own logic. Set well above normal use: this is a backstop, not
// a workflow, and when it fires the error names the cause.
export const MAX_WATCH_ROWS = 60;
export const CHECK_BATCH = 3;
export const CANDIDATE_SEARCH_LIMIT = 50;

// The relevance floor for unattended alerting — stricter than display ranking:
// a compound look-alike ("milk chocolate", whole-word hit 100 × 0.45 penalty =
// 45) must stay BELOW this gate, while a genuine word-start match (70) passes.
const REL_FLOOR = 50;

const EPS = 1e-9;
const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;

// A FLEXIBLE watch's class, if the caller asked for one. Rejected loudly when
// malformed: a spec that silently fell back to "match everything" would be the
// worst possible failure mode for an unattended alert.
function specFromBody(b) {
  // An explicit spec wins — that is the API-level way to ask for a class.
  if (b.spec) {
    const spec = parseSpec(b.spec);
    if (spec && validateSpec(spec).valid) return JSON.stringify(spec);
    return null;
  }
  // Otherwise the watch dialog's three toggles. Unchecking ANY of them is the
  // user asking for a CLASS rather than a product ("any brand", "any size"),
  // which is precisely a spec. All three checked means "this exact product",
  // which is a strict watch and gets no spec at all.
  const relaxed = b.matchBrand === false || b.matchSize === false || b.matchVariant === false;
  if (!relaxed) return null;
  const listing = b.listing || { name: b.label || b.query, brand: b.brand, size: b.sizeText };
  const candidate = listingIdentityCandidate(listing);
  const spec = specFromListing(candidate, {
    matchBrand: b.matchBrand !== false,
    matchSize: b.matchSize !== false,
    matchVariant: b.matchVariant !== false,
  });
  return validateSpec(spec).valid ? JSON.stringify(spec) : null;
}

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

  const kind = ['product', 'grocery', 'registry'].includes(b.kind) ? b.kind : null;
  if (!kind) return { error: "kind must be 'product', 'grocery' or 'registry'" };

  const query = String(b.query || '').trim().slice(0, 80);
  if (query.length < 2) return { error: 'query must be at least 2 characters' };

  const targetPrice = Number(b.targetPrice);
  if (!Number.isFinite(targetPrice) || targetPrice <= 0 || targetPrice > 100000) {
    return { error: 'targetPrice must be a positive number' };
  }
  const closeThreshold = b.closeThreshold == null || b.closeThreshold === ''
    ? null
    : Number(b.closeThreshold);
  if (closeThreshold != null &&
      (!Number.isFinite(closeThreshold) || closeThreshold <= 0 || closeThreshold > 100)) {
    return { error: 'closeThreshold must be between 0 and 100 percent' };
  }

  // A malformed spec is refused, never silently dropped: a Flexible Watch that
  // quietly lost its pins would match everything.
  if (b.spec != null) {
    const parsed = parseSpec(b.spec);
    const check = parsed ? validateSpec(parsed) : { valid: false, errors: ['spec must be an object'] };
    if (!check.valid) return { error: `Invalid watch specification: ${check.errors.join('; ')}` };
  }

  const provider = String(b.provider || '').trim().slice(0, 30) || null;
  const productId = String(b.productId || '').trim().slice(0, 80) || null;
  if (kind === 'product') {
    if (!provider || !MONITOR_PROVIDERS.includes(provider)) {
      return { error: `product watches need a provider (one of: ${MONITOR_PROVIDERS.join(', ')})` };
    }
    if (!productId) return { error: 'product watches need a productId' };
  }
  if (kind === 'registry' && !/^pr_[a-z0-9]+$/.test(productId || '')) {
    return { error: 'registry watches need a registry productId (pr_…)' };
  }

  const url = (v) => {
    const s = String(v || '').trim().slice(0, 400);
    return /^https?:\/\//.test(s) ? s : null;
  };

  const label = String(b.label || '').trim().slice(0, 120) || query;
  // The reference SIZE is still read from the listing, but only as a
  // comparison basis (a per-kg target needs to know the pack size). It is no
  // longer part of identity — the resolver owns that now.
  const quantity = watchQuantity([label, query, String(b.sizeText || '').slice(0, 160)]
    .filter(Boolean).join(' '), '');
  const sizeUnit = quantity?.unit || null;
  const sizeTotal = quantity?.total || null;
  const sizeSource = quantity?.src || null;
  const targetUnit = unitPriceFor(targetPrice, quantity);
  // A Flexible Watch that leaves size free compares per unit. The target may
  // arrive either way: as a pack price plus a readable size (the product-card
  // flow, converted here), or as a unit price the user typed directly ("any
  // chicken breast under 30 SAR/kg"), which needs no reference pack at all.
  const spec = b.spec ? parseSpec(b.spec) : null;
  const statedUnitPrice = Number(b.targetUnitPrice);
  const statedUnitLabel = String(b.unitLabel || '').trim().slice(0, 24) || null;
  const statedUnit = Number.isFinite(statedUnitPrice) && statedUnitPrice > 0 && statedUnitLabel
    ? { value: statedUnitPrice, label: statedUnitLabel }
    : null;
  const unitTarget = statedUnit || targetUnit;
  if (spec && comparesByUnitPrice(spec) && !unitTarget) {
    return {
      error: 'A per-unit target needs either a readable package size or an explicit unit price',
    };
  }

  return {
    watch: {
      id: newId('w'),
      profileId,
      kind,
      label,
      query,
      provider: kind === 'product' ? provider : null,
      // kind 'product': a CACHE of where this identity currently sits in the
      // store's catalog (refreshed automatically when the retailer moves it).
      // kind 'registry': the registry's own stable id, which IS the identity.
      productId: kind === 'product' || kind === 'registry' ? productId : null,
      // `kind` is retained (it is NOT NULL, and the previous deployment keys off
      // it) but `scope` is the behavioural switch now: kind used to select a
      // whole resolution STRATEGY, and there is only one of those left.
      scope: kind === 'product' ? 'store' : 'market',
      // THE ANCHOR. A registry watch already carries one. Every other watch is
      // anchored by `anchorWatch` below, in the foreground, with the user
      // present — never inferred later by an unattended check.
      registryProductId: kind === 'registry' ? productId : null,
      spec: specFromBody(b),
      link: url(b.link),
      image: url(b.image),
      targetPrice: Math.round(targetPrice * 100) / 100,
      currency: 'SAR',
      sizeUnit,
      sizeTotal,
      sizeSource,
      targetUnitPrice: unitTarget ? Math.round(unitTarget.value * 10000) / 10000 : null,
      unitLabel: unitTarget?.label || null,
      closeThreshold: closeThreshold == null ? null : Math.round(closeThreshold * 100) / 100,
      active: true,
      isBelow: false,
      isClose: false,
      createdAt: new Date().toISOString(),
    },
  };
}

// --- anchoring (the ONE place identity is resolved) -------------------------------
// Resolution happens ONCE, when the watch is created, IN THE FOREGROUND, with
// the user present to adjudicate. This is the whole safety argument of the
// design: an ambiguous identity is settled by a human at the moment they are
// looking at the product, instead of by an unattended cron at 05:45 that can
// only choose between guessing and going quiet.
//
// Returns { watch } with an anchor, or { watch, needsConfirmation, candidates }
// when the resolver could not decide alone. Never throws on ambiguity.
// `dryRun` answers "what WOULD this do?" without writing anything — no mint,
// no anchor. The migration is the one moment this subsystem creates registry
// products, and a mint survives an engine rollback, so the operator gets to
// see the exact list before it happens rather than after.
export async function anchorWatch(ctx, watch, listing, { dryRun = false } = {}) {
  // A Flexible Watch is anchored by declaration — its class was pinned by the
  // user, so there is nothing to infer and it can never be ambiguous.
  if (watch.spec || watch.registryProductId) return { watch };
  if (!ctx.registryStore) {
    return {
      watch: {
        ...watch,
        lastResolution: RESOLUTION.UNRESOLVABLE,
        lastResolutionReason: 'The product registry is unavailable.',
      },
    };
  }

  // A legacy watch has no live listing, but its row already stores the brand
  // and size the v2 build derived. Those are the two attributes that dominate
  // resolution, so throwing them away and re-deriving from the label alone
  // would make the backfill resolve WORSE than the data allows — and every
  // watch that fails to resolve becomes a question for the user.
  const source = listing || {
    id: watch.productId,
    name: watch.label || watch.query,
    brand: watch.brandId || null,
    size: watch.sizeUnit && Number(watch.sizeTotal) > 0
      ? `${watch.sizeTotal} ${watch.sizeUnit}`
      : null,
    link: watch.link,
    image: watch.image,
  };
  const candidate = listingIdentityCandidate(source);
  if (!candidate) {
    return {
      watch: {
        ...watch,
        lastResolution: RESOLUTION.UNRESOLVABLE,
        lastResolutionReason: 'This listing carries no usable product name.',
      },
    };
  }

  const decision = await resolveIdentityCandidate(
    candidate,
    { offerId: `watch:${watch.id}`, store: watch.provider || null, region: null },
    ctx.registryStore,
  );

  if (decision.outcome === 'attach' && decision.productId) {
    return { watch: { ...watch, registryProductId: decision.productId } };
  }

  // CREATE-ON-DOUBT (REGISTRY-DESIGN §3 P1) reaching the online world: a watch
  // on a product no flyer has ever carried mints that product from the listing
  // the user is looking at. A false split heals later by merge; forcing the
  // watch onto a near-miss product would pollute invisibly.
  if (decision.outcome === 'create') {
    const product = productFromListing(source, { date: new Date().toISOString().slice(0, 10) });
    if (product) {
      if (dryRun) return { watch, wouldCreate: product, dryRun: true };
      await ctx.registryStore.createProduct(
        product, profileTokens(decodeProfile(product.token_profile)),
      );
      return { watch: { ...watch, registryProductId: product.id }, created: product };
    }
  }

  // Review, or a read too thin to mint. The user picks — and until they do the
  // watch holds an EXPLICIT waiting state and monitors nothing.
  const candidates = (decision.matchCandidates || []).slice(0, 5);
  return {
    watch: {
      ...watch,
      lastResolution: RESOLUTION.NEEDS_CONFIRMATION,
      lastResolutionReason: candidates.length
        ? `${candidates.length} products could match this listing.`
        : 'This listing does not name enough of the product to identify it.',
    },
    needsConfirmation: true,
    candidates,
  };
}

// --- the ONE-TIME legacy backfill -------------------------------------------------
// Moves every watch created before the product anchor out of 'pending-migration'
// into exactly one terminal state: anchored, needs-confirmation, or
// unresolvable. Run once from the ops console; idempotent, so a second run is a
// no-op over rows it already settled.
//
// The mapping is mechanical because a v2 row already stored its derived class:
// a gate that was STRICT pinned its attribute, a gate that was RELAXED left it
// free (identity/spec.js specFromLegacyWatch).
//
//   kind 'registry'            -> already anchored (the SQL migration copied it)
//   grocery, any gate relaxed  -> FLEXIBLE: the relaxed gates ARE the spec
//   everything else            -> STRICT: resolve the stored label to a product
// One reviewable row per product this migration would create. Everything an
// operator needs to judge a mint WITHOUT opening the registry: which watch
// caused it, the exact identity dimensions it was minted from, and the display
// name it will carry.
function mintLine(watch, product) {
  return {
    productId: product.id,
    displayName: product.display_name,
    fromWatch: watch.id,
    fromLabel: watch.label || watch.query,
    brand: product.brand_text || null,
    family: product.family || null,
    size: product.size_unit && product.size_total != null
      ? `${product.size_total} ${product.size_unit}`
        + (product.size_pack > 1 ? ` x${product.size_pack}` : '')
      : null,
    tokens: Object.keys(decodeProfile(product.token_profile)),
  };
}

// The default is deliberately SMALL. Measured in production 2026-07-29 against
// a 7,082-product registry: resolving even a handful of watches in one
// invocation exceeds the Worker CPU limit (error 1101), and the cost is
// per-watch dependent — a watch whose tokens are common retrieves far more
// blocking candidates than one whose tokens are rare, so limit=8 can succeed
// where limit=5 fails. A fixed "safe" batch size does not exist.
//
// This is safe to run in a loop because progress is DURABLE PER WATCH: each
// watch is settled with its own setAnchor inside the loop, and an already
// settled watch is skipped on the next pass. A CPU death mid-batch loses only
// the watch it was working on. Call repeatedly until `scanned` is 0.
export async function resolveLegacyWatches(ctx, { limit = 3, dryRun = false, retry = false } = {}) {
  const report = {
    startedAt: new Date().toISOString(),
    dryRun,
    scanned: 0, anchored: 0, specced: 0, needsConfirmation: 0, unresolvable: 0,
    minted: [], lines: [],
  };
  const watches = await ctx.watchStore.list({});
  for (const watch of watches) {
    if (report.scanned >= limit) break;
    // SETTLED means anchored OR already given a terminal explanation. Skipping
    // only the anchored ones livelocks: a needs-confirmation watch is not
    // monitorable, so every pass re-visits it, and with a small batch the run
    // never advances past the first few stuck watches. Measured in production
    // 2026-07-29 — 12 batches re-scanned the same 2 watches while 17 were
    // never visited. Re-resolving them is also pointless: the outcome cannot
    // change without a registry change or a human, and `retry` asks for that
    // deliberately.
    if (isMonitorable(watch)) continue;
    if (!retry && UNANCHORED.has(watch.lastResolution)
        && watch.lastResolution !== RESOLUTION.PENDING_MIGRATION) continue;
    report.scanned += 1;
    const line = { id: watch.id, label: watch.label };

    // A relaxed v2 gate means the user asked for a CLASS. That intent survives
    // as a spec — this is the capability the redesign had to preserve.
    const relaxed = watch.matchBrand === false
      || watch.matchSize === false
      || watch.matchVariant === false;
    if (relaxed) {
      const spec = specFromLegacyWatch(watch);
      if (validateSpec(spec).valid) {
        if (!dryRun) {
          await ctx.watchStore.setAnchor(watch.id, {
            spec: JSON.stringify(spec), lastResolution: null, lastResolutionReason: null,
          });
        }
        report.specced += 1;
        report.lines.push({ ...line, outcome: 'spec', spec });
        continue;
      }
      if (!dryRun) {
        await ctx.watchStore.setAnchor(watch.id, {
          lastResolution: RESOLUTION.UNRESOLVABLE,
          lastResolutionReason: 'No product class could be derived from this watch.',
        });
      }
      report.unresolvable += 1;
      report.lines.push({ ...line, outcome: 'unresolvable' });
      continue;
    }

    // Otherwise the watch meant ONE product. Resolve from the stored label plus
    // the brand and size the row already carries. Zero subrequests.
    const anchored = await anchorWatch(ctx, watch, null, { dryRun });

    // A DRY RUN reports what would happen and writes nothing.
    if (anchored.wouldCreate) {
      report.anchored += 1;
      report.minted.push(mintLine(watch, anchored.wouldCreate));
      report.lines.push({ ...line, outcome: 'anchored', wouldMint: anchored.wouldCreate.id });
      continue;
    }

    if (anchored.watch.registryProductId) {
      if (!dryRun) {
        await ctx.watchStore.setAnchor(watch.id, {
          registryProductId: anchored.watch.registryProductId,
          lastResolution: null, lastResolutionReason: null,
        });
      }
      report.anchored += 1;
      if (anchored.created) report.minted.push(mintLine(watch, anchored.created));
      report.lines.push({
        ...line, outcome: 'anchored',
        productId: anchored.watch.registryProductId,
        minted: anchored.created ? anchored.created.id : null,
      });
      continue;
    }
    if (!dryRun) {
      await ctx.watchStore.setAnchor(watch.id, {
        lastResolution: anchored.watch.lastResolution,
        lastResolutionReason: anchored.watch.lastResolutionReason,
      });
    }
    if (anchored.watch.lastResolution === RESOLUTION.NEEDS_CONFIRMATION) report.needsConfirmation += 1;
    else report.unresolvable += 1;
    report.lines.push({
      ...line,
      outcome: anchored.watch.lastResolution,
      reason: anchored.watch.lastResolutionReason,
    });
  }
  report.finishedAt = new Date().toISOString();
  // The invariant this whole exercise exists to hold.
  report.stillPending = (await ctx.watchStore.list({}))
    .filter((w) => !isMonitorable(w) && !UNANCHORED.has(w.lastResolution)).length;
  return report;
}

// --- diagnostics: "why is this watch quiet?" -------------------------------------
// `last_resolution` says WHAT happened. This says why, per candidate, against
// live results — the question an operator actually has when a watch has been
// reporting not-found for a week and the product is visibly on the shelf.
//
// Read-only and side-effect free: it runs the real retrieval and the real
// identity decision, then reports every candidate with its verdict instead of
// selecting one. Nothing is written, no alert can fire.
export async function diagnoseWatch(ctx, watch) {
  const anchor = watchAnchor(watch);
  const out = {
    id: watch.id,
    label: watch.label,
    anchor: anchor
      ? { kind: anchor.kind, productId: anchor.productId || null, spec: anchor.spec || null }
      : null,
    lastResolution: watch.lastResolution || null,
    lastResolutionReason: watch.lastResolutionReason || null,
    resolvedAt: watch.resolvedAt || null,
    candidates: [],
    notes: [],
  };
  if (!anchor) {
    out.notes.push('This watch has no anchor, so it monitors nothing.');
    return out;
  }

  let product = null;
  if (anchor.kind === 'product') {
    const landed = await productForWatch(ctx.registryStore, anchor.productId);
    product = landed.product;
    out.product = product
      ? {
          id: product.id,
          displayName: product.display_name,
          brand: product.brand_text || product.brand_slug || null,
          family: product.family || null,
          size: product.size_unit && product.size_total != null
            ? `${product.size_total} ${product.size_unit}` : null,
          sightings: product.sightings ?? null,
        }
      : null;
    if (landed.moved) out.notes.push(`A registry merge moved this watch to ${landed.productId}.`);
    if (!product) {
      out.notes.push('The watched product is no longer in the registry.');
      return out;
    }
  }

  const query = retrievalQuery(watch, anchor, product);
  out.query = query;
  const sweep = await sweepProviders(ctx, watch, query, out.notes);
  const entries = [...sweep.candidates];
  if (anchor.kind === 'spec') entries.push(...(await sweepFlyers(ctx, query, out.notes)));
  out.seen = entries.length;

  for (const entry of entries) {
    const candidate = listingIdentityCandidate(entry.listing);
    const decision = anchor.kind === 'product'
      ? verifyListing(entry.listing, product)
      : matchesSpec(candidate, anchor.spec);
    out.candidates.push({
      store: entry.store,
      source: entry.source,
      name: entry.listing.name,
      price: effectivePurchasePrice(entry.listing),
      matched: decision.matched,
      // The resolver's own words — "cut-conflict", "variety-not-evidenced",
      // "below-identity-threshold" — are what actually explain a rejection.
      reason: decision.reason || decision.failed || null,
      score: decision.score != null ? Math.round(decision.score * 1000) / 1000 : null,
      extracted: candidate
        ? {
            brand: candidate.brand, family: candidate.family, cut: candidate.cut,
            processing: candidate.processing, variety: candidate.variety,
            size: candidate.size, count: candidate.count,
          }
        : null,
    });
  }
  // Rejections first, and the closest near-misses at the top of those: the
  // candidate that ALMOST matched is the one worth looking at.
  out.candidates.sort((a, b) => (a.matched === b.matched ? (b.score || 0) - (a.score || 0) : a.matched ? 1 : -1));
  out.matched = out.candidates.filter((c) => c.matched).length;
  return out;
}

// The products a user may pick from when confirming an ambiguous watch. Read
// only — picking is a separate, explicit write.
export async function watchCandidates(ctx, watch) {
  if (!ctx.registryStore || !watch) return [];
  const candidate = listingIdentityCandidate({
    id: watch.productId, name: watch.label || watch.query, brand: null, size: null,
  });
  if (!candidate) return [];
  const decision = await resolveIdentityCandidate(
    candidate,
    { offerId: `watch:${watch.id}`, store: watch.provider || null, region: null },
    ctx.registryStore,
    { includeDiagnostics: true },
  );
  const ids = (decision.matchCandidates || [])
    .map((c) => c.productId || c.id)
    .filter(Boolean)
    .slice(0, 8);
  if (!ids.length) return [];
  const rows = await ctx.registryStore.getProducts(ids);
  return rows.map((r) => ({
    productId: r.id,
    name: r.display_name || r.display_name_ar || r.id,
    brand: r.brand_text || r.brand_slug || null,
    size: r.size_unit && r.size_total ? `${r.size_total} ${r.size_unit}` : null,
  }));
}

// The user's answer. Binding is ONE write and teaches the registry nothing —
// human confirmation is high-quality evidence, but feeding it into the token
// profile is a separate decision this change deliberately does not take.
export async function confirmWatchProduct(ctx, watch, productId) {
  if (!/^pr_[a-z0-9]+$/.test(String(productId || ''))) {
    return { error: 'A registry product id (pr_…) is required.' };
  }
  const [product] = await ctx.registryStore.getProducts([productId]);
  if (!product) return { error: 'That product is not in the registry.' };
  await ctx.watchStore.setAnchor(watch.id, {
    registryProductId: product.id, lastResolution: null, lastResolutionReason: null,
  });
  return { productId: product.id };
}

export function buildWatchSettingsUpdate(body, watch) {
  const b = body && typeof body === 'object' ? body : {};
  if (!watch) return { error: 'Watch not found.' };
  const fields = {};
  // The old matchBrand/matchSize/matchVariant toggles were MATCHING
  // relaxations, and matching is the resolver's job now. What they expressed —
  // "any brand", "any size" — is a property of what the watch is ABOUT, so it
  // belongs to the spec, which is fixed at creation. Loosening a watch's
  // identity after the fact would silently change which product it alerts on.
  for (const key of ['matchBrand', 'matchSize', 'matchVariant']) {
    if (key in b) {
      return {
        error: `${key} is no longer a setting. Create a watch with a product `
          + 'specification (e.g. {"family":"chicken","cut":"breast"}) to watch a class of products.',
      };
    }
  }
  if ('closeThreshold' in b) {
    if (b.closeThreshold == null || b.closeThreshold === '') {
      fields.closeThreshold = null;
    } else {
      const value = Number(b.closeThreshold);
      if (!Number.isFinite(value) || value <= 0 || value > 100) {
        return { error: 'closeThreshold must be between 0 and 100 percent' };
      }
      fields.closeThreshold = Math.round(value * 100) / 100;
    }
  }
  if (!Object.keys(fields).length) return { error: 'No watch settings supplied.' };
  return { fields };
}

// --- evaluation ----------------------------------------------------------------
// ONE evaluation path. A watch is anchored either to a registry PRODUCT
// (STRICT — "this product, wherever it is sold") or to a SPEC of pinned
// identity dimensions (FLEXIBLE — "this class of product"). Retrieval is still
// lexical, because a query string is how a store's search endpoint finds
// anything; the DECISION never is. Every candidate goes through the shared
// extractor (identity/listingCandidate.js) and is then either verified against
// the product (identity/verify.js) or tested against the spec (identity/spec.js).
//
// An evaluation ALWAYS returns a resolution and a reason. "Found nothing" is a
// reported outcome with counted exclusions, never an empty return that a caller
// cannot distinguish from "nothing was on offer".

export const RESOLUTION = Object.freeze({
  OK: 'ok',
  NOT_FOUND: 'not-found',
  NO_PRICE: 'no-price',
  PROVIDER_ERROR: 'provider-error',
  PENDING_MIGRATION: 'pending-migration',
  NEEDS_CONFIRMATION: 'needs-confirmation',
  UNRESOLVABLE: 'unresolvable',
});

// The states in which a watch has no anchor and therefore does not monitor.
// Every one of them is EXPLICIT: there is no row that simply means "unknown".
const UNANCHORED = new Set([
  RESOLUTION.PENDING_MIGRATION,
  RESOLUTION.NEEDS_CONFIRMATION,
  RESOLUTION.UNRESOLVABLE,
]);

export function parseSpec(value) {
  if (!value) return null;
  if (typeof value === 'object') return Array.isArray(value) ? null : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// The anchor a watch carries, or null. The single place that decides whether a
// watch is monitorable — the cron, the caps and the UI all read this answer.
export function watchAnchor(watch = {}) {
  if (watch.registryProductId) return { kind: 'product', productId: watch.registryProductId };
  const spec = parseSpec(watch.spec);
  if (spec && validateSpec(spec).valid) return { kind: 'spec', spec };
  return null;
}

export const isMonitorable = (watch) => watchAnchor(watch) != null;

// The providers this watch sweeps. 'store' is one retailer, 'market' is all of
// them. Legacy rows without `scope` fall back to what their old kind meant.
export function watchProviders(watch = {}) {
  const scope = watch.scope || (watch.kind === 'product' ? 'store' : 'market');
  if (scope === 'store') {
    return MONITOR_PROVIDERS.includes(watch.provider) ? [watch.provider] : [];
  }
  return MONITOR_PROVIDERS;
}

// The comparison basis is DERIVED from the anchor, never configured beside it:
// without a pinned size, pack prices are not comparable across candidates, so
// the target must be a unit price.
export function watchTarget(watch, anchor) {
  const unitMode = anchor?.kind === 'spec' && comparesByUnitPrice(anchor.spec);
  if (!unitMode) return { value: Number(watch.targetPrice), unitLabel: null };
  if (Number.isFinite(Number(watch.targetUnitPrice)) && Number(watch.targetUnitPrice) > 0) {
    return { value: Number(watch.targetUnitPrice), unitLabel: watch.unitLabel || null };
  }
  const ref = watch.sizeUnit && watch.sizeTotal
    ? { unit: watch.sizeUnit, total: watch.sizeTotal, src: watch.sizeSource || 'measure' }
    : null;
  const normalized = unitPriceFor(watch.targetPrice, ref);
  return normalized ? { value: normalized.value, unitLabel: normalized.label } : null;
}

// A listing-shaped view of a flyer offer row, so ONE extractor serves both
// sources. The engine never grows a second way to read a product.
function offerAsListing(offer, row = {}) {
  return {
    id: offer.id,
    name: offer.name || offer.nameAr || '',
    nameAr: offer.nameAr || null,
    brand: row.e_brand || null,
    size: row.e_size || null,
    price: offer.price,
    currency: offer.currency || 'SAR',
    link: offer.link || null,
    image: offer.imageUrl || null,
  };
}

// Online candidates from every provider in scope. A store that fails to answer
// told us nothing about the product; it is counted, noted, and never fatal.
async function sweepProviders(ctx, watch, query, notes) {
  const providers = watchProviders(watch);
  if (!providers.length) {
    notes.push('no supported provider for this watch');
    return { candidates: [], failed: 0, attempted: 0 };
  }
  if (!ctx.searchClient) {
    notes.push('no search client (CONNECTOR binding missing)');
    return { candidates: [], failed: providers.length, attempted: providers.length };
  }
  const candidates = [];
  let failed = 0;
  await Promise.all(providers.map(async (provider) => {
    try {
      const results = await ctx.searchClient.search(provider, query, CANDIDATE_SEARCH_LIMIT);
      for (const r of (results || []).slice(0, CANDIDATE_SEARCH_LIMIT)) {
        candidates.push({ listing: r, store: provider, source: 'online' });
      }
    } catch (err) {
      failed += 1;
      notes.push(`${provider}: ${err.message}`);
    }
  }));
  return { candidates, failed, attempted: providers.length };
}

// Flyer candidates for a SPEC watch: current offers, classified with the same
// extractor. (A PRODUCT watch needs none of this — the registry already
// assigned its sightings, so the cheapest current sighting IS the flyer price.)
async function sweepFlyers(ctx, query, notes) {
  if (!ctx.offerStore) return [];
  try {
    const rows = await ctx.offerStore.search({
      q: query,
      currentOn: new Date().toISOString().slice(0, 10),
      limit: CANDIDATE_SEARCH_LIMIT,
    });
    const out = [];
    for (const row of rows) {
      const offer = rowToOffer(row);
      applyEnrichment(offer, row); // the SAME servable gate Search serves from
      if (!offer.name && !offer.nameAr) continue;
      out.push({ listing: offerAsListing(offer, row), store: offer.store, source: 'flyer' });
    }
    return out;
  } catch (err) {
    notes.push(`offers: ${err.message}`);
    return [];
  }
}

// Turn one surviving candidate into a priced observation, or null when it
// carries no usable price (counted separately from an identity rejection —
// "found but unpriced" and "not the product" are different facts).
function pricedObservation(entry, unitLabel) {
  const purchasePrice = effectivePurchasePrice(entry.listing);
  if (purchasePrice == null) return null;
  const quantity = quantityForOffer(entry.listing);
  if (!unitLabel) {
    return {
      price: purchasePrice, purchasePrice, unitLabel: null, quantity,
      offer: entry.listing, store: entry.store, source: entry.source,
      currency: entry.listing.currency || 'SAR',
      name: entry.listing.name, link: entry.listing.link || null,
    };
  }
  const normalized = unitPriceFor(purchasePrice, quantity);
  if (!normalized || normalized.label !== unitLabel) return null;
  return {
    price: normalized.value, purchasePrice, unitLabel: normalized.label, quantity,
    offer: entry.listing, store: entry.store, source: entry.source,
    currency: entry.listing.currency || 'SAR',
    name: entry.listing.name, link: entry.listing.link || null,
  };
}

// The retrieval query. Lexical by necessity and by design — it only has to
// surface candidates; identity decides which of them count.
export function retrievalQuery(watch, anchor, product) {
  const fromSpec = anchor?.kind === 'spec'
    ? [anchor.spec.brand, anchor.spec.family, anchor.spec.cut]
        .flatMap((v) => (Array.isArray(v) ? v.slice(0, 1) : [v]))
        .filter(Boolean)
        .join(' ')
    : null;
  const candidates = [
    stripSizes(watch.query || ''),
    product?.display_name,
    fromSpec,
    watch.label,
  ];
  for (const q of candidates) {
    const text = String(q || '').trim();
    if (text.length >= 2) return text.slice(0, 80);
  }
  return null;
}

// Evaluate one watch. Always returns { resolution, reason, ... }.
// `flyerOnly` is the post-ingest pass (index.js): flyer prices change ONLY at
// ingest, so that is when a flyer deal becomes knowable. It reads the registry
// sighting and nothing else — no provider sweep, no subrequests. It may only
// ever IMPROVE a watch: finding nothing returns resolution `null`, which means
// "no change", so a free extra look can never overwrite the daily check's
// recorded outcome with a misleading one.
export async function evaluateWatch(ctx, watch, notes = [], { flyerOnly = false } = {}) {
  const anchor = watchAnchor(watch);
  if (!anchor) {
    // An unanchored watch reads no price and alerts never. It keeps whichever
    // explicit waiting state it already has; it never silently becomes "found
    // nothing", because it did not look.
    const resolution = UNANCHORED.has(watch.lastResolution)
      ? watch.lastResolution
      : RESOLUTION.PENDING_MIGRATION;
    return {
      price: null,
      resolution,
      reason: watch.lastResolutionReason
        || 'This watch is not bound to a product yet.',
    };
  }

  let product = null;
  let rebindTo = null;
  if (anchor.kind === 'product') {
    if (!ctx.registryStore) {
      return { price: null, resolution: RESOLUTION.PROVIDER_ERROR, reason: 'registry unavailable' };
    }
    const landed = await productForWatch(ctx.registryStore, anchor.productId);
    if (!landed.product) {
      return {
        price: null,
        resolution: RESOLUTION.UNRESOLVABLE,
        reason: `The watched product (${anchor.productId}) is no longer in the registry.`,
      };
    }
    product = landed.product;
    if (landed.moved) rebindTo = landed.productId; // a merge relocated the identity
  }

  const query = retrievalQuery(watch, anchor, product);
  if (!query) {
    return { price: null, resolution: RESOLUTION.UNRESOLVABLE, reason: 'no retrieval query' };
  }

  const target = watchTarget(watch, anchor);
  if (!target) {
    return { price: null, resolution: RESOLUTION.UNRESOLVABLE, reason: 'unit-price target unavailable' };
  }

  const sweep = flyerOnly
    ? { candidates: [], failed: 0, attempted: 0 }
    : await sweepProviders(ctx, watch, query, notes);
  const entries = [...sweep.candidates];
  const exclusions = emptyExclusions();
  const observations = [];

  // A PRODUCT watch takes its flyer price straight from the registry: the
  // sighting was already assigned to this product, so there is nothing to
  // classify and no subrequest to spend.
  if (anchor.kind === 'product' && ctx.registryStore?.bestCurrentForProduct) {
    try {
      const best = await ctx.registryStore.bestCurrentForProduct(
        product.id, new Date().toISOString().slice(0, 10),
      );
      if (best) {
        observations.push({
          price: best.price, purchasePrice: best.price, unitLabel: null, quantity: null,
          offer: { price: best.price }, store: best.store, source: 'flyer',
          currency: best.currency || 'SAR',
          name: product.display_name || watch.label, link: best.link || null,
          identityVerified: true,
        });
      }
    } catch (err) {
      notes.push(`registry: ${err.message}`);
    }
  } else if (anchor.kind === 'spec') {
    entries.push(...(await sweepFlyers(ctx, query, notes)));
  }

  let unpriced = 0;
  for (const entry of entries) {
    const decision = anchor.kind === 'product'
      ? verifyListing(entry.listing, product)
      : matchesSpec(listingIdentityCandidate(entry.listing), anchor.spec);
    if (!(decision.matched)) {
      countExclusion(exclusions, decision.failed || decision.reason);
      continue;
    }
    const observation = pricedObservation(entry, target.unitLabel);
    if (!observation) {
      unpriced += 1;
      continue;
    }
    observations.push(observation);
  }

  const detail = describeExclusions(exclusions);
  if (!observations.length && flyerOnly) {
    // Nothing on this week's flyers. That is not news and not a failure — the
    // daily check owns this watch's recorded state.
    return { price: null, resolution: null, reason: null, rebindTo };
  }
  if (!observations.length) {
    // Distinguish "the stores did not answer" from "the product is not on
    // offer" — the arming state must not move on a store outage.
    // A store outage only EXPLAINS an empty pool when the online sweep was the
    // only source. If flyer candidates were examined and rejected, that is the
    // more truthful answer and it must not be masked by the outage.
    if (sweep.attempted && sweep.failed === sweep.attempted && entries.length === 0) {
      return {
        price: null, resolution: RESOLUTION.PROVIDER_ERROR, exclusions,
        reason: `No store answered (${sweep.failed}/${sweep.attempted} failed).`,
        rebindTo,
      };
    }
    if (unpriced && !detail) {
      return {
        price: null, resolution: RESOLUTION.NO_PRICE, exclusions, rebindTo,
        reason: `Found ${unpriced} matching listing(s), none carrying a usable price.`,
      };
    }
    return {
      price: null, resolution: RESOLUTION.NOT_FOUND, exclusions, rebindTo,
      reason: `${entries.length} candidate(s) seen, none matched` + (detail ? ` — excluded: ${detail}` : '.'),
    };
  }

  const best = observations.reduce((a, b) => (b.price < a.price ? b : a));
  return {
    ...best,
    resolution: RESOLUTION.OK,
    reason: null,
    exclusions,
    rebindTo,
    anchorKind: anchor.kind,
    // The resolved product travels WITH the observation so the fail-closed
    // gate can re-verify against the same thing this check decided against,
    // rather than re-reading the watch row and trusting it to still agree.
    product,
    productId: product?.id || null,
    spec: anchor.kind === 'spec' ? anchor.spec : null,
  };
}

const samePrice = (a, b) => (
  Number.isFinite(Number(a)) &&
  Number.isFinite(Number(b)) &&
  Math.abs(Number(a) - Number(b)) <= 0.000001
);

// Final fail-closed gate between offer selection and every alert/push write.
// It independently re-reads the selected offer price and, for grocery watches,
// re-runs identity matching and unit conversion from that same offer snapshot.
export function validateNotificationObservation(watch, observation) {
  if (!watch || !observation || !observation.offer) {
    return { valid: false, reason: 'selected offer missing' };
  }
  const anchor = watchAnchor(watch);
  if (!anchor) return { valid: false, reason: 'watch is not bound to a product' };

  // Independently re-read the price from the selected offer.
  const selectedOfferPrice = effectivePurchasePrice(observation.offer);
  if (selectedOfferPrice == null ||
      !samePrice(selectedOfferPrice, observation.purchasePrice)) {
    return { valid: false, reason: 'display price does not match selected offer' };
  }

  // Independently re-run the identity decision. A flyer sighting a PRODUCT
  // watch took from the registry is already identity-verified by assignment —
  // there is no listing text to re-read, and re-classifying it would be
  // inventing a second opinion the registry did not ask for.
  if (!observation.identityVerified) {
    const decision = anchor.kind === 'product'
      ? verifyListing(observation.offer, observation.product || null)
      : matchesSpec(listingIdentityCandidate(observation.offer), anchor.spec);
    if (!decision.matched) {
      return {
        valid: false,
        reason: `matched product failed verification: ${decision.reason || decision.failed}`,
      };
    }
  }

  // And re-derive the comparison figure from that same price.
  if (observation.unitLabel) {
    const normalized = unitPriceFor(selectedOfferPrice, quantityForOffer(observation.offer));
    if (!normalized ||
        normalized.label !== observation.unitLabel ||
        !samePrice(normalized.value, observation.price)) {
      return { valid: false, reason: 'unit price failed verification' };
    }
  } else if (!samePrice(observation.price, selectedOfferPrice)) {
    return { valid: false, reason: 'display price does not match selected offer' };
  }

  return {
    valid: true,
    displayPrice: selectedOfferPrice,
    unitPrice: observation.unitLabel ? observation.price : null,
    unitLabel: observation.unitLabel || null,
  };
}

export function buildNotificationPayload(watch, observation, target, alertType, verified) {
  const stateText = alertType === 'target' ? 'Target reached' : 'Close to target';
  const comparison = verified.unitLabel
    ? ` — ${verified.unitPrice.toFixed(2)} ${verified.unitLabel}; target ${target.value.toFixed(2)} ${target.unitLabel}`
    : ` — target ${target.value.toFixed(2)}`;
  return {
    title:
      `${watch.label}: ${verified.displayPrice.toFixed(2)} ${observation.currency} at ${observation.store}`,
    body:
      `${stateText} — offer ${verified.displayPrice.toFixed(2)} ${observation.currency}${comparison} — ` +
      `${observation.name || watch.query}` +
      (observation.source === 'flyer' ? ' (flyer price — verify on the flyer)' : ''),
    link: notificationDestination(watch, observation),
  };
}

// --- the check (evaluate + crossing + alert + notify) ---------------------------
export async function checkWatch(ctx, watch, { flyerOnly = false } = {}) {
  const line = {
    id: watch.id, label: watch.label, status: 'no-data', price: null,
    alerted: false, alertType: null, resolution: null, notes: [],
  };
  const best = await evaluateWatch(ctx, watch, line.notes, { flyerOnly });
  const now = new Date().toISOString();
  line.resolution = best.resolution;

  // THE NO-SILENT-FAILURE RULE. Every check writes its outcome, including the
  // ones that found nothing. `checked_at` says a check RAN; `resolved_at` says
  // it SUCCEEDED. Before this, a watch that had quietly stopped resolving was
  // indistinguishable from one simply waiting for a discount.
  const record = (fields = {}) => ctx.watchStore.updateState(watch.id, {
    checkedAt: now,
    lastResolution: best.resolution,
    lastResolutionReason: best.reason ?? null,
    ...fields,
  });

  // A registry MERGE relocated the identity: re-point the anchor before
  // anything else, so the next check starts from the survivor. This is the one
  // write that may move what a watch is ABOUT, and only the registry triggers it.
  if (best.rebindTo && ctx.watchStore.rebindProduct) {
    line.rebound = best.rebindTo;
    await ctx.watchStore.rebindProduct(watch.id, best.rebindTo);
  }

  // resolution === null means "no change" — only the flyer-only pass produces
  // it, and it must leave the daily check's recorded outcome untouched.
  if (best.resolution == null) {
    line.status = 'no-change';
    return line;
  }

  if (best.resolution !== RESOLUTION.OK) {
    // Nothing trustworthy found: record WHY, and keep the arming state — a
    // flaky store must never re-arm a below-target watch.
    if (best.reason) line.notes.push(best.reason);
    await record();
    return line;
  }

  line.price = best.price;
  const target = watchTarget(watch, watchAnchor(watch));
  if (!target) {
    line.notes.push('unit-price target unavailable');
    await record({ lastResolution: RESOLUTION.UNRESOLVABLE });
    return line;
  }

  const verified = validateNotificationObservation(watch, best);
  if (!verified.valid) {
    line.status = 'invalid-offer';
    line.price = null;
    line.notes.push(`notification validation: ${verified.reason}`);
    await record({ lastResolution: RESOLUTION.NOT_FOUND, lastResolutionReason: verified.reason });
    return line;
  }

  const hit = best.price <= target.value + EPS;
  const closeBoundary = watch.closeThreshold
    ? target.value * (1 + Number(watch.closeThreshold) / 100)
    : null;
  const close = !hit && closeBoundary != null && best.price <= closeBoundary + EPS;
  line.status = hit ? 'below-target' : close ? 'close-target' : 'above-target';

  const alertType = hit && !watch.isBelow
    ? 'target'
    : close && !watch.isClose && !watch.isBelow
      ? 'close'
      : null;
  if (alertType) {
    const alert = {
      id: newId('a'),
      watchId: watch.id,
      price: best.price,
      purchasePrice: best.purchasePrice ?? best.price,
      targetPrice: target.value,
      unitLabel: best.unitLabel || target.unitLabel,
      alertType,
      currency: best.currency,
      store: best.store,
      source: best.source,
      name: best.name,
      link: best.link,
      observedAt: now,
    };
    await ctx.watchStore.insertAlert(alert);
    line.alerted = true;
    line.alertType = alertType;
    if (ctx.notifier) {
      try {
        await ctx.notifier.send(buildNotificationPayload(watch, best, target, alertType, verified));
      } catch (err) {
        line.notes.push(`notify: ${err.message}`);
      }
    }
  }

  await record({
    isBelow: hit,
    isClose: close,
    resolvedAt: now,
    lastPrice: best.price,
    lastPurchasePrice: best.purchasePrice ?? best.price,
    lastUnitLabel: best.unitLabel || target.unitLabel,
    lastStore: best.store,
    lastSource: best.source,
    lastName: best.name,
    lastLink: best.link,
  });
  return line;
}

// --- the batch (cron fan-out children pass batches of ids) ----------------------
// Sequential per watch: each check already parallelizes its own store sweep.
// UNANCHORED watches are skipped entirely — they cost zero subrequests, which
// is why they must not count against the monitoring caps either.
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
    if (!isMonitorable(watch)) {
      // Not a failure and not silence: the watch already carries an explicit
      // waiting state (pending-migration / needs-confirmation / unresolvable)
      // and is reported as skipped rather than quietly omitted.
      report.skipped = (report.skipped || 0) + 1;
      report.lines.push({
        id: watch.id, label: watch.label, status: 'unanchored', price: null,
        alerted: false, alertType: null,
        resolution: watch.lastResolution || RESOLUTION.PENDING_MIGRATION,
        notes: [watch.lastResolutionReason || 'not bound to a product'],
      });
      continue;
    }
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
