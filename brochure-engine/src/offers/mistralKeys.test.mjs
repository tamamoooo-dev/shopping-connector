// offers/mistralKeys.test.mjs — offline tests for the shared Mistral key
// failover primitive (offers/mistralKeys.js) and its integration into
// enrichWithFailover / drainEnrichment. Run with:
//   node brochure-engine/src/offers/mistralKeys.test.mjs   (repo root)
//
// Guards the policy (ACTIVE failover on rate limit, never parallel quota;
// updated 2026-07-19 — the backup is tried BEFORE waiting):
//  • the chain drops blanks + a backup that equals the primary,
//  • auth failure (401/403) retires the key IMMEDIATELY and the backup serves,
//  • a 429 PARKS the key (Retry-After) and the backup is tried AT ONCE (no wait),
//  • it SLEEPS only when EVERY key is dead/parked, then resumes at the soonest
//    window (honoring Retry-After); it is primary-preferred once a window passes,
//  • single-key config is backward compatible: a 429 is waited out then retried,
//  • 5xx / crop-fetch errors NEVER retire a key (backup hits the same provider),
//  • drainEnrichment surfaces failedOver and keeps draining across a failover.

import {
  createKeyChain, classifyMistral429, classifyMistralError, withFailover, remainingPercentage,
  buildMistralPools, latestMistralUsage, mistralPoolInventory,
} from './mistralKeys.js';
import { enrichWithFailover, drainEnrichment } from './enrich.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

const mistralErr = (status) => Object.assign(new Error(`mistral ${status}: x`), { stage: 'mistral', status });
const cropErr = (status) => Object.assign(new Error(`crop fetch ${status}`), { stage: 'crop', status });
const noLog = () => {};

// --- classifier ------------------------------------------------------------------
console.log('classifyMistralError:');
{
  check('401 -> auth', classifyMistralError(mistralErr(401)) === 'auth');
  check('402 -> auth (out of credits, fail over like a bad key)', classifyMistralError(mistralErr(402)) === 'auth');
  check('403 -> auth', classifyMistralError(mistralErr(403)) === 'auth');
  check('429 -> rate', classifyMistralError(mistralErr(429)) === 'rate');
  const zeroAllowance = Object.assign(mistralErr(429), {
    rateLimit: { limitRequestsMinute: '0', remainingRequestsMinute: '0' },
    providerError: { message: 'Rate limit exceeded', type: 'rate_limited', code: '1300' },
  });
  check('429 with request allowance 0 -> terminal restriction',
    classifyMistral429(zeroAllowance) === 'request_allowance_zero' &&
    classifyMistralError(zeroAllowance) === 'restriction');
  check('429 reason taxonomy separates quota, traffic, billing, capacity, and unknown',
    classifyMistral429(Object.assign(mistralErr(429), {
      rateLimit: { limitTokensMonth: '1000', remainingTokensMonth: '0' },
    })) === 'monthly_account_quota' &&
    classifyMistral429(Object.assign(mistralErr(429), {
      rateLimit: { limitTokensMinute: '1000', remainingTokensMinute: '0' },
    })) === 'token_rate_limit' &&
    classifyMistral429(Object.assign(mistralErr(429), {
      providerError: { message: 'Concurrent request limit exceeded' },
    })) === 'concurrency_limit' &&
    classifyMistral429(Object.assign(mistralErr(429), {
      providerError: { message: 'Billing subscription inactive' },
    })) === 'billing_restriction' &&
    classifyMistral429(Object.assign(mistralErr(429), {
      rateLimit: { limitRequestsMinute: '60', remainingRequestsMinute: '0' },
    })) === 'request_rate_limit' &&
    classifyMistral429(Object.assign(mistralErr(429), {
      providerError: { message: 'Temporary capacity throttling' },
    })) === 'capacity_throttling' &&
    classifyMistral429(mistralErr(429)) === 'unknown_429');
  check('500 -> transient', classifyMistralError(mistralErr(500)) === 'transient');
  check('crop fetch 404 -> other (never a key problem)', classifyMistralError(cropErr(404)) === 'other');
  check('message fallback: "invalid api key" -> auth',
    classifyMistralError(new Error('Mistral: invalid api key')) === 'auth');
  check('message fallback: "rate limit exceeded" -> rate',
    classifyMistralError(new Error('rate limit exceeded')) === 'rate');
  check('message fallback: "payment required" -> auth',
    classifyMistralError(new Error('402 Payment Required')) === 'auth');
  check('message fallback: "insufficient credits" -> auth',
    classifyMistralError(new Error('Insufficient credits on this workspace')) === 'auth');
}

// --- key chain -------------------------------------------------------------------
console.log('createKeyChain:');
{
  const c = createKeyChain(['  primary ', '', null, 'backup'], { log: noLog });
  check('trims + drops blanks', c.size === 2 && c.current() === 'primary');
  const dupe = createKeyChain(['same', 'same'], { log: noLog });
  check('drops a backup identical to the primary (no phantom failover)', dupe.size === 1);
  const empty = createKeyChain([null, '']);
  check('no usable keys', !empty.hasKeys() && empty.current() === null);

  const logs = [];
  const c2 = createKeyChain(['a', 'b'], { log: (m) => logs.push(m), now: () => 1000 });
  check('pick prefers the primary (lowest index)', c2.pick().key === 'a' && c2.pick().index === 0 && !c2.failedOver());
  c2.markDead(0, 'auth');
  check('markDead retires the key + logs + backup becomes current', c2.current() === 'b' && /retired/.test(logs[0]));
  check('serving a non-primary key marks failedOver', c2.pick().index === 1 && c2.failedOver());
  c2.markDead(1, 'auth');
  check('all keys dead -> current null, nothing to wait for', c2.current() === null && c2.nextResumeAt() === null);

  // Rate-limit parking + primary-preference over time (fixed clock).
  const c3 = createKeyChain(['a', 'b'], { log: noLog, now: () => 1000 });
  c3.markRateLimited(0, 2000); // park primary until t=2000
  check('a rate-limited primary yields the backup immediately', c3.pick(1000).key === 'b');
  check('nextResumeAt is null while any key is usable', c3.nextResumeAt(1000) === null);
  c3.markRateLimited(1, 1500); // park backup too (sooner window)
  check('all parked -> pick null, nextResumeAt = soonest window', c3.pick(1000) === null && c3.nextResumeAt(1000) === 1500);
  check('primary is preferred again once its window elapses', c3.pick(2000).key === 'a');

  const pct = remainingPercentage({
    limitRequestsMinute: 50,
    remainingRequestsMinute: 44,
    limitTokensMinute: 25000,
    remainingTokensMinute: 24000,
  });
  check('remaining percentage uses the tightest live constraint', pct === 88);
  check('OCR page headers produce a remaining percentage',
    remainingPercentage({
      limitOcrPagesMinute: 625,
      remainingOcrPagesMinute: 624,
    }) === 99.8);
  check('explicit 0/0 request allowance is zero usable capacity',
    remainingPercentage({ limitRequestsMinute: '0', remainingRequestsMinute: '0' }) === 0);
}

// --- withFailover ----------------------------------------------------------------
console.log('withFailover:');
{
  // auth on primary -> immediate failover, backup serves.
  {
    const chain = createKeyChain(['bad', 'good'], { log: noLog });
    const seen = [];
    const out = await withFailover(chain, async (k) => {
      seen.push(k);
      if (k === 'bad') throw mistralErr(401);
      return 'ok';
    }, { sleepImpl: async () => {} });
    check('auth failure fails over immediately to the standby',
      out === 'ok' && seen.join(',') === 'bad,good' && chain.failedOver());
  }

  // 402 (out of credits) on the primary -> immediate failover, same as auth.
  {
    const chain = createKeyChain(['broke', 'funded'], { log: noLog });
    const seen = [];
    const out = await withFailover(chain, async (k) => {
      seen.push(k);
      if (k === 'broke') throw mistralErr(402);
      return 'ok';
    }, { sleepImpl: async () => {} });
    check('402 (out of credits) fails over immediately to the funded key',
      out === 'ok' && seen.join(',') === 'broke,funded' && chain.failedOver());
  }

  // both primary AND first backup out of credits -> falls through to a third key.
  {
    const chain = createKeyChain(['broke1', 'broke2', 'funded'], { log: noLog });
    const seen = [];
    const out = await withFailover(chain, async (k) => {
      seen.push(k);
      if (k === 'broke1' || k === 'broke2') throw mistralErr(402);
      return 'ok';
    }, { sleepImpl: async () => {} });
    check('two exhausted keys in a row still fail over to a third',
      out === 'ok' && seen.join(',') === 'broke1,broke2,funded');
  }

  // 429 on the primary -> the backup is tried IMMEDIATELY, before any wait.
  {
    const chain = createKeyChain(['p', 'b'], { log: noLog });
    const seen = [];
    let slept = 0;
    const out = await withFailover(chain, async (k) => {
      seen.push(k);
      if (k === 'p') throw Object.assign(mistralErr(429), { retryAfterMs: 5000 });
      return 'ok';
    }, { sleepImpl: async () => { slept += 1; } });
    check('a 429 fails over to the backup IMMEDIATELY (no wait first)',
      out === 'ok' && seen.join(',') === 'p,b' && chain.failedOver() && slept === 0);
  }

  // ALL keys rate-limited -> wait the SOONEST Retry-After, then resume (a mock
  // clock advanced by sleepImpl proves the wait honors the window).
  {
    let t = 0;
    const clock = () => t;
    const chain = createKeyChain(['p', 'b'], { log: noLog, now: clock });
    const seen = [];
    const slept = [];
    const rate = () => Object.assign(mistralErr(429), { retryAfterMs: 10 });
    let firstP = true, firstB = true;
    const out = await withFailover(chain, async (k) => {
      seen.push(k);
      if (k === 'p' && firstP) { firstP = false; throw rate(); }
      if (k === 'b' && firstB) { firstB = false; throw rate(); }
      return 'ok:' + k;
    }, { now: clock, sleepImpl: async (ms) => { slept.push(ms); t += ms; }, maxRateRetries: 3 });
    check('all keys rate-limited -> waits the soonest window, then resumes',
      out === 'ok:p' && seen.join(',') === 'p,b,p' && slept.length === 1 && slept[0] === 10);
  }

  // A zero request allowance is not a short window. Each distinct account is
  // checked once, there is no sleep/retry cycle, and the full masked evidence
  // remains attached to the final error.
  {
    const chain = createKeyChain([
      { id: 'account-1', key: 'a' },
      { id: 'account-2', key: 'b' },
      { id: 'account-3', key: 'c' },
    ], { log: noLog });
    const seen = [];
    let sleeps = 0;
    let threw = null;
    try {
      await withFailover(chain, async (key) => {
        seen.push(key);
        throw Object.assign(mistralErr(429), {
          model: 'mistral-small-2603',
          responseBody: '{"object":"error","code":"1300"}',
          providerError: { object: 'error', code: '1300', type: 'rate_limited' },
          rateLimit: { status: 429, limitRequestsMinute: '0', remainingRequestsMinute: '0' },
        });
      }, { sleepImpl: async () => { sleeps += 1; } });
    } catch (err) { threw = err; }
    check('zero allowance checks each distinct key once and never sleeps/retries',
      seen.join(',') === 'a,b,c' && sleeps === 0);
    check('zero allowance preserves all attempted key ids and full provider body',
      threw?.mistralAttempts?.map((attempt) => attempt.keyId).join(',') ===
        'account-1,account-2,account-3' &&
      threw?.mistralAttempts?.every((attempt) => attempt.responseBody === '{"object":"error","code":"1300"}'));
    check('zero allowance marks every key restricted, not temporarily limited',
      chain.snapshot().every((slot) => slot.status === 'restricted'));
  }

  // 5xx never parks/retires a key; with a single key it just propagates.
  {
    const chain = createKeyChain(['only'], { log: noLog });
    let threw = null;
    try {
      await withFailover(chain, async () => { throw mistralErr(503); }, { sleepImpl: async () => {} });
    } catch (e) { threw = e; }
    check('5xx propagates without parking a key', threw?.status === 503 && !chain.failedOver());
  }

  // Single key (backward compatible): a persistent 429 is waited out, then
  // propagates once the wait budget is spent — nothing to fail over to.
  {
    const chain = createKeyChain(['only'], { log: noLog });
    let threw = null;
    try {
      await withFailover(chain, async () => { throw Object.assign(mistralErr(429), { retryAfterMs: 1 }); },
        { maxRateRetries: 1, sleepImpl: async () => {} });
    } catch (e) { threw = e; }
    check('single-key persistent 429 waits then propagates', threw?.status === 429);
  }

  check('no keys at all -> explicit error', await (async () => {
    try { await withFailover(createKeyChain([]), async () => 'x'); return false; }
    catch (e) { return /no API key/.test(e.message); }
  })());

  // Balanced Medium: sample each unknown slot, then always serve the highest
  // remaining percentage. Equal percentages use least-served round robin.
  {
    const chain = createKeyChain([
      { id: 'medium-1', label: 'Medium key 1', key: 'a' },
      { id: 'medium-2', label: 'Medium key 2', key: 'b' },
      { id: 'medium-3', label: 'Medium key 3', key: 'c' },
    ], { balance: true, log: noLog });
    const seen = [];
    const percentages = [90, 90, 90, 89, 89];
    for (const remainingPct of percentages) {
      await withFailover(chain, async (key) => {
        seen.push(key);
        return { rateLimit: { remainingPct, observedAt: '2026-07-30T00:00:00.000Z' } };
      });
    }
    check('balanced pool samples all three then keeps equal usage close',
      seen.join(',') === 'a,b,c,a,b');
    check('balanced snapshot is masked and carries per-key percentages',
      chain.snapshot().every((slot) => !Object.prototype.hasOwnProperty.call(slot, 'key')) &&
      chain.snapshot().every((slot) => slot.remainingPct != null));
  }

  // An exhausted account can return 401 until its external quota reset. A
  // durable 0% observation must therefore become probeable again, otherwise a
  // healthier key would permanently starve it even after the reset.
  {
    const nowMs = Date.parse('2026-07-30T12:00:00.000Z');
    const entries = [
      { id: 'medium-1', key: 'a' },
      { id: 'medium-2', key: 'b' },
    ];
    const freshZero = createKeyChain(entries, {
      balance: true,
      log: noLog,
      now: () => nowMs,
      usage: {
        'medium-1': { remainingPct: 75, observedAt: '2026-07-30T11:00:00.000Z' },
        'medium-2': { remainingPct: 0, observedAt: '2026-07-30T11:00:00.000Z' },
      },
    });
    check('fresh exhausted observation stays parked behind a healthier key',
      freshZero.pick().key === 'a');

    const staleZero = createKeyChain(entries, {
      balance: true,
      log: noLog,
      now: () => nowMs,
      usage: {
        'medium-1': { remainingPct: 75, observedAt: '2026-07-30T11:00:00.000Z' },
        'medium-2': { remainingPct: 0, observedAt: '2026-07-30T05:00:00.000Z' },
      },
    });
    check('stale exhausted observation is re-probed so resets are discovered',
      staleZero.pick().key === 'b' && staleZero.snapshot()[1].remainingPct == null);

    const persistedZeroAllowance = createKeyChain([{ id: 'small-1', key: 's' }], {
      log: noLog,
      now: () => nowMs,
      usage: {
        'small-1': {
          status: 'restricted',
          observedAt: '2026-07-30T11:00:00.000Z',
          rateLimit: {
            status: 429,
            limitRequestsMinute: '0',
            remainingRequestsMinute: '0',
            observedAt: '2026-07-30T11:00:00.000Z',
          },
        },
      },
    });
    let calls = 0;
    let persistedError = null;
    try {
      await withFailover(persistedZeroAllowance, async () => { calls += 1; });
    } catch (err) { persistedError = err; }
    check('fresh persisted zero allowance suppresses cross-invocation retry traffic',
      calls === 0 && persistedError?.mistralCategory === 'request_allowance_zero');
  }
}

// --- model-scoped pool inventory + durable audit snapshot ---------------------
console.log('model pools:');
{
  const pools = buildMistralPools({
    MISTRAL_MEDIUM_API_KEY_1: 'm1',
    MISTRAL_MEDIUM_API_KEY_2: 'm2',
    MISTRAL_MEDIUM_API_KEY_3: 'm3',
    MISTRAL_SMALL_API_KEY: 's1',
    MISTRAL_SMALL_API_KEY_BACKUP: 's2',
    MISTRAL_SMALL_API_KEY_BACKUP_2: 's3',
    MISTRAL_OCR_API_KEY: 'o1',
  });
  check('model keys are attached only to their intended pool',
    pools.medium.map((x) => x.key).join(',') === 'm1,m2,m3' &&
    pools.small.map((x) => x.key).join(',') === 's1,s2,s3' && pools.ocr[0].key === 'o1');
  check('small pool fails over across all three keys like medium does',
    createKeyChain(pools.small.map((x) => x.key), { log: noLog }).size === 3);
  const usage = latestMistralUsage([
    { detail: JSON.stringify({ keyUsage: [
      { id: 'medium-1', status: 'ready', remainingPct: 88, observedAt: '2026-07-30T00:00:00.000Z' },
    ] }) },
  ]);
  const inventory = mistralPoolInventory(pools, usage);
  check('developer inventory shows percentage and never secret material',
    inventory.find((x) => x.pool === 'medium').keys[0].remainingPct === 88 &&
    !JSON.stringify(inventory).includes('m1'));
}

// --- enrichWithFailover + drainEnrichment (integration) --------------------------
console.log('drain integration:');
{
  // A fake fetch: crop always 200; the Mistral endpoint 401s for key "dead"
  // and returns a valid reply for key "live".
  const makeFetch = (deadKey) => async (url, init) => {
    if (String(url).startsWith('http') && !String(url).includes('mistral')) {
      // crop fetch
      return { ok: true, headers: { get: () => 'image/jpeg' }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    }
    const auth = init?.headers?.authorization || '';
    if (auth.includes(deadKey)) {
      return { ok: false, status: 401, text: async () => 'unauthorized' };
    }
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"name_en":"Halah Oil","name_ar":"زيت هالة","brand":"Halah","size":"1.5L","confidence":0.9}' } }] }),
    };
  };

  const offer = { id: 'o:1', name: null, nameAr: null, imageUrl: 'http://cdn/x.jpg' };
  const chain = createKeyChain(['dead', 'live'], { log: noLog });
  const rec = await enrichWithFailover(offer, { keyChain: chain, fetchImpl: makeFetch('dead'), sleepImpl: async () => {} });
  check('enrichWithFailover recovers a 401 on the standby and returns the record',
    rec && rec.name === 'Halah Oil' && chain.failedOver());

  // drainEnrichment reports failedOver and keeps going across the switch.
  const debris = [
    { id: 'o:a', image_url: 'http://cdn/a.jpg', search_text: 'halah oil' },
    { id: 'o:b', image_url: 'http://cdn/b.jpg', search_text: 'halah oil' },
  ];
  const stored = [];
  const enrichStore = {
    pruneOrphans: async () => 0,
    listDebris: async () => debris,
    upsertMany: async (rows) => { stored.push(...rows); return { stored: rows.length }; },
    saveVisionOutcome: async ({ canonicalRow }) => {
      if (canonicalRow) stored.push(canonicalRow);
      return { stored: 1, queued: canonicalRow ? 0 : 1 };
    },
  };
  const drainChain = createKeyChain(['dead', 'live'], { log: noLog });
  // Inject the fake fetch by temporarily swapping global fetch (enrichOffer
  // defaults to global fetch; the drain doesn't thread fetchImpl through).
  const realFetch = globalThis.fetch;
  globalThis.fetch = makeFetch('dead');
  let report;
  try {
    report = await drainEnrichment({ enrichStore, keyChain: drainChain }, { maxRateRetries: 0 });
  } finally {
    globalThis.fetch = realFetch;
  }
  check('drain enriches both offers despite the primary being dead',
    report.enriched === 2 && stored.length === 2 && stored.every((r) => r.name === 'Halah Oil'));
  check('drain surfaces failedOver = true', report.failedOver === true && report.failed === 0);
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll mistralKeys tests passed.');
