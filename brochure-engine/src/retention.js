// retention.js — storage retention (a production-stability feature).
//
// Images become disposable seven days after expiry for noncurrent, fully
// processed editions, and fifteen days after expiry for editions whose every
// hotspot product is saved in the price archive (storage/offerArchive.js).
// Missing offers never count as completion.
// Save and hash-verify a structured snapshot before deleting page bytes.
// Brochure metadata, price history, the price archive and Vision evidence
// remain durable. Expired offers are copied into the price archive in the same
// batch that deletes them. The daily 03:00 UTC owner bounds deletes;
// incomplete editions keep images.

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

// Write a hash-verified structured snapshot of one brochure to `brochure-data/`
// and then delete its page images. The small publication/geometry manifests
// stay: they keep the brochure's structure and make a partial delete safe to
// retry. Returns the number of images deleted, or null when nothing was done
// (over budget, or the row changed since it was listed).
async function snapshotAndDeletePages(ctx, row, doc, hotspots, { policy, data, cutoff, budget }) {
  const { metadataStore, objectStore } = ctx;
  const base = `brochures/${row.storage_key}`;
  const keys = [...new Set(doc.pages.map(p => p.imageUrl))];
  if (keys.some(key => typeof key !== 'string' || !key.startsWith(`${base}/`)
      || !/^page\d+\.(?:webp|jpg|jpeg|png|img)$/.test(key.slice(base.length + 1)))) {
    throw new Error('unsafe brochure asset path');
  }
  if (keys.length > budget) return null; // out of delete budget this run — next fire drains it
  const archiveBytes = encoder.encode(JSON.stringify({
    version: 1, policy,
    archived_at: new Date().toISOString(), brochure: row,
    meta: doc, hotspots, ...data,
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
      return null;
    }
  }
  for (const key of keys) await objectStore.delete(key);
  return keys.length;
}

// Every product a brochure's hotspot manifest names (D4D offer ids).
export function hotspotOfferIds(hotspots) {
  if (!Array.isArray(hotspots?.pages)) return [];
  const ids = new Set();
  for (const page of hotspots.pages) {
    for (const spot of Array.isArray(page?.spots) ? page.spots : []) {
      if (spot?.offerId != null && String(spot.offerId).trim()) ids.add(String(spot.offerId));
    }
  }
  return [...ids];
}

// The price-archive pass (owner decision 2026-11-17): once every product of an
// expired brochure has its store, dates and price saved in the price archive,
// its page images may go. A product counts as saved when the archive holds a
// priced row for it, or when the flyer never priced it and the price fallback
// rejected it. A brochure with no hotspot products is never touched — its
// pages are the only record of what it offered.
async function pruneArchivedBrochures(ctx, report, { cutoff, budget, maxRows, maxCandidates }) {
  const { metadataStore, objectStore, offerArchive } = ctx;
  const out = { checked: 0, pruned: 0, deletes: 0, incomplete: 0, noProducts: 0 };
  const rows = await metadataStore.listArchivePrunable(cutoff, maxCandidates);
  for (const row of rows) {
    if (out.pruned >= maxRows || budget - out.deletes <= 0) break;
    try {
      if (row.is_current || !row.valid_to || row.valid_to >= cutoff) continue;
      const base = `brochures/${row.storage_key}`;
      const meta = await objectStore.get(`${base}/meta.json`);
      const hotspotObject = await objectStore.get(`${base}/hotspots.json`);
      if (!meta || !hotspotObject) continue;
      out.checked += 1;
      const doc = JSON.parse(new TextDecoder().decode(meta.bytes));
      const hotspots = JSON.parse(new TextDecoder().decode(hotspotObject.bytes));
      if (!Array.isArray(doc.pages) || !doc.pages.length) continue;
      const ids = hotspotOfferIds(hotspots);
      if (!ids.length) {
        out.noProducts += 1;
        continue;
      }
      const archived = await offerArchive.archivedOfferIds(row.store, row.region, ids);
      const snapshot = metadataStore.getProcessingSnapshot
        ? await metadataStore.getProcessingSnapshot(row)
        : null;
      const unpriced = new Set((snapshot?.pending || [])
        .filter((p) => p.status === 'rejected')
        .map((p) => String(p.offer_id)));
      if (!ids.every((id) => archived.has(id) || unpriced.has(id))) {
        out.incomplete += 1;
        continue;
      }
      const deleted = await snapshotAndDeletePages(ctx, row, doc, hotspots, {
        policy: 'price-archive-complete',
        data: {
          archived_offer_ids: [...archived],
          unpriced_offer_ids: [...unpriced],
          price_archive: 'offer_archive (GET /prices/archive)',
        },
        cutoff,
        budget: budget - out.deletes,
      });
      if (deleted == null) continue;
      out.deletes += deleted;
      await metadataStore.markPruned(row.id);
      out.pruned += 1;
    } catch (err) {
      report.errors.push(`${row.id}: ${err.message}`);
    }
  }
  return out;
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
  watchRunKeepDays = 30,
  maxArchiveCandidates = 300,
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
        const deleted = await snapshotAndDeletePages(ctx, row, doc, hotspots, {
          policy: 'processed-expired-7-days', data: snapshot, cutoff, budget,
        });
        if (deleted == null) {
          report.skipped += 1;
          continue;
        }
        budget -= deleted;
        report.deletes += deleted;
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

  // Brochure pages whose products are all in the price archive. Runs after the
  // offers prune above, one day past its horizon, so the expired offers this
  // brochure printed have already been copied into the archive.
  if (ctx.offerArchive?.archivedOfferIds && metadataStore.listArchivePrunable && objectStore.put) {
    try {
      const archiveCutoff = new Date(nowMs - (offerKeepDays + 1) * 86400000).toISOString().slice(0, 10);
      const archivePass = await pruneArchivedBrochures(ctx, report, {
        cutoff: archiveCutoff,
        budget,
        maxRows,
        maxCandidates: maxArchiveCandidates,
      });
      budget -= archivePass.deletes;
      report.deletes += archivePass.deletes;
      report.pruned += archivePass.pruned;
      report.archivePass = archivePass;
    } catch (err) {
      report.errors.push(`price archive pass: ${err.message}`);
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

  // Watch rounds: two rows per watch per day, kept forever until now. A month
  // is far past anything that reads them (the console looks back five days),
  // and each watch keeps its newest round regardless.
  if (ctx.watchRunStore && ctx.watchRunStore.pruneBefore) {
    try {
      const runsCutoff = new Date(now.getTime() - watchRunKeepDays * 86400000).toISOString();
      report.watchRunsPruned = await ctx.watchRunStore.pruneBefore(runsCutoff, { limit: 2000 });
    } catch (err) {
      report.errors.push(`watch runs: ${err.message}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}
