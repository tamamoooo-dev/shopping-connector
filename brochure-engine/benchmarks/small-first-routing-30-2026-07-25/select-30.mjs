// Seeded RANDOM draw of 30 crops from the frozen 50.
//
// Random, not purposive — the 10-crop economy A/B was purposive by design and
// therefore could not estimate a rate. This draw can, within its n.
// Seed is recorded so the draw is reproducible byte-for-byte.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, '..', 'mistral-medium-production-validation-50-2026-07-25');
const SEED = 'small-first-routing-30-2026-07-25';

// Deterministic PRNG (mulberry32 seeded from the sha256 of SEED).
function prng(seed) {
  let a = parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16);
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const source = JSON.parse(await readFile(join(BASE, 'frozen-sample.json'), 'utf8'));
const pool = [...source.samples];

// Fisher-Yates with the seeded PRNG, take the first 30, restore index order.
const rand = prng(SEED);
for (let i = pool.length - 1; i > 0; i -= 1) {
  const j = Math.floor(rand() * (i + 1));
  [pool[i], pool[j]] = [pool[j], pool[i]];
}
const picked = pool.slice(0, 30).sort((a, b) => a.index - b.index);

// Re-point `file` at the frozen assets; images are NOT duplicated.
const samples = picked.map((s) => ({
  ...s,
  file: join('..', 'mistral-medium-production-validation-50-2026-07-25', s.file).replace(/\\/gu, '/'),
}));

// Verify every image still hashes to the frozen value.
for (const s of samples) {
  const bytes = await readFile(join(HERE, s.file));
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== s.sha256) throw new Error(`crop ${s.index} hash drift: ${sha}`);
}

const ordered = createHash('sha256')
  .update(samples.map((s) => `${s.index}:${s.sha256}`).join('|'))
  .digest('hex');

const stores = [...new Set(samples.map((s) => s.store))];
const cats = [...new Set(samples.map((s) => s.category).filter(Boolean))];

await writeFile(
  join(HERE, 'sample-30.json'),
  `${JSON.stringify({
    schema_version: 'small-first-routing-30-v1',
    frozen_at: new Date().toISOString(),
    seed: SEED,
    method: 'seeded Fisher-Yates over the frozen 50; first 30; no human selection',
    source_manifest: 'mistral-medium-production-validation-50-2026-07-25/frozen-sample.json',
    source_sample_digest: source.ordered_sample_sha256,
    ordered_sample_sha256: ordered,
    coverage: { stores: stores.length, categories: cats.length },
    samples,
  }, null, 2)}\n`,
  'utf8',
);

console.log('picked %d crops | %d stores | %d categories', samples.length, stores.length, cats.length);
console.log('indices:', samples.map((s) => s.index).join(','));
console.log('stores :', stores.join(', '));
console.log('digest :', ordered);
