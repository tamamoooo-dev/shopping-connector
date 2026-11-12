// mistralKeyHealth.test.mjs — the durable per-key record.
// Run: node src/offers/mistralKeyHealth.test.mjs
import assert from 'node:assert/strict';
import {
  KEY_HEALTH_KEY,
  currentKeyUsage,
  mergeKeyUsage,
  noteKeyUsage,
  readKeyHealth,
} from './mistralKeyHealth.js';
import { createKeyChain } from './mistralKeys.js';
import { createMemoryOpsStore } from '../storage/local.js';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

function memoryObjects() {
  const objects = new Map();
  return {
    objects,
    puts: 0,
    async put(key, bytes, options) { this.puts += 1; objects.set(key, { bytes, contentType: options?.contentType }); },
    async get(key) { return objects.get(key) || null; },
  };
}

const T0 = Date.parse('2026-11-12T10:00:00Z');
const at = (minutes) => new Date(T0 + minutes * 60000).toISOString();
const item = (id, status, minutes, extra = {}) => ({ id, status, observedAt: at(minutes), calls: 3, ...extra });

await test('a first observation is written, without the per-run call count', async () => {
  const store = memoryObjects();
  assert.equal(await noteKeyUsage(store, [item('k1', 'ready', 0), item('k2', 'invalid', 0)]), true);
  const record = await readKeyHealth(store);
  assert.equal(record.k1.status, 'ready');
  assert.equal(record.k2.status, 'invalid');
  assert.equal('calls' in record.k1, false);
  assert.equal(store.objects.get(KEY_HEALTH_KEY).contentType, 'application/json');
});

await test('writes are throttled: same standing inside ten minutes is not rewritten', async () => {
  const store = memoryObjects();
  await noteKeyUsage(store, [item('k1', 'ready', 0)]);
  assert.equal(await noteKeyUsage(store, [item('k1', 'ready', 3)]), false);
  assert.equal(await noteKeyUsage(store, [item('k1', 'limited', 4)]), false, 'a rate-limit park is not a change of standing');
  assert.equal(store.puts, 1);
  assert.equal(await noteKeyUsage(store, [item('k1', 'ready', 10)]), true, 'ten minutes on, the observation is refreshed');
  assert.equal((await readKeyHealth(store)).k1.observedAt, at(10));
});

await test('a change of standing is written at once', async () => {
  const store = memoryObjects();
  await noteKeyUsage(store, [item('k1', 'ready', 0)]);
  assert.equal(await noteKeyUsage(store, [item('k1', 'invalid', 1)]), true);
  assert.equal(await noteKeyUsage(store, [item('k1', 'ready', 2, { restrictionCategory: 'monthly_account_quota' })]), true);
  assert.equal((await readKeyHealth(store)).k1.restrictionCategory, 'monthly_account_quota');
});

await test('unobserved keys and older observations never overwrite the record', async () => {
  const store = memoryObjects();
  await noteKeyUsage(store, [item('k1', 'invalid', 30)]);
  assert.equal(await noteKeyUsage(store, [{ id: 'k1', status: 'ready', observedAt: null }]), false);
  assert.equal(await noteKeyUsage(store, [item('k1', 'ready', 5)]), false);
  assert.equal((await readKeyHealth(store)).k1.status, 'invalid');
  assert.equal(await noteKeyUsage(store, []), false);
  assert.equal(await noteKeyUsage(null, [item('k1', 'ready', 40)]), false);
});

await test('merge: the audit rows win unless the record is newer', () => {
  const merged = mergeKeyUsage(
    { k1: item('k1', 'ready', 20), k2: { id: 'k2', status: 'ready', observedAt: null } },
    { k1: item('k1', 'invalid', 10), k2: item('k2', 'invalid', 5), k3: item('k3', 'invalid', 5) },
  );
  assert.equal(merged.k1.status, 'ready');
  assert.equal(merged.k2.status, 'invalid');
  assert.equal(merged.k3.status, 'invalid');
});

await test('an unreadable record reads as empty', async () => {
  const store = memoryObjects();
  store.objects.set(KEY_HEALTH_KEY, { bytes: new TextEncoder().encode('not json') });
  assert.deepEqual(await readKeyHealth(store), {});
  assert.deepEqual(await readKeyHealth({ async get() { throw new Error('R2 down'); } }), {});
});

// The reason the record exists: with no usage-carrying audit row in the
// newest window, the next invocation still knows which key is dead.
await test('a retired key stays retired when no audit row carries usage', async () => {
  const objectStore = memoryObjects();
  const opsStore = createMemoryOpsStore();
  await opsStore.record({ ts: at(1), action: 'cron:minimarts', origin: 'cron', ok: true });
  const observed = Date.now() - 5 * 60000;
  await noteKeyUsage(objectStore, [
    { id: 'pool-1', status: 'invalid', observedAt: new Date(observed).toISOString() },
  ]);

  const withoutRecord = createKeyChain([{ id: 'pool-1', key: 'a' }, { id: 'pool-2', key: 'b' }], {
    usage: await currentKeyUsage({ opsStore, objectStore: memoryObjects() }),
  });
  assert.equal(withoutRecord.snapshot()[0].status, 'ready', 'before: the dead key would be tried again');

  const chain = createKeyChain([{ id: 'pool-1', key: 'a' }, { id: 'pool-2', key: 'b' }], {
    usage: await currentKeyUsage({ opsStore, objectStore }),
  });
  assert.equal(chain.snapshot()[0].status, 'invalid');
  assert.equal(chain.pick().id, 'pool-2');
});

console.log(`\nmistralKeyHealth: ${passed} passed`);
