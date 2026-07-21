// upload-shadow.mjs — load the shadow-run vision results into offer_enrichments.
// TEMPORARY (vision evaluation, 2026-07-18): feeds the dev-only comparison mode
// AND doubles as the debris backfill (the serving overlay still uses only the
// debris rows; non-debris rows are visible ONLY via /offers?compare=1).
//
// Prereq: the migration (migrate-2026-07-enrichments.sql) has been applied.
// Run from brochure-engine/:
//   node upload-shadow.mjs <path-to-shadow-results.jsonl> <path-to-shadow-offers.json>
//
// Idempotent (INSERT OR REPLACE); safe to re-run as the shadow run grows.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { corroboration } from './src/offers/enrich.js';

const [jsonlPath, offersPath] = process.argv.slice(2);
if (!jsonlPath || !offersPath) {
  console.error('usage: node upload-shadow.mjs <shadow-results.jsonl> <shadow-offers.json>');
  process.exit(1);
}
const offers = new Map(JSON.parse(readFileSync(offersPath, 'utf8')).map((o) => [o.id, o]));
const sq = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const now = new Date().toISOString();

const rows = [];
for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const r = JSON.parse(line);
  const o = offers.get(r.id);
  if (!o) continue;
  if (r.declined) {
    rows.push(
      `INSERT OR REPLACE INTO offer_enrichments (id, model, crop_url, enriched_at) VALUES (${sq(r.id)}, 'mistral-small-latest', ${sq(o.image_url)}, ${sq(now)});`,
    );
  } else {
    // cor was computed at run time; recompute defensively if absent.
    const cor = r.cor ?? corroboration({ name: r.name, nameAr: r.nameAr, brand: r.brand }, o.search_text);
    rows.push(
      `INSERT OR REPLACE INTO offer_enrichments (id, name, name_ar, brand, size, confidence, corroboration, model, crop_url, enriched_at) VALUES (${sq(r.id)}, ${sq(r.name)}, ${sq(r.nameAr)}, ${sq(r.brand)}, ${sq(r.size)}, ${r.confidence ?? 'NULL'}, ${Number(cor).toFixed(3)}, 'mistral-small-latest', ${sq(o.image_url)}, ${sq(now)});`,
    );
  }
}
console.log(`${rows.length} rows to upload`);

const dir = mkdtempSync(join(tmpdir(), 'shadow-up-'));
const CHUNK = 500;
for (let i = 0; i < rows.length; i += CHUNK) {
  const file = join(dir, `up-${i}.sql`);
  writeFileSync(file, rows.slice(i, i + CHUNK).join('\n'), 'utf8');
  execSync(`npx wrangler d1 execute brochure-engine --remote --file "${file}"`, {
    encoding: 'utf8', stdio: 'inherit',
  });
  console.log(`uploaded ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
}
console.log('done.');
