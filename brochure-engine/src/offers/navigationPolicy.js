// offers/navigationPolicy.js — Policy B for exact local brochure navigation.
//
// Trust hierarchy:
//   1. DUAL: page_ref and the exact offer hotspot both resolve to ONE page and
//      agree. This remains the preferred and strongest evidence.
//   2. HOTSPOT_UNIQUE: page_ref is unavailable, while the exact source offer id
//      occurs on exactly one page in the same complete stored flyer snapshot.
//   3. Everything else fails closed. Ambiguity and disagreement are never
//      accepted, regardless of the configured circuit-breaker thresholds.
//
// Thresholds protect the fallback as a whole from source/markup drift. When a
// target's ambiguity or disagreement RATE exceeds its configured threshold,
// all otherwise-valid hotspot-only fallbacks for that target are suppressed;
// dual links remain available because their original correctness contract is
// unchanged.

export const NAVIGATION_PROVENANCE = Object.freeze({
  DUAL: 'dual',
  HOTSPOT_UNIQUE: 'hotspot_unique',
});

export const NAVIGATION_STATUS = Object.freeze({
  DUAL: 'dual',
  HOTSPOT_UNIQUE: 'hotspot_unique',
  FLYER_UNAVAILABLE: 'flyer_unavailable',
  PAGE_REF_ONLY: 'page_ref_only',
  UNAVAILABLE: 'unavailable',
  PAGE_REF_AMBIGUOUS: 'page_ref_ambiguous',
  HOTSPOT_AMBIGUOUS: 'hotspot_ambiguous',
  DISAGREEMENT: 'disagreement',
});

export const DEFAULT_NAVIGATION_POLICY = Object.freeze({
  ambiguityRateThreshold: 0,
  disagreementRateThreshold: 0,
});

const finiteRate = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
};

export function normalizeNavigationPolicy(policy = {}) {
  return {
    ambiguityRateThreshold: finiteRate(
      policy.ambiguityRateThreshold,
      DEFAULT_NAVIGATION_POLICY.ambiguityRateThreshold,
    ),
    disagreementRateThreshold: finiteRate(
      policy.disagreementRateThreshold,
      DEFAULT_NAVIGATION_POLICY.disagreementRateThreshold,
    ),
  };
}

export function addPageEvidence(map, id, pageIndex) {
  if (id == null || !Number.isInteger(pageIndex)) return;
  const key = String(id);
  const pages = map.get(key) || new Set();
  pages.add(pageIndex);
  map.set(key, pages);
}

function evidencePages(map, id) {
  if (!map || id == null) return new Set();
  const pages = map.get(String(id));
  return pages instanceof Set ? pages : new Set();
}

const onlyPage = (pages) => (pages.size === 1 ? pages.values().next().value : null);

export function resolveNavigation(nav, { pageRef, offerId } = {}) {
  if (!nav) {
    return {
      status: NAVIGATION_STATUS.FLYER_UNAVAILABLE,
      pageIndex: null,
      provenance: null,
    };
  }

  const pageRefPages = evidencePages(nav.byPageRef, pageRef);
  const hotspotPages = evidencePages(nav.byOfferId, offerId);
  const pageByRef = onlyPage(pageRefPages);
  const pageByHotspot = onlyPage(hotspotPages);

  // Ambiguity is rejected before considering corroboration. A page_ref must
  // never "pick" one occurrence of a duplicated hotspot, and vice versa.
  if (pageRefPages.size > 1) {
    return {
      status: NAVIGATION_STATUS.PAGE_REF_AMBIGUOUS,
      pageIndex: null,
      provenance: null,
      pageRefPages,
      hotspotPages,
    };
  }
  if (hotspotPages.size > 1) {
    return {
      status: NAVIGATION_STATUS.HOTSPOT_AMBIGUOUS,
      pageIndex: null,
      provenance: null,
      pageRefPages,
      hotspotPages,
    };
  }

  if (Number.isInteger(pageByRef) && Number.isInteger(pageByHotspot)) {
    if (pageByRef !== pageByHotspot) {
      return {
        status: NAVIGATION_STATUS.DISAGREEMENT,
        pageIndex: null,
        provenance: null,
        pageRefPages,
        hotspotPages,
      };
    }
    return {
      status: NAVIGATION_STATUS.DUAL,
      pageIndex: pageByRef,
      provenance: NAVIGATION_PROVENANCE.DUAL,
      pageRefPages,
      hotspotPages,
    };
  }

  if (!Number.isInteger(pageByRef) && Number.isInteger(pageByHotspot)) {
    return {
      status: NAVIGATION_STATUS.HOTSPOT_UNIQUE,
      pageIndex: pageByHotspot,
      provenance: NAVIGATION_PROVENANCE.HOTSPOT_UNIQUE,
      pageRefPages,
      hotspotPages,
    };
  }

  if (Number.isInteger(pageByRef)) {
    return {
      status: NAVIGATION_STATUS.PAGE_REF_ONLY,
      pageIndex: null,
      provenance: null,
      pageRefPages,
      hotspotPages,
    };
  }

  return {
    status: NAVIGATION_STATUS.UNAVAILABLE,
    pageIndex: null,
    provenance: null,
    pageRefPages,
    hotspotPages,
  };
}

const rate = (count, total) => (total > 0 ? count / total : 0);

function snapshotSignals(navigationByFlyer) {
  const out = {
    pageRefIds: 0,
    hotspotIds: 0,
    ambiguousPageRefIds: 0,
    ambiguousHotspotIds: 0,
  };
  for (const nav of navigationByFlyer.values()) {
    for (const pages of nav.byPageRef.values()) {
      out.pageRefIds += 1;
      if (pages.size !== 1) out.ambiguousPageRefIds += 1;
    }
    for (const pages of nav.byOfferId.values()) {
      out.hotspotIds += 1;
      if (pages.size !== 1) out.ambiguousHotspotIds += 1;
    }
  }
  return out;
}

function candidateShape(row) {
  return {
    id: row.id,
    flyerRef: row.flyerRef ?? row.flyer_ref ?? null,
    pageRef: row.pageRef ?? row.page_ref ?? null,
    offerId: row.offerId ?? row.offer_id ?? null,
  };
}

export function assessNavigation(
  navigationByFlyer,
  candidates,
  configuredPolicy = DEFAULT_NAVIGATION_POLICY,
) {
  const policy = normalizeNavigationPolicy(configuredPolicy);
  const signals = snapshotSignals(navigationByFlyer);
  const counts = Object.fromEntries(Object.values(NAVIGATION_STATUS).map((status) => [status, 0]));
  const resolutions = new Map();

  for (const row of candidates) {
    const candidate = candidateShape(row);
    const nav = candidate.flyerRef != null
      ? navigationByFlyer.get(String(candidate.flyerRef))
      : null;
    const resolution = resolveNavigation(nav, candidate);
    resolutions.set(candidate.id, resolution);
    counts[resolution.status] += 1;
  }

  const ambiguityCount =
    signals.ambiguousPageRefIds + signals.ambiguousHotspotIds;
  const signalCount = signals.pageRefIds + signals.hotspotIds;
  const comparableCount =
    counts[NAVIGATION_STATUS.DUAL] + counts[NAVIGATION_STATUS.DISAGREEMENT];
  const ambiguityRate = rate(ambiguityCount, signalCount);
  const disagreementRate = rate(
    counts[NAVIGATION_STATUS.DISAGREEMENT],
    comparableCount,
  );
  const ambiguityExceeded = ambiguityRate > policy.ambiguityRateThreshold;
  const disagreementExceeded =
    disagreementRate > policy.disagreementRateThreshold;
  const failClosed = ambiguityExceeded || disagreementExceeded;

  const eligibleHotspotUnique = counts[NAVIGATION_STATUS.HOTSPOT_UNIQUE];
  const health = {
    candidates: candidates.length,
    ...signals,
    ambiguityCount,
    signalCount,
    ambiguityRate,
    comparableCount,
    disagreementCount: counts[NAVIGATION_STATUS.DISAGREEMENT],
    disagreementRate,
    thresholds: policy,
    ambiguityExceeded,
    disagreementExceeded,
    failClosed,
    fallbackAllowed: !failClosed,
    dual: counts[NAVIGATION_STATUS.DUAL],
    hotspotUniqueEligible: eligibleHotspotUnique,
    hotspotUniqueAccepted: failClosed ? 0 : eligibleHotspotUnique,
    hotspotUniqueSuppressed: failClosed ? eligibleHotspotUnique : 0,
    pageRefOnly: counts[NAVIGATION_STATUS.PAGE_REF_ONLY],
    unavailable:
      counts[NAVIGATION_STATUS.UNAVAILABLE] +
      counts[NAVIGATION_STATUS.FLYER_UNAVAILABLE],
    pageRefAmbiguous: counts[NAVIGATION_STATUS.PAGE_REF_AMBIGUOUS],
    hotspotAmbiguous: counts[NAVIGATION_STATUS.HOTSPOT_AMBIGUOUS],
  };

  return { health, resolutions };
}

export function acceptedNavigation(resolution, health) {
  if (!resolution) return null;
  if (resolution.status === NAVIGATION_STATUS.DUAL) return resolution;
  if (
    resolution.status === NAVIGATION_STATUS.HOTSPOT_UNIQUE &&
    health?.fallbackAllowed === true
  ) return resolution;
  return null;
}

export function aggregateNavigationHealth(items = []) {
  const reports = items.filter(Boolean);
  if (!reports.length) return null;
  const sum = (key) => reports.reduce((n, item) => n + (Number(item[key]) || 0), 0);
  const thresholds = reports[0].thresholds || DEFAULT_NAVIGATION_POLICY;
  const signalCount = sum('signalCount');
  const ambiguityCount = sum('ambiguityCount');
  const comparableCount = sum('comparableCount');
  const disagreementCount = sum('disagreementCount');
  return {
    candidates: sum('candidates'),
    pageRefIds: sum('pageRefIds'),
    hotspotIds: sum('hotspotIds'),
    ambiguousPageRefIds: sum('ambiguousPageRefIds'),
    ambiguousHotspotIds: sum('ambiguousHotspotIds'),
    ambiguityCount,
    signalCount,
    ambiguityRate: rate(ambiguityCount, signalCount),
    comparableCount,
    disagreementCount,
    disagreementRate: rate(disagreementCount, comparableCount),
    thresholds,
    ambiguityExceeded: reports.some((item) => item.ambiguityExceeded),
    disagreementExceeded: reports.some((item) => item.disagreementExceeded),
    failClosed: reports.some((item) => item.failClosed),
    fallbackAllowed: reports.every((item) => item.fallbackAllowed),
    dual: sum('dual'),
    hotspotUniqueEligible: sum('hotspotUniqueEligible'),
    hotspotUniqueAccepted: sum('hotspotUniqueAccepted'),
    hotspotUniqueSuppressed: sum('hotspotUniqueSuppressed'),
    pageRefOnly: sum('pageRefOnly'),
    unavailable: sum('unavailable'),
    pageRefAmbiguous: sum('pageRefAmbiguous'),
    hotspotAmbiguous: sum('hotspotAmbiguous'),
  };
}
