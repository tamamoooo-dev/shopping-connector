// digest.test.mjs — the daily health digest's verdicts.
import assert from 'node:assert/strict';
import { composeDigest, gatherDigestInputs, isDigestTick, runDailyDigest } from './digest.js';
import { ntfyPushDisabled } from '../monitor.js';
import { createMemoryOpsStore } from '../storage/local.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };

ok(isDigestTick(Date.UTC(2026, 9, 9, 5, 0)), '05:00 UTC is the digest minute');
ok(!isDigestTick(Date.UTC(2026, 9, 9, 5, 1)) && !isDigestTick(Date.UTC(2026, 9, 9, 3, 0)), 'no other minute is');

const healthy = composeDigest({
  stores: [{ store: 'lulu', status: 'OK' }, { store: 'nesto', status: 'PUBLISHING' }],
  vision: { withCrop: 1000, served: 970, unread: 10, perHour: 300 },
  prices: { pending: 0, rejected: 12 },
  watches: { slot: '2026-10-09-AM', total: 7, completed: 7, incomplete: 0, open: 0 },
  keys: { usable: 2, retired: 3 },
});
ok(healthy.ok && healthy.title === 'Super Search: all healthy', 'a publishing store, retired spare keys and refused prices are not issues');
ok(healthy.body.includes('Vision: 97% served (970/1000)'), 'Vision coverage is shown as served/with-crop');

const sick = composeDigest({
  stores: [{ store: 'mkhazin', status: 'NO_FLYER' }, { store: 'grandhyper', status: 'FAIL', lastError: 'D4D has only expired flyers' }, { store: 'lulu', status: 'OK' }],
  vision: { withCrop: 14413, served: 6685, unread: 5919, perHour: 600 },
  prices: { pending: 40, rejected: 586 },
  watches: { slot: '2026-10-08-PM', total: 7, completed: 5, incomplete: 2, open: 0 },
  keys: { usable: 1, retired: 4 },
});
ok(!sick.ok && sick.problems.length === 4, 'stores, Vision, watches and keys are each one issue');
ok(sick.title === 'Super Search: 4 issue(s)', 'the title counts the issues');
ok(sick.body.includes('mkhazin: NO_FLYER') && sick.body.includes('grandhyper: FAIL (D4D has only expired flyers)'), 'each unhealthy store is named with its error');
ok(sick.body.includes('5919 unread, ~10 h to clear'), 'the unread backlog carries an ETA at the measured rate');
ok(/^[\x20-\x7e]*$/.test(sick.title), 'the title stays ASCII so ntfy can carry it in a header');

const sparse = composeDigest({ stores: [], vision: null, prices: null, watches: null, keys: null });
ok(sparse.ok && sparse.body.includes('Stores: all 0 OK'), 'missing inputs never invent problems');

// --- scheduler, retention, backup (2026-11-12) ---------------------------------
const quiet = composeDigest({
  stores: [{ store: 'lulu', status: 'OK' }],
  scheduler: { status: 'PASS', detail: 'last cron run 0.0h ago (price-fallback)' },
  retention: { ok: true, ageH: 2, error: null },
  backup: { id: '2026-11-08', done: true, ageDays: 4.2 },
});
ok(quiet.ok, 'a passing scheduler, yesterday\'s retention and this week\'s backup are not issues');
ok(!quiet.body.includes('Scheduler:'), 'a passing scheduler adds no line');
ok(quiet.body.includes('Retention: ran 2 h ago') && quiet.body.includes('Backup: last complete 2026-11-08 (4 d ago)'),
  'retention and backup are always reported');

const neglected = composeDigest({
  stores: [{ store: 'lulu', status: 'OK' }],
  scheduler: { status: 'FAIL', detail: 'pipeline missed its 2026-11-10 06:00Z fire' },
  retention: { ok: false, ageH: 2, error: 'ops: archive verification failed' },
  backup: { id: '2026-10-25', done: true, ageDays: 18 },
});
ok(neglected.problems.join('|') === 'scheduler|retention failed|backup overdue', 'each is one issue');
ok(neglected.body.includes('Scheduler: pipeline missed its 2026-11-10 06:00Z fire')
  && neglected.body.includes('Retention: failed (ops: archive verification failed)'), 'the reason is shown');

ok(composeDigest({ retention: { ok: true, ageH: 60 } }).problems[0] === 'retention not running',
  'a retention run older than two days is a missed run');
ok(composeDigest({ backup: { id: '2026-11-08', done: false, ageDays: 0.2 } }).ok, 'an export under way is not an issue');
ok(composeDigest({ backup: { id: '2026-11-08', done: false, ageDays: 3 } }).problems[0] === 'backup stuck',
  'an export still unfinished days later is');

// gatherDigestInputs reads them from the audit row and the export's state object.
{
  const opsStore = createMemoryOpsStore();
  const now = new Date('2026-11-12T05:00:00Z');
  await opsStore.record({ ts: '2026-11-12T03:00:00.000Z', action: 'cron:retention', origin: 'cron', ok: true });
  const objects = new Map([['backups/d1/active.json', { id: '2026-11-08', done: true }]]);
  const objectStore = {
    async get(key) {
      return objects.has(key) ? { bytes: new TextEncoder().encode(JSON.stringify(objects.get(key))) } : null;
    },
  };
  const inputs = await gatherDigestInputs({ opsStore, objectStore }, { now });
  ok(inputs.retention.ok && inputs.retention.ageH === 2, 'retention comes from the newest cron:retention row');
  ok(inputs.backup.done && inputs.backup.id === '2026-11-08' && Math.floor(inputs.backup.ageDays) === 4,
    'backup comes from backups/d1/active.json');
  ok(inputs.scheduler.status === 'PASS', 'the scheduler check is the console\'s own');
  const bare = await gatherDigestInputs({ opsStore: createMemoryOpsStore(), objectStore: { async get() { return null; } } }, { now });
  ok(bare.retention === null && bare.backup === null, 'no row and no export state: not judged');
}

// --- push off (2026-10-09): the digest is recorded, never pushed ----------------
ok(ntfyPushDisabled({ NTFY_PUSH: 'off' }) && ntfyPushDisabled({ NTFY_PUSH: ' OFF ' }) && ntfyPushDisabled({ NTFY_PUSH: 'false' }),
  'NTFY_PUSH off/false switches push off');
ok(!ntfyPushDisabled({}) && !ntfyPushDisabled({ NTFY_PUSH: 'on' }), 'absent or on keeps push');

{
  const opsStore = createMemoryOpsStore();
  const at = new Date(Date.UTC(2026, 9, 9, 5, 0));
  const ran = await runDailyDigest({ opsStore, notifier: null, pushDisabled: true }, { now: at });
  const [row] = await opsStore.list({ action: 'cron:digest', limit: 1 });
  ok(ran.push === 'disabled' && !ran.pushed, 'push off: nothing is sent');
  ok(row && row.ok && row.origin === 'cron', 'push off: the digest is still recorded as cron:digest');
  const detail = JSON.parse(row.detail);
  ok(detail.title === ran.title && detail.body === ran.body && detail.push === 'disabled',
    'the recorded row carries the full digest');
}
{
  const opsStore = createMemoryOpsStore();
  const sent = [];
  const ran = await runDailyDigest({ opsStore, notifier: { async send(p) { sent.push(p); } } }, { now: new Date() });
  ok(ran.pushed && sent.length === 1 && sent[0].title === ran.title, 'push on: one push, the same digest');
  const failing = createMemoryOpsStore();
  const broken = await runDailyDigest({ opsStore: failing, notifier: { async send() { throw new Error('ntfy 503'); } } }, { now: new Date() });
  const [row] = await failing.list({ action: 'cron:digest', limit: 1 });
  ok(!broken.pushed && row && !row.ok && /ntfy 503/.test(row.error), 'a failed push is recorded as a failed run, not lost');
}

console.log(`digest.test: ${passed} passed, 0 failed`);
