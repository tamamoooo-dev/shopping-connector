// registry/drain.js — the RESOLUTION drain (REGISTRY-DESIGN.md §2): resolve
// every unprocessed enrichment on a current offer into the registry. Runs as
// the post-step of the /enrich drain child and standalone via POST /resolve
// (the backlog/backfill path). D1-only — zero external fetches, zero new
// scheduling machinery; the drain children already run sequentially, so the
// resolver's single-writer assumption (§2) holds.
//
// Every enrichment row is processed EXACTLY ONCE: the drain feeds on
// mint_verdict IS NULL and stamps a verdict on every row it touches
// (IDENTITY-V2 §3.1 — every exclusion recorded, never silent). Servable reads
// resolve through the four outcomes (attach/review/create/defer); non-servable
// ones are stamped with their defer verdict and skipped forever. Re-runs are
// no-ops end to end (verdict feed + the sighting PK).

import { resolveOffer } from './resolver.js';
import { applyDecision } from './apply.js';
import { observationFromOffer } from './read.js';

export async function drainResolution(
  { enrichStore, registryStore },
  // `tuning` (resolver TUNING override) exists for the §8 replay/sweep
  // harness (calibrate.js) — production drains never pass it.
  { limit = 50, currentOn, tuning } = {},
) {
  const report = {
    startedAt: new Date().toISOString(),
    scanned: 0,
    reindexed: 0,
    attached: 0, reviewed: 0, created: 0, deferred: 0, noop: 0,
    verdicts: {}, // §3.1 counters, this batch
    errors: [],
  };

  // Heal shadow-era rows missing their vision haystack (cheap, self-limiting;
  // a few passes per drain so a 10k-row shadow upload converges in a handful
  // of drains instead of dozens).
  for (let pass = 0; pass < 5; pass += 1) {
    const healed = await enrichStore.reindexMatchText().catch(() => 0);
    report.reindexed += healed;
    if (healed < 400) break;
  }

  const rows = await enrichStore.listUnresolved({ currentOn, limit });
  report.scanned = rows.length;
  // Snapshot the batch-invariant product count ONCE (it feeds only the resolver's
  // approximate distinctness ceiling; a ≤batch-size drift over the run is
  // negligible) instead of re-running SELECT COUNT(*) inside resolveRead for
  // every offer — one fewer D1 subrequest per offer, the biggest cheap win.
  const productCount = await registryStore.productCount().catch(() => null);
  // Candidate profiles repeat heavily inside a 50-row drain. Cache only their
  // derived admission views for this invocation; the signature includes every
  // learned field, so an auto-band profile update invalidates itself. This is
  // ephemeral resolver work, not registry state.
  const resolveOpts = {
    productCount,
    admissionCache: new Map(),
    ...(tuning ? { tuning } : {}),
  };
  const verdicts = [];
  for (const r of rows) {
    const offer = {
      id: r.id, store: r.store, region: r.region, source: r.source,
      category: r.category, search_text: r.search_text,
      price: r.price, old_price: r.old_price,
      valid_from: r.valid_from, detected_at: r.detected_at,
    };
    const enrichment = {
      name: r.e_name, name_ar: r.e_name_ar, brand: r.e_brand,
      size: r.e_size, corroboration: r.e_corroboration,
    };
    try {
      const decision = await resolveOffer(
        offer, enrichment, registryStore, resolveOpts,
      );
      const applied = await applyDecision(
        decision,
        observationFromOffer(offer, enrichment),
        registryStore,
      );
      if (applied.applied === 'attach') report.attached += 1;
      else if (applied.applied === 'review') report.reviewed += 1;
      else if (applied.applied === 'create') report.created += 1;
      else if (applied.applied === 'defer') report.deferred += 1;
      else report.noop += 1;
      verdicts.push({ id: r.id, verdict: decision.verdict });
      report.verdicts[decision.verdict] = (report.verdicts[decision.verdict] || 0) + 1;
    } catch (err) {
      // A single bad row must not stall the feed forever: record the error,
      // leave the row unstamped (retried next drain), continue.
      report.errors.push(`${r.id}: ${String(err.message).slice(0, 160)}`);
      if (report.errors.length >= 5) break; // systemic failure — stop the batch
    }
  }
  if (verdicts.length) await enrichStore.setVerdicts(verdicts);
  report.finishedAt = new Date().toISOString();
  return report;
}
