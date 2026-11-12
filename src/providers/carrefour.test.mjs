// Carrefour: never asked by the server; the owner's own browser's answer is
// normalized, and nothing in it is trusted as an address.
import assert from 'node:assert/strict';
import { handleRequest } from '../connector.js';
import { carrefourProvider } from './carrefour.js';

const card = (over = {}) => ({
  productId: 55,
  productName: 'حليب طازج 2 لتر',
  sellingPrice: 11.5,
  markedPrice: 13,
  currency: 'SAR',
  productUrl: '/mafsau/ar/p/55',
  imageUrl: 'https://cdn.example/x.jpg',
  isSoldByWeight: false,
  ...over,
});
const registry = { carrefour: carrefourProvider };
const search = (options) => handleRequest(new Request('https://connector.test/search?provider=carrefour&q=milk'), registry, options);

{
  // No code: blocked, and no request leaves for Carrefour (the strategy only throws).
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => ((fetched += 1), new Response('{}'));
  const res = await search({});
  globalThis.fetch = realFetch;
  assert.equal(res.status, 403);
  assert.equal((await res.json()).blocked, true);
  assert.equal(fetched, 0);
}
{
  const res = await search({ relayKey: 'ABCDEFGH2345', relay: async () => ({ state: 'ok', products: [card()] }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.via, 'browser');
  assert.deepEqual(body.results[0], {
    id: '55',
    name: 'حليب طازج 2 لتر',
    image: 'https://cdn.example/x.jpg',
    price: 11.5,
    oldPrice: 13,
    currency: 'SAR',
    link: 'https://www.carrefourksa.com/mafsau/ar/p/55',
    size: '',
    brand: '',
    discountLabel: '12% Off',
  });
}
{
  // The page came without its data: the app is told to open the store's site once.
  const res = await search({ relayKey: 'ABCDEFGH2345', relay: async () => ({ state: 'no-price' }) });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).relay, 'no-price');
}
{
  const results = carrefourProvider.fromBrowser({
    products: [
      card({ productId: 1, productUrl: 'https://evil.example/x' }),
      card({ productId: 2, productUrl: '/mafsau/ar//evil.example' }),
      card({ productId: 3, imageUrl: 'http://cdn.example/x.jpg' }),
      card({ productId: 4, isSoldByWeight: true }),
      card({ productId: 5, currency: 'AED' }),
      card({ productId: 6, sellingPrice: 0 }),
      card({ productId: 7, markedPrice: 11.5 }),
      card({ productId: 7 }),
      card({ productId: 8, productName: '  ' }),
      null,
    ],
  });
  assert.deepEqual(results.map((r) => r.id), ['3', '7']);
  assert.equal(results[0].image, '', 'an image must be https');
  assert.equal(results[1].oldPrice, null, 'the same marked price is no old price');
}

console.log('carrefour.test: ok');
