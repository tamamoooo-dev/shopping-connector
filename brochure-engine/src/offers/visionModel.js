// offers/visionModel.js — the Vision Model Selection Policy (2026-07-25).
//
// ⚠️ POLICY (permanent user directive). Read this before changing anything here:
//
//   • MEDIUM IS THE PRODUCTION BASELINE for all Vision extraction. It is the
//     quality model and the one the FROZEN extraction baseline was validated
//     under (benchmarks/mistral-medium-production-validation-50-2026-07-25).
//     Canonical product data is built from Medium reads.
//
//   • SMALL IS A MANUAL OPERATIONAL FALLBACK, offered for when API limits or
//     budget become a concern. It is a supported mode, not a default.
//
//   • NEVER SWITCH MODELS AUTOMATICALLY. No size gate, no cost router, no
//     small-first-then-escalate. That design was measured on 2026-07-25 over 30
//     crops and REJECTED: escalation fired 0% of the time because no validator
//     has coverage, and the 91% cost saving bought a 16.7% defect rate. The
//     only thing that moves this setting is an operator in the Operations
//     Center's Developer Tool.
//
//   • FUTURE MODEL COMPARISONS must use identical prompts, identical samples,
//     identical scoring and identical methodology — see the two benchmark
//     folders above for the shape of a comparison that counts.
//
// Where the selection lives: the object store (KV in production, R2 where
// bound) behind storage/objectStore.js — the same place the console keeps its
// own small ops/ records. Deliberately NOT D1: the toggle then needs no
// migration and no redeploy, and a read failure can fall back to Medium
// without touching the database.

const enc = new TextEncoder();

// The selected-tier record. One key, one small JSON document.
export const VISION_MODEL_KEY = 'ops/settings/vision-model.json';

export const DEFAULT_VISION_TIER = 'medium';

// The two supported tiers. `model` is the literal string put on the wire.
export const VISION_MODEL_TIERS = {
  medium: {
    tier: 'medium',
    label: 'Medium 3.5',
    note: 'Recommended',
    // The ALIAS, not the pinned id: `mistral-medium-latest` is the exact string
    // the frozen 50-crop production validation sent, and enrich.test.mjs
    // asserts production still sends it byte for byte. `mistral-medium-3.5` is
    // what that alias resolves to — recorded here, never sent.
    model: 'mistral-medium-latest',
    version: 'mistral-medium-3.5',
    budget: false,
    warning: null,
    description: 'Production baseline. Highest extraction quality.',
  },
  small: {
    tier: 'small',
    label: 'Ministral 14B',
    note: 'Budget',
    // PINNED, unlike medium: the budget measurement was run against 2603
    // specifically (benchmarks/small-first-routing-30-2026-07-25), so budget
    // mode sends the version whose defect rate we actually know rather than
    // letting `-latest` drift to an unmeasured build.
    model: 'ministral-14b-2512',
    version: 'ministral-14b-2512',
    alias: 'ministral-14b-2512',
    budget: true,
    warning:
      'Budget Mode enabled. Extraction quality may decrease, especially for package size and brand recognition.',
    description: 'Manual fallback for API-limit or budget pressure. Not a production default.',
  },
};

export const VISION_MODEL_OPTIONS = Object.values(VISION_MODEL_TIERS).map((t) => ({
  tier: t.tier,
  label: t.label,
  note: t.note,
  model: t.model,
  version: t.version,
  budget: t.budget,
  description: t.description,
}));

// Anything unrecognized resolves to the production baseline. A typo, a stale
// record or a half-written value must never silently downgrade extraction.
export function normalizeVisionTier(tier) {
  const key = String(tier == null ? '' : tier).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(VISION_MODEL_TIERS, key) ? key : DEFAULT_VISION_TIER;
}

export function visionModelFor(tier) {
  return VISION_MODEL_TIERS[normalizeVisionTier(tier)];
}

// ARMED vs INERT — the safety property this whole module is built around.
//
// `armed` is true only when an operator actually stored a selection. Until then
// the feature is INERT: engine.js passes NO model to drainEnrichment, extraction
// keeps running on enrich.js's own DEFAULT_MODEL, and production behaves exactly
// as it did before this feature existed. That is what lets the selector ship
// ahead of the frozen extraction baseline instead of riding with it.
//
// `tier`/`model` still describe the tier that WOULD be selected (Medium, by the
// fail-safe rule below) so the console has something coherent to render — they
// are a proposal while inert, not a description of what is running. Callers must
// branch on `armed`, never on `model` alone.
function settingFrom(tier, extra = {}) {
  const t = visionModelFor(tier);
  const source = extra.source || 'default';
  return {
    tier: t.tier,
    model: t.model,
    version: t.version,
    label: t.label,
    budget: t.budget,
    warning: t.warning,
    selectedAt: null,
    selectedBy: null,
    ...extra,
    source,
    armed: source === 'stored',
  };
}

// Read the active selection. FAIL-SAFE BY CONSTRUCTION: no store bound, key
// absent, unreadable bytes, corrupt JSON or an unknown tier all resolve to
// Medium, because the failure mode of guessing wrong must be "too good", never
// "silently degraded". `source` says which happened so the console can show it.
export async function readVisionModelSetting(objectStore) {
  if (!objectStore || typeof objectStore.get !== 'function') {
    return settingFrom(DEFAULT_VISION_TIER, { source: 'default' });
  }
  const rec = await objectStore.get(VISION_MODEL_KEY).catch(() => null);
  if (!rec) return settingFrom(DEFAULT_VISION_TIER, { source: 'default' });
  try {
    const parsed = JSON.parse(new TextDecoder().decode(rec.bytes));
    const raw = String(parsed?.tier == null ? '' : parsed.tier).trim().toLowerCase();
    // A stored tier we no longer recognize was NOT honored — report the record
    // as absent rather than attributing the baseline to an operator choice.
    const known = Object.prototype.hasOwnProperty.call(VISION_MODEL_TIERS, raw);
    return settingFrom(known ? raw : DEFAULT_VISION_TIER, {
      selectedAt: known ? parsed.selectedAt || null : null,
      selectedBy: known ? parsed.selectedBy || null : null,
      source: known ? 'stored' : 'default',
    });
  } catch {
    return settingFrom(DEFAULT_VISION_TIER, { source: 'default' });
  }
}

// Persist a selection. Writes are rare by design (an operator toggling a
// switch), so the object store's write budget is never a concern here.
export async function writeVisionModelSetting(objectStore, tier, { by = 'ops', now = new Date() } = {}) {
  const resolved = visionModelFor(tier);
  const record = {
    tier: resolved.tier,
    model: resolved.model,
    selectedAt: now.toISOString(),
    selectedBy: by,
  };
  if (!objectStore || typeof objectStore.put !== 'function') {
    throw new Error('Vision model setting is unavailable (no object store bound).');
  }
  await objectStore.put(VISION_MODEL_KEY, enc.encode(JSON.stringify(record)), {
    contentType: 'application/json',
  });
  return settingFrom(resolved.tier, {
    selectedAt: record.selectedAt,
    selectedBy: record.selectedBy,
    source: 'stored',
  });
}
