// registry/lifecycle.js — the registry's LIFECYCLE jobs (REGISTRY-DESIGN.md
// §5.1 dormancy, §5.4 consolidation/merge, and the apply.js crash-containment
// sweep). D1-only work, zero external fetches: it runs inside the existing
// daily cron (weekly cadence, index.js) and behind the guarded
// POST /registry/maintain — no new scheduling machinery (§2 discipline).
//
// The §5.4 asymmetry is the whole design: MERGE (false-split healing) is
// automated but conservative — a threshold strictly above tAttach plus
// requirements a live match never has — while SPLIT is human-gated (flags +
// the review surfaces; automation deliberately unbuilt until §8 metrics show
// splits are common). Every merge is LOGGED (ops audit) and reversible in
// principle: sightings keep their original product_id and their own reads;
// the loser row remains as a tombstone.

import { scoreCandidate, brandRelation, TUNING } from './resolver.js';
import { capProfile, LEARN_TUNING } from './learn.js';
import { decodeProfile, encodeProfile, DORMANT_AFTER_WEEKS, REGISTRY_ALGO_VERSION } from './model.js';

// Calibration priors, same discipline as TUNING/LEARN_TUNING (grounded
// defaults, overridable, never asserted final):
//   tMerge — strictly above tAttach (0.7): a merge must clear a bar no live
//     attach clears, because a wrong merge is the P1 top-risk failure.
//   minShared — pair retrieval floor (2 shared distinctive tokens; 1 retrieves
//     half the catalog through brand tokens alone).
//   maxPairs/maxMerges — per-run caps: a weekly job that merges conservatively
//     forever beats one big pass that could compound one systematic mistake.
export const LIFECYCLE_TUNING = Object.freeze({
  tMerge: 0.85,
  minShared: 2,
  maxPairs: 200,
  maxMerges: 25,
  dormantAfterDays: DORMANT_AFTER_WEEKS * 7,
});

const isoDaysAgo = (today, days) => {
  const t = new Date(`${today}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - days);
  return t.toISOString().slice(0, 10);
};

// --- §5.4 merge decision (pure) ----------------------------------------------
// Decide whether two products are the same product split in two. The smaller
// profile plays the resolver's "read" against the bigger one's profile — the
// exact §4 scoring path (size veto, kind gate, containment workhorse), so the
// merge bar is provably at least as strict as a live attach — PLUS the §5.4
// extra requirements a live match never has:
//   • brand conflict VETOES (live matching only penalizes, P2 — but a merge
//     is forever-ish, so undeterminable-or-compatible brands are required),
//   • corroborating overlap: overlapping stores_seen OR the same size read on
//     both rows (two stores calling it the same thing, or the strongest
//     physical evidence agreeing).
// Returns { merge: false } or { merge: true, survivor, loser, score }.
export function decideMerge(a, b, tuning = LIFECYCLE_TUNING) {
  if (!a || !b || a.id === b.id) return { merge: false };
  if (a.status === 'merged' || b.status === 'merged') return { merge: false };
  if ((a.kind || 'product') !== (b.kind || 'product')) return { merge: false };

  // Brand conflict veto (stricter than live matching, by design).
  if (brandRelation(a.brand_text || null, b.brand_text || null) === -1) return { merge: false };
  if (a.brand_slug && b.brand_slug && a.brand_slug !== b.brand_slug) return { merge: false };

  // The §5.4 corroborating-overlap requirement.
  const storesA = new Set(JSON.parse(a.stores_seen || '[]'));
  const storesOverlap = JSON.parse(b.stores_seen || '[]').some((s) => storesA.has(s));
  const bothSized = a.size_unit != null && a.size_total != null && b.size_unit != null && b.size_total != null;
  if (!storesOverlap && !bothSized) return { merge: false };

  // Survivor = the better-evidenced row (more sightings, then older, then id —
  // fully deterministic).
  let cmp = (b.sightings || 0) - (a.sightings || 0);
  if (!cmp) cmp = String(a.first_seen).localeCompare(String(b.first_seen));
  if (!cmp) cmp = String(a.id).localeCompare(String(b.id));
  const [survivor, loser] = cmp <= 0 ? [a, b] : [b, a];

  // The loser's profile as a read into the survivor (§4 scoring, size veto and
  // kind gate included). corroboration 1: profiles are accumulated evidence,
  // not single reads.
  const read = {
    tokens: Object.keys(decodeProfile(loser.token_profile)),
    size:
      loser.size_unit != null && loser.size_total != null
        ? { unit: loser.size_unit, each: loser.size_total, pack: loser.size_pack || 1 }
        : null,
    brandText: loser.brand_text || null,
    family: loser.family || null,
    category: loser.category || null,
    kind: loser.kind || 'product',
    corroboration: 1,
  };
  if (read.tokens.length < 2) return { merge: false };
  const { score, vetoed } = scoreCandidate(read, survivor, { tuning: TUNING });
  if (vetoed || score < tuning.tMerge) return { merge: false };
  return { merge: true, survivor, loser, score };
}

// What the survivor learns from absorbing the loser (§5.4): the profile UNION
// (counts summed, freshest week kept, §5.2 cap in the shared deterministic
// drop order), summed evidence counters, and fills — never overwrites — for
// presentation/metadata. Returns { fields, tokens } for updateProduct.
export function mergedFields(survivor, loser, tuning = LEARN_TUNING) {
  const profile = decodeProfile(survivor.token_profile);
  for (const [t, v] of Object.entries(decodeProfile(loser.token_profile))) {
    const cur = profile[t];
    profile[t] = cur
      ? {
          count: cur.count + v.count,
          week: String(v.week || '') > String(cur.week || '') ? v.week : cur.week,
        }
      : { ...v };
  }
  const capped = capProfile(profile, tuning.profileCap);

  const stores = new Set([
    ...JSON.parse(survivor.stores_seen || '[]'),
    ...JSON.parse(loser.stores_seen || '[]'),
  ]);
  const fields = {
    token_profile: encodeProfile(capped),
    sightings: (survivor.sightings || 0) + (loser.sightings || 0),
    stores_seen: JSON.stringify([...stores].sort()),
    first_seen:
      String(loser.first_seen) < String(survivor.first_seen) ? loser.first_seen : survivor.first_seen,
    last_seen:
      String(loser.last_seen) > String(survivor.last_seen) ? loser.last_seen : survivor.last_seen,
    algo_version: REGISTRY_ALGO_VERSION,
  };
  if (survivor.display_name == null && survivor.display_name_ar == null && (loser.display_name != null || loser.display_name_ar != null)) {
    fields.display_name = loser.display_name;
    fields.display_name_ar = loser.display_name_ar;
    fields.display_corroboration = loser.display_corroboration;
    fields.display_week = loser.display_week;
  }
  if (survivor.size_unit == null && loser.size_unit != null) {
    fields.size_unit = loser.size_unit;
    fields.size_total = loser.size_total;
    fields.size_pack = loser.size_pack;
  }
  if (survivor.brand_text == null && loser.brand_text != null) fields.brand_text = loser.brand_text;
  if (survivor.brand_slug == null && loser.brand_slug != null) fields.brand_slug = loser.brand_slug;
  if (survivor.family == null && loser.family != null) fields.family = loser.family;
  if (survivor.category == null && loser.category != null) fields.category = loser.category;
  if (survivor.review_flag == null && loser.review_flag != null) fields.review_flag = loser.review_flag;
  return { fields, tokens: Object.keys(capped) };
}

// --- the weekly consolidation pass (§5.4) -------------------------------------
export async function consolidate(registryStore, { tuning = LIFECYCLE_TUNING } = {}) {
  const report = { pairs: 0, merges: 0, log: [] };
  const productCount = await registryStore.productCount();
  // Same distinctiveness ceiling as §4.1 blocking: common tokens pair nothing.
  const commonCeiling = Math.max(
    TUNING.commonTokenFloor,
    Math.ceil(productCount * TUNING.commonTokenShare),
  );
  const pairs = await registryStore.consolidationPairs({
    commonCeiling,
    minShared: tuning.minShared,
    limit: tuning.maxPairs,
  });
  report.pairs = pairs.length;
  if (!pairs.length) return report;

  const ids = [...new Set(pairs.flatMap((p) => [p.aId, p.bId]))];
  const byId = new Map((await registryStore.getProducts(ids)).map((p) => [p.id, p]));
  const touched = new Set(); // a product merges at most once per run

  for (const pair of pairs) {
    if (report.merges >= tuning.maxMerges) break;
    if (touched.has(pair.aId) || touched.has(pair.bId)) continue;
    const decision = decideMerge(byId.get(pair.aId), byId.get(pair.bId), tuning);
    if (!decision.merge) continue;
    const { survivor, loser, score } = decision;
    // Tombstone first, then teach the survivor: a crash in between leaves a
    // merged loser whose evidence hasn't reached the survivor — future reads
    // still redirect single-hop; nothing double-counts (same containment
    // shape as apply.js).
    await registryStore.tombstoneProduct(loser.id, survivor.id);
    const { fields, tokens } = mergedFields(survivor, loser);
    await registryStore.updateProduct(survivor.id, fields, tokens);
    touched.add(survivor.id).add(loser.id);
    report.merges += 1;
    report.log.push({
      survivor: survivor.id,
      loser: loser.id,
      score: Math.round(score * 1000) / 1000,
      shared: pair.shared,
    });
  }
  return report;
}

// --- crash containment (§1.3/§6, apply.js contract) ----------------------------
// A death between "sighting inserted" and "product created" leaves a sighting
// whose product row is missing. Healing = delete the sighting and un-stamp its
// enrichment verdict, so the very next drain re-resolves the offer cleanly
// (the §3.1 feed reads mint_verdict IS NULL).
export async function healDanglingSightings(
  { registryStore, enrichStore },
  { limit = 200 } = {},
) {
  const offerIds = await registryStore.listDanglingSightings(limit);
  if (!offerIds.length) return { healed: 0 };
  await registryStore.deleteSightings(offerIds);
  if (enrichStore?.resetVerdicts) await enrichStore.resetVerdicts(offerIds);
  return { healed: offerIds.length };
}

// --- the maintenance entry point ----------------------------------------------
// One call = the registry's full §5 upkeep: dormancy sweep (§5.1), duplicate
// consolidation (§5.4), dangling-sighting healing. Weekly from the daily cron
// (index.js gates on the day), manual via POST /registry/maintain.
export const REGISTRY_MERGE_KEY = 'ops/settings/registry-merge.json';

// Read the merge kill switch. Same shape and same store as the other operator
// settings (offers/visionModel.js, recovery/policy.js): a JSON object under
// ops/settings/. Absent or unreadable = ENABLED, i.e. today's behaviour — a
// storage blip must never silently stop maintenance, only an operator may.
export async function readMergeSetting(objectStore) {
  if (!objectStore || typeof objectStore.get !== 'function') return { enabled: true, source: 'default' };
  const rec = await objectStore.get(REGISTRY_MERGE_KEY).catch(() => null);
  if (!rec) return { enabled: true, source: 'default' };
  try {
    const text = typeof rec === 'string' ? rec : new TextDecoder().decode(await rec.arrayBuffer());
    const raw = JSON.parse(text);
    return {
      enabled: raw?.enabled !== false,
      reason: typeof raw?.reason === 'string' ? raw.reason : null,
      source: 'stored',
    };
  } catch {
    return { enabled: true, source: 'unreadable' };
  }
}

// Move the switch. The ONLY writer — merges are never disabled automatically,
// by policy, for the same reason they are never enabled automatically: an
// operator decides when the corpus is stable enough to consolidate.
export async function writeMergeSetting(objectStore, enabled, { reason = null, by = 'ops' } = {}) {
  if (!objectStore || typeof objectStore.put !== 'function') {
    throw new Error('no object store bound');
  }
  const record = {
    enabled: enabled !== false,
    reason: reason ? String(reason).slice(0, 200) : null,
    by,
    at: new Date().toISOString(),
  };
  await objectStore.put(
    REGISTRY_MERGE_KEY,
    new TextEncoder().encode(JSON.stringify(record)),
    { httpMetadata: { contentType: 'application/json' } },
  );
  return record;
}

export async function runMaintenance(
  { registryStore, enrichStore, opsStore, objectStore },
  { today = new Date().toISOString().slice(0, 10), tuning = LIFECYCLE_TUNING } = {},
) {
  const report = { startedAt: new Date().toISOString(), today };
  report.dormant = await registryStore.sweepDormancy(isoDaysAgo(today, tuning.dormantAfterDays));

  // MERGE KILL SWITCH (`ops/settings/registry-merge.json`, `{"enabled":false}`).
  // Merge is the one registry operation that is irreversible in practice: undoing
  // one is N per-sighting splits, and a split needs the sighting's Identity
  // Candidate to still exist. It is also AUTOMATED and unattended. That is an
  // acceptable trade against a stable corpus and a bad one while the input
  // distribution is changing — which is exactly what a migration does. The
  // switch lets an operator freeze merges for the duration and re-arm after,
  // without a deploy. Absent setting = enabled (today's behaviour, unchanged).
  const mergeSetting = await readMergeSetting(objectStore);
  if (!mergeSetting.enabled) {
    report.consolidation = {
      pairs: 0, merges: 0, log: [], skipped: true,
      reason: mergeSetting.reason || 'Automated merge is disabled by an operator setting.',
    };
    Object.assign(report, await healDanglingSightings({ registryStore, enrichStore }));
    report.finishedAt = new Date().toISOString();
    return report;
  }
  report.consolidation = await consolidate(registryStore, { tuning });
  Object.assign(report, await healDanglingSightings({ registryStore, enrichStore }));
  report.finishedAt = new Date().toISOString();
  if (opsStore) {
    // The §5.4 merge log: one audit row per run carries every merge — the
    // reversibility trail (sightings retain their reads; tombstones point).
    await opsStore
      .record({
        ts: report.startedAt,
        action: 'registry:maintain',
        origin: 'cron',
        ok: true,
        detail: {
          dormant: report.dormant,
          pairs: report.consolidation.pairs,
          merges: report.consolidation.merges,
          log: report.consolidation.log,
          healed: report.healed,
        },
      })
      .catch(() => {});
  }
  return report;
}
