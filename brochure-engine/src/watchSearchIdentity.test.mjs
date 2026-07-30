import assert from 'node:assert/strict';
import { handleRequest } from './engine.js';
import { notificationDestination, SUPER_SEARCH_URL } from './notificationNavigation.js';
import { createMemRegistryStore } from './registry/memstore.js';
import { createMemoryWatchStore } from './storage/local.js';
import {
  registryProductSearchIdentity,
  watchesWithSearchIdentity,
} from './watchSearchIdentity.js';

const PROFILE = 'profile-search-identity-1';
const product = {
  id: 'pr_sadia1',
  status: 'active',
  merged_into: null,
  kind: 'product',
  display_name: 'Sadia Chicken Breast',
  display_name_ar: null,
  display_corroboration: 1,
  display_week: '2026-07-30',
  brand_slug: 'sadia',
  brand_text: 'Sadia',
  size_unit: 'g',
  size_total: 1000,
  size_pack: 1,
  family: 'Chicken',
  category: null,
  token_profile: JSON.stringify({
    sadia: { count: 12, week: '2026-07-30' },
    chicken: { count: 12, week: '2026-07-30' },
    breast: { count: 12, week: '2026-07-30' },
    'family:chicken': { count: 12, week: '2026-07-30' },
    'cut:breast': { count: 12, week: '2026-07-30' },
  }),
  sightings: 12,
  stores_seen: '["panda"]',
  first_seen: '2026-07-01',
  last_seen: '2026-07-30',
  review_flag: null,
  algo_version: 2,
};
const watch = {
  id: 'w_sadia_legacy',
  profileId: PROFILE,
  kind: 'grocery',
  label: 'Fresh Boneless Premium Sadia Chicken Breast Tender 1 kg',
  query: 'Fresh Boneless Premium Sadia Chicken Breast Tender',
  registryProductId: product.id,
  anchorState: 'anchored_registry',
  sourceSnapshot: null,
  targetPrice: 20,
  active: true,
};

assert.deepEqual(registryProductSearchIdentity(product), {
  family: 'Chicken',
  category: null,
  cut: 'breast',
  processing: null,
  variety: null,
  brand: 'Sadia',
});

const registryStore = createMemRegistryStore();
await registryStore.createProduct(product, Object.keys(JSON.parse(product.token_profile)));
const projected = await watchesWithSearchIdentity(registryStore, [watch]);
assert.equal(projected[0].searchIdentity.cut, 'breast');
assert.equal(watch.searchIdentity, undefined, 'runtime projection does not mutate stored identity');
assert.equal(
  notificationDestination(projected[0], { store: 'panda' }),
  `${SUPER_SEARCH_URL}#/search?q=Chicken+Breast+Sadia&product=pr_sadia1`,
);

const watchStore = createMemoryWatchStore();
await watchStore.create(watch);
const response = await handleRequest(
  new Request(`https://engine.test/watches?profile=${PROFILE}`),
  { watchStore, registryStore },
);
const body = await response.json();
assert.equal(response.status, 200);
assert.equal(body.watches[0].searchIdentity.family, 'Chicken');
assert.equal((await watchStore.get(watch.id)).searchIdentity, undefined);

console.log('watchSearchIdentity.test: 8 passed, 0 failed');
