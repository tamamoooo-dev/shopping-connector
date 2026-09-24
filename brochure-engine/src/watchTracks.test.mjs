import assert from 'node:assert/strict';
import {
  buildWatch, checkWatch, customSearchDecision, MONITOR_PROVIDERS, RESOLUTION,
  watchAnchor, watchTarget,
} from './monitor.js';
import { createMemoryWatchStore } from './storage/local.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };

const built = buildWatch({
  profileId: 'profile-tracks-1',
  kind: 'grocery',
  provider: 'panda',
  productId: 'catalog-123',
  query: 'حليب نادك كامل الدسم 1 لتر',
  label: 'حليب نادك كامل الدسم 1 لتر',
  brand: 'نادك',
  sizeText: '1 لتر',
  targetPrice: 7,
  customSearchQuery: 'حليب نادك',
  listing: {
    id: 'catalog-123', provider: 'panda', name: 'حليب نادك كامل الدسم 1 لتر',
    brand: 'نادك', size: '1 لتر',
  },
});
assert.equal(built.error, undefined, built.error);
ok(built.watch.watchTrack === 'market_general', 'non-Amazon-linked product uses general track');
const spec = JSON.parse(built.watch.spec);
ok(spec.family === 'milk' && spec.brand === 'nadec' && spec.size == null,
  'general identity keeps product + brand but not package size');

const calls = [];
const watchStore = createMemoryWatchStore();
await watchStore.create(built.watch);
const line = await checkWatch({
  watchStore,
  searchClient: {
    async search(provider, query) {
      calls.push({ provider, query });
      return [];
    },
  },
}, built.watch);
ok(line.resolution === RESOLUTION.NOT_FOUND, 'a complete empty sweep is a trustworthy not-found round');
ok(new Set(calls.map((call) => call.provider)).size === MONITOR_PROVIDERS.length,
  'general track searches every configured source');
ok(calls.some((call) => call.provider === 'amazon'), 'general track includes Amazon');
ok(calls.every((call) => call.query === 'حليب نادك'), 'advanced search phrase overrides retrieval wording');

const advanced = { customSearchQuery: 'تندرينا 185' };
ok(customSearchDecision(advanced, {
  name: 'Goody Tenderina Soft Tuna', brand: 'Goody', size: '185 g',
}).matched, 'advanced Arabic product-line phrase matches the English catalogue spelling');
ok(!customSearchDecision(advanced, {
  name: 'قودي تونة مفتتة علبة 185 جم', brand: 'قودي', size: '185 جرام',
}).matched, 'advanced product name rejects a same-brand same-family look-alike');
ok(!customSearchDecision(advanced, {
  name: 'قودي تندرينا تونا ناعمة 80 جم', brand: 'قودي', size: '80 جرام',
}).matched, 'advanced package number rejects the wrong size');
ok(customSearchDecision(advanced, {
  name: 'تندرينا تونه ناعمه', brand: 'قودي', size: '',
  link: 'https://danube.sa/ar/products/goody-tenderina-soft-tuna-185g',
}).matched, 'an online product slug may supply missing size evidence');

const tenderina = buildWatch({
  profileId: 'profile-tracks-3',
  kind: 'product', provider: 'danube', productId: '2669',
  query: 'تندرينا تونه ناعمه', label: 'تندرينا تونه ناعمه',
  brand: 'قودي', sizeText: '185 غرام', targetPrice: 100,
  customSearchQuery: 'تندرينا 185',
  listing: {
    id: '2669', provider: 'danube', name: 'تندرينا تونه ناعمه',
    brand: 'قودي', size: '185 غرام',
  },
});
assert.equal(tenderina.error, undefined, tenderina.error);
const tenderinaStore = createMemoryWatchStore();
await tenderinaStore.create(tenderina.watch);
const candidates = {
  panda: [{ id: 'lookalike', name: 'قودي تونة مفتتة علبة 185 جم', brand: 'قودي', size: '185 جرام', price: 1 }],
  tamimi: [{ id: 'exact', name: 'تونة تندرينا ناعمة', brand: 'قودي', size: '185 غرام', price: 7 }],
  ninja: [{ id: 'wrong-size', name: 'قودي تندرينا تونا ناعمة 80 جم', brand: 'قودي', size: '80 جرام', price: 0.5 }],
};
const tenderinaLine = await checkWatch({
  watchStore: tenderinaStore,
  searchClient: {
    async search(provider) { return candidates[provider] || []; },
  },
}, tenderina.watch);
ok(tenderinaLine.resolution === RESOLUTION.OK, 'advanced phrase still resolves a matching product');
const checkedTenderina = await tenderinaStore.get(tenderina.watch.id);
ok(checkedTenderina.lastStore === 'tamimi' && checkedTenderina.lastPurchasePrice === 7,
  'only the candidate matching the advanced name and size can become the result');

const generic = buildWatch({
  profileId: 'profile-tracks-2', kind: 'grocery', query: 'حليب طويل الأجل',
  label: 'حليب طويل الأجل', targetPrice: 50,
  listing: { name: 'حليب طويل الأجل' },
});
assert.equal(generic.error, undefined, generic.error);
assert.deepEqual(watchTarget(generic.watch, watchAnchor(generic.watch)), {
  value: 50, unitLabel: null,
}, 'a size-less general watch falls back to the listed purchase price');

console.log(`watchTracks.test: ${passed + 1} passed, 0 failed`);
