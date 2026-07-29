// recovery/policy.js — the execution policy (VISION-PIPELINE.md C-8, C-9).
//
// The THIRD independent axis. The queue says what needs recovery; a processor
// says how to attempt it; this says whether anything runs at all, and it is the
// operator's decision, never the pipeline's.
//
//   MANUAL (default) — items wait until the operator dispatches them explicitly.
//   AUTO             — the queue self-drains with the configured processors,
//                      armed when the operator judges quota and budget allow.
//
// Both are the SAME runner. They differ only in who supplies the item list, so
// switching between them is an operational act and not an architectural one —
// which is exactly what C-8 requires of a spend decision.
//
// WHERE IT LIVES, and why not D1: the object store, beside the Vision model
// selection (offers/visionModel.js). No migration, no redeploy to flip, and a
// read failure cannot take the database with it.
//
// ⚠️ THE FAIL-SAFE INVERTS visionModel.js, DELIBERATELY. There, an unreadable
// setting resolves to the BEST model, because the failure mode of guessing wrong
// must be "too good" rather than "silently degraded". Here the same reasoning
// points the other way: recovery costs materially more per offer than the
// primary read, so an unreadable setting must resolve to spending NOTHING.
// No store bound, key absent, corrupt JSON, unknown mode, empty or unresolvable
// processor list — every one of them yields Manual and disarmed. Getting this
// backwards would let a storage blip start billing.

const enc = new TextEncoder();

export const RECOVERY_POLICY_KEY = 'ops/settings/recovery-policy.json';

export const RECOVERY_MODES = Object.freeze({ MANUAL: 'manual', AUTO: 'auto' });

// Caps, applied even when armed. A runaway Auto drain is the failure this
// feature is most likely to produce, so the bound is always present rather than
// being something the operator has to remember to set.
export const DEFAULT_MAX_ITEMS_PER_RUN = 25;
export const DEFAULT_MAX_ATTEMPTS_PER_ITEM = 2;
const MAX_ITEMS_CEILING = 100;

function clamp(value, fallback, ceiling) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), ceiling);
}

/**
 * `armed` is the ONLY flag a caller may branch on, and it is deliberately
 * conjunctive: stored by an operator AND mode is auto AND at least one named
 * processor actually resolves in the registry. `mode`/`processors` still
 * describe what WOULD run so a console has something coherent to render, but
 * they are a proposal while disarmed, not a description of what is running —
 * the same discipline as visionModel.js's `armed`.
 */
function policyFrom(raw, { source, registry, unknownProcessors = [] }) {
  const mode = raw?.mode === RECOVERY_MODES.AUTO ? RECOVERY_MODES.AUTO : RECOVERY_MODES.MANUAL;
  const processors = Array.isArray(raw?.processors) ? raw.processors.filter(Boolean) : [];
  const resolvable = registry ? processors.filter((id) => registry.has(id)) : processors;
  const expired = raw?.until ? Date.parse(raw.until) <= Date.now() : false;
  return Object.freeze({
    mode,
    processors: Object.freeze(resolvable),
    unknownProcessors: Object.freeze(unknownProcessors),
    maxItemsPerRun: clamp(raw?.maxItemsPerRun, DEFAULT_MAX_ITEMS_PER_RUN, MAX_ITEMS_CEILING),
    maxAttemptsPerItem: clamp(raw?.maxAttemptsPerItem, DEFAULT_MAX_ATTEMPTS_PER_ITEM, 10),
    until: raw?.until || null,
    expired,
    selectedAt: raw?.selectedAt || null,
    selectedBy: raw?.selectedBy || null,
    source,
    armed: source === 'stored'
      && mode === RECOVERY_MODES.AUTO
      && resolvable.length > 0
      && !expired,
  });
}

const MANUAL_DEFAULT = (registry) => policyFrom(
  { mode: RECOVERY_MODES.MANUAL, processors: [] },
  { source: 'default', registry },
);

/**
 * Read the active policy. TOTAL — never throws, and every failure path lands on
 * Manual/disarmed. `source` says which path was taken so an operator can tell
 * "nobody has configured this" from "the stored record could not be read".
 */
export async function readRecoveryPolicy(objectStore, { registry = null } = {}) {
  if (!objectStore || typeof objectStore.get !== 'function') return MANUAL_DEFAULT(registry);
  const rec = await objectStore.get(RECOVERY_POLICY_KEY).catch(() => null);
  if (!rec) return MANUAL_DEFAULT(registry);
  try {
    const parsed = JSON.parse(new TextDecoder().decode(rec.bytes));
    // A stored processor id the registry no longer knows is REPORTED, not
    // silently dropped: it usually means a processor was renamed or removed
    // under a policy still naming it, and an operator who armed Auto deserves
    // to see that the thing they armed is gone rather than watch a drain do
    // nothing. If it empties the list, `armed` goes false — spend nothing.
    const named = Array.isArray(parsed?.processors) ? parsed.processors.filter(Boolean) : [];
    const unknown = registry ? named.filter((id) => !registry.has(id)) : [];
    return policyFrom(parsed, { source: 'stored', registry, unknownProcessors: unknown });
  } catch {
    return MANUAL_DEFAULT(registry);
  }
}

/**
 * Persist a policy. Writes are rare by design — an operator flipping a switch —
 * so the object store's write budget is never a concern.
 *
 * Unknown processor ids are REJECTED on write, unlike on read. Arming Auto
 * against a processor that does not exist is a mistake worth failing loudly at
 * the moment it is made; tolerating it on read is only about surviving a
 * later rename.
 */
export async function writeRecoveryPolicy(objectStore, patch = {}, { by = 'ops', now = new Date(), registry = null } = {}) {
  if (!objectStore || typeof objectStore.put !== 'function') {
    throw new Error('Recovery policy is unavailable (no object store bound).');
  }
  const mode = patch.mode === RECOVERY_MODES.AUTO ? RECOVERY_MODES.AUTO : RECOVERY_MODES.MANUAL;
  const processors = Array.isArray(patch.processors) ? patch.processors.filter(Boolean) : [];
  if (registry) {
    const unknown = processors.filter((id) => !registry.has(id));
    if (unknown.length) {
      throw new Error(`Unknown recovery processor(s): ${unknown.join(', ')}`);
    }
  }
  const record = {
    mode,
    processors,
    maxItemsPerRun: clamp(patch.maxItemsPerRun, DEFAULT_MAX_ITEMS_PER_RUN, MAX_ITEMS_CEILING),
    maxAttemptsPerItem: clamp(patch.maxAttemptsPerItem, DEFAULT_MAX_ATTEMPTS_PER_ITEM, 10),
    until: patch.until || null,
    selectedAt: now.toISOString(),
    selectedBy: by,
  };
  await objectStore.put(RECOVERY_POLICY_KEY, enc.encode(JSON.stringify(record)), {
    contentType: 'application/json',
  });
  return policyFrom(record, { source: 'stored', registry });
}
