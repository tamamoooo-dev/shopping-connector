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
  createKeyChain, classifyMistralError, withFailover,
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
  check('403 -> auth', classifyMistralError(mistralErr(403)) === 'auth');
  check('429 -> rate', classifyMistralError(mistralErr(429)) === 'rate');
  check('500 -> transient', classifyMistralError(mistralErr(500)) === 'transient');
  check('crop fetch 404 -> other (never a key problem)', classifyMistralError(cropErr(404)) === 'other');
  check('message fallback: "invalid api key" -> auth',
    classifyMistralError(new Error('Mistral: invalid api key')) === 'auth');
  check('message fallback: "rate limit exceeded" -> rate',
    classifyMistralError(new Error('rate limit exceeded')) === 'rate');
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
      json: async () => ({ choices: [{ message: { content: '{"name_en":"Halah Oil","name_ar":null,"brand":"Halah","size":"1.5L","confidence":0.9}' } }] }),
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
