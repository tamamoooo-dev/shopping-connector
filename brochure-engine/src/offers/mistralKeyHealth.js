// offers/mistralKeyHealth.js — the durable record of each Mistral key's last
// observed state (2026-11-12).
//
// WHY. A key chain lives for one Worker invocation. What the last invocation
// learned (this key answers 401, that one has no allowance left) reached the
// next one only through `detail.keyUsage` on the newest 120 audit rows. Runs
// that record usage are not always among them: the vision children write a row
// only when something failed, and the price lanes only while unpriced items
// wait. With none in the window every key read "unobserved" — the console
// showed nothing, the digest counted retired keys as usable, and each
// invocation spent a call on every dead key again.
//
// HOW. One small JSON object in the engine's object store, newest observation
// per key id. It is merged with the audit rows on read, so either source alone
// still works. Only the masked snapshot is stored (ids, status, rate-limit
// counters) — never key material.
//
// Writes are throttled: a run rewrites the record when a key's standing
// changed (usable / invalid / restricted) or the stored observation is older
// than REFRESH_MS. Parallel lanes may overwrite each other's write; the loser's
// observation returns within REFRESH_MS, and the audit rows cover the gap.

import { isTerminalMistralLimit, latestMistralUsage } from './mistralKeys.js';

export const KEY_HEALTH_KEY = 'ops/mistral-key-health.json';
export const KEY_HEALTH_REFRESH_MS = 10 * 60 * 1000;

const observedMs = (item) => {
  const ms = Date.parse(item?.observedAt || item?.rateLimit?.observedAt || '');
  return Number.isFinite(ms) ? ms : null;
};

// What decides whether a key is tried at all. "limited" is a rate-limit park
// that ends within the minute, so it is not a change of standing.
function standing(item) {
  if (item?.status === 'invalid') return 'invalid';
  const category = item?.restrictionCategory || item?.rateLimit?.category || null;
  return isTerminalMistralLimit(category) ? `restricted:${category}` : 'usable';
}

export async function readKeyHealth(objectStore) {
  if (!objectStore?.get) return {};
  try {
    const stored = await objectStore.get(KEY_HEALTH_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(new TextDecoder().decode(stored.bytes));
    return parsed && typeof parsed.keys === 'object' && parsed.keys ? parsed.keys : {};
  } catch {
    return {}; // unreadable record: the audit rows still carry the state
  }
}

// `primary` is what the audit rows say (newest row wins, as before). A stored
// entry replaces it only when it is the newer observation.
export function mergeKeyUsage(primary = {}, stored = {}) {
  const merged = { ...primary };
  for (const [id, item] of Object.entries(stored || {})) {
    const storedAt = observedMs(item);
    if (storedAt == null) continue;
    const current = merged[id];
    const currentAt = current ? observedMs(current) : null;
    if (!current || currentAt == null || storedAt > currentAt) merged[id] = item;
  }
  return merged;
}

// The usage every reader shares: the engine's key chains, the console's key
// pools and the digest's key count.
export async function currentKeyUsage(ctx, { rows = null, stored = null } = {}) {
  const auditRows = rows || (ctx.opsStore?.list ? await ctx.opsStore.list({ limit: 120 }).catch(() => []) : []);
  const record = stored || (await readKeyHealth(ctx.objectStore));
  return mergeKeyUsage(latestMistralUsage(auditRows), record);
}

// After a run: fold its snapshot into the record. Returns true when written.
export async function noteKeyUsage(objectStore, keyUsage, { stored = null, now = new Date() } = {}) {
  if (!objectStore?.put || !Array.isArray(keyUsage) || !keyUsage.length) return false;
  const record = { ...(stored || (await readKeyHealth(objectStore))) };
  let changed = false;
  for (const item of keyUsage) {
    const at = observedMs(item);
    if (!item?.id || at == null) continue; // never observed: nothing to remember
    const known = record[item.id];
    const knownAt = known ? observedMs(known) : null;
    if (knownAt != null && at < knownAt) continue;
    const { calls, ...kept } = item; // calls is per run
    if (knownAt == null || standing(known) !== standing(item) || at - knownAt >= KEY_HEALTH_REFRESH_MS) {
      record[item.id] = kept;
      changed = true;
    }
  }
  if (!changed) return false;
  const body = JSON.stringify({ updatedAt: now.toISOString(), keys: record });
  await objectStore.put(KEY_HEALTH_KEY, new TextEncoder().encode(body), { contentType: 'application/json' });
  return true;
}
