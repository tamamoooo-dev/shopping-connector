// registry/calibrate.js — the §8 CALIBRATION / REPLAY harness core
// (REGISTRY-DESIGN.md §8): pure, offline logic behind calibrate-registry.mjs.
// The human-labeled pair set is the calibration input AND the permanent
// regression corpus: every resolver or model change must replay it and clear
// the ship gate before its sightings attach (§6 "model swap" containment).
//
// Three pieces:
//   samplePairs — turn a corpus of resolver-feed rows into candidate pairs
//     stratified around the decision boundary (that is where labels teach the
//     most; a random sample would be almost all easy negatives).
//   replay     — run the REAL production path (drainResolution -> resolver ->
//     apply, zero forks) over the corpus in ingest order against the
//     in-memory twin, then score the labeled pairs:
//       same-labeled pair resolved to ONE product   -> attach hit
//       different-labeled pair resolved to one      -> FALSE ATTACH (the P1
//                                                      top-risk failure)
//   sweep      — replay across a tuning grid; report every configuration
//     against the ship gate (attach >= 95%, false-attach <= 0.5%).
//
// Rows are the resolver-feed shape (enrichStore.listUnresolved: offer fields
// + e_* enrichment fields) — the harness consumes exactly what production
// resolution consumes.

import { readFromOffer } from './read.js';
import { scoreCandidate, TUNING } from './resolver.js';
import { drainResolution } from './drain.js';
import { createMemRegistryStore } from './memstore.js';
import { encodeProfile, profileFromRead } from './model.js';

// The §8 ship gate. Not tunable from the CLI on purpose: the gate is the
// design's promise, not a knob.
export const GATE = Object.freeze({ attach: 0.95, falseAttach: 0.005 });

// Deterministic PRNG (LCG) — sampling must reproduce exactly across runs, or
// the labeled corpus and its pairs file drift apart.
export function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const feedOffer = (r) => ({
  id: r.id, store: r.store, region: r.region, source: r.source,
  category: r.category, search_text: r.search_text,
  price: r.price, old_price: r.old_price,
  valid_from: r.valid_from, detected_at: r.detected_at,
});
const feedEnrichment = (r) => ({
  name: r.e_name, name_ar: r.e_name_ar, brand: r.e_brand,
  size: r.e_size, corroboration: r.e_corroboration,
});

// A read posing as a one-sighting product row, so read-vs-read pair scoring
// goes through the REAL scoreCandidate — no second scoring path to drift.
export function readAsProductRow(read, week = null) {
  return {
    id: 'pair', status: 'active', merged_into: null, kind: read.kind,
    brand_slug: null, brand_text: read.brandText,
    size_unit: read.size?.unit ?? null,
    size_total: read.size?.each ?? null,
    size_pack: read.size?.pack ?? null,
    family: read.family, category: read.category,
    token_profile: encodeProfile(profileFromRead(read.tokens, week)),
  };
}

// Score two reads against each other (max of both directions — containment is
// asymmetric and a labeling pair should surface when EITHER direction is
// boundary-interesting).
export function pairScore(readA, readB, tuning = TUNING) {
  const ab = scoreCandidate(readA, readAsProductRow(readB), { tuning });
  const ba = scoreCandidate(readB, readAsProductRow(readA), { tuning });
  if (ab.vetoed && ba.vetoed) return { score: 0, vetoed: true };
  return { score: Math.max(ab.vetoed ? 0 : ab.score, ba.vetoed ? 0 : ba.score), vetoed: false };
}

// Which stratum a score belongs to. Boundary strata get the label budget.
export function stratumOf(score, tuning = TUNING) {
  if (score >= tuning.tAttach + 0.15) return 'high';
  if (score >= tuning.tAttach) return 'attach-edge';
  if (score >= tuning.tReview) return 'review-band';
  if (score >= tuning.tReview - 0.15) return 'create-edge';
  return 'low';
}

// Candidate pairs from a corpus: block on shared rare tokens (a full n² is
// pointless and unaffordable), score with the production scorer, and sample
// per stratum. Returns [{ aId, bId, score, stratum }] plus per-stratum counts.
export function samplePairs(rows, { perStratum = 60, seed = 42, tuning = TUNING } = {}) {
  const rng = makeRng(seed);
  const reads = new Map();
  for (const r of rows) {
    const res = readFromOffer(feedOffer(r), feedEnrichment(r));
    if (res.ok) reads.set(r.id, res.read);
  }
  // Rare-token blocking over the corpus itself (same §4.1 idea, corpus scale).
  const byToken = new Map();
  for (const [id, read] of reads) {
    for (const t of read.tokens) {
      if (!byToken.has(t)) byToken.set(t, []);
      byToken.get(t).push(id);
    }
  }
  const ceiling = Math.max(10, Math.ceil(reads.size * 0.02));
  const buckets = new Map(); // stratum -> [{aId,bId,score}]
  const seen = new Set();
  for (const ids of byToken.values()) {
    if (ids.length > ceiling) continue;
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = ids[i] < ids[j] ? `${ids[i]}|${ids[j]}` : `${ids[j]}|${ids[i]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { score, vetoed } = pairScore(reads.get(ids[i]), reads.get(ids[j]), tuning);
        if (vetoed || score <= 0) continue;
        const stratum = stratumOf(score, tuning);
        if (!buckets.has(stratum)) buckets.set(stratum, []);
        buckets.get(stratum).push({ aId: ids[i], bId: ids[j], score });
      }
    }
  }
  // Reservoir-less deterministic sample: shuffle (seeded) then cut.
  const out = [];
  const counts = {};
  for (const [stratum, list] of buckets) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const k = Math.floor(rng() * (i + 1));
      [list[i], list[k]] = [list[k], list[i]];
    }
    counts[stratum] = { candidates: list.length, sampled: Math.min(perStratum, list.length) };
    for (const p of list.slice(0, perStratum)) {
      out.push({ ...p, score: Math.round(p.score * 1000) / 1000, stratum });
    }
  }
  return { pairs: out, counts, reads: reads.size };
}

// Replay the production resolution path over the corpus (ingest order) and
// score the labeled pairs. `labels` = [{ aId, bId, label: 'same'|'different' }].
export async function replay(rows, labels, { tuning = TUNING } = {}) {
  const ordered = rows
    .slice()
    .sort((a, z) => String(a.detected_at).localeCompare(String(z.detected_at)) || String(a.id).localeCompare(String(z.id)));
  const registry = createMemRegistryStore({ offers: ordered.map(feedOffer) });
  const verdicts = new Map();
  const feed = {
    async reindexMatchText() { return 0; },
    async listUnresolved({ limit = 500 } = {}) {
      return ordered.filter((r) => !verdicts.has(r.id)).slice(0, limit);
    },
    async setVerdicts(pairs) {
      for (const { id, verdict } of pairs) verdicts.set(id, verdict);
    },
  };
  // Drain to exhaustion — the exact production path, tuning threaded through.
  for (;;) {
    const rep = await drainResolution(
      { enrichStore: feed, registryStore: registry },
      { limit: 500, currentOn: '0000-01-01', tuning },
    );
    if (rep.scanned === 0) break;
    if (rep.errors.length) throw new Error(`replay drain error: ${rep.errors[0]}`);
  }

  const metrics = {
    tuning: { tAttach: tuning.tAttach, tReview: tuning.tReview },
    products: await registry.productCount(),
    labeled: { same: 0, different: 0 },
    attachHits: 0,
    falseAttaches: 0,
    unresolvable: 0,
    misses: [], // same-labeled pairs that split (for inspection)
    falses: [], // different-labeled pairs that merged (the P1 list)
  };
  const productOf = async (offerId) => {
    const s = await registry.getSighting(offerId);
    if (!s) return null;
    // Follow a merge tombstone so consolidation can't fail the gate unfairly.
    const [p] = await registry.getProducts([s.product_id]);
    return p?.status === 'merged' ? p.merged_into : s.product_id;
  };
  for (const { aId, bId, label } of labels) {
    if (label !== 'same' && label !== 'different') continue;
    const [pa, pb] = [await productOf(aId), await productOf(bId)];
    if (!pa || !pb) {
      metrics.unresolvable += 1;
      continue;
    }
    metrics.labeled[label] += 1;
    if (label === 'same') {
      if (pa === pb) metrics.attachHits += 1;
      else metrics.misses.push({ aId, bId });
    } else if (pa === pb) {
      metrics.falseAttaches += 1;
      metrics.falses.push({ aId, bId });
    }
  }
  metrics.attachRate = metrics.labeled.same ? metrics.attachHits / metrics.labeled.same : null;
  metrics.falseAttachRate = metrics.labeled.different
    ? metrics.falseAttaches / metrics.labeled.different
    : null;
  metrics.gate = {
    attach: metrics.attachRate == null ? null : metrics.attachRate >= GATE.attach,
    falseAttach: metrics.falseAttachRate == null ? null : metrics.falseAttachRate <= GATE.falseAttach,
  };
  metrics.pass = metrics.gate.attach === true && metrics.gate.falseAttach !== false;
  return metrics;
}

// Threshold sweep: replay per grid point. The grid defaults to a fan around
// the priors; anything failing the gate is reported but ranked last.
export async function sweep(rows, labels, {
  tAttachGrid = [0.6, 0.65, 0.7, 0.75, 0.8],
  tReviewGrid = [0.35, 0.4, 0.45, 0.5, 0.55],
} = {}) {
  const results = [];
  for (const tAttach of tAttachGrid) {
    for (const tReview of tReviewGrid) {
      if (tReview >= tAttach) continue;
      const tuning = { ...TUNING, tAttach, tReview };
      results.push(await replay(rows, labels, { tuning }));
    }
  }
  results.sort((a, z) =>
    (z.pass ? 1 : 0) - (a.pass ? 1 : 0) ||
    (z.attachRate ?? 0) - (a.attachRate ?? 0) ||
    (a.falseAttachRate ?? 1) - (z.falseAttachRate ?? 1));
  return results;
}

// The OR-deal fire-rate measurement (IDENTITY-V2 §3 gate 2b "re-measured
// before lock"): how the corpus' reads fare at the gates, verdict by verdict.
export function measureVerdicts(rows) {
  const counts = {};
  for (const r of rows) {
    const res = readFromOffer(feedOffer(r), feedEnrichment(r));
    const v = res.ok ? 'minted' : res.verdict;
    counts[v] = (counts[v] || 0) + 1;
  }
  const total = rows.length || 1;
  return {
    total: rows.length,
    counts,
    rates: Object.fromEntries(
      Object.entries(counts).map(([v, n]) => [v, Math.round((n / total) * 10000) / 100]),
    ),
  };
}
