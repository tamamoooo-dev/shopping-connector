import assert from 'node:assert/strict';
import { isD1RetentionTick, pruneStoredBytes } from './retention.js';

const objects = new Map();
const calls = [];
const ctx = {
  metadataStore: {
    listPrunable: async (cutoff) => { calls.push(['brochures', cutoff]); return []; },
    markPruned: async () => {},
  },
  objectStore: {
    put: async (key, bytes, options) => {
      objects.set(key, { bytes: new Uint8Array(bytes), contentType: options?.contentType });
    },
    get: async (key) => objects.get(key) || null,
    delete: async () => {},
  },
  opsStore: {
    listArchiveBefore: async (cutoff) => {
      calls.push(['ops-list', cutoff]);
      return [{ id: 4, ts: '2026-07-01T00:00:00.000Z', detail: '{"large":true}' }];
    },
    deleteArchived: async (ids) => { calls.push(['ops-delete', ids]); return ids.length; },
  },
  offerStore: {
    pruneExpiredBefore: async () => { throw new Error('D1 must use atomic sidecar cleanup'); },
  },
  enrichStore: {
    pruneExpiredOffers: async (cutoff, options) => {
      calls.push(['expired-offers', cutoff, options.limit]);
      return { offers: 7, sidecars: 6, byTable: { offer_enrichments: 6 } };
    },
    pruneOrphans: async () => { throw new Error('hot orphan sweep must not run'); },
    compactExpiredEvidence: async (cutoff, options) => {
      calls.push(['compact', cutoff, options.limit]);
      return 5;
    },
  },
  historyStore: {
    pruneStale: async (cutoff) => { calls.push(['history', cutoff]); return 0; },
  },
};

const report = await pruneStoredBytes(ctx, {
  now: new Date('2026-08-13T12:00:00.000Z'),
  maxEvidenceRows: 4321,
});

assert.equal(report.offersPruned, 7);
assert.equal(report.offerSidecarsPruned, 6);
assert.equal(report.evidenceCompacted, 5);
assert.equal(report.ops.archived, 1);
assert.equal(report.ops.deleted, 1);
assert.match(report.ops.key, /^ops-archive\/2026-08-06\/4-4-[a-f0-9]{16}\.ndjson$/);
assert.equal(objects.get(report.ops.key)?.contentType, 'application/x-ndjson');
assert.deepEqual(calls.find((entry) => entry[0] === 'expired-offers'), ['expired-offers', '2026-07-30', 5000]);
assert.deepEqual(report.offerSidecarsByTable, { offer_enrichments: 6 });
assert.equal(calls.some((entry) => entry[0] === 'orphans'), false);
assert.deepEqual(calls.find((entry) => entry[0] === 'compact'), ['compact', '2026-08-13', 4321]);
assert.ok(calls.findIndex((entry) => entry[0] === 'expired-offers')
  < calls.findIndex((entry) => entry[0] === 'compact'));
assert.equal(report.errors.length, 0);
assert.equal(isD1RetentionTick('2026-08-13T03:00:00.000Z'), true);
assert.equal(isD1RetentionTick('2026-08-13T03:01:00.000Z'), false);
assert.equal(isD1RetentionTick('not-a-date'), false);

console.log('retention: verified R2 archive-before-delete, atomic 14-day offer cleanup, and compact evidence');
