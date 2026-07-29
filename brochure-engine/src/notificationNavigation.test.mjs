import { notificationDestination, SUPER_SEARCH_URL } from './notificationNavigation.js';

function check(name, condition) {
  if (!condition) throw new Error(`FAIL: ${name}`);
  console.log(`ok - ${name}`);
}

check(
  'non-Amazon retailer links go to Super Search',
  notificationDestination(
    { query: ' Snickers   50g ' },
    { store: 'panda', link: 'https://panda.sa/removed' },
  ) === `${SUPER_SEARCH_URL}#/search?q=Snickers+50g`,
);

check(
  'expired brochure links go to Super Search',
  notificationDestination(
    { query: 'Twix' },
    { store: 'othaim', source: 'flyer', link: '#/brochures?brochure=expired' },
  ) === `${SUPER_SEARCH_URL}#/search?q=Twix`,
);

check(
  'Amazon remains the direct exception',
  notificationDestination(
    { kind: 'product', provider: 'amazon', query: 'Echo Dot' },
    { store: 'amazon', link: 'https://www.amazon.sa/dp/B0TEST' },
  ) === 'https://www.amazon.sa/dp/B0TEST',
);

check(
  'a forged Amazon link falls back to Super Search',
  notificationDestination(
    { kind: 'product', provider: 'amazon', query: 'Echo Dot' },
    { store: 'amazon', link: 'https://example.com/not-amazon' },
  ) === `${SUPER_SEARCH_URL}#/search?q=Echo+Dot`,
);

check(
  'registry identity is retained with a canonical query fallback',
  notificationDestination(
    { kind: 'registry', productId: 'pr_twix1', label: 'Twix Chocolate 50g', query: 'chocolate' },
    { store: 'lulu', name: 'Twix 50 g', link: 'https://lulu.example/old' },
  ) === `${SUPER_SEARCH_URL}#/search?q=Twix+Chocolate+50g&product=pr_twix1`,
);

// A PRODUCT-ANCHORED watch carries its `pr_` in registry_product_id, not in
// product_id, and its kind is 'product'/'grocery'. Keying the deep link off
// `kind` dropped it silently for every watch created after the 2026-07-29
// redesign — the alert still worked, it just landed on a bare search.
check(
  'a product-anchored watch keeps its registry deep link',
  notificationDestination(
    {
      kind: 'grocery', registryProductId: 'pr_chick1', productId: '12142',
      label: 'Sadia Chicken Breast 900 g', query: 'chicken breast',
    },
    { store: 'panda', name: 'Sadia Chicken Breast' },
    // An anchored watch prefers its LABEL as the text fallback — the specific
    // product name beats the broad query it was found by.
  ) === `${SUPER_SEARCH_URL}#/search?q=Sadia+Chicken+Breast+900+g&product=pr_chick1`,
);

// A retailer catalog id is NOT a registry id and must never reach `product=`.
check(
  'a bare catalog id is never treated as a registry anchor',
  notificationDestination(
    { kind: 'product', provider: 'panda', productId: '12142', query: 'chicken breast' },
    { store: 'panda' },
  ) === `${SUPER_SEARCH_URL}#/search?q=chicken+breast`,
);

console.log('notification navigation tests passed');
