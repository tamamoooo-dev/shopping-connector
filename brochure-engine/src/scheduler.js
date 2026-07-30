// scheduler.js — the M3 scheduler / fan-out layer (Architecture C).
//
// WHY THIS EXISTS
// The M2 cron refreshed ONE store per fire (stale-first rotation) to stay inside
// the Workers Free plan's 50-external-subrequest per-INVOCATION budget: an
// image-set store pulls ~45 subrequests, so ingesting all 8 stores in a single
// invocation overflows it. That rotation spread the 8 stores across ~8 days —
// unacceptable, because Saudi brochures drop on a single publication day
// (Tue/Wed) and every store must refresh together, not staggered.
//
// ARCHITECTURE C — Self Service-Binding Fan-out (approved 2026-07-02)
// The scheduled() handler fans one cron fire out into N INDEPENDENT Worker
// invocations, one per store, via a SELF service binding. Each child invocation
// runs the existing single-store ingest (POST /ingest?store=<id>, ~45
// subrequests) and gets its OWN fresh 50-subrequest budget — so all stores
// refresh in the same minute, on the Free plan, with per-store isolation. The
// coordinator itself makes only N service-binding calls (8 << 50) and touches no
// storage, so it stays trivially inside its own budget and CPU.
//
// REPLACEABILITY (a hard requirement of M3)
// The fan-out MECHANISM is isolated behind a single `dispatchStore(storeId)`
// function. `runFanOut` — the store-agnostic "refresh every registered store
// concurrently" policy — never learns HOW a store is dispatched. Migrating to
// another Cloudflare-native scheduler (e.g. a Queue producer + consumer) is a
// swap of the dispatcher factory below; runFanOut, the collectors, the pipeline,
// storage, and the Core stay byte-for-byte unchanged.

// Fan out to EVERY registered store concurrently — one dispatch per store — and
// return a per-store settlement report. Store-agnostic: it reasons purely over
// the registry keys, so adding/removing a provider needs no scheduler change.
// `dispatchStore(storeId) -> Promise<any>` is the replaceable mechanism; a
// rejection for one store never blocks the others (Promise.allSettled).
export async function runFanOut(registry, dispatchStore) {
  const stores = Object.keys(registry);
  const startedAt = new Date().toISOString();
  const settled = await Promise.allSettled(stores.map((store) => dispatchStore(store)));
  const perStore = stores.map((store, i) => {
    const r = settled[i];
    return r.status === 'fulfilled'
      ? { store, ok: true, result: r.value }
      : { store, ok: false, error: r.reason?.message || String(r.reason) };
  });
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    dispatched: stores.length,
    ok: perStore.filter((s) => s.ok).length,
    failed: perStore.filter((s) => !s.ok).length,
    stores: perStore,
  };
}

// A manual store run is a synchronous operator contract: when it returns, each
// targeted store's newly discovered brochure must either be published or the
// operation must fail loudly. D4D collection became resumable in 2026-07,
// so one /ingest child now advances at most 20 pages and may return
// `storeComplete:false`. Keep dispatching fresh SELF-bound children (each with
// its own external-subrequest budget) until the publication boundary has been
// crossed. The normal all-store cron remains one-batch fan-out; its durable
// queue is advanced by the */2 resume cron.
//
// 48 invocations is a runaway guard and covers up to 960 newly downloaded
// pages at the production batch size. SELF calls are internal-service
// subrequests, so they do not consume the Free plan's 50 external-request
// allowance (the current internal-service allowance is much higher).
export async function runStoreToPublication(
  store,
  dispatchInitial,
  dispatchResume = dispatchInitial,
  { maxInvocations = 48 } = {},
) {
  const reports = [];
  let previousProgress = null;

  for (let invocation = 1; invocation <= maxInvocations; invocation += 1) {
    const report = await (invocation === 1 ? dispatchInitial : dispatchResume)(store);
    reports.push(report);

    const failed = Number(report?.totals?.failed || 0);
    if (failed > 0) {
      const detail =
        report?.targets?.flatMap((target) => target.errors || []).find(Boolean) ||
        report?.resumable?.error ||
        `ingest reported ${failed} failed target(s)`;
      throw new Error(`brochure publication ${store} failed: ${detail}`);
    }

    const resumable = report?.resumable;
    if (!resumable || resumable.storeComplete === true) {
      return {
        ...report,
        publication: {
          complete: true,
          invocations: reports.length,
          pageBatches: reports.filter((item) => item?.resumable?.batch).length,
          pagesCollected: reports.reduce(
            (sum, item) => sum + Number(item?.resumable?.pagesCollected || 0),
            0,
          ),
        },
      };
    }

    const progress = JSON.stringify([
      resumable.flyerRef || null,
      resumable.nextPage ?? null,
      resumable.brochuresCompleted ?? null,
      resumable.complete === true,
    ]);
    if (progress === previousProgress) {
      throw new Error(
        `brochure publication ${store} made no progress at flyer ${resumable.flyerRef || 'unknown'} ` +
        `(next page ${resumable.nextPage ?? 'unknown'})`,
      );
    }
    previousProgress = progress;
  }

  throw new Error(
    `brochure publication ${store} did not complete within ${maxInvocations} invocations`,
  );
}

// The DEFAULT fan-out mechanism: a SELF service binding (Architecture C).
// Each call triggers a fresh invocation of THIS Worker's fetch handler at
// POST /ingest?store=<id>, guarded by the ingest secret — reusing the existing,
// already budget-safe single-store ingest path with ZERO change to it. The bound
// hostname is irrelevant (service-binding requests route straight to the Worker,
// never over the Internet), so `origin` is a stable placeholder.
//
// To migrate the scheduler later, write a sibling factory (e.g.
// `createQueueDispatcher({ queue })` whose dispatchStore does `queue.send({ store })`)
// and pass it to runFanOut instead. Nothing else in the engine changes.
// Optional knobs (both default off, so the cron path is byte-for-byte the same):
//   mode  'offers' | 'brochures' — the child runs only that half of the ingest
//         (engine.js /ingest `mode` param). The Ops Console's "Offers Only" /
//         "Brochures Only" all-stores operations ride the SAME fan-out this way.
//   tag   stamps X-Ops-Origin on the child request so its audit row records who
//         triggered it ('ops' for console operations; absent = 'cron').
export function createServiceBindingDispatcher({
  self,
  ingestSecret,
  origin = 'https://brochure-engine.internal',
  mode = '',
  tag = '',
  returnReport = false,
}) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding (env.SELF) is required for the fan-out dispatcher');
  }
  return async function dispatchStore(store) {
    const qs = `store=${encodeURIComponent(store)}` + (mode ? `&mode=${encodeURIComponent(mode)}` : '');
    const res = await self.fetch(`${origin}/ingest?${qs}`, {
      method: 'POST',
      headers: { 'X-Ingest-Secret': ingestSecret || '', ...(tag ? { 'X-Ops-Origin': tag } : {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`ingest ${store} -> HTTP ${res.status}`);
      err.body = body;
      throw err;
    }
    return returnReport ? body : body.totals || body;
  };
}

// --- Price Monitoring fan-out (the daily watch-check cron) ---------------------
// Same Architecture-C mechanism, different unit of work: the coordinator lists
// the active watches (a D1 read — no fetch subrequest), chunks their ids into
// small batches, and dispatches each batch to POST /watches/check?ids=… via the
// SELF binding. Each child invocation gets its own fresh 50-subrequest budget;
// a grocery watch sweeps ~7 stores, so a batch of 3 stays comfortably inside.
export async function runWatchFanOut(watchIds, dispatchBatch, { batchSize = 3 } = {}) {
  const startedAt = new Date().toISOString();
  const batches = [];
  for (let i = 0; i < watchIds.length; i += batchSize) {
    batches.push(watchIds.slice(i, i + batchSize));
  }
  const settled = await Promise.allSettled(batches.map((ids) => dispatchBatch(ids)));
  const perBatch = batches.map((ids, i) => {
    const r = settled[i];
    return r.status === 'fulfilled'
      ? { ids, ok: true, result: r.value }
      : { ids, ok: false, error: r.reason?.message || String(r.reason) };
  });
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    watches: watchIds.length,
    batches: batches.length,
    ok: perBatch.filter((b) => b.ok).length,
    failed: perBatch.filter((b) => !b.ok).length,
    alerted: perBatch.reduce((n, b) => n + (b.ok && b.result ? b.result.alerted || 0 : 0), 0),
    lines: perBatch,
  };
}

export function createWatchCheckDispatcher({ self, ingestSecret, origin = 'https://brochure-engine.internal' }) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding (env.SELF) is required for the watch-check dispatcher');
  }
  return async function dispatchBatch(ids) {
    const res = await self.fetch(`${origin}/watches/check?ids=${encodeURIComponent(ids.join(','))}`, {
      method: 'POST',
      headers: { 'X-Ingest-Secret': ingestSecret || '' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`watch check ${ids.join(',')} -> HTTP ${res.status}`);
      err.body = body;
      throw err;
    }
    return body;
  };
}

// --- Vision-enrichment drain (the daily cron's third duty) ---------------------
// Same Architecture-C mechanism, same shape as the watch fan-out — but the
// children run SEQUENTIALLY, on purpose: each child makes ~batchSize paced
// vision-API calls, and running children one at a time keeps the global call
// rate flat under the free tier's per-minute cap (concurrency here would
// recreate exactly the burst the drain exists to avoid). `pending` (a D1
// count, no subrequest) sizes the run; maxBatches bounds a big backlog to a
// few days of quiet drains rather than one hot one. A failed child aborts the
// rest — its cause (rate cap, key trouble) would fail them too, and the
// backlog simply carries to the next fire.
export async function runEnrichDrain(dispatchBatch, { pending = 0, batchSize = 15, maxBatches = 4 } = {}) {
  const startedAt = new Date().toISOString();
  const target = Math.min(Number(maxBatches) || 0, Math.ceil((Number(pending) || 0) / batchSize));
  const lines = [];
  for (let i = 0; i < target; i++) {
    try {
      lines.push({ ok: true, result: await dispatchBatch(batchSize) });
    } catch (err) {
      lines.push({ ok: false, error: err?.message || String(err) });
      break;
    }
  }
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    pending,
    batches: lines.length,
    ok: lines.filter((l) => l.ok).length,
    failed: lines.filter((l) => !l.ok).length,
    enriched: lines.reduce((n, l) => n + (l.ok && l.result ? l.result.enriched || 0 : 0), 0),
    lines,
  };
}

export function createEnrichDispatcher({ self, ingestSecret, origin = 'https://brochure-engine.internal', tag } = {}) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding (env.SELF) is required for the enrich dispatcher');
  }
  return async function dispatchBatch(limit) {
    const res = await self.fetch(`${origin}/enrich?limit=${encodeURIComponent(limit)}`, {
      method: 'POST',
      // `tag: 'ops'` marks operator-triggered children so their audit rows
      // say origin ops, not cron (engine.js /enrich reads X-Ops-Origin).
      headers: { 'X-Ingest-Secret': ingestSecret || '', ...(tag ? { 'X-Ops-Origin': tag } : {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`enrich drain -> HTTP ${res.status}`);
      err.body = body;
      throw err;
    }
    return body;
  };
}

export function createOcrEnrichDispatcher({ self, ingestSecret, origin = 'https://brochure-engine.internal' } = {}) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding (env.SELF) is required for the OCR enrich dispatcher');
  }
  return async function dispatchBatch(limit) {
    const res = await self.fetch(`${origin}/ocr-enrich?limit=${encodeURIComponent(limit)}`, {
      method: 'POST',
      headers: { 'X-Ingest-Secret': ingestSecret || '' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`ocr enrich drain -> HTTP ${res.status}`);
      err.body = body;
      throw err;
    }
    return body;
  };
}

// --- Recovery drain -----------------------------------------------------------
// Same durable fan-out shape as Background Vision. Each child receives its own
// Worker invocation and therefore its own external-subrequest budget; children
// stay sequential so Medium's request rate remains flat. A child that scans no
// work ends the fire early instead of issuing the remaining empty hops.
export async function runRecoveryDrainFanOut(
  dispatchBatch,
  { maxBatches = 4 } = {},
) {
  const startedAt = new Date().toISOString();
  const lines = [];
  for (let i = 0; i < Math.max(1, Number(maxBatches) || 1); i += 1) {
    try {
      const result = await dispatchBatch();
      lines.push({ ok: true, result });
      const runs = result?.runs || [];
      const scanned = runs.reduce((n, run) => n + Number(run.scanned || 0), 0);
      const stopped = result?.skipped
        || scanned === 0
        || runs.some((run) => run.providerLimit || run.failed > 0);
      if (stopped) break;
    } catch (err) {
      lines.push({ ok: false, error: err?.message || String(err) });
      break;
    }
  }
  const reports = lines.flatMap((line) => (line.ok ? line.result?.runs || [] : []));
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    batches: lines.length,
    ok: lines.filter((line) => line.ok).length,
    failed: lines.filter((line) => !line.ok).length
      + reports.reduce((n, run) => n + Number(run.failed || 0), 0),
    scanned: reports.reduce((n, run) => n + Number(run.scanned || 0), 0),
    attempted: reports.reduce((n, run) => n + Number(run.attempted || 0), 0),
    recovered: reports.reduce((n, run) => n + Number(run.recovered || 0), 0),
    reconciledAsIs: lines.reduce(
      (n, line) => n + Number(line.ok ? line.result?.reconciledAsIs?.resolved || 0 : 0),
      0,
    ),
    lines,
  };
}

export function createRecoveryDrainDispatcher({
  self,
  ingestSecret,
  origin = 'https://brochure-engine.internal',
} = {}) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding is required for the recovery dispatcher');
  }
  return async function dispatchRecoveryBatch() {
    const res = await self.fetch(`${origin}/recovery-drain`, {
      method: 'POST',
      headers: { 'X-Ingest-Secret': ingestSecret || '' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`recovery drain -> HTTP ${res.status}`);
      err.body = body;
      throw err;
    }
    return body;
  };
}
