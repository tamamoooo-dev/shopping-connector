// retention.js — storage retention (a production-stability feature).
//
// WHY: the engine keeps every brochure EDITION forever in D1 (tiny rows — the
// Price History backbone), but the edition's BYTES (page images / PDFs) live
// in KV, whose Free-plan budget is 1 GB total and 1,000 deletes/day. With ~19
// stores ingesting weekly, unpruned bytes would exhaust the namespace within
// weeks. So: METADATA IS FOREVER, BYTES ARE A ROLLING WINDOW.
//
// Policy: a brochure that is (a) no longer current AND (b) expired more than
// `keepDays` ago has its object bytes deleted (pages, meta.json, original.pdf)
// and its row marked `pruned_at`. The row itself — store, edition, validity,
// checksum, source URL — is never deleted, so history/dedup/price anchoring
// are untouched. The frontend only renders bytes for current + most-recently-
// expired flyers, which stay well inside the window. Offer/search rows use a
// separate 14-day hot window; durable attempt evidence is archived in R2.
//
// Budgets: deletes are capped per run (KV Free allows 1,000/day; the cron runs
// at most twice a week) and rows are processed oldest-first, so a backlog
// drains across fires without ever tripping the daily cap. Store-agnostic.

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
  keepDays = 28,
  offerKeepDays = 14,
  opsKeepDays = 7,
  maxDeletes = 250,
  maxRows = 12,
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
      // A link brochure never wrote bytes — just mark it pruned.
      if (row.source_type !== 'link') {
        const base = `brochures/${row.storage_key}`;
        const meta = await objectStore.get(`${base}/meta.json`);
        const keys = [];
        if (meta) {
          try {
            const doc = JSON.parse(new TextDecoder().decode(meta.bytes));
            for (const p of doc.pages || []) if (p.imageUrl) keys.push(p.imageUrl);
          } catch {
            /* unreadable meta — still delete the known fixed keys below */
          }
          keys.push(`${base}/meta.json`);
          // Image sets store their tap-geometry snapshot next to the pages.
          if (row.source_type === 'images') keys.push(`${base}/hotspots.json`);
        }
        if (row.source_type === 'pdf') keys.push(`${base}/original.pdf`);
        if (keys.length > budget) {
          report.skipped += 1; // out of delete budget this run — next fire drains it
          continue;
        }
        for (const key of keys) {
          await objectStore.delete(key);
          report.deletes += 1;
        }
        budget -= keys.length;
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
