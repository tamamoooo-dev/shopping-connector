// retention.js — storage retention (a production-stability feature).
//
// Images become disposable seven days after expiry, only for noncurrent,
// fully processed editions. Missing offers never count as completion.
// Save and hash-verify a structured snapshot before deleting page bytes.
// Brochure metadata, price history and Vision evidence remain durable.
// The daily 03:00 UTC owner bounds deletes; incomplete editions keep images.

import { processingComplete } from './storage/brochureProcessing.js';

const encoder = new TextEncoder();

export function isD1RetentionTick(value) {
  const scheduled = new Date(value);
  return Number.isFinite(scheduled.getTime())
    && scheduled.getUTCHours() === 3
    && scheduled.getUTCMinutes() === 0;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function archiveOldOps(ctx, cutoffISO, limit) {
  if (!ctx.opsStore?.listArchiveBefore || !ctx.opsStore?.deleteArchived) return null;
  const rows = await ctx.opsStore.listArchiveBefore(cutoffISO, limit);
  if (!rows.length) return { archived: 0, deleted: 0, key: null };

  const generatedAt = new Date().toISOString();
  const lines = [JSON.stringify({
    record_type: 'ops_archive_manifest', version: 1, generated_at: generatedAt,
    cutoff: cutoffISO, rows: rows.length,
  })];
  for (const row of rows) lines.push(JSON.stringify({ record_type: 'ops_run', ...row }));
  const bytes = encoder.encode(`${lines.join('\n')}\n`);
  const hash = await sha256Hex(bytes);
  const first = rows[0].id;
  const last = rows[rows.length - 1].id;
  const key = `ops-archive/${cutoffISO.slice(0, 10)}/${first}-${last}-${hash.slice(0, 16)}.ndjson`;

  await ctx.objectStore.put(key, bytes, { contentType: 'application/x-ndjson' });
  const stored = await ctx.objectStore.get(key);
  if (!stored || await sha256Hex(stored.bytes) !== hash) {
    throw new Error(`ops archive verification failed for ${key}`);
  }
  const deleted = await ctx.opsStore.deleteArchived(rows.map((row) => row.id));
  if (deleted !== rows.length) {
    throw new Error(`ops archive delete mismatch: archived=${rows.length}, deleted=${deleted}`);
  }
  return { archived: rows.length, deleted, key, sha256: hash, bytes: bytes.byteLength };
}

export async function pruneStoredBytes(ctx, {
  keepDays = 7,
  offerKeepDays = 14,
  opsKeepDays = 7,
  maxDeletes = 750,
  maxRows = 40,
  maxOpsRows = 3000,
  maxEvidenceRows = 5000,
  maxOfferRows = 5000,
  now = new Date(),
} = {}) {
  const report = { startedAt: new Date().toISOString(), pruned: 0, deletes: 0, skipped: 0, errors: [] };
  const { metadataStore, objectStore } = ctx;
  if (!metadataStore.listPrunable || !metadataStore.markPruned || !objectStore.delete) {
    report.errors.push('retention: storage backends lack prune support');
    return report;
  }

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const cutoff = new Date(nowMs - keepDays * 86400000).toISOString().slice(0, 10);
  const rows = await metadataStore.listPrunable(cutoff, maxRows);
  let budget = maxDeletes;

  for (const row of rows) {
    try {
      if (row.is_current || !row.valid_to || row.valid_to >= cutoff
          || !metadataStore.getProcessingSnapshot || !objectStore.put) {
        report.skipped += 1;
        continue;
      }
      {
        const base = `brochures/${row.storage_key}`;
        const meta = await objectStore.get(`${base}/meta.json`);
        const hotspotObject = await objectStore.get(`${base}/hotspots.json`);
        if (!meta || !hotspotObject) {
          report.skipped += 1;
          continue;
        }
        const doc = JSON.parse(new TextDecoder().decode(meta.bytes));
        const hotspots = JSON.parse(new TextDecoder().decode(hotspotObject.bytes));
        const snapshot = await metadataStore.getProcessingSnapshot(row);
        if (!processingComplete(row, doc, hotspots, snapshot)) {
          report.skipped += 1;
          continue;
        }
        // Keep the small publication/geometry manifests as structured data.
        // They also make a failed or partial image deletion safe to retry.
        const keys = [...new Set(doc.pages.map(p => p.imageUrl))];
        if (keys.some(key => !key.startsWith(`${base}/`)
            || !/^page\d+\.(?:webp|jpg|jpeg|png|img)$/.test(key.slice(base.length + 1)))) {
          throw new Error('unsafe brochure asset path');
        }
        if (keys.length > budget) {
          report.skipped += 1; // out of delete budget this run — next fire drains it
          continue;
        }
        const archiveBytes = encoder.encode(JSON.stringify({
          version: 1, policy: 'processed-expired-7-days',
          archived_at: new Date().toISOString(), brochure: row,
          meta: doc, hotspots, ...snapshot,
          attempt_evidence_prefix: 'vision-verification/attempts/',
        }));
        const hash = await sha256Hex(archiveBytes);
        const archiveKey = `brochure-data/${encodeURIComponent(row.id)}/${hash}.json`;
        await objectStore.put(archiveKey, archiveBytes, { contentType: 'application/json' });
        const archived = await objectStore.get(archiveKey);
        if (!archived || await sha256Hex(archived.bytes) !== hash) {
          throw new Error('brochure data archive verification failed');
        }
        if (metadataStore.getById) {
          const live = await metadataStore.getById(row.id);
          if (!live || live.is_current || live.pruned_at || live.checksum !== row.checksum
              || live.storage_key !== row.storage_key || !live.valid_to || live.valid_to >= cutoff) {
            report.skipped += 1;
            continue;
          }
        }
        for (const key of keys) {
          budget -= 1;
          await objectStore.delete(key);
          report.deletes += 1;
        }
      }
      await metadataStore.markPruned(row.id);
      report.pruned += 1;
    } catch (err) {
      report.errors.push(`${row.id}: ${err.message}`);
    }
  }

  // Old Ops drill-down is archived to R2 and hash-verified before its D1 rows
  // are deleted. Summary/history storage must not grow with every cron hop.
  if (ctx.objectStore?.put && ctx.objectStore?.get) {
    try {
      const opsCutoff = new Date(nowMs - opsKeepDays * 86400000).toISOString();
      report.ops = await archiveOldOps(ctx, opsCutoff, maxOpsRows);
    } catch (err) {
      report.errors.push(`ops: ${err.message}`);
    }
  }

  // Offers rows: comparison + recent brochure history need a 14-day rolling
  // horizon, not six months. Long-term price and
  // identity memory live in the compact history/Registry tables below.
  if (ctx.enrichStore?.pruneExpiredOffers || ctx.offerStore?.pruneExpiredBefore) {
    try {
      const offerCutoff = new Date(nowMs - offerKeepDays * 86400000).toISOString().slice(0, 10);
      if (ctx.enrichStore?.pruneExpiredOffers) {
        const cleanup = await ctx.enrichStore.pruneExpiredOffers(
          offerCutoff,
          { limit: maxOfferRows },
        );
        report.offersPruned = cleanup.offers;
        report.offerSidecarsPruned = cleanup.sidecars;
        report.offerSidecarsByTable = cleanup.byTable;
      } else {
        // Local/older store compatibility. Production D1 uses the atomic,
        // candidate-driven branch above; this fallback preserves the public
        // store contract during rolling deployments and unit tests.
        report.offersPruned = await ctx.offerStore.pruneExpiredBefore(
          offerCutoff,
          { limit: maxOfferRows },
        );
        if (ctx.enrichStore?.pruneOrphans) {
          report.offerSidecarsPruned = await ctx.enrichStore.pruneOrphans(
            { limit: maxOfferRows },
          );
        }
      }
    } catch (err) {
      report.errors.push(`offers: ${err.message}`);
    }
  }

  // Expired offers that remain inside the recent-history window retain their
  // display columns, but verbose audit-only JSON is replaced by the small read
  // projection. Its full attempt already lives in R2.
  if (ctx.enrichStore?.compactExpiredEvidence) {
    try {
      const expiredCutoff = new Date(nowMs).toISOString().slice(0, 10);
      report.evidenceCompacted = await ctx.enrichStore.compactExpiredEvidence(
        expiredCutoff,
        { limit: maxEvidenceRows },
      );
    } catch (err) {
      report.errors.push(`evidence: ${err.message}`);
    }
  }

  // The vision price fallback's queue only matters while its flyer is valid;
  // decisions are kept a month past expiry for audit, then dropped.
  if (ctx.offerStore && ctx.offerStore.prunePricePendingBefore) {
    try {
      const pendingCutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      report.pricePendingPruned = await ctx.offerStore.prunePricePendingBefore(pendingCutoff);
    } catch (err) {
      report.errors.push(`price pending: ${err.message}`);
    }
  }

  // Price-history identities unseen for a year (product discontinued, or an
  // OCR-name variant that never recurred) are dead weight; their points go
  // with them. Active products' histories are never touched, so lowest-ever
  // claims stay backed by rows that exist. Capped per run like everything else.
  if (ctx.historyStore && ctx.historyStore.pruneStale) {
    try {
      const historyCutoff = new Date(nowMs - 365 * 86400000).toISOString().slice(0, 10);
      report.historyPruned = await ctx.historyStore.pruneStale(historyCutoff, { maxRows: 400 });
    } catch (err) {
      report.errors.push(`history: ${err.message}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}
