// watchIdentity.js — the watch-specific identity policy.
//
// Registry resolution answers whether an observation may teach the shared
// product ledger. Watch resolution has a smaller, reversible blast radius and
// also knows which listing the user selected. This module keeps those decisions
// separate without weakening Registry thresholds or alert-time verification.

import { normalizeText, stripSizes } from './matching.js';
import {
  listingBrand,
  listingIdentityCandidate,
  listingSize,
} from './identity/listingCandidate.js';

export const WATCH_POLICY_VERSION = 'watch-identity-v3-2026-07-30';

export const WATCH_IDENTITY_STATE = Object.freeze({
  RESOLVING: 'resolving',
  ANCHORED_REGISTRY: 'anchored_registry',
  ANCHORED_SOURCE: 'anchored_source',
  ANCHORED_SPEC: 'anchored_spec',
  CONFIRMATION_REQUIRED: 'confirmation_required',
  UNRESOLVABLE: 'unresolvable',
  INACTIVE: 'inactive',
});

export const MONITORING_HEALTH = Object.freeze({
  UNCHECKED: 'unchecked',
  OK: 'ok',
  NOT_FOUND: 'not_found',
  NO_PRICE: 'no_price',
  PROVIDER_ERROR: 'provider_error',
  ANCHOR_UNAVAILABLE: 'anchor_unavailable',
});

export const TRUSTED_SOURCE_PROVIDERS = new Set(['amazon']);
export const SOURCE_AUTO_THRESHOLD = 0.72;
export const SOURCE_AUTO_MARGIN = 0.16;
export const SOURCE_PLAUSIBLE_THRESHOLD = 0.30;

const clean = (value, max = 500) => String(value ?? '').trim().slice(0, max);
const clamp = (value) => Math.max(0, Math.min(1, value));

export function parseWatchJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return Array.isArray(value) ? fallback : value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function isTrustedSourceIdentity(provider, productId) {
  const p = clean(provider, 30).toLowerCase();
  const id = clean(productId, 100);
  if (!TRUSTED_SOURCE_PROVIDERS.has(p)) return false;
  if (p === 'amazon') return /^B[A-Z0-9]{9}$/i.test(id);
  return false;
}

export function sourceSnapshot(listing = {}, fallback = {}) {
  const alreadyProjected = listing && typeof listing === 'object' &&
    ('family' in listing || 'processing' in listing) &&
    (listing.size == null || typeof listing.size === 'object');
  if (alreadyProjected) {
    return {
      provider: clean(listing.provider ?? fallback.provider, 30).toLowerCase() || null,
      productId: clean(listing.productId ?? listing.id ?? fallback.productId, 100) || null,
      name: clean(listing.name ?? fallback.name, 240) || null,
      nameAr: clean(listing.nameAr ?? fallback.nameAr, 240) || null,
      brand: clean(listing.brand ?? fallback.brand, 100) || null,
      size: listing.size && typeof listing.size === 'object' ? listing.size : null,
      count: Number(listing.count) > 0 ? Number(listing.count) : null,
      family: clean(listing.family, 80) || null,
      cut: clean(listing.cut, 80) || null,
      processing: clean(listing.processing, 80) || null,
      variety: clean(listing.variety, 120) || null,
      image: clean(listing.image ?? fallback.image, 500) || null,
      link: clean(listing.link ?? fallback.link, 500) || null,
    };
  }
  const merged = {
    id: listing.id ?? listing.productId ?? fallback.id ?? fallback.productId ?? null,
    provider: listing.provider ?? listing.store ?? fallback.provider ?? null,
    name: listing.name ?? fallback.name ?? fallback.label ?? fallback.query ?? '',
    nameAr: listing.nameAr ?? fallback.nameAr ?? null,
    brand: listing.brand ?? fallback.brand ?? fallback.brandId ?? null,
    size: listing.size ?? fallback.size ?? fallback.sizeText ?? null,
    image: listing.image ?? listing.imageUrl ?? fallback.image ?? null,
    link: listing.link ?? fallback.link ?? null,
  };
  const candidate = listingIdentityCandidate(merged);
  return {
    provider: clean(merged.provider, 30).toLowerCase() || null,
    productId: clean(merged.id, 100) || null,
    name: clean(merged.name, 240) || null,
    nameAr: clean(merged.nameAr, 240) || null,
    brand: candidate?.brand || listingBrand(merged) || clean(merged.brand, 100) || null,
    size: candidate?.size || null,
    count: candidate?.count || null,
    family: candidate?.family || null,
    cut: candidate?.cut || null,
    processing: candidate?.processing || null,
    variety: candidate?.variety || null,
    image: clean(merged.image, 500) || null,
    link: clean(merged.link, 500) || null,
  };
}

function imageKey(value) {
  const raw = clean(value, 500);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`.toLowerCase();
  } catch {
    return raw.split('?')[0].toLowerCase();
  }
}

function titleKey(snapshot) {
  return normalizeText(`${snapshot?.name || ''} ${snapshot?.nameAr || ''}`);
}

function titleTokens(snapshot) {
  const key = normalizeText(stripSizes(titleKey(snapshot)));
  return new Set(key.split(/\s+/u).filter((token) => token.length > 1));
}

function overlap(a, b) {
  const aa = titleTokens(a);
  const bb = titleTokens(b);
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const token of aa) if (bb.has(token)) intersection += 1;
  return intersection / Math.max(aa.size, bb.size);
}

function sameMeasuredSize(a, b) {
  if (!a?.size || !b?.size) return null;
  if (a.size.unit !== b.size.unit) return false;
  const av = Number(a.size.value);
  const bv = Number(b.size.value);
  if (!(av > 0) || !(bv > 0)) return null;
  return Math.abs(av - bv) / Math.max(av, bv) <= 0.03;
}

function identityConflicts(reference, candidate, { strictCandidatePair = false } = {}) {
  const conflicts = [];
  if (reference.brand && candidate.brand && reference.brand !== candidate.brand) {
    conflicts.push('brand-conflict');
  }
  const sizeSame = sameMeasuredSize(reference, candidate);
  if (sizeSame === false) conflicts.push('size-conflict');
  if (reference.count && candidate.count && Number(reference.count) !== Number(candidate.count)) {
    conflicts.push('count-conflict');
  }
  for (const field of ['family', 'cut', 'processing', 'variety']) {
    const a = reference[field];
    const b = candidate[field];
    if (a && b && a !== b) conflicts.push(`${field}-conflict`);
    if (strictCandidatePair && field === 'variety' && Boolean(a) !== Boolean(b)) {
      conflicts.push('variety-evidence-conflict');
    }
  }
  return conflicts;
}

export function scoreSourceListing(referenceInput, listing, { provider = null } = {}) {
  const reference = sourceSnapshot(referenceInput);
  const candidate = sourceSnapshot(listing, { provider });
  const conflicts = identityConflicts(reference, candidate);
  const evidence = [];
  let score = 0;

  const sameSourceId = Boolean(
    reference.provider && candidate.provider &&
    reference.provider === candidate.provider &&
    reference.productId && candidate.productId &&
    reference.productId === candidate.productId
  );
  if (sameSourceId) {
    score += 0.48;
    evidence.push('source-id');
  }

  if (imageKey(reference.image) && imageKey(reference.image) === imageKey(candidate.image)) {
    score += 0.28;
    evidence.push('image');
  }

  const referenceTitle = titleKey(reference);
  const candidateTitle = titleKey(candidate);
  const nameOverlap = overlap(reference, candidate);
  if (referenceTitle && referenceTitle === candidateTitle) {
    score += 0.30;
    evidence.push('exact-name');
  } else if (nameOverlap > 0) {
    score += 0.25 * nameOverlap;
    evidence.push(`name-overlap:${nameOverlap.toFixed(2)}`);
  }

  if (reference.brand && candidate.brand && reference.brand === candidate.brand) {
    score += 0.10;
    evidence.push('brand');
  }
  const sizeSame = sameMeasuredSize(reference, candidate);
  if (sizeSame === true) {
    score += 0.10;
    evidence.push('size');
  }
  if (reference.count && candidate.count && Number(reference.count) === Number(candidate.count)) {
    score += 0.07;
    evidence.push('count');
  }
  for (const field of ['family', 'cut', 'processing', 'variety']) {
    if (reference[field] && candidate[field] && reference[field] === candidate[field]) {
      score += 0.04;
      evidence.push(field);
    }
  }

  return {
    score: conflicts.length ? 0 : clamp(score),
    conflicts,
    evidence,
    nameOverlap,
    sameSourceId,
    reference,
    candidate,
    listing,
  };
}

function sameSourceProduct(a, b) {
  if (identityConflicts(a.candidate, b.candidate, { strictCandidatePair: true }).length) {
    return false;
  }
  if (
    a.candidate.provider === b.candidate.provider &&
    a.candidate.productId && a.candidate.productId === b.candidate.productId
  ) return true;
  if (imageKey(a.candidate.image) && imageKey(a.candidate.image) === imageKey(b.candidate.image)) {
    return true;
  }
  const exactName = titleKey(a.candidate) && titleKey(a.candidate) === titleKey(b.candidate);
  if (exactName) return true;
  const brandCompatible = !a.candidate.brand || !b.candidate.brand ||
    a.candidate.brand === b.candidate.brand;
  const sizeCompatible = sameMeasuredSize(a.candidate, b.candidate) !== false;
  return brandCompatible && sizeCompatible && overlap(a.candidate, b.candidate) >= 0.35;
}

function candidateView(group) {
  const best = group.entries.reduce((winner, entry) => (
    !winner || entry.score > winner.score ? entry : winner
  ), null);
  const providers = [...new Set(group.entries.map((entry) => entry.candidate.provider).filter(Boolean))];
  const supportBonus = Math.min(0.18, Math.max(0, providers.length - 1) * 0.06);
  const score = clamp((best?.score || 0) + supportBonus);
  return {
    type: 'source',
    provider: best?.candidate.provider || null,
    productId: best?.candidate.productId || null,
    name: best?.candidate.name || best?.candidate.nameAr || null,
    nameAr: best?.candidate.nameAr || null,
    brand: best?.candidate.brand || null,
    size: best?.candidate.size || null,
    count: best?.candidate.count || null,
    image: best?.candidate.image || null,
    link: best?.candidate.link || null,
    score,
    runnerEvidence: best?.evidence || [],
    sourceCount: providers.length,
    providers,
    conflicts: best?.conflicts || [],
    snapshot: best?.candidate || null,
  };
}

export function rankSourceCandidates(reference, entries, {
  coverageComplete = true,
  attempted = 0,
  succeeded = 0,
  historyEntries = [],
} = {}) {
  const scored = (entries || [])
    .map((entry) => scoreSourceListing(reference, entry.listing || entry, {
      provider: entry.provider || entry.store || entry.listing?.provider || null,
    }))
    .filter((entry) => !entry.conflicts.length && entry.candidate.productId);

  const groups = [];
  for (const entry of scored.sort((a, b) => b.score - a.score)) {
    const group = groups.find((candidateGroup) => sameSourceProduct(candidateGroup.entries[0], entry));
    if (group) group.entries.push(entry);
    else groups.push({ entries: [entry] });
  }
  const candidates = groups.map(candidateView).map((candidate) => {
    const matchingHistory = historyEntries.filter((row) => {
      const historical = sourceSnapshot(row);
      if (identityConflicts(candidate.snapshot, historical).length) return false;
      const sameImage = imageKey(candidate.image) &&
        imageKey(candidate.image) === imageKey(historical.image);
      const sameTitle = titleKey(candidate.snapshot) &&
        titleKey(candidate.snapshot) === titleKey(historical);
      return sameImage || sameTitle;
    });
    const historyWeeks = matchingHistory.reduce(
      (total, row) => total + Math.max(1, Number(row.weeksSeen || row.weeks_seen || 1)),
      0,
    );
    const historyBonus = Math.min(0.08, historyWeeks * 0.01);
    return {
      ...candidate,
      score: clamp(candidate.score + historyBonus),
      historyCount: matchingHistory.length,
      historyWeeks,
      runnerEvidence: historyBonus
        ? [...candidate.runnerEvidence, `price-history:${historyWeeks}`]
        : candidate.runnerEvidence,
    };
  }).sort((a, b) => b.score - a.score);
  const plausible = candidates.filter((candidate) => candidate.score >= SOURCE_PLAUSIBLE_THRESHOLD);
  const top = candidates[0] || null;
  const second = candidates[1] || null;
  const margin = top ? top.score - (second?.score || 0) : 0;
  const autoCandidate = top && coverageComplete &&
    top.score >= SOURCE_AUTO_THRESHOLD &&
    margin >= SOURCE_AUTO_MARGIN
    ? top
    : null;

  return {
    candidates,
    plausible,
    autoCandidate,
    top,
    margin,
    coverageComplete,
    attempted,
    succeeded,
  };
}

export function verifySourceListing(reference, listing, {
  provider = null,
  productId = null,
  allowRotation = true,
} = {}) {
  const result = scoreSourceListing(reference, listing, { provider });
  if (result.conflicts.length) {
    return { matched: false, score: 0, reason: result.conflicts[0], evidence: result.evidence };
  }
  const actualId = clean(result.candidate.productId, 100);
  const expectedId = clean(productId || result.reference.productId, 100);
  const providerMatches = !result.reference.provider || !result.candidate.provider ||
    result.reference.provider === result.candidate.provider;
  if (providerMatches && expectedId && actualId === expectedId &&
      result.score >= SOURCE_AUTO_THRESHOLD) {
    return { matched: true, score: result.score, reason: null, evidence: result.evidence };
  }
  if (allowRotation && result.score >= SOURCE_AUTO_THRESHOLD) {
    return { matched: true, score: result.score, reason: null, evidence: result.evidence };
  }
  return {
    matched: false,
    score: result.score,
    reason: expectedId && actualId !== expectedId
      ? 'source-id-mismatch-without-continuity'
      : 'below-source-identity-threshold',
    evidence: result.evidence,
  };
}

export function inferIdentityState(watch = {}) {
  if (watch.active === false) return WATCH_IDENTITY_STATE.INACTIVE;
  if (Object.values(WATCH_IDENTITY_STATE).includes(watch.anchorState)) return watch.anchorState;
  if (watch.registryProductId) return WATCH_IDENTITY_STATE.ANCHORED_REGISTRY;
  if (watch.spec) return WATCH_IDENTITY_STATE.ANCHORED_SPEC;
  if (watch.lastResolution === 'needs-confirmation') return WATCH_IDENTITY_STATE.CONFIRMATION_REQUIRED;
  if (watch.lastResolution === 'unresolvable') return WATCH_IDENTITY_STATE.UNRESOLVABLE;
  return WATCH_IDENTITY_STATE.RESOLVING;
}

export function inferMonitoringHealth(watch = {}) {
  if (watch.monitoringHealth) return watch.monitoringHealth;
  if (![WATCH_IDENTITY_STATE.ANCHORED_REGISTRY, WATCH_IDENTITY_STATE.ANCHORED_SOURCE,
    WATCH_IDENTITY_STATE.ANCHORED_SPEC].includes(inferIdentityState(watch))) return null;
  const legacy = {
    ok: MONITORING_HEALTH.OK,
    'not-found': MONITORING_HEALTH.NOT_FOUND,
    'no-price': MONITORING_HEALTH.NO_PRICE,
    'provider-error': MONITORING_HEALTH.PROVIDER_ERROR,
    unresolvable: MONITORING_HEALTH.ANCHOR_UNAVAILABLE,
  };
  return legacy[watch.lastResolution] || MONITORING_HEALTH.UNCHECKED;
}

export function buildCandidateSnapshot(candidates, reason, {
  now = new Date().toISOString(),
  policyVersion = WATCH_POLICY_VERSION,
} = {}) {
  const seed = `${now}|${policyVersion}|${(candidates || []).map((c) => (
    `${c.type}:${c.provider || ''}:${c.productId || ''}:${Number(c.score || 0).toFixed(4)}`
  )).join('|')}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return {
    version: `wc_${(hash >>> 0).toString(36)}`,
    policyVersion,
    createdAt: now,
    reason,
    candidates: (candidates || []).slice(0, 8),
  };
}
