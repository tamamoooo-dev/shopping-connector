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
export function createKeyChain(keys, { log = console.error, label = 'mistral', now = () => Date.now() } = {}) {
  const seen = new Set();
  const slots = [];
  for (const k of keys || []) {
    const key = k == null ? '' : String(k).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    slots.push({ key, dead: false, until: 0 });
  }
  let everFailedOver = false;

  // Lowest-index key that is neither auth-dead nor currently rate-limited.
  const usableIndex = (t = now()) => {
    for (let i = 0; i < slots.length; i += 1) {
      if (!slots[i].dead && slots[i].until <= t) return i;
    }
    return -1;
  };

  return {
    size: slots.length,
    hasKeys() {
      return slots.length > 0;
    },
    // The primary-preferred usable key, or null when every key is dead/parked
    // right now. Marks that a non-primary key was actually served (failedOver).
    pick(t = now()) {
      const i = usableIndex(t);
      if (i < 0) return null;
      if (i > 0) everFailedOver = true;
      return { key: slots[i].key, index: i };
    },
    current(t = now()) {
      const i = usableIndex(t);
      return i < 0 ? null : slots[i].key;
    },
    failedOver() {
      return everFailedOver;
    },
    // Auth failure: this key is unusable for the rest of the run.
    markDead(index, reason) {
      const s = slots[index];
      if (!s || s.dead) return;
      s.dead = true;
      const alt = usableIndex();
      log(`[${label}-failover] key #${index + 1} retired (${reason})` +
        (alt >= 0 ? `; using key #${alt + 1} of ${slots.length}` : '; NO usable key remains'));
    },
    // Rate limit: park this key until `untilMs`. Logs the immediate switch when
    // another key can take over now (the active-failover behavior).
    markRateLimited(index, untilMs, reason = 'rate limited') {
      const s = slots[index];
      if (!s) return;
      s.until = Math.max(s.until, untilMs);
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
        return await doCall(slot.key);
      } catch (err) {
        lastErr = err;
        const kind = classifyMistralError(err);
        if (kind === 'auth') {
          keyChain.markDead(slot.index, `auth (${err?.status || '?'})`);
          continue; // try the next usable key immediately
        }
        if (kind === 'rate') {
          // Park this key until the provider's own Retry-After window (or a
          // growing backoff when none was sent), then loop — pick() hands us the
          // next usable key at once, so the backup is tried BEFORE any wait.
          const untilMs = err.retryAfterMs != null
            ? now() + err.retryAfterMs
            : now() + backoffMs * (waitCycles + 1);
          keyChain.markRateLimited(slot.index, untilMs);
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
