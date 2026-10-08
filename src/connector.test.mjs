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

console.log('connector.test: exact product route passed');
