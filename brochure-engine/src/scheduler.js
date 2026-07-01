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
export function createServiceBindingDispatcher({ self, ingestSecret, origin = 'https://brochure-engine.internal' }) {
  if (!self || typeof self.fetch !== 'function') {
    throw new Error('scheduler: a SELF service binding (env.SELF) is required for the fan-out dispatcher');
  }
  return async function dispatchStore(store) {
    const res = await self.fetch(`${origin}/ingest?store=${encodeURIComponent(store)}`, {
      method: 'POST',
      headers: { 'X-Ingest-Secret': ingestSecret || '' },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(`ingest ${store} -> HTTP ${res.status}`);
      err.body = body;
      throw err;
    }
    return body.totals || body;
  };
}
