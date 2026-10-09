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
//
// Running out of invocations while the durable job is still advancing is NOT a
// failure: the job is persisted and the */2 brochureResume cron owns its
// completion (the dashboard shows it as PUBLISHING, and as FAIL once it stops
// moving for PUBLICATION_PROGRESS_MAX_GAP_MS). The loop hands the store off
// instead of throwing. That was the "did not complete within 2 invocations"
// Run All error of 2026-09-30: 18 targets split 48 calls into 2 each, while
// one invocation advances one flyer by <= 20 downloaded or 8 re-verified
// pages — an unchanged 137-page flyer alone needs ~18. Only a child failure or
// a hop that makes no progress fails the store.
//
// `budget` ({ remaining }) is optional and SHARED by every store of one
// operation, so stores that finish early leave their calls to the big ones.
// The first dispatch always runs (it is what seeds the durable job).
export async function runStoreToPublication(
  store,
  dispatchInitial,
  dispatchResume = dispatchInitial,
  { maxInvocations = 48, budget = null } = {},
) {
  const reports = [];
  let previousProgress = null;

  for (let invocation = 1; invocation <= maxInvocations; invocation += 1) {
    if (budget) {
      if (invocation > 1 && budget.remaining <= 0) break;
      budget.remaining -= 1;
    }
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
      return { ...report, publication: publicationSummary(reports, { complete: true }) };
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

  const last = reports[reports.length - 1];
  return {
    ...last,
    publication: publicationSummary(reports, {
      complete: false,
      handedOff: true,
      flyerRef: last?.resumable?.flyerRef || null,
      nextPage: last?.resumable?.nextPage ?? null,
    }),
  };
}

function publicationSummary(reports, fields) {
  return {
    ...fields,
    invocations: reports.length,
    pageBatches: reports.filter((item) => item?.resumable?.batch).length,
    pagesCollected: reports.reduce(
      (sum, item) => sum + Number(item?.resumable?.pagesCollected || 0),
      0,
    ),
  };
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
//
// Unattended drains used ONE offer per SELF child because crop base64,
// extraction validation, identity building and the Stage-2 R2/D1 commit
// crossed the Workers FREE CPU limit (10 ms) when grouped. On Workers Paid
// (2026-09-30: 30 s default, 5 min configured in wrangler.toml [limits]) a
// child takes FOUR, so a fire covers 112 offers instead of 28. (Until
// 2026-10-08 the candidate queries still clamped to 50, so a fire read 50;
// the cron fires now also run their children in parallel lanes —
// runDrainLanes below.) Twenty-eight children still leave headroom
// below the service-binding limit of 32 invocations for the coordinator and a
// detached resolution child.
export const CPU_SAFE_BACKGROUND_DRAIN = Object.freeze({
  batchSize: 4,
  maxBatches: 28,
});

// A normal Stage 1 batch always runs Registry resolution immediately. When the
// Vision queue is empty, resolution is only a repair safety net (for example a
// manually reopened verdict), not new ingestion work. Keep that repair
// behavior once/day instead of repeating its current-offer join 72 times/day.
export function isDailyEmptyResolutionTick(scheduledTime) {
  const at = new Date(scheduledTime);
  return Number.isFinite(at.getTime()) && at.getUTCHours() === 0 && at.getUTCMinutes() === 10;
}

export async function runEnrichDrain(
  dispatchBatch,
  { pending = 0, batchSize = 15, maxBatches = 4, candidateIds = null, shouldContinue = null } = {},
) {
  const startedAt = new Date().toISOString();
  const size = Math.max(1, Number(batchSize) || 15);
  const cap = Math.max(0, Number(maxBatches) || 0);
  const selected = Array.isArray(candidateIds)
    ? [...new Set(candidateIds.map(String).filter(Boolean))].slice(0, size * cap)
    : null;
  const work = selected
    ? Array.from({ length: Math.ceil(selected.length / size) }, (_, index) => selected.slice(index * size, (index + 1) * size))
    : Array.from({ length: Math.min(cap, Math.ceil((Number(pending) || 0) / size)) }, () => size);
  const lines = [];
  for (const batch of work) {
    if (shouldContinue && !(await shouldContinue())) break;
    try {
      const result = await dispatchBatch(batch);
      if (Number(result?.failed) > 0) {
        // /enrich returns a diagnostic report as HTTP 200 even when Mistral
        // rejected the offer. Honor the scheduler's stop-on-failed-child
        // contract instead of fanning that rejection through all 28 SELF
        // children.
        lines.push({
          ok: false,
          error: result?.errors?.[0] || 'Mistral enrichment failed',
          result,
        });
        break;
      }
      lines.push({ ok: true, result });
    } catch (err) {
      lines.push({ ok: false, error: err?.message || String(err) });
      break;
    }
  }
  const providerFailure = lines.find((line) => !line.ok && line.result?.providerLimit);
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    pending,
    batches: lines.length,
    ok: lines.filter((l) => l.ok).length,
    failed: lines.filter((l) => !l.ok).length,
    enriched: lines.reduce((n, l) => n + (l.ok && l.result ? l.result.enriched || 0 : 0), 0),
    providerLimit: providerFailure?.result?.providerLimit || null,
    providerError: providerFailure?.result?.providerError || null,
    lines,
  };
}

// A SELF child that never answers must not hold its lane (2026-10-09). The
// drain lanes awaited children with no bound, so one hung child held the
// coordinator — and with it the 15-minute Vision lease — until the cron
// invocation was killed at its wall-time limit: no `cron:enrich` row, lease
// left to expire, the next fires skipped. A child is now given
// SELF_CHILD_TIMEOUT_MS; past it the lane stops like any failed child, and the
// coordinator records its run and releases the lease. 8 min of dispatching
// (DRAIN_DISPATCH_WINDOW_MS) + 5 min for the last child stays under the
// 15-minute cron limit. The offers of an abandoned child are simply still
// unread (or still claimed, for Stage 2) and are picked up by a later fire.
export const SELF_CHILD_TIMEOUT_MS = 5 * 60 * 1000;

export async function fetchSelfChild(self, url, init, { timeoutMs = SELF_CHILD_TIMEOUT_MS, label = 'child' } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // Reject BEFORE aborting: abort() rejects the fetch synchronously, and
      // the race must settle on the timeout, not on a bare AbortError.
      const err = new Error(`${label} -> no answer after ${Math.round(timeoutMs / 1000)} s`);
      err.timeout = true;
      reject(err);
      controller?.abort();
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      self.fetch(url, controller ? { ...init, signal: controller.signal } : init),
      expired,
    ]);
    const body = await Promise.race([res.json().catch(() => ({})), expired]);
    return { res, body };
  } finally {
    clearTimeout(timer);
  }
}

export function createEnrichDispatcher({
  self,
  ingestSecret,
  origin = 'https://brochure-engine.internal',
  tag,
  childTimeoutMs = SELF_CHILD_TIMEOUT_MS,
} = {}) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding (env.SELF) is required for the enrich dispatcher');
  }
  return async function dispatchBatch(limitOrIds) {
    const query = Array.isArray(limitOrIds)
      ? `ids=${encodeURIComponent(limitOrIds.join(','))}`
      : `limit=${encodeURIComponent(limitOrIds)}`;
    const { res, body } = await fetchSelfChild(self, `${origin}/enrich?${query}`, {
      method: 'POST',
      // `tag: 'ops'` marks operator-triggered children so their audit rows
      // say origin ops, not cron (engine.js /enrich reads X-Ops-Origin).
      headers: { 'X-Ingest-Secret': ingestSecret || '', ...(tag ? { 'X-Ops-Origin': tag } : {}) },
    }, { timeoutMs: childTimeoutMs, label: 'enrich drain' });
    if (!res.ok) {
      const err = new Error(`enrich drain -> HTTP ${res.status}`);
      err.body = body;
      throw err;
    }
    return body;
  };
}

// Durable round worker. Unlike the legacy ad-hoc check route, ids here are
// watch_run ids carrying a lease token in D1; replaying the dispatch is safe.
export function createWatchRunDispatcher({ self, ingestSecret, origin = 'https://brochure-engine.internal' }) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding is required for the watch-run dispatcher');
  }
  return async function dispatchRuns(ids) {
    const res = await self.fetch(`${origin}/watches/run?ids=${encodeURIComponent(ids.join(','))}`, {
      method: 'POST',
      headers: { 'X-Ingest-Secret': ingestSecret || '' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`watch runs ${ids.join(',')} -> HTTP ${res.status}`);
      err.body = body;
      throw err;
    }
    return body;
  };
}

// Stage-two copies of the stage-one live/background drain. Keep the pacing,
// batch sizing, sequential children, stop-on-failure behavior, and report
// contract aligned with runEnrichDrain/createEnrichDispatcher.
export async function runVisionVerificationDrain(
  dispatchBatch,
  { pending = 0, batchSize = 15, maxBatches = 4, candidateIds = null, shouldContinue = null } = {},
) {
  const startedAt = new Date().toISOString();
  const size = Math.max(1, Number(batchSize) || 15);
  const cap = Math.max(0, Number(maxBatches) || 0);
  const selected = Array.isArray(candidateIds)
    ? [...new Set(candidateIds.map(String).filter(Boolean))].slice(0, size * cap)
    : null;
  const work = selected
    ? Array.from({ length: Math.ceil(selected.length / size) }, (_, index) => selected.slice(index * size, (index + 1) * size))
    : Array.from({ length: Math.min(cap, Math.ceil((Number(pending) || 0) / size)) }, () => size);
  const lines = [];
  for (const batch of work) {
    if (shouldContinue && !(await shouldContinue())) break;
    try {
      const result = await dispatchBatch(batch);
      if (Number(result?.failed) > 0) {
        lines.push({
          ok: false,
          error: result?.errors?.[0] || 'Mistral verification failed',
          result,
        });
        break;
      }
      lines.push({ ok: true, result });
    } catch (err) {
      lines.push({ ok: false, error: err?.message || String(err) });
      break;
    }
  }
  const providerFailure = lines.find((line) => !line.ok && line.result?.providerLimit);
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    pending,
    batches: lines.length,
    ok: lines.filter((l) => l.ok).length,
    failed: lines.filter((l) => !l.ok).length,
    enriched: lines.reduce((n, l) => n + (l.ok && l.result ? l.result.verified || 0 : 0), 0),
    verified: lines.reduce((n, l) => n + (l.ok && l.result ? l.result.verified || 0 : 0), 0),
    unmatched: lines.reduce((n, l) => n + (l.ok && l.result ? l.result.unmatched || 0 : 0), 0),
    providerLimit: providerFailure?.result?.providerLimit || null,
    providerError: providerFailure?.result?.providerError || null,
    lines,
  };
}

// Parallel lanes (2026-10-08). A fire's children ran strictly one after
// another, so Vision throughput was bound by response time (~5-13 s a read),
// not by Mistral's window: 50 reads per 20-minute fire used ~5% of the two
// keys' 60 requests/minute while 5,919 current offers sat unread. Lanes split
// ONE fire's candidates into concurrent sequential drains (`drain` is
// runEnrichDrain or runVisionVerificationDrain). Batches are dealt
// round-robin, so every lane starts with the soonest-expiring offers and the
// expiry-first order survives. The child count is unchanged (still at most
// maxBatches, under the 32-invocation service-binding limit); only the
// concurrency is new. Each lane keeps the stop-on-failed-child contract: a
// lane that meets a spent minute window stops, its offers stay unread for the
// next fire, and the other lanes carry on. `deadlineMs` stops dispatching new
// children so a fire ends before the next one is due.
export async function runDrainLanes(drain, dispatchBatch, {
  lanes = 1,
  candidateIds = [],
  batchSize = 15,
  maxBatches = 4,
  deadlineMs = null,
  shouldContinue = null,
  now = () => Date.now(),
} = {}) {
  const startedAt = new Date().toISOString();
  const size = Math.max(1, Number(batchSize) || 15);
  const cap = Math.max(0, Number(maxBatches) || 0);
  const selected = [...new Set((candidateIds || []).map(String).filter(Boolean))].slice(0, size * cap);
  const batches = Array.from(
    { length: Math.ceil(selected.length / size) },
    (_, index) => selected.slice(index * size, (index + 1) * size),
  );
  const count = Math.max(1, Math.min(Math.floor(Number(lanes)) || 1, batches.length || 1));
  const shards = Array.from({ length: count }, () => []);
  batches.forEach((batch, index) => shards[index % count].push(...batch));
  const stopAt = deadlineMs == null ? null : now() + Number(deadlineMs);
  const keepGoing = async () => (stopAt == null || now() < stopAt)
    && (!shouldContinue || await shouldContinue());
  const reports = await Promise.all(shards.map((ids) => drain(dispatchBatch, {
    pending: ids.length,
    candidateIds: ids,
    batchSize: size,
    maxBatches: Math.ceil(ids.length / size),
    shouldContinue: keepGoing,
  })));
  const sum = (field) => reports.reduce((n, report) => n + (Number(report[field]) || 0), 0);
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    pending: selected.length,
    lanes: count,
    batches: sum('batches'),
    ok: sum('ok'),
    failed: sum('failed'),
    enriched: sum('enriched'),
    verified: sum('verified'),
    unmatched: sum('unmatched'),
    providerLimit: reports.find((report) => report.providerLimit)?.providerLimit || null,
    providerError: reports.find((report) => report.providerError)?.providerError || null,
    lines: reports.flatMap((report) => report.lines || []),
  };
}

export function createVisionVerificationDispatcher({
  self,
  ingestSecret,
  origin = 'https://brochure-engine.internal',
  tag,
  childTimeoutMs = SELF_CHILD_TIMEOUT_MS,
} = {}) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding is required for the vision verification dispatcher');
  }
  return async function dispatchBatch(limitOrIds) {
    const query = Array.isArray(limitOrIds)
      ? `ids=${encodeURIComponent(limitOrIds.join(','))}`
      : `limit=${encodeURIComponent(limitOrIds)}`;
    const { res, body } = await fetchSelfChild(self, `${origin}/vision-verification?${query}`, {
      method: 'POST',
      headers: { 'X-Ingest-Secret': ingestSecret || '', ...(tag ? { 'X-Ops-Origin': tag } : {}) },
    }, { timeoutMs: childTimeoutMs, label: 'vision verification drain' });
    if (!res.ok) {
      const err = new Error(`vision verification drain -> HTTP ${res.status}`);
      err.body = body;
      throw err;
    }
    return body;
  };
}

// Registry resolution is deliberately dispatched as a sibling SELF child.
// Running it directly in a drain coordinator makes its CPU part of the cron
// invocation that already coordinated Vision children, recreating the original
// enrichment+resolution resource-limit failure.
export function createResolutionDispatcher({
  self,
  ingestSecret,
  origin = 'https://brochure-engine.internal',
  tag,
} = {}) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding is required for the resolution dispatcher');
  }
  return async function dispatchResolution(limit) {
    const { res, body } = await fetchSelfChild(self, `${origin}/resolve?limit=${encodeURIComponent(limit)}`, {
      method: 'POST',
      headers: { 'X-Ingest-Secret': ingestSecret || '', ...(tag ? { 'X-Ops-Origin': tag } : {}) },
    }, { label: 'resolution drain' });
    if (!res.ok) {
      const err = new Error(`resolution drain -> HTTP ${res.status}`);
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

// A minute-tick price lane starts no new item after this long, so it ends
// before the next tick that drains the same shards (see priceFallbackLanes).
export const PRICE_FALLBACK_LANE_DEADLINE_MS = 35 * 1000;

// The shards one minute tick drains: `lanes` disjoint shards of 2 x lanes,
// alternating halves on even and odd minutes. A lane that runs past its minute
// (one mid-item wait for the next Mistral window) never shares items with the
// next tick's lanes; the same shards come back two ticks later.
export function priceFallbackLanes(lanes, minute) {
  const base = (minute % 2) * lanes;
  return Array.from({ length: lanes }, (_, i) => ({ shard: base + i, shards: lanes * 2 }));
}

// Vision price fallback child (engine.js POST /price-fallback).
export function createPriceFallbackDispatcher({ self, ingestSecret, origin = 'https://brochure-engine.internal' } = {}) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding (env.SELF) is required for the price fallback dispatcher');
  }
  return async function dispatchBatch(limit, { shard = null, shards = null, deadlineMs = null } = {}) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (shards > 1) {
      params.set('shard', String(shard));
      params.set('shards', String(shards));
    }
    if (deadlineMs) params.set('deadlineMs', String(deadlineMs));
    const res = await self.fetch(`${origin}/price-fallback?${params}`, {
      method: 'POST',
      headers: { 'X-Ingest-Secret': ingestSecret || '' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`price fallback drain -> HTTP ${res.status}`);
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
