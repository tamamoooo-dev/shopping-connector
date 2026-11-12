// cronAudit.test.mjs — the weekly D1 export leaves an audit row.
// Run: node src/cronAudit.test.mjs
//
// Retention and the backup used to report to the Worker log only, so the Ops
// Console and the daily digest could not tell whether either had run.
import assert from 'node:assert/strict';
import { recordBackupRun } from './index.js';
import { createMemoryOpsStore } from './storage/local.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

const backupRows = async (opsStore) =>
  (await opsStore.list({ limit: 50 })).filter((row) => row.action === 'cron:backup');

await test('a finished export writes one cron:backup row with its totals', async () => {
  const opsStore = createMemoryOpsStore();
  const wrote = await recordBackupRun({ opsStore }, {
    id: '2026-11-08', done: true, rows: 120000, tables: 31, rotated: ['2026-09-13'],
    startedAt: '2026-11-08T02:00:00.000Z', finishedAt: '2026-11-08T02:14:00.000Z',
  });
  assert.equal(wrote, true);
  const [row] = await backupRows(opsStore);
  assert.equal(row.origin, 'cron');
  assert.ok(row.ok);
  assert.equal(row.ts, '2026-11-08T02:14:00.000Z');
  assert.equal(row.elapsed_ms, 14 * 60 * 1000);
  const detail = typeof row.detail === 'string' ? JSON.parse(row.detail) : row.detail;
  assert.equal(detail.id, '2026-11-08');
  assert.equal(detail.rows, 120000);
  assert.deepEqual(detail.rotated, ['2026-09-13']);
});

await test('a failing export is recorded once, not once a minute', async () => {
  const opsStore = createMemoryOpsStore();
  const at = (iso) => ({ now: new Date(iso) });
  assert.equal(await recordBackupRun({ opsStore }, null, new Error('R2 unavailable'), at('2026-11-08T02:01:00Z')), true);
  assert.equal(await recordBackupRun({ opsStore }, null, new Error('R2 unavailable'), at('2026-11-08T02:02:00Z')), false);
  assert.equal(await recordBackupRun({ opsStore }, null, new Error('R2 unavailable'), at('2026-11-08T07:59:00Z')), false);
  assert.equal((await backupRows(opsStore)).length, 1);
  // A different failure, and the same one six hours on, are both news.
  assert.equal(await recordBackupRun({ opsStore }, null, new Error('D1 timeout'), at('2026-11-08T08:00:00Z')), true);
  assert.equal(await recordBackupRun({ opsStore }, null, new Error('D1 timeout'), at('2026-11-08T14:01:00Z')), true);
  const rows = await backupRows(opsStore);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => !row.ok && row.failed === 1));
});

await test('no audit store: nothing is written and nothing throws', async () => {
  assert.equal(await recordBackupRun({}, { id: 'x', done: true }), false);
});

console.log(`\ncronAudit: ${passed} passed`);
