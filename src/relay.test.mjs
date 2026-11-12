// "Search with my own browser": the code, the meeting point, the connector's
// fallback and Lulu's mapping of what the browser sent.
import assert from 'node:assert/strict';
import { handleRequest } from './connector.js';
import { BrowserRelay, cleanKey, relayAnswer, relayRoutes } from './relay.js';
import { luluProvider } from './providers/lulu.js';

// --- the code as people type it ---------------------------------------------------
assert.equal(cleanKey('abcd-efgh-2345'), 'ABCDEFGH2345');
assert.equal(cleanKey(' ABCD EFGH 2345 '), 'ABCDEFGH2345');
assert.equal(cleanKey('ABCD-EFGH-2389'), null, '8 and 9 are not in the alphabet, so this code is short');
assert.equal(cleanKey('A0CD-EF1H-2345'), 'AOCDEFIH2345', '0 is read as O and 1 as I');
assert.equal(cleanKey('ABCDEFGH234'), null, 'too short');
assert.equal(cleanKey('ABCDEFGH23456'), null, 'too long');
assert.equal(cleanKey(''), null);
assert.equal(cleanKey(null), null);

// --- what the browser said -> one state --------------------------------------------
assert.deepEqual(relayAnswer({ paused: true }), { state: 'paused' });
assert.equal(relayAnswer({ refused: true, status: 403 }).state, 'refused');
assert.equal(relayAnswer({ stopped: true, until: '2026-11-12T10:00:00.000Z' }).until, '2026-11-12T10:00:00.000Z');
assert.equal(relayAnswer({ error: 'x' }).state, 'error');
assert.equal(relayAnswer({}).state, 'error');
assert.equal(relayAnswer({ products: Array.from({ length: 80 }, () => ({})) }).products.length, 60, 'at most 60 products are taken');

// --- the meeting point ---------------------------------------------------------------
function fakeState(sockets) {
  return { getWebSockets: () => sockets };
}
function fakeSocket(reply) {
  const ws = { readyState: 1, sent: [], relay: null };
  ws.send = (text) => {
    ws.sent.push(JSON.parse(text));
    if (reply) queueMicrotask(() => ws.relay.webSocketMessage(ws, JSON.stringify({ id: ws.sent.at(-1).id, ...reply(ws.sent.at(-1)) })));
  };
  return ws;
}

{
  const relay = new BrowserRelay(fakeState([]));
  assert.deepEqual(await relay.ask('lulu', 'milk'), { state: 'offline' }, 'no browser connected');
}
{
  const ws = fakeSocket((ask) => ({ locale: 'ar-sa', products: [{ pk: 1, name: ask.query }], ms: 900 }));
  const relay = new BrowserRelay(fakeState([ws]));
  ws.relay = relay;
  const first = await relay.ask('lulu', 'milk');
  assert.equal(first.state, 'ok');
  assert.equal(first.products[0].name, 'milk');
  assert.deepEqual(Object.keys(ws.sent[0]).sort(), ['id', 'query', 'store'], 'the browser is sent the store and the words, nothing else');
  const again = await relay.ask('lulu', 'milk');
  assert.equal(again.cached, true, 'the same search within 5 minutes is not asked twice');
  assert.equal(ws.sent.length, 1);
  await relay.ask('lulu', 'milk', Date.now() + 6 * 60 * 1000);
  assert.equal(ws.sent.length, 2, 'after 5 minutes it is asked again');
}
{
  // A refusal is passed on and never kept.
  const ws = fakeSocket(() => ({ refused: true, status: 403 }));
  const relay = new BrowserRelay(fakeState([ws]));
  ws.relay = relay;
  assert.equal((await relay.ask('lulu', 'milk')).state, 'refused');
  assert.equal((await relay.ask('lulu', 'milk')).state, 'refused');
  assert.equal(ws.sent.length, 2, 'the extension decides to stop; the meeting point does not hide it');
}
{
  // 40 searches in 10 minutes at most.
  const ws = fakeSocket((ask) => ({ products: [], locale: 'ar-sa', q: ask.query }));
  const relay = new BrowserRelay(fakeState([ws]));
  ws.relay = relay;
  for (let i = 0; i < 40; i += 1) assert.equal((await relay.ask('lulu', `q${i}`)).state, 'ok');
  assert.equal((await relay.ask('lulu', 'one more')).state, 'busy');
  assert.equal(ws.sent.length, 40);
}
{
  // A closed socket does not count as a browser.
  const ws = fakeSocket();
  ws.readyState = 3;
  assert.equal((await new BrowserRelay(fakeState([ws])).ask('lulu', 'milk')).state, 'offline');
}

// --- the routes --------------------------------------------------------------------------
{
  const url = (path) => new URL(`https://connector.test${path}`);
  assert.equal(await relayRoutes(new Request('https://connector.test/search'), {}, url('/search')), null, 'other paths are not the relay');
  const noBinding = await relayRoutes(new Request('https://connector.test/relay/status'), {}, url('/relay/status'));
  assert.equal(noBinding.status, 503);
  const calls = [];
  const env = {
    RELAY: {
      idFromName: (name) => name,
      get: (id) => ({
        fetch: async (input) => {
          calls.push([id, new URL(typeof input === 'string' ? input : input.url).pathname]);
          return Response.json({ connected: true });
        },
      }),
    },
  };
  const noKey = await relayRoutes(new Request('https://connector.test/relay/status'), env, url('/relay/status'));
  assert.equal(noKey.status, 401, 'no code, no answer');
  const ok = await relayRoutes(
    new Request('https://connector.test/relay/status', { headers: { 'X-Relay-Key': 'abcd-efgh-2345' } }),
    env,
    url('/relay/status'),
  );
  assert.deepEqual(await ok.json(), { connected: true });
  assert.deepEqual(calls, [['ABCDEFGH2345', '/status']]);
  const plain = await relayRoutes(new Request('https://connector.test/relay/connect'), env, url('/relay/connect'));
  assert.equal(plain.status, 426, 'connect is a WebSocket only');
  const badCode = await relayRoutes(
    new Request('https://connector.test/relay/connect', { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'lsa-relay, short' } }),
    env,
    url('/relay/connect'),
  );
  assert.equal(badCode.status, 401);
  const preflight = await relayRoutes(new Request('https://connector.test/relay/status', { method: 'OPTIONS' }), env, url('/relay/status'));
  assert.match(preflight.headers.get('Access-Control-Allow-Headers'), /X-Relay-Key/);
}

// --- the connector's fallback ---------------------------------------------------------
const blockedStore = {
  id: 'lulu',
  label: 'Lulu',
  strategies: [
    {
      name: 'direct',
      run: async () => {
        const err = new Error('HTTP 403');
        err.blocked = true;
        throw err;
      },
    },
  ],
  fromBrowser: luluProvider.fromBrowser,
};
const product = (over = {}) => ({
  pk: 7,
  name: 'حليب المراعي 2 لتر',
  price: '12.500',
  retail_price: '14.000',
  currency_type: 'sar',
  absolute_url: '/almarai-milk-2l/',
  productimage_set: [{ image: 'https://cdn.example/milk.jpg' }],
  attributes: { brand: 'Almarai' },
  ...over,
});
const search = (headers, relay, registry = { lulu: blockedStore }) =>
  handleRequest(new Request('https://connector.test/search?provider=lulu&q=milk', { headers }), registry, relay);

{
  // No code: the store is blocked, as before, and the browser is never asked.
  let asked = 0;
  const res = await search({}, { relay: async () => ((asked += 1), { state: 'ok', products: [] }), relayKey: null });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.blocked, true);
  assert.equal('relay' in body, false);
  assert.equal(asked, 0);
}
{
  // With the code: the browser answers and the results look like any store's.
  const asks = [];
  const res = await search(
    {},
    {
      relayKey: 'ABCDEFGH2345',
      relay: async (key, ask) => {
        asks.push([key, ask]);
        return { state: 'ok', locale: 'ar-sa', products: [product(), product({ pk: 8, price: '99999', name: 'no price' })] };
      },
    },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(asks, [['ABCDEFGH2345', { store: 'lulu', query: 'milk' }]]);
  assert.equal(body.via, 'browser');
  assert.equal(body.strategy, 'browser-relay');
  assert.equal(body.count, 1, 'a product without a real price is left out');
  assert.deepEqual(body.results[0], {
    id: 7,
    name: 'حليب المراعي 2 لتر',
    image: 'https://cdn.example/milk.jpg',
    price: 12.5,
    oldPrice: 14,
    currency: 'SAR',
    link: 'https://gcc.luluhypermarket.com/ar-sa/almarai-milk-2l/',
    size: '',
    brand: 'Almarai',
    discountLabel: '11% Off',
  });
}
{
  // The browser is not connected, or the store refused it: still "blocked", with the reason.
  for (const state of ['offline', 'refused', 'stopped', 'timeout', 'paused', 'busy']) {
    const res = await search({}, { relayKey: 'ABCDEFGH2345', relay: async () => ({ state }) });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.blocked, true);
    assert.equal(body.relay, state);
  }
}
{
  // Every price is the placeholder: no region chosen in the browser. Never shown as prices.
  const res = await search(
    {},
    { relayKey: 'ABCDEFGH2345', relay: async () => ({ state: 'ok', locale: null, products: [product({ price: '99999' }), product({ pk: 9, price: 99999 })] }) },
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).relay, 'no-price');
}
{
  // The store has no match: an empty answer, not an error.
  const res = await search({}, { relayKey: 'ABCDEFGH2345', relay: async () => ({ state: 'ok', locale: 'ar-sa', products: [] }) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.empty, true);
  assert.equal(body.count, 0);
}
{
  // A store that answers this Worker is never sent to the browser.
  let asked = 0;
  const open = { lulu: { ...blockedStore, strategies: [{ name: 'direct', run: async () => [{ id: 1, name: 'x', price: 1 }] }] } };
  const res = await search({}, { relayKey: 'ABCDEFGH2345', relay: async () => ((asked += 1), { state: 'ok', products: [] }) }, open);
  assert.equal(res.status, 200);
  assert.equal(asked, 0);
}
{
  // A store with no browser reader stays blocked even with a code.
  let asked = 0;
  const noReader = { lulu: { ...blockedStore, fromBrowser: undefined } };
  const res = await search({}, { relayKey: 'ABCDEFGH2345', relay: async () => ((asked += 1), { state: 'ok', products: [] }) }, noReader);
  assert.equal(res.status, 403);
  assert.equal(asked, 0);
}
{
  const res = await handleRequest(new Request('https://connector.test/search', { method: 'OPTIONS' }), {});
  assert.match(res.headers.get('Access-Control-Allow-Headers'), /X-Relay-Key/);
}

// --- Lulu: nothing from the browser is trusted as an address ------------------------
{
  const results = luluProvider.fromBrowser({
    locale: 'xx-yy',
    products: [
      product({ pk: 1, absolute_url: '//evil.example/x' }),
      product({ pk: 2, absolute_url: 'https://evil.example/x' }),
      product({ pk: 3, productimage_set: [{ image: 'javascript:alert(1)' }] }),
      product({ pk: 4, retail_price: '99999' }),
      product({ pk: 5, price: '0' }),
      product({ pk: 6, name: '   ' }),
      null,
      'text',
    ],
  });
  assert.deepEqual(results.map((r) => r.id), [3, 4]);
  assert.equal(results[0].image, '', 'an image must be https');
  assert.equal(results[0].link, 'https://gcc.luluhypermarket.com/ar-sa/almarai-milk-2l/', 'an unknown locale falls back to ar-sa');
  assert.equal(results[1].oldPrice, null, 'a placeholder old price is no old price');
  assert.equal(results[1].discountLabel, '');
}

console.log('relay.test: ok');

// --- Lulu set to another country in the browser: its prices are not riyals ------------
{
  assert.throws(
    () => luluProvider.fromBrowser({ locale: 'ar-sa', products: [product({ currency_type: 'aed' })] }),
    (err) => err.relayState === 'no-price',
  );
  assert.equal(luluProvider.fromBrowser({ locale: 'ar-sa', products: [product({ currency_type: 'aed' }), product({ pk: 2 })] }).length, 1);
}

console.log('relay.test: currency ok');
