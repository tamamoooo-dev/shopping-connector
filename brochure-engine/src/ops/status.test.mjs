// ops/status.test.mjs — pure, offline tests for the Ops Console status engine:
// per-store rows (coverage math, status precedence), subsystem checks, the
// System Confidence blend, scheduler heartbeat/next-fire, and self test.
// Run: node src/ops/status.test.mjs

import {
  computeStoreRows,
  subsystemChecks,
  systemConfidence,
  schedulerInfo,
  selfTest,
  cronNext,
  healthPct,
  unhealthyStores,
  failedStores,
  COVERAGE_THRESHOLD,
  visionProgress,
  enrichRate,
  queueSnapshot,
  cronMonitor,
  pipelineHealth,
  latencyStats,
} from './status.js';
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
const NOW = new Date('2026-07-10T12:00:00Z');
const today = '2026-07-10';
const inWeek = '2026-07-17';
const lastWeek = '2026-07-03';

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

const provider = (id) => ({ id, label: id.toUpperCase(), regions: { central: {} }, strategies: [] });

async function buildFixture() {
  const registry = Object.fromEntries(
    ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((id) => [id, provider(id)]),
  );
  const metadataStore = createMemoryMetadataStore();
  const offerStore = createMemoryOfferStore();
  const opsStore = createMemoryOpsStore();
  const objectStore = memoryObjectStore();

  const brochure = (store, edition, validTo, { flyer = null, sourceType = 'images' } = {}) => ({
    id: `${store}:central:${edition}`,
    store,
    region: 'central',
    edition,
    title: null,
    valid_from: lastWeek,
    valid_to: validTo,
    detected_at: `${today}T06:00:00Z`,
    source_type: sourceType,
    source_url: flyer ? `https://agg.example/offers/${store}-9/${flyer}/weekly` : `https://agg.example/${store}`,
    pdf_url: null,
    checksum: `sha256:${store}:${edition}`,
    collector: 'd4d',
    storage_key: `${store}/central/${edition}`,
  });
  const spots = (ids) => ({ pages: [{ index: 0, spots: ids.map((id) => ({ offerId: id, x: 0, y: 0, w: 0.1, h: 0.1 })) }] });
  const offerRow = (store, offerId, flyer) => ({
    id: `${store}:central:d4d:${offerId}`,
    store,
    region: 'central',
    source: 'd4d',
    offer_id: offerId,
    flyer_ref: flyer,
    price: 5,
    valid_from: lastWeek,
    valid_to: inWeek,
    detected_at: `${today}T06:00:00Z`,
    search_text: 'x',
  });

  // alpha: fresh flyer, 2/2 spots clickable, offers held -> OK.
  await metadataStore.upsert(brochure('alpha', '2026-W28', inWeek, { flyer: '111' }));
  objectStore.objects.set('brochures/alpha/central/2026-W28/hotspots.json', {
    bytes: enc.encode(JSON.stringify(spots(['A', 'B']))),
  });
  await offerStore.upsertMany([offerRow('alpha', 'A', '111'), offerRow('alpha', 'B', '111')]);

  // beta: holds a flyer but it EXPIRED last week -> STALE.
  await metadataStore.upsert(brochure('beta', '2026-W27', lastWeek));

  // gamma: nothing held at all -> NO_FLYER.

  // delta: fresh flyer, but its LATEST ingest run failed -> FAIL outranks all.
  // (origin 'ops' — manual retries — so the scheduler-heartbeat tests below
  // control their own cron rows; a cron CHILD row is a valid heartbeat too.)
  await metadataStore.upsert(brochure('delta', '2026-W28', inWeek));
  await opsStore.record({ ts: `${today}T05:00:00Z`, action: 'ingest', origin: 'ops', store: 'delta', ok: true, elapsed_ms: 900 });
  await opsStore.record({ ts: `${today}T06:00:00Z`, action: 'ingest', origin: 'ops', store: 'delta', ok: false, error: 'd4d: HTTP 503' });

  // epsilon: fresh flyer, 1/4 spots clickable (25% < threshold) -> LOW_COVERAGE.
  await metadataStore.upsert(brochure('epsilon', '2026-W28', inWeek, { flyer: '555' }));
  objectStore.objects.set('brochures/epsilon/central/2026-W28/hotspots.json', {
    bytes: enc.encode(JSON.stringify(spots(['P', 'Q', 'R', 'S']))),
  });
  await offerStore.upsertMany([offerRow('epsilon', 'P', '555')]);

  return {
    registry,
    metadataStore,
    offerStore,
    opsStore,
    objectStore,
    historyStore: createMemoryHistoryStore(),
    watchStore: createMemoryWatchStore(),
    notifier: null,
    searchClient: null,
    crons: { pipeline: '0 6 * * 2,3,5', watches: '45 5 * * *' },
  };
}

// --- store rows: coverage math + status precedence ------------------------------
{
  const ctx = await buildFixture();
  const rows = await computeStoreRows(ctx, { now: NOW });
  const by = Object.fromEntries(rows.map((r) => [r.store, r]));

  check('alpha is OK', by.alpha.status === 'OK', by.alpha.status);
  check('alpha coverage 100%', by.alpha.coverage === 100, String(by.alpha.coverage));
  check('alpha raw numbers exposed', by.alpha.hotspots === 2 && by.alpha.clickable === 2 && by.alpha.offers === 2);
  check('alpha flyer id surfaced', by.alpha.flyers[0].flyerRef === '111', JSON.stringify(by.alpha.flyers));
  check('beta is STALE (expired flyer)', by.beta.status === 'STALE', by.beta.status);
  check('gamma is NO_FLYER', by.gamma.status === 'NO_FLYER', by.gamma.status);
  check('delta is FAIL (latest run failed)', by.delta.status === 'FAIL', by.delta.status);
  check('delta carries the error + last ok run', by.delta.lastError === 'd4d: HTTP 503' && by.delta.lastOkMs === 900);
  check(
    'epsilon is LOW_COVERAGE at 25%',
    by.epsilon.status === 'LOW_COVERAGE' && by.epsilon.coverage === 25 && 25 < COVERAGE_THRESHOLD,
    `${by.epsilon.status} ${by.epsilon.coverage}`,
  );
  check('unhealthy stores sort first', rows[rows.length - 1].store === 'alpha', rows.map((r) => r.store).join(','));
  check(
    'unhealthyStores = everything but alpha',
    JSON.stringify(unhealthyStores(rows).sort()) === JSON.stringify(['beta', 'delta', 'epsilon', 'gamma']),
  );
  check(
    'failedStores = FAIL + NO_FLYER only',
    JSON.stringify(failedStores(rows).sort()) === JSON.stringify(['delta', 'gamma']),
  );
  console.log('store rows ✅');
}

// --- subsystem checks + scheduler heartbeat --------------------------------------
{
  const ctx = await buildFixture();
  let checks = await subsystemChecks(ctx, { now: NOW });
  const by = Object.fromEntries(checks.map((c) => [c.name, c]));
  check('D1 passes', by.D1.status === 'PASS');
  check('KV passes', by.KV.status === 'PASS');
  check('Brochure Engine passes with current flyers', by['Brochure Engine'].status === 'PASS');
  check('Offers Engine passes with current offers', by['Offers Engine'].status === 'PASS');
  check('Hotspots detail exposes clickable/total', by.Hotspots.detail === '3/6 spots clickable', by.Hotspots.detail);
  check('Search unconfigured without connector', by.Search.status === 'UNCONFIGURED');
  check('Notifier unconfigured without topic', by.Notifier.status === 'UNCONFIGURED');
  check('Scheduler UNKNOWN before any coordinator row', by.Scheduler.status === 'UNKNOWN', by.Scheduler.detail);

  // A recent cron coordinator row flips the heartbeat to PASS…
  await ctx.opsStore.record({ ts: '2026-07-10T06:00:00Z', action: 'cron:fanout', origin: 'cron', ok: true });
  checks = await subsystemChecks(ctx, { now: NOW });
  check('Scheduler PASS on a fresh heartbeat', checks.find((c) => c.name === 'Scheduler').status === 'PASS');

  // …and a stale one (3 days old, daily watch cron missing) reads FAIL.
  const staleCtx = await buildFixture();
  await staleCtx.opsStore.record({ ts: '2026-07-07T06:00:00Z', action: 'cron:fanout', origin: 'cron', ok: true });
  checks = await subsystemChecks(staleCtx, { now: NOW });
  check('Scheduler FAIL on a stale heartbeat', checks.find((c) => c.name === 'Scheduler').status === 'FAIL');
  check('healthPct excludes UNCONFIGURED/UNKNOWN', healthPct([
    { status: 'PASS' },
    { status: 'FAIL' },
    { status: 'UNCONFIGURED' },
    { status: 'UNKNOWN' },
  ]) === 50);
  console.log('subsystem checks ✅');
}

// --- System Confidence -------------------------------------------------------------
{
  const ctx = await buildFixture();
  await ctx.opsStore.record({ ts: '2026-07-10T06:00:00Z', action: 'cron:fanout', origin: 'cron', ok: true });
  const storeRows = await computeStoreRows(ctx, { now: NOW });
  const checks = await subsystemChecks(ctx, { storeRows, now: NOW });
  const conf = systemConfidence({ storeRows, checks });
  const comp = Object.fromEntries(conf.components.map((c) => [c.key, c]));

  // freshness: alpha, delta, epsilon fresh -> 3/5 = 60.
  check('freshness component 60', comp.freshness.score === 60, String(comp.freshness.score));
  // coverage: alpha 100 + epsilon 25 -> 62.5.
  check('coverage component 62.5', comp.coverage.score === 62.5, String(comp.coverage.score));
  // offers: alpha + epsilon have current offers -> 2/5 = 40.
  check('offers component 40', comp.offers.score === 40, String(comp.offers.score));
  check('scheduler component 100', comp.scheduler.score === 100);
  check('confidence within bounds', conf.score >= 0 && conf.score <= 100, String(conf.score));
  // exact blend: (60*30 + 62.5*25 + 40*15 + 100*15 + subsystems*15) / 100
  const subs = comp.subsystems.score;
  const expected = Math.round((60 * 30 + 62.5 * 25 + 40 * 15 + 100 * 15 + subs * 15) / 100);
  check('confidence blend exact', conf.score === expected, `${conf.score} != ${expected}`);

  // A component with no signal is excluded and weights renormalize.
  const noCov = systemConfidence({
    storeRows: storeRows.map((r) => ({ ...r, coverage: null, hotspots: 0, clickable: 0 })),
    checks,
  });
  check('missing coverage excluded, not zeroed', noCov.components.find((c) => c.key === 'coverage').score === null && noCov.score > 0);
  console.log('system confidence ✅');
}

// --- scheduler info + cronNext ------------------------------------------------------
{
  const ctx = await buildFixture();
  await ctx.opsStore.record({ ts: '2026-07-10T05:46:00Z', action: 'cron:watches', origin: 'cron', ok: true });
  const info = await schedulerInfo(ctx, { now: NOW });
  check('scheduler healthy with fresh heartbeat', info.healthy === true, info.detail);
  check('last cron runs listed', info.lastRuns.length === 1 && info.lastRuns[0].action === 'cron:watches');
  const pipeline = info.crons.find((c) => c.name === 'pipeline');
  // 2026-07-10 12:00Z is a Friday (dow 5, a cron day) — next fire is Tue 06:00Z.
  check('pipeline next fire Tue 06:00Z', pipeline.nextRun === '2026-07-14T06:00:00.000Z', pipeline.nextRun);
  const watches = info.crons.find((c) => c.name === 'watches');
  check('watches next fire tomorrow 05:45Z', watches.nextRun === '2026-07-11T05:45:00.000Z', watches.nextRun);

  check('cronNext same-day when before fire time', cronNext('0 6 * * 2,3,5', new Date('2026-07-10T04:00:00Z'))?.toISOString() === '2026-07-10T06:00:00.000Z');
  check('cronNext rejects malformed exprs', cronNext('not a cron') === null && cronNext('0 6 * *') === null);
  console.log('scheduler info ✅');
}

// --- self test ------------------------------------------------------------------------
{
  const ctx = await buildFixture();
  await ctx.opsStore.record({ ts: '2026-07-10T06:00:00Z', action: 'cron:fanout', origin: 'cron', ok: true });
  ctx.searchClient = {
    async search() {
      return [{ name: 'x', price: 1 }];
    },
  };
  const st = await selfTest(ctx, { now: NOW });
  const by = Object.fromEntries(st.checks.map((c) => [c.name, c]));
  check('self test KV round-trip PASS', by.KV.status === 'PASS' && by.KV.detail.includes('round-trip'));
  check('self test live search PASS', by.Search.status === 'PASS' && by.Search.detail === 'live query ok');
  check('self test probe key cleaned up', !ctx.objectStore.objects.has('ops/selftest-probe'));
  check('self test carries confidence + rows', st.confidence.score > 0 && st.storeRows.length === 5);

  // A broken object store must read FAIL, never throw.
  const broken = await buildFixture();
  broken.objectStore.put = async () => {
    throw new Error('kv write refused');
  };
  const st2 = await selfTest(broken, { now: NOW });
  check('broken KV reads FAIL', st2.checks.find((c) => c.name === 'KV').status === 'FAIL');
  console.log('self test ✅');
}

// --- Operations Center: Vision Progress / Queue / Cron (§1,§4,§5) ---------------
{
  const OPS_ROWS = [
    { action: 'cron:enrich', origin: 'cron', ts: '2026-07-10T11:50:00Z', ok: 1, elapsed_ms: 4200, detail: JSON.stringify({ enriched: 30, batches: 4 }) },
    { action: 'cron:enrich', origin: 'cron', ts: '2026-07-10T11:20:00Z', ok: 1, elapsed_ms: 4000, detail: JSON.stringify({ enriched: 30 }) },
    { action: 'ingest', origin: 'cron', ts: '2026-07-10T06:00:00Z', ok: 1, elapsed_ms: 9000 },
  ];
  const stubCtx = (over = {}) => ({
    crons: { enrich: '10,30,50 * * * *', pipeline: '0 6 * * 2,3,5', watches: '45 5 * * *' },
    opsStore: {
      async list({ origin, limit } = {}) {
        const rows = origin ? OPS_ROWS.filter((r) => r.origin === origin) : OPS_ROWS;
        return rows.slice(0, limit || 50);
      },
    },
    offerStore: { async counts() { return { total: 100, current: 60, stores: 4 }; } },
    enrichStore: {
      async coverage() { return { withCrop: 50, attempted: 40, enriched: 35, servable: 30, declined: 5, remaining: 10, coverage: 80 }; },
      async countDebris() { return 10; },
      async verdictCounts() { return { minted: 80, unresolved: 5, declined: 3, low_corroboration: 2, too_few_tokens: 1, or_deal: 0 }; },
    },
    registryStore: {
      async productCount() { return 25; },
      async sightingsCount() { return 120; },
      async stats() { return { products: { active: 20, dormant: 3, merged: 2, flagged: 1, assortments: 0 }, bands: { auto: 50, review: 10, created: 20 } }; },
    },
    ...over,
  });

  const rate = await enrichRate(stubCtx(), { now: NOW });
  check('enrichRate sums detail.enriched over window', rate.enriched === 60 && rate.perHour === 2.5, JSON.stringify(rate));

  const prog = await visionProgress(stubCtx(), { now: NOW });
  check('visionProgress passes coverage + registry counts', prog.coverage === 80 && prog.remaining === 10 && prog.registryProducts === 25 && prog.sightings === 120);
  check('visionProgress ETA from rate', prog.rate === 2.5 && prog.etaHours === 4, `${prog.rate}/${prog.etaHours}`);
  check('visionProgress next enrich cron computed', prog.nextCron === '2026-07-10T12:10:00.000Z', prog.nextCron);
  check('visionProgress worker idle when last enrich is stale', prog.worker === 'idle', prog.worker);

  const running = await visionProgress(
    stubCtx({
      opsStore: {
        async list({ origin, limit } = {}) {
          const rows = [{ action: 'cron:enrich', origin: 'cron', ts: '2026-07-10T11:59:30Z', ok: 1, elapsed_ms: 100, detail: '{}' }];
          return (origin ? rows.filter((r) => r.origin === origin) : rows).slice(0, limit || 50);
        },
      },
    }),
    { now: NOW },
  );
  check('visionProgress worker running on a <2min enrich row', running.worker === 'running');

  const q = await queueSnapshot(stubCtx(), { now: NOW });
  check('queueSnapshot vision + resolution + deferred sum', q.vision.queued === 10 && q.resolution.minted === 80 && q.resolution.deferred === 6, JSON.stringify(q.resolution));

  const cm = await cronMonitor(stubCtx(), { now: NOW });
  check('cronMonitor covers every schedule with a parsed last detail', cm.crons.length === 3 && cm.crons.find((c) => c.name === 'enrich').last.detail.enriched === 30);
  check('cronMonitor next fire for enrich', cm.crons.find((c) => c.name === 'enrich').nextRun === '2026-07-10T12:10:00.000Z');
  console.log('vision progress + queue + cron ✅');
}

// --- Operations Center: Pipeline Health + Diagnostics (§6,§7) -------------------
{
  const ctx = await buildFixture();
  ctx.crons = { ...ctx.crons, enrich: '10,30,50 * * * *' };
  ctx.enrichStore = {
    async coverage() { return { withCrop: 50, attempted: 40, enriched: 35, servable: 30, declined: 5, remaining: 10, coverage: 80 }; },
    async verdictCounts() { return { minted: 80, unresolved: 5, declined: 3, low_corroboration: 2, too_few_tokens: 1, or_deal: 0 }; },
    async countDebris() { return 10; },
  };
  ctx.registryStore = { async stats() { return { products: { active: 20, dormant: 3, merged: 2, flagged: 1, assortments: 0 }, bands: { auto: 50, review: 10, created: 20 } }; } };
  ctx.offerStore.oldestUnenrichedAge = async () => '2026-07-10T09:00:00Z';
  await ctx.opsStore.record({ ts: '2026-07-10T06:00:00Z', action: 'cron:fanout', origin: 'cron', ok: true, elapsed_ms: 9000 });
  await ctx.opsStore.record({ ts: '2026-07-10T11:50:00Z', action: 'cron:enrich', origin: 'cron', ok: true, elapsed_ms: 4200 });

  const ph = await pipelineHealth(ctx, { now: NOW });
  check('pipelineHealth emits the 7 stages in order', ph.stages.map((s) => s.name).join(',') === 'OCR,Vision,Resolve,Registry,Sightings,Price History,Search', ph.stages.map((s) => s.name).join(','));
  check('Vision stage reflects the backlog as warn', ph.stages.find((s) => s.name === 'Vision').status === 'warn');
  check('Registry stage warns on a flagged product', ph.stages.find((s) => s.name === 'Registry').status === 'warn');

  const ls = await latencyStats(ctx, { now: NOW });
  // ingest group = delta's ok ingest (900) + the cron:fanout (9000) -> 4950.
  check('latencyStats: D1 probe + ingest latency + queue age', typeof ls.probes.d1 === 'number' && ls.latency.ingest === 4950 && ls.queueAgeMs === 3 * 3600000, `${ls.latency.ingest}/${ls.queueAgeMs}`);
  check('latencyStats names the 3 un-instrumented metrics', ls.notInstrumented.length === 3);
  console.log('pipeline health + diagnostics ✅');
}

if (failures) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
}
console.log('\nAll ops status tests passed.');
