// backfill-enrich.mjs — ONE-TIME local backfill for Vision Enrichment
// (offers/enrich.js). The daily cron drains ~60 debris offers/day; this script
// clears the standing backlog (~322 current debris offers, 2026-07-18) in one
// sitting from your machine instead of waiting ~a week.
//
// Run from brochure-engine/ (needs wrangler auth + a Mistral key file):
//   put the key in brochure-engine/.mistral.key   (backup: .mistral.key.backup)
//   node backfill-enrich.mjs
// (a MISTRAL_API_KEY env var still overrides the file if you prefer.)
//
// Resumable: already-attempted offers (any offer_enrichments row) are skipped,
// so re-running after an interruption continues where it left off. Paced
// sequentially (~2-3s/offer) to stay far under the API's per-minute cap.
// Key failover is automatic (offers/mistralKeys.js): the cold-standby key is
// used only when the primary becomes unusable, and every switch is logged.
// Writes via `wrangler d1 execute --remote --file` in chunks.

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enrichWithFailover, corroboration } from './src/offers/enrich.js';
import { createKeyChain } from './src/offers/mistralKeys.js';
import { visionMatchText } from './src/storage/enrichStore.js';
import { loadMistralKeys } from './local-secrets.mjs';

// Cold-standby key chain from .mistral.key (+ .mistral.key.backup), or the
// MISTRAL_API_KEY[_BACKUP] env override. Failover + logging live in the shared
// primitive (offers/mistralKeys.js) — this long backfill benefits automatically.
const KEYS = loadMistralKeys();
if (!KEYS.length) {
  console.error('No Mistral key: create .mistral.key (and optionally .mistral.key.backup) or set MISTRAL_API_KEY.');
  process.exit(1);
}
// A long run is exactly where waiting out a transient 429 is right, so it is
// patient on a blip and only promotes the standby on a PERSISTENT wall.
const keyChain = createKeyChain(KEYS);
console.log(`Mistral keys loaded: ${keyChain.size} (${keyChain.size > 1 ? 'primary + cold standby' : 'primary only'}).`);

const today = new Date().toISOString().slice(0, 10);
const sq = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

function d1(sql) {
  const out = execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', 'brochure-engine', '--remote', '--json', '--command', sql],
    { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 },
  );
  const m = /\[[\s\S]*\]/.exec(out);
  return JSON.parse(m[0])[0].results;
}

function d1File(path) {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['wrangler', 'd1', 'execute', 'brochure-engine', '--remote', '--file', path],
    { encoding: 'utf8', shell: process.platform === 'win32', stdio: 'inherit' },
  );
}

// SCOPE (pipeline evaluation, 2026-07-18): 'all' (default) enriches EVERY
// current offer with a crop — full-catalog vision coverage for the Vision +
// Registry pipeline. 'debris' restores the original deriveNames-defeated
// subset. Resumable either way (attempted offers are skipped).
//   node backfill-enrich.mjs          (full catalog)
//   node backfill-enrich.mjs debris   (debris only)
const SCOPE = process.argv[2] === 'debris' ? 'debris' : 'all';
const scopeWhere = SCOPE === 'debris' ? 'AND o.name IS NULL AND o.name_ar IS NULL' : '';
console.log(`Reading current ${SCOPE === 'debris' ? 'debris ' : ''}offers (minus already-attempted)…`);
const debris = d1(
  `SELECT o.id, o.image_url, o.search_text
     FROM offers o LEFT JOIN offer_enrichments e ON e.id = o.id
    WHERE e.id IS NULL ${scopeWhere}
      AND o.image_url IS NOT NULL AND o.valid_to >= '${today}'`,
);
console.log(`${debris.length} offers to enrich. (~${Math.round((debris.length * 2.5) / 60)} min)`);

const dir = mkdtempSync(join(tmpdir(), 'enrich-'));
let batch = [];
let n = 0;
let enriched = 0;
let declined = 0;
let flushed = 0;

async function flush() {
  if (!batch.length) return;
  const file = join(dir, `batch-${flushed}.sql`);
  writeFileSync(file, batch.join('\n'), 'utf8');
  d1File(file);
  flushed += 1;
  batch = [];
}

for (const d of debris) {
  n += 1;
  try {
    const rec = await enrichWithFailover(
      { id: d.id, name: null, nameAr: null, imageUrl: d.image_url },
      { keyChain, maxRateRetries: 3, backoffMs: 2000 },
    );
    const now = new Date().toISOString();
    if (!rec) {
      declined += 1;
      batch.push(
        `INSERT OR REPLACE INTO offer_enrichments (id, model, crop_url, enriched_at) VALUES (${sq(d.id)}, 'mistral-small-latest', ${sq(d.image_url)}, ${sq(now)});`,
      );
    } else {
      enriched += 1;
      const cor = corroboration(rec, d.search_text);
      // match_text mirrors enrichStore.upsertMany — backfilled rows are
      // vision-searchable immediately, no reindex wait.
      const mt = visionMatchText({ name: rec.name, name_ar: rec.nameAr, brand: rec.brand });
      batch.push(
        `INSERT OR REPLACE INTO offer_enrichments (id, name, name_ar, brand, size, confidence, corroboration, model, crop_url, enriched_at, match_text) VALUES (${sq(d.id)}, ${sq(rec.name)}, ${sq(rec.nameAr)}, ${sq(rec.brand)}, ${sq(rec.size)}, ${rec.confidence}, ${cor.toFixed(3)}, ${sq(rec.model)}, ${sq(rec.cropUrl)}, ${sq(rec.enrichedAt)}, ${sq(mt)});`,
      );
    }
    console.log(`${n}/${debris.length}  ${d.id}  ${rec ? '-> ' + (rec.name || rec.nameAr) : '(declined)'}`);
  } catch (err) {
    console.error(`${n}/${debris.length}  ${d.id}  ERROR ${String(err.message).slice(0, 120)} — stopping (re-run to resume).`);
    break;
  }
  if (batch.length >= 40) await flush();
  await new Promise((r) => setTimeout(r, 800)); // pacing
}
await flush();
console.log(`\nDone: ${enriched} enriched, ${declined} declined, ${flushed} write batches.`);
console.log('Verify: curl "https://brochure-engine.tamamoooo.workers.dev/offers?q=<something>"');
