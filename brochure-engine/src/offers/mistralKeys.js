// offers/mistralKeys.js — the SHARED Mistral key-failover primitive. One
// implementation, every caller benefits: the Worker enrichment drain
// (offers/enrich.js, driven by the cron, the Ops "Vision Drain" button, and the
// Background Manual Vision job) and the local backfill script compose the SAME
// chain + runner here.
//
// POLICY (ACTIVE failover on rate limit, updated 2026-07-19 per user request —
// supersedes the earlier cold-standby "wait on the same key first" rule):
//   • the chain hands out ONE key at a time (never parallel quota), lowest-index
//     first — MISTRAL_API_KEY is the primary, MISTRAL_API_KEY_BACKUP the backup;
//   • an AUTH failure (bad/revoked key) retires that key for the rest of the run;
//   • on a RATE limit (429), the key is parked until its Retry-After window and
//     the runner IMMEDIATELY tries the next key that is neither dead nor parked —
//     it does NOT wait first when another key is available;
//   • the runner SLEEPS only when EVERY configured key is currently dead/parked;
//     it waits until the SOONEST Retry-After window elapses, then resumes
//     automatically (honoring the provider's own Retry-After);
//   • it is primary-preferred: once a key's rate-limit window passes it is used
//     again ahead of a backup (no permanent demotion), every switch is LOGGED;
//   • a 5xx / network failure is NOT a key problem (the backup hits the same
//     provider), so it never parks or retires a key.
//   • ONE key configured ⇒ fully backward compatible: nothing to fail over to,
//     so a 429 is simply waited out (Retry-After) and retried, exactly as before.
//
// Dependency-free and Workers-safe: it knows nothing about vision, offers, or
// enrichOffer — the caller passes a `doCall(apiKey)` closure. That keeps this a
// reusable failover runner and avoids any import cycle with enrich.js.

// A failover chain over an ordered key list. Blank/duplicate keys are dropped so
// a misconfigured "backup" that equals the primary is a no-op, not a phantom
// failover target. Each slot tracks whether it is auth-dead and, if 429'd, the
// timestamp until which it is rate-limited. `now` is injectable for tests.
function finiteNumber(value) {
  const n = value == null || value === '' ? NaN : Number(value);
  return Number.isFinite(n) ? n : null;
}

// A zero-capacity observation cannot be trusted forever: monthly/account quota
// resets happen outside the Worker and Mistral may report an exhausted key as
// 401 without a reset header. Re-sample a previously exhausted slot at most
// once per window so it automatically rejoins the balanced pool after reset,
// while healthy keys continue serving between probes.
const EXHAUSTED_KEY_RECHECK_MS = 6 * 60 * 60 * 1000;

export function remainingPercentage(rateLimit) {
  if (!rateLimit) return null;
  const pairs = [
    [rateLimit.remainingRequestsMinute, rateLimit.limitRequestsMinute],
    [rateLimit.remainingTokensMinute, rateLimit.limitTokensMinute],
    [rateLimit.remainingTokensMonth, rateLimit.limitTokensMonth],
    [rateLimit.remainingOcrPagesMinute, rateLimit.limitOcrPagesMinute],
  ];
  const percentages = pairs
    .map(([remaining, limit]) => {
      const r = finiteNumber(remaining);
      const l = finiteNumber(limit);
      return r != null && l != null && l > 0 ? (r / l) * 100 : null;
    })
    .filter((value) => value != null);
  if (!percentages.length) return finiteNumber(rateLimit.remainingPct);
  return Math.round(Math.max(0, Math.min(100, Math.min(...percentages))) * 10) / 10;
}

function keyEntry(value, index) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const key = value.key == null ? '' : String(value.key).trim();
    return {
      key,
      id: String(value.id || `key-${index + 1}`),
      label: String(value.label || `Key ${index + 1}`),
      pool: value.pool || null,
      model: value.model || null,
    };
  }
  return {
    key: value == null ? '' : String(value).trim(),
    id: `key-${index + 1}`,
    label: `Key ${index + 1}`,
    pool: null,
    model: null,
  };
}

export function createKeyChain(
  keys,
  {
    log = console.error,
    label = 'mistral',
    now = () => Date.now(),
    balance = false,
    usage = {},
  } = {},
) {
  const seen = new Set();
  const slots = [];
  for (const [index, value] of (keys || []).entries()) {
    const entry = keyEntry(value, index);
    if (!entry.key || seen.has(entry.key)) continue;
    seen.add(entry.key);
    const storedPrior = usage?.[entry.id] || {};
    const storedRateLimit = storedPrior.rateLimit || storedPrior;
    const storedPct = remainingPercentage(storedRateLimit);
    const observedAt = storedPrior.observedAt || storedPrior.rateLimit?.observedAt || null;
    const observedMs = observedAt ? Date.parse(observedAt) : NaN;
    const exhaustedRecheckDue = storedPct != null && storedPct <= 0 &&
      (!Number.isFinite(observedMs) || now() - observedMs >= EXHAUSTED_KEY_RECHECK_MS);
    const prior = exhaustedRecheckDue ? {} : storedPrior;
    slots.push({
      ...entry,
      dead: false,
      until: 0,
      calls: 0,
      rateLimit: prior.rateLimit || prior,
      remainingPct: remainingPercentage(prior.rateLimit || prior),
      observedAt: prior.observedAt || prior.rateLimit?.observedAt || null,
    });
  }
  let everFailedOver = false;

  // The legacy chain stays primary-preferred. Balanced pools (Medium's three
  // independent workspaces) first sample any unobserved slot, then choose the
  // highest remaining percentage. Equal percentages use the least-served slot,
  // keeping a fresh pool round-robin instead of draining key #1 first.
  const usableIndex = (t = now()) => {
    const candidates = slots
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => !slot.dead && slot.until <= t);
    if (!candidates.length) return -1;
    if (!balance) return candidates[0].index;
    candidates.sort((a, b) => {
      const ap = a.slot.remainingPct;
      const bp = b.slot.remainingPct;
      if (ap == null && bp != null) return -1;
      if (ap != null && bp == null) return 1;
      if (ap != null && bp != null && ap !== bp) return bp - ap;
      if (a.slot.calls !== b.slot.calls) return a.slot.calls - b.slot.calls;
      return a.index - b.index;
    });
    return candidates[0].index;
  };

  const recordRateLimit = (index, rateLimit) => {
    const slot = slots[index];
    if (!slot || !rateLimit) return;
    slot.rateLimit = { ...rateLimit };
    slot.remainingPct = remainingPercentage(rateLimit);
    slot.observedAt = rateLimit.observedAt || new Date(now()).toISOString();
  };

  const publicSlot = (slot) => ({
    id: slot.id,
    label: slot.label,
    pool: slot.pool,
    model: slot.model,
    configured: true,
    status: slot.dead ? 'invalid' : slot.until > now() ? 'limited' : 'ready',
    remainingPct: slot.remainingPct,
    observedAt: slot.observedAt,
    rateLimit: slot.rateLimit || null,
    calls: slot.calls,
  });

  return {
    size: slots.length,
    hasKeys() {
      return slots.length > 0;
    },
    snapshot() {
      return slots.map(publicSlot);
    },
    // The selected usable key, or null when every key is dead/parked right now.
    // Secret material never crosses snapshot(); only pick/current expose it to
    // the provider call path.
    pick(t = now()) {
      const i = usableIndex(t);
      if (i < 0) return null;
      if (!balance && i > 0) everFailedOver = true;
      return { key: slots[i].key, id: slots[i].id, index: i };
    },
    current(t = now()) {
      const i = usableIndex(t);
      return i < 0 ? null : slots[i].key;
    },
    failedOver() {
      return everFailedOver;
    },
    markSuccess(index, rateLimit = null) {
      const slot = slots[index];
      if (!slot) return;
      slot.calls += 1;
      recordRateLimit(index, rateLimit);
    },
    // Auth failure: this key is unusable for the rest of the run.
    markDead(index, reason, rateLimit = null) {
      const s = slots[index];
      if (!s || s.dead) return;
      s.dead = true;
      s.calls += 1;
      s.remainingPct = 0;
      s.observedAt = rateLimit?.observedAt || new Date(now()).toISOString();
      if (rateLimit) s.rateLimit = { ...rateLimit };
      const alt = usableIndex();
      log(`[${label}-failover] key #${index + 1} retired (${reason})` +
        (alt >= 0 ? `; using key #${alt + 1} of ${slots.length}` : '; NO usable key remains'));
    },
    // Rate limit: park this key until `untilMs`. Logs the immediate switch when
    // another key can take over now (the active-failover behavior).
    markRateLimited(index, untilMs, reason = 'rate limited', rateLimit = null) {
      const s = slots[index];
      if (!s) return;
      s.until = Math.max(s.until, untilMs);
      s.calls += 1;
      recordRateLimit(index, rateLimit);
      if (s.remainingPct == null) s.remainingPct = 0;
      const alt = usableIndex();
      if (alt >= 0 && alt !== index) {
        log(`[${label}-failover] key #${index + 1} ${reason}; switching to usable key #${alt + 1} of ${slots.length}`);
      }
    },
    // The soonest moment a parked (not dead) key becomes usable again, or null
    // when a key is usable NOW or every remaining key is auth-dead (nothing to
    // wait for). Drives the "sleep only when all keys are rate-limited" branch.
    nextResumeAt(t = now()) {
      if (usableIndex(t) >= 0) return null;
      let soonest = Infinity;
      for (const s of slots) {
        if (!s.dead && s.until > t) soonest = Math.min(soonest, s.until);
      }
      return soonest === Infinity ? null : soonest;
    },
  };
}

export const MISTRAL_POOL_DEFINITIONS = Object.freeze({
  medium: {
    label: 'Medium 3.5',
    model: 'mistral-medium-latest',
    slots: [
      ['medium-1', 'Medium key 1'],
      ['medium-2', 'Medium key 2'],
      ['medium-3', 'Medium key 3'],
    ],
  },
  small: {
    label: 'Small 2603',
    model: 'mistral-small-2603',
    slots: [['small-1', 'Small key']],
  },
  ocr: {
    label: 'OCR',
    model: 'mistral-ocr-latest',
    slots: [['ocr-1', 'OCR key']],
  },
  // The price-fallback reader (offers/priceFallback.js): Ministral 3 14B,
  // v25.12. `ministral-14b-2512` is the PINNED API name Mistral's model page
  // lists (alias `ministral-14b-latest`), pinned for the same reason Small is:
  // the fallback's behaviour is only known for a fixed build. A dedicated pool
  // with NO fallback to any other pool's secrets — this path never spends
  // Medium, Small or OCR quota.
  ministral14: {
    label: 'Ministral 3 14B',
    model: 'ministral-14b-2512',
    slots: [
      ['ministral14-1', 'Ministral 14B key 1'],
      ['ministral14-2', 'Ministral 14B key 2'],
      ['ministral14-3', 'Ministral 14B key 3'],
    ],
  },
});

function poolEntry(pool, slot, key) {
  const def = MISTRAL_POOL_DEFINITIONS[pool];
  return {
    id: slot[0],
    label: slot[1],
    pool,
    model: def.model,
    key: key || null,
  };
}

// Dedicated bindings win. The old two-key names remain compatibility fallbacks
// so deploying the code before rotating secrets cannot interrupt production.
export function buildMistralPools(env = {}) {
  const medium = MISTRAL_POOL_DEFINITIONS.medium.slots.map((slot, index) =>
    poolEntry(
      'medium',
      slot,
      index === 0
        ? (env.MISTRAL_MEDIUM_API_KEY_1 || env.MISTRAL_API_KEY)
        : index === 1
          ? (env.MISTRAL_MEDIUM_API_KEY_2 || env.MISTRAL_API_KEY_BACKUP)
          : env.MISTRAL_MEDIUM_API_KEY_3,
    ));
  return {
    medium,
    small: [
      poolEntry(
        'small',
        MISTRAL_POOL_DEFINITIONS.small.slots[0],
        env.MISTRAL_SMALL_API_KEY || env.MISTRAL_API_KEY || env.MISTRAL_API_KEY_BACKUP,
      ),
    ],
    ocr: [
      poolEntry(
        'ocr',
        MISTRAL_POOL_DEFINITIONS.ocr.slots[0],
        env.MISTRAL_OCR_API_KEY || env.MISTRAL_OCR_API_KEY_BACKUP
          || env.MISTRAL_API_KEY || env.MISTRAL_API_KEY_BACKUP,
      ),
    ],
    // Dedicated secrets only (MINISTRAL_14B_API_KEY_1..3): an unset slot stays
    // empty rather than borrowing another pool's key.
    ministral14: MISTRAL_POOL_DEFINITIONS.ministral14.slots.map((slot, index) =>
      poolEntry('ministral14', slot, env[`MINISTRAL_14B_API_KEY_${index + 1}`])),
  };
}

function parseDetail(row) {
  if (!row?.detail) return null;
  if (typeof row.detail === 'object') return row.detail;
  try { return JSON.parse(row.detail); } catch { return null; }
}

// Audit rows are newest-first. Keep the newest observation for each masked slot;
// this makes balancing durable across Worker invocations without storing secrets
// or adding a schema migration.
export function latestMistralUsage(rows = []) {
  const usage = {};
  for (const row of rows) {
    const list = parseDetail(row)?.keyUsage;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item?.id || usage[item.id]) continue;
      usage[item.id] = item;
    }
  }
  return usage;
}

export function mistralPoolInventory(pools, usage = {}) {
  return Object.entries(MISTRAL_POOL_DEFINITIONS).map(([pool, def]) => ({
    pool,
    label: def.label,
    model: def.model,
    keys: (pools?.[pool] || []).map((entry) => {
      const seen = usage[entry.id] || {};
      return {
        id: entry.id,
        label: entry.label,
        configured: !!entry.key,
        status: entry.key ? (seen.status || 'unobserved') : 'missing',
        remainingPct: entry.key ? (remainingPercentage(seen.rateLimit || seen)) : null,
        observedAt: seen.observedAt || seen.rateLimit?.observedAt || null,
      };
    }),
  }));
}

// Classify an error thrown by a Mistral call (enrichOffer tags its errors with
// `.stage` and `.status`; message-sniffing is the fallback for anything else).
//   auth      — 401/403/invalid key: the key is unusable, fail over now.
//   rate      — 429/quota: transient until it proves PERSISTENT.
//   transient — 5xx/network: provider trouble, NOT a key problem.
//   other     — crop fetch, parse, everything else: never a key problem.
export function classifyMistralError(err) {
  if (err?.stage === 'crop') return 'other';
  const status = Number(err?.status) || 0;
  const msg = String(err?.message || '').toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    /unauthor|invalid api key|invalid_api_key|authentication|forbidden/.test(msg)
  ) {
    return 'auth';
  }
  if (status === 429 || /rate.?limit|quota|too many requests|capacity exceeded/.test(msg)) {
    return 'rate';
  }
  if (
    (status >= 500 && status < 600) ||
    /timeout|temporarily|unavailable|econn|network|fetch failed/.test(msg)
  ) {
    return 'transient';
  }
  return 'other';
}

// Run `doCall(apiKey)` against the chain with ACTIVE failover (see the policy
// note at the top of the file). On AUTH it retires the key and tries the next
// usable one immediately. On a 429 it PARKS the key until its Retry-After window
// and immediately tries the next usable key — it sleeps ONLY when every key is
// dead/parked, and then only until the soonest window elapses (bounded by
// `maxRateRetries` wait-cycles). Transient/other errors propagate unchanged —
// the caller's own pacing/retry handles them. `now` is injectable for tests.
export async function withFailover(keyChain, doCall, {
  maxRateRetries = 2,
  backoffMs = 1500,
  sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  if (!keyChain || !keyChain.hasKeys()) throw new Error('withFailover: no API key available');
  let waitCycles = 0;
  let lastErr = null;
  for (;;) {
    const slot = keyChain.pick(now());
    if (slot) {
      try {
        const result = await doCall(slot.key);
        keyChain.markSuccess?.(slot.index, result?.rateLimit || null);
        return result;
      } catch (err) {
        lastErr = err;
        const kind = classifyMistralError(err);
        if (kind === 'auth') {
          keyChain.markDead(slot.index, `auth (${err?.status || '?'})`, err?.rateLimit || null);
          continue; // try the next usable key immediately
        }
        if (kind === 'rate') {
          // Park this key until the provider's own Retry-After window (or a
          // growing backoff when none was sent), then loop — pick() hands us the
          // next usable key at once, so the backup is tried BEFORE any wait.
          const untilMs = err.retryAfterMs != null
            ? now() + err.retryAfterMs
            : now() + backoffMs * (waitCycles + 1);
          keyChain.markRateLimited(slot.index, untilMs, 'rate limited', err?.rateLimit || null);
          continue;
        }
        // transient (5xx / network) and other (crop fetch / parse) are not key
        // problems — the backup hits the same provider, so never fail over.
        throw err;
      }
    }
    // No key is usable right now. If any is merely rate-limited (not dead), wait
    // until the SOONEST window elapses and resume; if every key is auth-dead
    // there is nothing to wait for. Bounded so a permanently throttled account
    // eventually surfaces the 429 to the caller's own retry/reporting.
    const resumeAt = keyChain.nextResumeAt(now());
    if (resumeAt == null) throw lastErr || new Error('withFailover: all API keys exhausted');
    if (waitCycles >= maxRateRetries) throw lastErr || new Error('withFailover: all API keys rate limited');
    waitCycles += 1;
    await sleepImpl(Math.max(0, resumeAt - now()));
  }
}
