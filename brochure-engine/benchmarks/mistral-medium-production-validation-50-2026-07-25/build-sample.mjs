// Deterministic 50-crop sampler for the Mistral Medium production validation.
// Read-only: consumes a production D1 dump + the historical usage exclusion list.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SEED = 'mistral-medium-production-validation-50-2026-07-25';

const pool = JSON.parse(await readFile(join(HERE, 'pool.json'), 'utf8'))[0].results;

async function readSet(file) {
  return new Set(
    (await readFile(join(HERE, file), 'utf8'))
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

// Exclusion = images actually PROCESSED by a prior benchmark/validation.
// candidate-snapshot.json files are eligible-pool snapshots, not processed
// samples, and are deliberately not treated as prior usage.
const used = await readSet('used-urls-strict.txt');
const usedIds = await readSet('used-ids-strict.txt');

function rank(id) {
  return createHash('sha256').update(`${SEED}:${id}`).digest('hex');
}

const fresh = pool.filter((row) => row.image_url
  && !used.has(row.image_url.trim())
  && !usedIds.has(row.id));
const seenUrl = new Set();
const deduped = [];
for (const row of fresh.sort((a, b) => rank(a.id).localeCompare(rank(b.id)))) {
  const url = row.image_url.trim();
  if (seenUrl.has(url)) continue;
  seenUrl.add(url);
  deduped.push(row);
}

const byStore = new Map();
for (const row of deduped) {
  if (!byStore.has(row.store)) byStore.set(row.store, []);
  byStore.get(row.store).push(row);
}

// Realistic retailer mix: every live retailer represented, volume-capped so no
// high-volume chain dominates. prime carries only 34 current offers, so it gets 2.
const stores = [...byStore.keys()].sort();
const quota = new Map(stores.map((store) => [store, store === 'prime' ? 2 : 3]));

const chosenCategories = new Set();
const picked = [];
// Two passes per store: first take categories not yet in the sample, then fill.
for (const store of stores) {
  const rows = byStore.get(store);
  const want = quota.get(store);
  const take = [];
  for (const row of rows) {
    if (take.length >= want) break;
    const cat = row.category || 'uncategorised';
    if (chosenCategories.has(cat)) continue;
    if (take.some((item) => (item.category || 'uncategorised') === cat)) continue;
    take.push(row);
    chosenCategories.add(cat);
  }
  for (const row of rows) {
    if (take.length >= want) break;
    if (take.includes(row)) continue;
    take.push(row);
    chosenCategories.add(row.category || 'uncategorised');
  }
  picked.push(...take);
}

picked.sort((a, b) => (a.store === b.store
  ? rank(a.id).localeCompare(rank(b.id))
  : a.store.localeCompare(b.store)));

const samples = picked.map((row, position) => ({
  index: position + 1,
  id: row.id,
  store: row.store,
  category: row.category || null,
  image_url: row.image_url.trim(),
  production_price: row.price ?? null,
  production_old_price: row.old_price ?? null,
  production_name: row.name ?? null,
}));

const manifest = {
  schema_version: 'frozen-production-crop-sample-v1',
  created_at: new Date().toISOString(),
  seed: SEED,
  selection: {
    source: 'production D1 read-only query',
    current_on: '2026-07-25',
    method: 'seeded deterministic shuffle; per-retailer quota (3 each, prime 2); '
      + 'category-diversity-first within each retailer',
    exclusion: 'every image URL / offer id processed by any prior benchmark or validation run',
    excluded_url_count: used.size,
    excluded_id_count: usedIds.size,
    eligible_pool: pool.length,
    eligible_after_exclusion: deduped.length,
    sample_size: samples.length,
    stores: new Set(samples.map((s) => s.store)).size,
    declared_categories: new Set(samples.map((s) => s.category)).size,
  },
  samples,
};

await writeFile(join(HERE, 'sample-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(manifest.selection, null, 2)}\n`);
for (const sample of samples) {
  process.stdout.write(`${sample.index}\t${sample.store}\t${sample.category}\n`);
}
