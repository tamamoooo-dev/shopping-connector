// storage/visionJobStore.test.mjs — the Background Manual Vision job store, with
// focus on the single-writer LEASE (tryLease CAS) the 1-minute `visionDrain` cron
// relies on: only one fire drains at a time, and a live lease blocks concurrent
// fires while an expired/absent one lets the next fire in. A tiny in-memory D1
// fake honors the exact SQL the store issues. Run:
//   node src/storage/visionJobStore.test.mjs
import { createD1VisionJobStore } from './visionJobStore.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else { failures += 1; console.error(`FAIL  ${label}`); }
}

// One-row vision_jobs fake, honoring the store's statements in specificity order.
function fakeDb() {
  let row = null;
  return {
    prepare(sql) {
      let b = [];
      const stmt = {
        bind(...args) { b = args; return stmt; },
        async run() {
          if (/INSERT OR REPLACE INTO vision_jobs/.test(sql)) {
            const [id, scope, total, remaining, started, updated, origin] = b;
            row = { id, status: 'running', scope, total, processed: 0, enriched: 0, declined: 0, failed: 0, remaining, hops: 0, started_at: started, updated_at: updated, finished_at: null, last_error: null, provider_limit: null, origin, lease_until: null };
            return { meta: { changes: 1 } };
          }
          if (/INSERT INTO vision_jobs/.test(sql)) {
            const [id, scope, started, updated, origin] = b;
            if (!row) {
              row = { id, status: 'running', scope, total: 0, processed: 0, enriched: 0, declined: 0, failed: 0, remaining: 0, hops: 0, started_at: started, updated_at: updated, finished_at: null, last_error: null, provider_limit: null, origin, lease_until: null };
            } else if (row.id === id && row.status !== 'running') {
              row = { ...row, status: 'running', scope, updated_at: updated, finished_at: null, origin, lease_until: null };
            }
            return { meta: { changes: 1 } };
          }
          // Heartbeat renewal: CAS on the value the renewing store last wrote.
          if (/SET lease_until = \? WHERE id = \? AND lease_until = \?/.test(sql)) {
            const [until, id, held] = b;
            if (row && row.id === id && row.lease_until === held) {
              row.lease_until = until;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          // Lease CAS — MUST be tested before the generic SET update.
          if (/SET lease_until = \?\s+WHERE id = \? AND status = 'running'/.test(sql)) {
            const [until, id, now] = b;
            if (row && row.id === id && row.status === 'running' && (row.lease_until == null || row.lease_until < now)) {
              row.lease_until = until;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          }
          if (/SET status = 'stopped'/.test(sql)) {
            const [updated, finished, id] = b;
            if (row && row.id === id && row.status === 'running') { row = { ...row, status: 'stopped', updated_at: updated, finished_at: finished }; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          if (/^\s*UPDATE vision_jobs SET/.test(sql)) {
            const setPart = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'));
            const setCols = setPart.split(',').map((s) => s.trim().split('=')[0].trim());
            const id = b[b.length - 1];
            if (row && row.id === id) setCols.forEach((c, i) => { row[c] = b[i]; });
            return { meta: { changes: row ? 1 : 0 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() { return row ? { ...row } : null; },
      };
      return stmt;
    },
  };
}

{
  const store = createD1VisionJobStore(fakeDb(), { id: 'recovery' });
  await store.ensureRunning({ scope: 'recovery' });
  check('a named coordinator row can be armed without a new table',
    (await store.get()).id === 'recovery' && (await store.get()).status === 'running');
  check('the named row uses the same single-writer lease',
    await store.tryLease({ nowMs: 2_000_000, leaseMs: 120000 }));
  await store.ensureRunning({ scope: 'recovery' });
  check('ensureRunning preserves a live lease instead of resetting it',
    (await store.get()).lease_until != null);
}

console.log('visionJobStore lease (single-writer):');
{
  const store = createD1VisionJobStore(fakeDb());
  await store.start({ scope: 'all', total: 100 });
  check('start arms a running job with no lease', (await store.get()).status === 'running' && (await store.get()).lease_until === null);

  const t0 = 1_000_000;
  check('first fire acquires the lease', (await store.tryLease({ nowMs: t0, leaseMs: 120000 })) === true);
  check('a concurrent fire is refused while the lease is live', (await store.tryLease({ nowMs: t0 + 1000, leaseMs: 120000 })) === false);

  await store.update({ lease_until: null }); // a completed fire releases the lease
  check('released lease -> the next fire acquires it', (await store.tryLease({ nowMs: t0 + 2000, leaseMs: 120000 })) === true);

  check('an EXPIRED lease -> the next fire acquires it', (await store.tryLease({ nowMs: t0 + 500000, leaseMs: 120000 })) === true);

  await store.stop();
  check('a stopped job refuses the lease (no drain writer)', (await store.tryLease({ nowMs: t0 + 600000, leaseMs: 120000 })) === false && (await store.get()).status === 'stopped');
}

console.log('visionJobStore lease heartbeat (renewLease):');
{
  const db = fakeDb();
  const hop = createD1VisionJobStore(db);
  await hop.start({ scope: 'all', total: 100 });
  const t0 = 1_000_000;
  check('a store that never leased cannot renew', (await hop.renewLease({ nowMs: t0, leaseMs: 240000 })) === false);

  await hop.tryLease({ nowMs: t0, leaseMs: 240000 });
  check('the holder extends its own lease',
    (await hop.renewLease({ nowMs: t0 + 60000, leaseMs: 240000 })) === true
      && (await hop.get()).lease_until === new Date(t0 + 300000).toISOString());
  check('a renewed lease still blocks another fire',
    (await createD1VisionJobStore(db).tryLease({ nowMs: t0 + 200000, leaseMs: 240000 })) === false);

  // The holder died: no renewal, the lease lapses, the next hop takes it.
  const next = createD1VisionJobStore(db);
  check('a lapsed lease is taken by the next hop',
    (await next.tryLease({ nowMs: t0 + 400000, leaseMs: 240000 })) === true);
  check('the old holder cannot extend the new holder\'s lease',
    (await hop.renewLease({ nowMs: t0 + 410000, leaseMs: 240000 })) === false
      && (await hop.get()).lease_until === new Date(t0 + 640000).toISOString());

  await next.update({ lease_until: null }); // the hop hands off
  check('a released lease is not revived by a late beat',
    (await next.renewLease({ nowMs: t0 + 420000, leaseMs: 240000 })) === false
      && (await next.get()).lease_until === null);
}

if (failures) { console.error(`\n${failures} FAILURE(S)`); process.exit(1); }
console.log('\nAll visionJobStore tests passed.');
