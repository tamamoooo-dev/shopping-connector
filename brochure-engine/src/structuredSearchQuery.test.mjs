import assert from 'node:assert/strict';
import { structuredSearchQuery } from './structuredSearchQuery.js';
import { notificationDestination, SUPER_SEARCH_URL } from './notificationNavigation.js';

const identityWatch = (identity, extra = {}) => ({
  label: 'Retailer marketing title remains visible',
  sourceSnapshot: JSON.stringify(identity),
  ...extra,
});

assert.equal(structuredSearchQuery(identityWatch({
  family: 'chicken', cut: 'breast', brand: 'sadia',
  processing: 'fresh', variety: 'premium',
})), 'Chicken Breast Sadia');
assert.equal(structuredSearchQuery(identityWatch({
  family: 'milk', processing: 'long life', brand: 'nadec',
})), 'Long Life Milk Nadec');
assert.equal(structuredSearchQuery(identityWatch({
  family: 'kitchen towels', brand: 'uno',
})), 'Kitchen Towels Uno');
assert.equal(structuredSearchQuery(identityWatch({
  family: 'rice', variety: 'basmati', brand: 'Abu Kass',
})), 'Basmati Rice Abu Kass');

const sadia = identityWatch({
  family: 'chicken', cut: 'breast', brand: 'sadia',
  processing: 'fresh', variety: 'premium',
}, {
  kind: 'grocery',
  registryProductId: 'pr_sadia1',
  label: 'Fresh Boneless Premium Sadia Chicken Breast Tender 900 g',
  query: 'Fresh Boneless Premium Sadia Chicken Breast Tender 900 g',
});
const before = sadia.label;
assert.equal(
  notificationDestination(sadia, { store: 'panda' }),
  `${SUPER_SEARCH_URL}#/search?q=Chicken+Breast+Sadia&product=pr_sadia1`,
);
assert.equal(sadia.label, before, 'query generation must not mutate the displayed title');

console.log('structuredSearchQuery.test: 6 passed, 0 failed');
