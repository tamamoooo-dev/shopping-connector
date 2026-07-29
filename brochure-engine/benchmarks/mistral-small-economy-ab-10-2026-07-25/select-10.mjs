// Stratified purposive selection of 10 crops from the FROZEN 50-crop set.
//
// No new images. Every crop is taken by index out of
// ../mistral-medium-production-validation-50-2026-07-25/frozen-sample.json and
// its bytes are re-hashed against that file's recorded sha256, so the A/B runs
// on provably the same pixels the Medium baseline ran on.
//
// Selection is deliberate, not random: the brief asked for multiple retailers,
// multiple categories, easy and difficult products, English names, prices and
// package sizes. It is therefore NOT an unbiased subsample of the 50 — see
// REPORT.md "What this sample can and cannot support".
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, '..', 'mistral-medium-production-validation-50-2026-07-25');

// index -> why this crop is in the sample
const PICKS = {
  8: 'HARD. Medium missed name + BOTH price roles here (returned the crossed-out 44.99 as current). Brochure misprints "Jmbo"; caption carries a compound pack expression "Pk40\'s11-18kg". Tests transcription discipline, price-role assignment and pack parsing at once.',
  10: 'EASY. Clean English caption with brand-first and a trailing size ("ZAIQA PURE BEE HONEY 500 GM"). The canonical decomposition-vs-verbatim test.',
  13: 'EASY. Short all-caps English caption, size fused to the last token ("425G"), two clean prices.',
  19: 'MODERATE. Small print, and the pack shows a competing on-pack sub-brand ("Break 3") that the original prompt fell for. Multiplier size "4x19g".',
  26: 'HARD. Loose produce priced per piece; only quantity mark is "/PC". Medium missed quantity. No brand exists — tests correct-null discipline.',
  30: 'HARD. Medium missed name + BOTH prices. Brand ("St Michel") is a small pack mark, not in the caption; size is parenthesised "(85g)".',
  33: 'HARD. Medium substituted marketing copy for the caption ("Steamed 1121 Basmati Rice"). Numeric variety token "1121" adjacent to size "5kg".',
  40: 'EASY-BUT-DISCRIMINATING. The only pick with NO old price and NO printed size. Tests false-positive suppression: does the model invent a crossed-out price or a package size that is not printed?',
  44: 'HARD. Medium misread the old price (45.5 for a printed 45.51). Most complex pack expression in the set: "(2 X 1.5 LTR + 500 ML)".',
  48: 'MODERATE. Tamimi house caption style: comma-separated, with a size RANGE ("68 - 114 GRAMS") rather than a single size.',
};

const frozen = JSON.parse(await readFile(join(BASE, 'frozen-sample.json'), 'utf8'));
const truth = JSON.parse(await readFile(join(BASE, 'human-canonical.json'), 'utf8'));
const mediumMetrics = JSON.parse(await readFile(join(BASE, 'verbatim-metrics.json'), 'utf8'));

const samples = [];
for (const index of Object.keys(PICKS).map(Number).sort((a, b) => a - b)) {
  const sample = frozen.samples.find((item) => item.index === index);
  if (!sample) throw new Error(`index ${index} not in frozen sample`);
  const bytes = await readFile(join(BASE, sample.file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== sample.sha256) throw new Error(`index ${index} byte drift vs frozen sample`);
  const mediumRow = mediumMetrics.per_image.find((item) => item.index === index);
  samples.push({
    ...sample,
    file: join('..', 'mistral-medium-production-validation-50-2026-07-25', sample.file).replace(/\\/gu, '/'),
    rationale: PICKS[index],
    truth_name_en: truth.samples.find((item) => item.index === index)?.name_en?.accepted?.[0] ?? null,
    medium_verbatim_misses: Object.entries(mediumRow.fields)
      .filter(([, cell]) => cell.status === 'wrong').map(([field]) => field),
  });
}

const manifest = {
  schema_version: 'mistral-small-economy-ab-10-v1',
  built_at: new Date().toISOString(),
  purpose: 'Economic A/B: mistral-small-latest vs the frozen mistral-medium-latest production baseline.',
  source_benchmark: 'benchmarks/mistral-medium-production-validation-50-2026-07-25',
  source_sample_digest: frozen.ordered_sample_sha256,
  selection: 'stratified purposive (documented per crop), NOT random — see rationale fields',
  new_images_introduced: 0,
  retailers: [...new Set(samples.map((item) => item.store))],
  categories: [...new Set(samples.map((item) => item.category))],
  medium_clean_crops: samples.filter((item) => !item.medium_verbatim_misses.length).map((item) => item.index),
  medium_missed_crops: samples.filter((item) => item.medium_verbatim_misses.length).map((item) => item.index),
  ordered_sample_sha256: createHash('sha256')
    .update(samples.map((item) => `${item.index}:${item.sha256}`).join('|')).digest('hex'),
  samples,
};

await writeFile(join(HERE, 'sample-10.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
process.stdout.write(`10 crops, ${manifest.retailers.length} retailers, ${manifest.categories.length} categories\n`);
process.stdout.write(`retailers: ${manifest.retailers.join(', ')}\n`);
process.stdout.write(`Medium-clean: ${manifest.medium_clean_crops.join(', ')}\n`);
process.stdout.write(`Medium-missed: ${manifest.medium_missed_crops.join(', ')}\n`);
process.stdout.write(`digest ${manifest.ordered_sample_sha256}\n`);
