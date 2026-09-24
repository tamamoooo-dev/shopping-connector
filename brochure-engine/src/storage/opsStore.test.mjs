import assert from 'node:assert/strict';
import { createD1OpsStore } from './opsStore.js';
import { createSqliteD1 } from './testSqliteD1.mjs';

const { db, close } = createSqliteD1(['schema.sql']);
try {
  const store = createD1OpsStore(db);
  await store.record({
    ts: '2026-08-19T00:00:00.000Z',
    action: 'normal',
    origin: 'cron',
    ok: true,
    detail: { retained: true },
  });
  await store.record({
    ts: '2026-08-19T00:01:00.000Z',
    action: 'oversized',
    origin: 'cron',
    ok: true,
    detail: { evidence: 'x'.repeat(50000) },
  });

  const rows = await store.list({ limit: 10 });
  const normal = JSON.parse(rows.find((row) => row.action === 'normal').detail);
  const compact = JSON.parse(rows.find((row) => row.action === 'oversized').detail);
  assert.deepEqual(normal, { retained: true });
  assert.equal(compact._truncated, true);
  assert.ok(compact.originalChars > 50000);
  assert.ok(rows.find((row) => row.action === 'oversized').detail.length < 16000);
  console.log('opsStore: normal detail retained; oversized detail bounded');
} finally {
  close();
}
