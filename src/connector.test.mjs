import assert from 'node:assert/strict';
import { handleRequest } from './connector.js';

const ASIN = 'B012345678';
const exact = { id: ASIN, name: 'Exact variation', price: 99 };
let mode = 'exact';
const registry = {
  amazon: {
    id: 'amazon',
    strategies: [],
    async lookup(id) {
      assert.equal(id, ASIN);
      if (mode === 'fail') throw new Error('unreachable');
      if (mode === 'similar') return { ...exact, id: 'B999999999' };
      return exact;
    },
  },
};

let response = await handleRequest(
  new Request(`https://connector.test/product?provider=amazon&id=${ASIN}`),
  registry,
);
assert.equal(response.status, 200);
assert.deepEqual((await response.json()).product, exact);

mode = 'similar';
response = await handleRequest(
  new Request(`https://connector.test/product?provider=amazon&id=${ASIN}`),
  registry,
);
assert.equal(response.status, 502, 'a similar ASIN is never accepted');

mode = 'fail';
response = await handleRequest(
  new Request(`https://connector.test/product?provider=amazon&id=${ASIN}`),
  registry,
);
assert.equal(response.status, 502, 'unreachable exact product stays a retryable upstream failure');

// /search: "no match" (a strategy answered with nothing) is a 200 answer;
// only "every strategy threw" is the 502 an outage deserves.
const search = (provider) => handleRequest(
  new Request(`https://connector.test/search?provider=${provider}&q=milk`),
  {
    found: { id: 'found', strategies: [{ name: 'a', run: async () => [{ id: '1', name: 'Milk' }] }] },
    empty: { id: 'empty', strategies: [{ name: 'a', run: async () => [] }] },
    mixed: {
      id: 'mixed',
      strategies: [
        { name: 'a', run: async () => { throw new Error('HTTP 503'); } },
        { name: 'b', run: async () => [] },
      ],
    },
    down: {
      id: 'down',
      strategies: [
        { name: 'a', run: async () => { throw new Error('HTTP 503'); } },
        { name: 'b', run: async () => { throw new Error('blocked'); } },
      ],
    },
  },
);

response = await search('found');
assert.equal(response.status, 200);
assert.equal((await response.json()).count, 1);

response = await search('empty');
assert.equal(response.status, 200, 'no match is an answer, not an outage');
let body = await response.json();
assert.equal(body.count, 0);
assert.deepEqual(body.results, []);
assert.equal(body.empty, true);

response = await search('mixed');
assert.equal(response.status, 200, 'one strategy failing while another answers empty is still an answer');
body = await response.json();
assert.equal(body.empty, true);
assert.equal(body.strategy, 'b');
assert.ok(body.failures.some((f) => f.includes('HTTP 503')), 'the failed strategy stays visible');

response = await search('down');
assert.equal(response.status, 502, 'every strategy failing is an outage');
assert.equal((await response.json()).error, 'No strategy returned results.');

console.log('connector.test: exact product route + search answers passed');
