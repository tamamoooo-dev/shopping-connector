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

console.log('notification navigation tests passed');
