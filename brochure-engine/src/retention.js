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
// expired flyers, which stay well inside the window.
//
// Budgets: deletes are capped per run (KV Free allows 1,000/day; the cron runs
// at most twice a week) and rows are processed oldest-first, so a backlog
// drains across fires without ever tripping the daily cap. Store-agnostic.

export async function pruneStoredBytes(ctx, { keepDays = 28, maxDeletes = 250, maxRows = 12 } = {}) {
  const report = { startedAt: new Date().toISOString(), pruned: 0, deletes: 0, skipped: 0, errors: [] };
  const { metadataStore, objectStore } = ctx;
  if (!metadataStore.listPrunable || !metadataStore.markPruned || !objectStore.delete) {
    report.errors.push('retention: storage backends lack prune support');
    return report;
  }

  const cutoff = new Date(Date.now() - keepDays * 86400000).toISOString().slice(0, 10);
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

  // Offers rows: comparison + recent history need a bounded horizon, not an
  // archive. Expired > ~6 months -> gone (D1 delete, cheap). Long-term price
  // memory lives in the compact price-history tables, which survive this.
  if (ctx.offerStore && ctx.offerStore.pruneExpiredBefore) {
    try {
      const offerCutoff = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
      report.offersPruned = await ctx.offerStore.pruneExpiredBefore(offerCutoff);
    } catch (err) {
      report.errors.push(`offers: ${err.message}`);
    }
  }

  // Price-history identities unseen for a year (product discontinued, or an
  // OCR-name variant that never recurred) are dead weight; their points go
  // with them. Active products' histories are never touched, so lowest-ever
  // claims stay backed by rows that exist. Capped per run like everything else.
  if (ctx.historyStore && ctx.historyStore.pruneStale) {
    try {
      const historyCutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
      report.historyPruned = await ctx.historyStore.pruneStale(historyCutoff, { maxRows: 400 });
    } catch (err) {
      report.errors.push(`history: ${err.message}`);
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}
