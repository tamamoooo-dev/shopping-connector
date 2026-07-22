// In-memory representative historical Identity Candidate replay. No D1 writes.

import { createMemRegistryStore } from './memstore.js';
import { newProductRow, decodeProfile, profileTokens } from './model.js';
import { resolveIdentityCandidate } from './resolver.js';
import { resolveLegacyOffer } from './legacyResolver.js';

function product(id, { tokens, brand, family, size }) {
  return {
    ...newProductRow({
      tokens, week: '2026-06-01', date: '2026-06-01', store: 'othaim',
      displayName: tokens.join(' '), displayCorroboration: 1,
      brandText: brand, family,
      sizeUnit: size?.unit ?? null, sizeTotal: size?.each ?? null, sizePack: size?.pack ?? null,
    }),
    id,
  };
}

const known = [
  product('pr_sadia_breast', {
    tokens: ['sadia', 'chicken', 'breast', 'fresh'], brand: 'Sadia', family: 'Chicken',
    size: { unit: 'g', each: 900, pack: 1 },
  }),
  product('pr_almarai_full_fat_milk', {
    tokens: ['almarai', 'pasteurized', 'milk', 'full', 'fat'], brand: 'Almarai', family: 'Milk',
    size: { unit: 'ml', each: 1000, pack: 1 },
  }),
];
const store = createMemRegistryStore();
for (const row of known) await store.createProduct(row, profileTokens(decodeProfile(row.token_profile)));

const base = {
  brand: null, family: null, cut: null, processing: null, variety: null,
  package: null, size: null, count: null,
};
const samples = [
  {
    id: 'hist:sadia-breast-repeat', expected: 'Known Product',
    candidate: { ...base, brand: 'Sadia', family: 'Chicken', cut: 'Breast', processing: 'Fresh', size: { value: 900, unit: 'g' }, count: 1 },
    extraction: { name: 'Sadia Fresh Chicken Breast', brand: 'Sadia', size: '900g' },
  },
  {
    id: 'hist:almarai-milk-repeat', expected: 'Known Product',
    candidate: { ...base, brand: 'Almarai', family: 'Milk', variety: 'Full Fat', processing: 'Pasteurized', size: { value: 1, unit: 'l' }, count: 1 },
    extraction: { name: 'Almarai Pasteurized Full Fat Milk', brand: 'Almarai', size: '1L' },
  },
  {
    id: 'hist:sadia-thigh-new', expected: 'New Product',
    candidate: { ...base, brand: 'Sadia', family: 'Chicken', cut: 'Thigh', processing: 'Fresh', size: { value: 900, unit: 'g' }, count: 1 },
    extraction: { name: 'Sadia Fresh Chicken Thigh', brand: 'Sadia', size: '900g' },
  },
  {
    id: 'hist:nadec-milk-new', expected: 'New Product',
    candidate: { ...base, brand: 'Nadec', family: 'Milk', variety: 'Full Fat', processing: 'Pasteurized', size: { value: 1, unit: 'l' }, count: 1 },
    extraction: { name: 'Nadec Pasteurized Full Fat Milk', brand: 'Nadec', size: '1L' },
  },
  {
    id: 'hist:partial-milk-review', expected: 'Review',
    candidate: { ...base, brand: 'Almarai', family: 'Milk', size: { value: 1, unit: 'l' }, count: 1 },
    extraction: { name: 'Almarai Milk', brand: 'Almarai', size: '1L' },
  },
  {
    id: 'hist:fish-fillet-new', expected: 'New Product',
    candidate: { ...base, brand: 'Ocean', family: 'Fish', cut: 'Fillet', processing: 'Frozen', size: { value: 500, unit: 'g' }, count: 1 },
    extraction: { name: 'Ocean Frozen Fish Fillet', brand: 'Ocean', size: '500g' },
  },
];

const rows = [];
for (const sample of samples) {
  const context = { offerId: sample.id, store: 'othaim', region: 'riyadh' };
  const started = performance.now();
  const current = await resolveIdentityCandidate(sample.candidate, context, store);
  const latency = performance.now() - started;
  const legacy = await resolveLegacyOffer(
    { id: sample.id, store: 'othaim', region: 'riyadh', category: null, search_text: sample.extraction.name },
    { ...sample.extraction, name_ar: null, corroboration: 0.9 },
    store,
  );
  const previous = legacy.outcome === 'attach' ? 'Known Product'
    : legacy.outcome === 'create' ? 'New Product' : 'Review';
  const currentCorrect = current.registryOutcome === sample.expected;
  const previousCorrect = previous === sample.expected;
  rows.push({
    id: sample.id,
    expected: sample.expected,
    previous,
    current: current.registryOutcome,
    comparison: currentCorrect && !previousCorrect ? 'Better'
      : !currentCorrect && previousCorrect ? 'Worse' : 'Comparable',
    latencyMs: latency,
  });
}

const count = (field, value) => rows.filter((row) => row[field] === value).length;
const report = {
  samples: rows.length,
  existingProductsCorrectlyMatched: rows.filter((r) => r.expected === 'Known Product' && r.current === r.expected).length,
  newProductsCorrectlyIdentified: rows.filter((r) => r.expected === 'New Product' && r.current === r.expected).length,
  reviewCandidates: count('current', 'Review'),
  falseMerges: rows.filter((r) => r.current === 'Known Product' && r.expected !== 'Known Product').length,
  duplicateRisk: rows.filter((r) => r.current === 'New Product' && r.expected === 'Known Product').length,
  averageLatencyMs: rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length,
  comparison: {
    Better: count('comparison', 'Better'),
    Comparable: count('comparison', 'Comparable'),
    Worse: count('comparison', 'Worse'),
  },
  rows,
};
console.log(JSON.stringify(report, null, 2));
if (report.falseMerges || report.duplicateRisk || report.comparison.Worse) process.exit(1);
