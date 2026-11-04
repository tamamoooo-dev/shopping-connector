// The /minimarts routes (engine.js) over the real schema: add a shop by link,
// list shops + live offers, serve an offer's picture, remove a shop.
import assert from 'node:assert/strict';
import { handleRequest } from './engine.js';
import { createMinimartStore } from './storage/minimartStore.js';
import { createSqliteD1 } from './storage/testSqliteD1.mjs';

const BASE = 'https://engine.test';
const call = (ctx, path, init) => handleRequest(new Request(`${BASE}${path}`, init), ctx);

function pageHtml(pageProps) {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script>`;
}
const PAGES = {
  't.sshoco': pageHtml({
    userProfile: { $case: 'publicProfileInfo', publicProfileInfo: { title: 'وقت التحليهـ', address: 'الروابي' } },
    story: { snapList: [{
      snapId: { value: 'R38XrLDwQ5SH2jq-2SFujQ' },
      snapMediaType: 0,
      timestampInSec: { value: '1793738741' },
      snapUrls: { mediaUrl: 'https://cf-st.sc-cdn.net/d/a', mediaPreviewUrl: { value: 'https://cf-st.sc-cdn.net/d/a-cover' } },
    }] },
  }),
  someone: pageHtml({ userProfile: { $case: 'userInfo', userInfo: { displayName: 'Someone' } } }),
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const user = decodeURIComponent(String(url).split('/add/')[1] || '');
  return PAGES[user] ? new Response(PAGES[user], { status: 200 }) : new Response('', { status: 404 });
};

const objects = new Map([['minimarts/t.sshoco/R38XrLDwQ5SH2jq-2SFujQ-photo.jpg', new Uint8Array([0xff, 0xd8, 0xff])]]);
const storageBucket = { async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; } };

const fixture = createSqliteD1(['schema.sql']);
try {
  const minimartStore = createMinimartStore(fixture.db);
  const ctx = { minimartStore, storageBucket };

  let res = await call(ctx, '/minimarts/shops', { method: 'POST', body: JSON.stringify({ link: 'https://www.snapchat.com/add/t.sshoco?share_id=x' }) });
  assert.equal(res.status, 201);
  let out = await res.json();
  assert.equal(out.shop.username, 't.sshoco');
  assert.equal(out.shop.title, 'وقت التحليهـ');
  assert.equal(out.shop.status, 'ok');
  assert.equal(out.queued, 1);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');

  res = await call(ctx, '/minimarts/shops', { method: 'POST', body: JSON.stringify({ link: 'someone' }) });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, 'not_public');
  res = await call(ctx, '/minimarts/shops', { method: 'POST', body: JSON.stringify({ link: 'nobody-here' }) });
  assert.equal(res.status, 404);
  res = await call(ctx, '/minimarts/shops', { method: 'POST', body: JSON.stringify({ link: 'https://instagram.com/x' }) });
  assert.equal(res.status, 400);

  await minimartStore.insertOffers([{
    id: 'R38XrLDwQ5SH2jq-2SFujQ:1', username: 't.sshoco', snapId: 'R38XrLDwQ5SH2jq-2SFujQ', name: 'لبنة تركية', brand: null,
    size: null, count: 4, unit: 'حبات', price: 11.5, wasPrice: 14, imageKey: 'minimarts/t.sshoco/R38XrLDwQ5SH2jq-2SFujQ-photo.jpg',
    postedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), votes: 2, createdAt: new Date().toISOString(),
  }]);
  res = await call(ctx, '/minimarts');
  out = await res.json();
  assert.deepEqual(out.shops.map((s) => s.username), ['t.sshoco']);
  assert.equal(out.offers.length, 1);
  assert.equal(out.offers[0].perUnit, 2.88);
  assert.equal(out.offers[0].imageKey, undefined);
  assert.equal(out.offers[0].image, '/minimarts/image?key=minimarts%2Ft.sshoco%2FR38XrLDwQ5SH2jq-2SFujQ-photo.jpg');

  res = await call(ctx, out.offers[0].image);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  res = await call(ctx, '/minimarts/image?key=brochures/secret.json');
  assert.equal(res.status, 404);

  res = await call(ctx, '/minimarts/shops?username=t.sshoco', { method: 'DELETE' });
  assert.equal(res.status, 200);
  out = await (await call(ctx, '/minimarts')).json();
  assert.equal(out.shops.length, 0);
  assert.equal(out.offers.length, 0);
} finally {
  globalThis.fetch = realFetch;
  fixture.close();
}

console.log('minimartsRoutes.test.mjs OK');
