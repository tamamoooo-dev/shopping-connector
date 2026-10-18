// Vision policy: Ministral 14B only (2026-10-18). Legacy storage keys remain readable.
const enc = new TextEncoder();

// The selected-tier record. One key, one small JSON document.
export const VISION_MODEL_KEY = 'ops/settings/vision-model.json';

// Keep the existing stored tier key for compatibility; it now selects the sole
// approved model. Old Medium selections and invalid records resolve to 14B.
export const DEFAULT_VISION_TIER = 'small';

// The sole supported model. The tier key remains compatible with stored selections.
export const VISION_MODEL_TIERS = {
  small: {
    tier: 'small',
    label: 'Ministral 14B',
    note: 'Production',
    // PINNED, unlike medium: model comparisons must measure an immutable build,
    // and the operator explicitly selected Ministral 3 14B as the immediate
    // replacement while its 3B/8B/14B comparison is completed.
    model: 'ministral-14b-2512',
    version: 'ministral-14b-2512',
    alias: 'ministral-14b-latest',
    budget: false,
    warning: null,
    description: 'Production extraction with the approved Ministral 14B model.',
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
// `tier`/`model` still describe the tier that WOULD be selected (Ministral 14B, by the
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
// Ministral 14B, because the failure mode of guessing wrong must be "too good", never
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
