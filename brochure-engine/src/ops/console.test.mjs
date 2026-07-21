// ops/console.test.mjs — offline tests for the Operations Console: auth
// (token, session cookie, rate limiting, bearer), route surface, the
// production-path dispatch rule (SELF fan-out when bound, per-store audit rows
// from the /ingest children), Repair Unhealthy / Retry Failed target
// resolution, Emergency Heal pipeline + typed confirmation, verification
// summaries, and the engine's /ingest mode param.
// Run: node src/ops/console.test.mjs

import { handleOps, OPS_PATH } from './console.js';
import { handleRequest } from '../engine.js';
import {
  createMemoryMetadataStore,
  createMemoryOfferStore,
  createMemoryOpsStore,
  createMemoryHistoryStore,
  createMemoryWatchStore,
} from '../storage/local.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const enc = new TextEncoder();
const today = new Date().toISOString().slice(0, 10);
const inWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
const lastMonth = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

function memoryObjectStore() {
  const objects = new Map();
  return {
    objects,
    async put(key, bytes, { contentType } = {}) {
      objects.set(key, { bytes, contentType });
    },
    async get(key) {
      return objects.get(key) || null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

// Scripted providers driving the REAL ingest pipeline (engine.js ingestTarget):
//   held  — the collector confirms the pre-seeded current flyer (an unchanged
//           week: candidate.existing -> deduped, run succeeds)
//   empty — the collector finds nothing ("no brochure" -> failed target)
//   throw — the source is down (collector error -> failed target)
function provider(id, { collect = 'empty', held = null } = {}) {
  return {
    id,
    label: id.toUpperCase(),
    regions: { central: {} },
    strategies: [
      {
        name: 'stub',
        async collect() {
          if (collect === 'throw') throw new Error('stub source down');
          if (collect === 'held') return [{ existing: held }];
          return [];
        },
      },
    ],
  };
}

async function buildCtx({ withSelf = true } = {}) {
  const registry = {
    alpha: provider('alpha', {
      collect: 'held',
      held: { id: 'alpha:central:2026-W28', checksum: 'sha256:alpha', storage_key: 'alpha/central/2026-W28' },
    }),
    beta: provider('beta'),
    gamma: provider('gamma', { collect: 'throw' }),
  };
  const metadataStore = createMemoryMetadataStore();
  const offerStore = createMemoryOfferStore();
  const opsStore = createMemoryOpsStore();
  const objectStore = memoryObjectStore();

  // alpha: healthy — fresh flyer, 2/2 clickable spots, current offers.
  await metadataStore.upsert({
    id: 'alpha:central:2026-W28',
    store: 'alpha',
    region: 'central',
    edition: '2026-W28',
    title: null,
    valid_from: today,
    valid_to: inWeek,
    detected_at: new Date().toISOString(),
    source_type: 'images',
    source_url: 'https://agg.example/offers/alpha-9/111/weekly',
    pdf_url: null,
    checksum: 'sha256:alpha',
    collector: 'd4d',
    storage_key: 'alpha/central/2026-W28',
  });
  objectStore.objects.set('brochures/alpha/central/2026-W28/hotspots.json', {
    bytes: enc.encode(JSON.stringify({ pages: [{ index: 0, spots: [{ offerId: 'A' }, { offerId: 'B' }] }] })),
  });
  await offerStore.upsertMany([
    { id: 'alpha:central:d4d:A', store: 'alpha', region: 'central', source: 'd4d', offer_id: 'A', flyer_ref: '111', price: 5, valid_from: today, valid_to: inWeek, detected_at: 'x', search_text: 'x' },
    { id: 'alpha:central:d4d:B', store: 'alpha', region: 'central', source: 'd4d', offer_id: 'B', flyer_ref: '111', price: 6, valid_from: today, valid_to: inWeek, detected_at: 'x', search_text: 'x' },
  ]);

  // beta: unhealthy — its only flyer expired a month ago (STALE).
  await metadataStore.upsert({
    id: 'beta:central:2026-W23',
    store: 'beta',
    region: 'central',
    edition: '2026-W23',
    title: null,
    valid_from: lastMonth,
    valid_to: lastMonth,
    detected_at: `${lastMonth}T06:00:00Z`,
    source_type: 'link',
    source_url: 'https://beta.example/offers',
    pdf_url: null,
    checksum: 'sha256:beta',
    collector: 'officialLink',
    storage_key: 'beta/central/2026-W23',
  });

  // gamma: unhealthy — holds nothing (NO_FLYER) and its collector throws.

  const ctx = {
    registry,
    metadataStore,
    offerStore,
    opsStore,
    objectStore,
    historyStore: createMemoryHistoryStore(),
    watchStore: createMemoryWatchStore(),
    offersSource: null, // offers ingest skips cleanly (provider config carries no offers address)
    notifier: null,
    searchClient: null,
    pipeline: { ingest: async () => ({ status: 'new', doc: {} }) },
    ingestSecret: 'dev',
    opsToken: 'test-ops-token',
    crons: { pipeline: '0 6 * * 2,3,5', watches: '45 5 * * *' },
  };
  if (withSelf) {
    // The SELF service binding, faithfully: a fetch that re-enters this same
    // Worker's router in a "fresh invocation".
    ctx.selfCalls = [];
    ctx.self = {
      fetch: (url, init) => {
        ctx.selfCalls.push(String(url));
        return handleRequest(new Request(url, init), ctx);
      },
    };
  }
  return ctx;
}

const B = 'https://engine.test' + OPS_PATH;
const req = (ctx, path, opts = {}) => handleOps(new Request(B + path, opts), ctx);
const post = (ctx, path, body, headers = {}) =>
  req(ctx, path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// --- mount + auth ------------------------------------------------------------------
{
  const ctx = await buildCtx();

  check('non-ops paths return null (engine handles them)', (await handleOps(new Request('https://engine.test/brochures'), ctx)) === null);
  check('prefix look-alike is not captured', (await handleOps(new Request('https://engine.test/__opsx'), ctx)) === null);

  let r = await req(ctx, '');
  const html = await r.text();
  check('UI served with strict CSP', r.status === 200 && html.includes('System Confidence') && (r.headers.get('Content-Security-Policy') || '').includes("default-src 'none'"));
  check('UI never cached or indexed', r.headers.get('Cache-Control') === 'no-store' && (r.headers.get('X-Robots-Tag') || '').includes('noindex'));
  check('no CORS on ops responses', !r.headers.get('Access-Control-Allow-Origin'));

  r = await req(ctx, '/api/overview');
  check('unauthenticated API -> 401', r.status === 401);

  r = await post(ctx, '/api/login', { token: 'wrong' });
  check('bad login -> 401', r.status === 401);

  r = await post(ctx, '/api/login', { token: 'test-ops-token' });
  const cookie = (r.headers.get('Set-Cookie') || '').split(';')[0];
  check('good login sets HttpOnly Strict cookie', r.status === 200 && cookie.startsWith('ops_session=') && /HttpOnly/.test(r.headers.get('Set-Cookie')) && /SameSite=Strict/.test(r.headers.get('Set-Cookie')));

  r = await req(ctx, '/api/overview', { headers: { Cookie: cookie } });
  check('cookie auth works', r.status === 200);

  r = await req(ctx, '/api/overview', { headers: { Authorization: 'Bearer test-ops-token' } });
  check('bearer auth works', r.status === 200);

  r = await req(ctx, '/api/overview', { headers: { Cookie: 'ops_session=' + (Date.now() + 9e6) + '.deadbeef' } });
  check('tampered cookie rejected', r.status === 401);

  // Rate limiting: 5 bad attempts lock the IP even with the right token.
  const ip = { 'CF-Connecting-IP': '9.9.9.9' };
  for (let i = 0; i < 5; i++) await post(ctx, '/api/login', { token: 'nope' }, ip);
  r = await post(ctx, '/api/login', { token: 'test-ops-token' }, ip);
  check('login rate limit locks after 5 fails', r.status === 429);
  r = await post(ctx, '/api/login', { token: 'test-ops-token' }, { 'CF-Connecting-IP': '8.8.8.8' });
  check('other IPs unaffected', r.status === 200);

  // Locked console without the secret.
  const locked = await buildCtx();
  locked.opsToken = undefined;
  r = await req(locked, '');
  check('missing OPS_TOKEN -> 503 locked', r.status === 503);
  console.log('mount + auth ✅');
}

// --- overview + inspector + diagnostics ----------------------------------------------
{
  const ctx = await buildCtx();
  const auth = { Authorization: 'Bearer test-ops-token' };

  const o = await (await req(ctx, '/api/overview', { headers: auth })).json();
  check('overview: registry drives the store list', o.stores.length === 3 && o.stores.some((s) => s.store === 'alpha'));
  check('overview: alpha healthy at 100% coverage', o.stores.find((s) => s.store === 'alpha').status === 'OK');
  check('overview: beta STALE, gamma NO_FLYER', o.stores.find((s) => s.store === 'beta').status === 'STALE' && o.stores.find((s) => s.store === 'gamma').status === 'NO_FLYER');
  check('overview carries confidence + checks + scheduler', typeof o.confidence.score === 'number' && o.checks.length >= 9 && o.scheduler.crons.length === 2);

  const s = await (await req(ctx, '/api/store?id=alpha', { headers: auth })).json();
  check('inspector: flyer id + edition + counts', s.flyers[0].flyerRef === '111' && s.flyers[0].edition === '2026-W28' && s.hotspots === 2 && s.clickable === 2);
  check('inspector: unknown store -> 404', (await req(ctx, '/api/store?id=nope', { headers: auth })).status === 404);

  const d = await (await req(ctx, '/api/diagnostics', { headers: auth })).json();
  check('diagnostics: no errors yet, counts present', d.latestError === null && d.counts.currentFlyers === 2);
  console.log('read routes ✅');
}

// --- operations: production path, verification, audit ---------------------------------
{
  const ctx = await buildCtx();
  const auth = { Authorization: 'Bearer test-ops-token' };

  let r = await post(ctx, '/api/run', { op: 'all' }, auth);
  check('run without confirm -> 428', r.status === 428);

  r = await post(ctx, '/api/run', { op: 'all', confirm: true }, auth);
  const all = await r.json();
  check('Run All dispatches every store through SELF', ctx.selfCalls.length === 3 && ctx.selfCalls.every((u) => u.includes('/ingest?store=')), JSON.stringify(ctx.selfCalls));
  check('ops origin tagged on children', (await ctx.opsStore.list({ origin: 'ops' })).some((row) => row.action === 'ingest' && row.store === 'alpha'));
  check('run report carries per-store verification', all.verification.lines.length === 3 && all.verification.lines.find((l) => l.store === 'alpha').pass === true);
  check('run not ok while beta/gamma unhealthy', all.ok === false && all.verification.failures.sort().join(',') === 'beta,gamma');

  const coord = (await ctx.opsStore.list({})).find((row) => row.action === 'ops:all');
  check('coordinator audit row written', !!coord && coord.stores === 3 && coord.ok === 0);

  // Single store: still the same production path (SELF bound -> fan-out of 1).
  ctx.selfCalls.length = 0;
  r = await post(ctx, '/api/run', { op: 'store', stores: ['alpha'], confirm: true }, auth);
  const one = await r.json();
  check('single store rides the same child route', ctx.selfCalls.length === 1 && ctx.selfCalls[0].includes('store=alpha') && one.verification.lines.length === 1);

  // Partial runs carry the mode through to the child URL.
  ctx.selfCalls.length = 0;
  await post(ctx, '/api/run', { op: 'offers', confirm: true }, auth);
  check('Offers Only children run mode=offers', ctx.selfCalls.length === 3 && ctx.selfCalls.every((u) => u.includes('mode=offers')));

  // Detection-driven targeting.
  ctx.selfCalls.length = 0;
  r = await post(ctx, '/api/run', { op: 'repair', confirm: true }, auth);
  const repair = await r.json();
  check('Repair targets ONLY unhealthy stores', repair.targets.sort().join(',') === 'beta,gamma', JSON.stringify(repair.targets));
  ctx.selfCalls.length = 0;
  r = await post(ctx, '/api/run', { op: 'retry-failed', confirm: true }, auth);
  const retry = await r.json();
  check('Retry Failed targets FAIL/NO_FLYER stores', retry.targets.includes('gamma') && !retry.targets.includes('alpha'), JSON.stringify(retry.targets));

  check('unknown store in selection -> 404', (await post(ctx, '/api/run', { op: 'selected', stores: ['zzz'], confirm: true }, auth)).status === 404);
  check('unknown op -> 400', (await post(ctx, '/api/run', { op: 'zap', confirm: true }, auth)).status === 400);

  // Verify: read-only, no confirm needed, audited.
  r = await post(ctx, '/api/verify', {}, auth);
  const v = await r.json();
  check('verify summarizes without ingesting', v.action === 'ops:verify' && v.verification.lines.length === 3 && v.ok === false);

  // Repair on an all-healthy system is a clean no-op.
  const healthy = await buildCtx();
  delete healthy.registry.beta;
  delete healthy.registry.gamma;
  r = await post(healthy, '/api/run', { op: 'repair', confirm: true }, auth);
  const noop = await r.json();
  check('repair with nothing to do says so', noop.ok === true && noop.nothingToDo === true, JSON.stringify(noop));
  console.log('operations ✅');
}

// --- Emergency Heal ---------------------------------------------------------------------
{
  const ctx = await buildCtx();
  const auth = { Authorization: 'Bearer test-ops-token' };

  check('heal without typed confirm -> 428', (await post(ctx, '/api/heal', { confirm: true }, auth)).status === 428);

  const r = await post(ctx, '/api/heal', { confirm: 'HEAL' }, auth);
  const heal = await r.json();
  const names = heal.steps.map((s) => s.name);
  check(
    'heal runs the full pipeline in order',
    names[0] === 'Pre-heal verification' &&
      names[1].startsWith('Ingest fan-out') &&
      names[2] === 'Coverage validation' &&
      names[3] === 'Hotspot validation' &&
      names[4] === 'Notification' &&
      names[5] === 'Final verification',
    names.join(' | '),
  );
  check('heal dispatched every store via SELF', ctx.selfCalls.length === 3);
  check('heal reports final health + confidence', heal.health && typeof heal.health.confidence === 'number');
  check('heal not ok while stores are unhealthy', heal.ok === false && heal.verification.failures.length === 2);
  check('heal audit row written', (await ctx.opsStore.list({})).some((row) => row.action === 'ops:heal'));

  // Notification step reports the notifier outcome and heal notifies by default.
  const notified = [];
  const nctx = await buildCtx();
  nctx.notifier = { async send(n) { notified.push(n); } };
  const heal2 = await (await post(nctx, '/api/heal', { confirm: 'HEAL' }, auth)).json();
  check('heal sends the ntfy report through the engine notifier', notified.length === 1 && heal2.steps[4].detail === 'sent' && notified[0].title.includes('HEAL'));
  console.log('emergency heal ✅');
}

// --- engine /ingest mode param + in-process dev fallback ---------------------------------
{
  const ctx = await buildCtx();
  const ingest = (qs) =>
    handleRequest(new Request('https://engine.test/ingest' + qs, { method: 'POST', headers: { 'X-Ingest-Secret': 'dev' } }), ctx);

  let r = await ingest('?store=alpha&mode=offers');
  const body = await r.json();
  check('mode=offers skips brochures', r.status === 200 && body.totals.detected === 0 && body.targets.length === 0);
  r = await ingest('?store=alpha&mode=brochures');
  const body2 = await r.json();
  check('mode=brochures skips offers', r.status === 200 && body2.offers === undefined);
  check('bad mode rejected', (await ingest('?store=alpha&mode=zap')).status === 400);
  check('child ingest wrote audit rows', (await ctx.opsStore.list({ store: 'alpha' })).length >= 2);

  // No SELF binding (dev.mjs): the same functions run in-process.
  const dev = await buildCtx({ withSelf: false });
  const auth = { Authorization: 'Bearer test-ops-token' };
  const rr = await post(dev, '/api/run', { op: 'store', stores: ['alpha'], confirm: true }, auth);
  const rep = await rr.json();
  check('dev fallback runs in-process with audit', rep.verification.lines.length === 1 && (await dev.opsStore.list({ store: 'alpha' })).length === 1);
  console.log('engine mode + dev fallback ✅');
}

// --- manual vision drain (developer tool, NOT normal operations) -------------------
{
  const auth = { Authorization: 'Bearer test-ops-token' };
  const ctx = await buildCtx();

  check('enrich requires confirmation', (await post(ctx, '/api/enrich', {}, auth)).status === 428);
  check('enrich unavailable without MISTRAL_API_KEY -> 503',
    (await post(ctx, '/api/enrich', { confirm: true }, auth)).status === 503);

  // A drained queue is a result, not an error — and it is audited.
  ctx.mistralKey = 'k';
  ctx.enrichStore = {
    countDebris: async () => 0,
    listDebris: async () => [],
    pruneOrphans: async () => 0,
    upsertMany: async () => ({ stored: 0 }),
  };
  const idle = await (await post(ctx, '/api/enrich', { confirm: true }, auth)).json();
  check('empty queue -> nothingToDo, audited',
    idle.nothingToDo === true && (await ctx.opsStore.list({ limit: 50 })).some((r) => r.action === 'ops:enrich'));

  // A pending queue dispatches /enrich children through SELF — the exact cron
  // path — with the ops origin tag; the summary row lands in the audit.
  ctx.enrichStore.countDebris = async () => 17; // ceil(17/15) = 2 children
  ctx.selfCalls.length = 0;
  const run = await (await post(ctx, '/api/enrich', { confirm: true }, auth)).json();
  check('pending queue -> SELF /enrich children (cron-identical path)',
    run.ok === true && run.batches === 2 && ctx.selfCalls.length === 2 &&
    ctx.selfCalls.every((u) => u.includes('/enrich?limit=15')));
  check('drain children audit as ops origin',
    (await ctx.opsStore.list({ limit: 50 })).some((r) => r.action === 'enrich' && r.origin === 'ops'));
  check('report carries queue depth + remaining', run.pending === 17 && 'remaining' in run);
  console.log('manual vision drain ✅');
}

// --- Background Manual Vision job (§2, cron-driven redesign 2026-07-20):
// vision/start just ARMS a running job — the 1-minute `visionDrain` cron (index.js
// scheduled(), single-writer lease) drains it, so start no longer kicks any chain.
// vision/stop halts it; vision/job reports it; a second start is refused.
{
  const auth = { Authorization: 'Bearer test-ops-token' };
  const ctx = await buildCtx();
  function memVisionJobStore() {
    let row = null;
    return {
      async start({ scope = 'all', total = 0, origin = 'ops' } = {}) {
        const now = new Date().toISOString();
        row = { id: 'active', status: 'running', scope, total, processed: 0, enriched: 0, declined: 0, failed: 0, remaining: total, hops: 0, started_at: now, updated_at: now, finished_at: null, last_error: null, provider_limit: null, origin, lease_until: null };
        return { ...row };
      },
      async get() { return row ? { ...row } : null; },
      async update(patch = {}) { if (row) row = { ...row, ...patch, updated_at: new Date().toISOString() }; return row ? { ...row } : null; },
      async stop() { if (row && row.status === 'running') { const now = new Date().toISOString(); row = { ...row, status: 'stopped', finished_at: now, updated_at: now }; } return row ? { ...row } : null; },
    };
  }

  check('vision/start needs confirmation -> 428', (await post(ctx, '/api/vision/start', {}, auth)).status === 428);
  check('vision/start unavailable without MISTRAL_API_KEY -> 503', (await post(ctx, '/api/vision/start', { confirm: true }, auth)).status === 503);

  ctx.mistralKey = 'k';
  ctx.visionJobStore = memVisionJobStore();
  let n = 0;
  ctx.enrichStore = { countDebris: async () => n };

  const empty = await (await post(ctx, '/api/vision/start', { confirm: true }, auth)).json();
  check('empty queue -> nothingToDo, no job armed', empty.nothingToDo === true && empty.job === null);

  n = 42;
  ctx.selfCalls.length = 0;
  const started = await (await post(ctx, '/api/vision/start', { confirm: true }, auth)).json();
  check('vision/start ARMS a running job (no chain kick — the cron drains it)',
    started.ok === true && started.job.status === 'running' && started.job.total === 42 && ctx.selfCalls.length === 0);
  check('vision/start audited', (await ctx.opsStore.list({ limit: 50 })).some((r) => r.action === 'ops:vision-start'));

  const jobRead = (await (await req(ctx, '/api/vision/job', { headers: auth })).json()).job;
  check('vision/job returns the running job', jobRead.status === 'running' && jobRead.total === 42);

  const again = await (await post(ctx, '/api/vision/start', { confirm: true }, auth)).json();
  check('vision/start refuses a second job while one is running', again.alreadyRunning === true);

  const stopped = await (await post(ctx, '/api/vision/stop', {}, auth)).json();
  check('vision/stop halts the running job', stopped.job.status === 'stopped');
  console.log('background manual vision ✅');
}

// --- Operations Center routes (Ops plan §1–§8) --------------------------------
{
  const auth = { Authorization: 'Bearer test-ops-token' };
  const ctx = await buildCtx();
  ctx.crons = { pipeline: '0 6 * * 2,3,5', watches: '45 5 * * *', enrich: '10,30,50 * * * *' };
  // The vision/registry stores the new panels read (memory twins in
  // storage/local.js cover only the classic stores).
  ctx.enrichStore = {
    coverage: async () => ({ withCrop: 50, attempted: 40, enriched: 35, servable: 30, declined: 5, remaining: 10, coverage: 80 }),
    countDebris: async () => 10,
    verdictCounts: async () => ({ minted: 80, unresolved: 5, declined: 3, low_corroboration: 2, too_few_tokens: 1, or_deal: 0 }),
    getForIds: async () => new Map(),
    resetVerdicts: async () => {},
  };
  ctx.registryStore = {
    productCount: async () => 25,
    sightingsCount: async () => 120,
    stats: async () => ({ products: { active: 20, dormant: 3, merged: 2, flagged: 1, assortments: 0 }, bands: { auto: 50, review: 10, created: 20 } }),
    searchProducts: async ({ q }) => (q === 'milk' ? [{ id: 'pr_1', display_name: 'Milk', brand_slug: 'x', status: 'active', sightings: 4 }] : []),
    getProducts: async (ids) => (ids.includes('pr_1') ? [{ id: 'pr_1', status: 'active', kind: 'product', display_name: 'Milk', size_unit: null, sightings: 4, first_seen: '2026-07-01', last_seen: '2026-07-10' }] : []),
    getSighting: async () => null,
    mergedLoserIds: async () => new Map(),
    sightingsForProducts: async () => [],
  };
  ctx.offerStore.getById = async (id) =>
    id === 'alpha:central:d4d:A'
      ? { id, store: 'alpha', region: 'central', name: 'A', name_ar: null, price: 5, currency: 'SAR', image_url: null, source_url: null, valid_to: inWeek, detected_at: 'x', search_text: 'x', category: null, old_price: null }
      : null;
  ctx.offerStore.inspectorFeed = async () => [
    { id: 'alpha:central:d4d:A', store: 'alpha', price: 5, currency: 'SAR', image_url: null, o_name: 'A', e_name: null, e_servable: 0, e_enriched_at: null, s_match_band: null, e_corroboration: null },
  ];
  ctx.offerStore.oldestUnenrichedAge = async () => new Date(Date.now() - 3600000).toISOString();

  check('progress needs auth -> 401', (await req(ctx, '/api/progress')).status === 401);

  const prog = await (await req(ctx, '/api/progress', { headers: auth })).json();
  check('progress shape', prog.coverage === 80 && prog.registryProducts === 25 && prog.sightings === 120 && prog.remaining === 10 && prog.nextCron !== null);

  const q = await (await req(ctx, '/api/queue', { headers: auth })).json();
  check('queue snapshot buckets', q.vision.queued === 10 && q.resolution.minted === 80 && q.resolution.deferred === 6);

  const cr = await (await req(ctx, '/api/crons', { headers: auth })).json();
  check('cron monitor lists every schedule', cr.crons.length === 3 && cr.crons.every((c) => 'nextRun' in c));

  const pipe = await (await req(ctx, '/api/pipeline', { headers: auth })).json();
  check('pipeline health has the 7 stages', pipe.stages.length === 7 && pipe.stages[0].name === 'OCR' && pipe.stages[6].name === 'Search');

  const diag = await (await req(ctx, '/api/diagnostics2', { headers: auth })).json();
  check('diagnostics names the un-instrumented metrics', diag.notInstrumented.length === 3 && 'd1' in diag.probes && diag.queueAgeMs > 0);

  const ins = await (await req(ctx, '/api/inspector?filter=all', { headers: auth })).json();
  check('inspector feed returns items + echoes filter', ins.filter === 'all' && ins.items.length === 1);

  const one = await (await req(ctx, '/api/inspect?id=alpha:central:d4d:A', { headers: auth })).json();
  check('inspect composes offer + ocr + vision(none) + registry', one.offer.id === 'alpha:central:d4d:A' && one.ocr.name === 'A' && one.vision === null && one.product === null);
  check('inspect unknown offer -> 404', (await req(ctx, '/api/inspect?id=zzz', { headers: auth })).status === 404);

  const ps = await (await req(ctx, '/api/productsearch?q=milk', { headers: auth })).json();
  check('product search returns matches', ps.products.length === 1 && ps.products[0].id === 'pr_1');

  const pd = await (await req(ctx, '/api/product?id=pr_1', { headers: auth })).json();
  check('product detail composes a sightings list', pd.product.id === 'pr_1' && Array.isArray(pd.sightings));
  check('product unknown -> 404', (await req(ctx, '/api/product?id=nope', { headers: auth })).status === 404);

  // The three new mutations keep the confirmation gate.
  check('resolve needs confirm -> 428', (await post(ctx, '/api/resolve', {}, auth)).status === 428);
  check('maintain needs confirm -> 428', (await post(ctx, '/api/maintain', {}, auth)).status === 428);
  check('reopen needs confirm -> 428', (await post(ctx, '/api/reopen', { ids: ['x'] }, auth)).status === 428);
  check('reopen with no ids -> 400', (await post(ctx, '/api/reopen', { confirm: true, ids: [] }, auth)).status === 400);

  // CSP now permits Inspector images while connect-src stays same-origin.
  const csp = (await req(ctx, '')).headers.get('Content-Security-Policy') || '';
  check('CSP allows images, keeps connect-src self', csp.includes("img-src 'self' data: https:") && csp.includes("connect-src 'self'"));
  console.log('operations center routes ✅');
}

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll ops console tests passed.');
