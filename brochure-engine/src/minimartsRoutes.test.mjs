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
const storageBucket = {
  async get(key) { return objects.has(key) ? { body: objects.get(key) } : null; },
  async put(key, bytes) { objects.set(key, bytes); },
  async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
};

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
  // A name and size the picture does not print are never served.
  await minimartStore.insertOffers([{
    id: 'R38XrLDwQ5SH2jq-2SFujQ:2', username: 't.sshoco', snapId: 'R38XrLDwQ5SH2jq-2SFujQ', name: 'مربى الفراولة', shownName: '',
    brand: null, size: '400 جرام', sizePrinted: 0, count: 1, unit: null, price: 37.5, wasPrice: null, imageKey: null,
    postedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString(), votes: 2, createdAt: new Date().toISOString(),
  }]);
  res = await call(ctx, '/minimarts');
  out = await res.json();
  assert.deepEqual(out.shops.map((s) => s.username), ['t.sshoco']);
  const guessed = out.offers.find((o) => o.price === 37.5);
  assert.deepEqual([guessed.name, guessed.size, guessed.shownName], [null, null, undefined]);
  out.offers = out.offers.filter((o) => o !== guessed);
  assert.equal(out.offers.length, 1);
  assert.equal(out.offers[0].name, 'لبنة تركية');
  assert.equal(out.offers[0].perUnit, 2.88);
  assert.equal(out.offers[0].imageKey, undefined);
  assert.equal(out.offers[0].image, '/minimarts/image?key=minimarts%2Ft.sshoco%2FR38XrLDwQ5SH2jq-2SFujQ-photo.jpg');

  res = await call(ctx, out.offers[0].image);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  res = await call(ctx, '/minimarts/image?key=brochures/secret.json');
  assert.equal(res.status, 404);

  // The PC reader's routes need the ingest secret.
  const reader = { ...ctx, ingestSecret: 's3cret' };
  const key = { 'X-Ingest-Secret': 's3cret' };
  res = await call(reader, '/minimarts/reader/queue');
  assert.equal(res.status, 403);
  res = await call(reader, '/minimarts/reader/queue?pictures=10', { headers: key });
  out = await res.json();
  assert.deepEqual(out.snaps, []); // the queued snap is new, not yet prepared
  assert.ok(out.prompt.includes('"Picture 1"'));
  assert.equal((await (await call(reader, '/minimarts/reader/status', { headers: key })).json()).reader.lastRunAt, null);
  res = await call(reader, '/minimarts/reader/reread', { method: 'POST', headers: key, body: '{}' });
  assert.equal(res.status, 400);
  res = await call(reader, '/minimarts/reader/reread', { method: 'POST', headers: key, body: '{"all":true}' });
  assert.deepEqual(await res.json(), { queued: 0 }); // nothing read yet
  res = await call(reader, '/minimarts/reader/readings', { method: 'POST', headers: key, body: JSON.stringify({ snaps: [{ snapId: 'x', pictures: [] }], run: { calls: 0 } }) });
  out = await res.json();
  assert.deepEqual(out.results, [{ snapId: 'x', status: 'conflict' }]);
  assert.equal(out.run.refused, 1);

  // Both Claude accounts at their limit: a short wait is the reader's, a long one Mistral's.
  res = await call(reader, '/minimarts/reader/limit', { method: 'POST', headers: key, body: '{}' });
  assert.equal(res.status, 400);
  const soon = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  res = await call(reader, '/minimarts/reader/limit', { method: 'POST', headers: key, body: JSON.stringify({ until: soon, accounts: { main: soon, backup: soon } }) });
  assert.deepEqual(await res.json(), { limitedUntil: soon, reads: 'reader' });
  const far = new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString();
  res = await call(reader, '/minimarts/reader/limit', { method: 'POST', headers: key, body: JSON.stringify({ until: far }) });
  assert.equal((await res.json()).reads, 'mistral');
  out = await (await call(reader, '/minimarts/reader/status', { headers: key })).json();
  assert.equal(out.reader.limitedUntil, far);
  assert.deepEqual(out.checkProblems, []);

  // The owner's name for a shop (2026-11-14), kept when the profile is read again.
  res = await call(ctx, '/minimarts/shops', { method: 'POST', body: JSON.stringify({ link: 't.sshoco', nameAr: '  كيو ', nameEn: 'Q' }) });
  out = await res.json();
  assert.deepEqual([out.shop.title, out.shop.nameAr, out.shop.nameEn], ['وقت التحليهـ', 'كيو', 'Q']);
  res = await call(ctx, '/minimarts/shops', { method: 'POST', body: JSON.stringify({ link: 't.sshoco' }) });
  assert.deepEqual([(await res.json()).shop.nameAr], ['كيو'], 'left out: unchanged');
  res = await call(ctx, '/minimarts/shops', { method: 'POST', body: JSON.stringify({ link: 't.sshoco', nameEn: '', nameAr: 7 }) });
  out = await res.json();
  assert.deepEqual([out.shop.nameAr, out.shop.nameEn], [null, null], 'empty or not text: cleared');
  await call(ctx, '/minimarts/shops', { method: 'POST', body: JSON.stringify({ link: 't.sshoco', nameAr: 'كيو', nameEn: 'Q' }) });
  out = await (await call(ctx, '/minimarts')).json();
  assert.deepEqual([out.shops[0].nameAr, out.shops[0].nameEn], ['كيو', 'Q']);

  // A presenter shop (2026-11-14): its card shows the product crop, never the frame.
  res = await call(ctx, '/minimarts/shops', { method: 'POST', body: JSON.stringify({ link: 't.sshoco', style: 'presenter' }) });
  assert.equal((await res.json()).shop.style, 'presenter');
  const frameKey = 'minimarts/t.sshoco/R38XrLDwQ5SH2jq-2SFujQ-photo.jpg';
  const lebna = () => call(ctx, '/minimarts').then((r) => r.json()).then((o) => o.offers.find((x) => x.price === 11.5));
  assert.equal((await lebna()).image, null); // no crop yet: no picture
  res = await call(reader, '/minimarts/reader/crops', { headers: key });
  out = await res.json();
  assert.deepEqual(out.offers.map((o) => [o.offerId, o.imageKey, o.name]), [['R38XrLDwQ5SH2jq-2SFujQ:1', frameKey, 'لبنة تركية']]);
  assert.equal(out.offers[0].url, `/minimarts/image?key=${encodeURIComponent(frameKey)}`);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]).toString('base64');
  res = await call(reader, '/minimarts/reader/crops', { method: 'POST', headers: key, body: JSON.stringify({ crops: [
    { offerId: 'R38XrLDwQ5SH2jq-2SFujQ:1', imageKey: frameKey, image: jpeg, kind: 'close', rect: [1, 2, 3, 4] },
    { offerId: 'R38XrLDwQ5SH2jq-2SFujQ:1', imageKey: 'minimarts/t.sshoco/other-f9.jpg', image: jpeg }, // not its picture any more
    { offerId: 'R38XrLDwQ5SH2jq-2SFujQ:2', imageKey: frameKey, image: 'bm90IGEganBlZw==' },
  ] }) });
  out = await res.json();
  assert.deepEqual(out.results.map((r) => r.status), ['cropped', 'conflict', 'invalid']);
  const cropKey = 'minimarts/t.sshoco/R38XrLDwQ5SH2jq-2SFujQ-photo.crop.R38XrLDwQ5SH2jq-2SFujQ-1.jpg';
  assert.ok(objects.has(cropKey));
  assert.ok(!objects.has('minimarts/t.sshoco/other-f9.crop.R38XrLDwQ5SH2jq-2SFujQ-1.jpg'), 'a refused crop is not kept');
  const shownCrop = (await lebna()).image;
  assert.equal(shownCrop, `/minimarts/image?key=${encodeURIComponent(cropKey)}`);
  assert.equal((await call(ctx, shownCrop)).status, 200);
  assert.deepEqual((await (await call(reader, '/minimarts/reader/crops', { headers: key })).json()).offers, []);
  // None stood: answered, and no picture.
  await minimartStore.saveCrop('R38XrLDwQ5SH2jq-2SFujQ:1', frameKey, null);
  assert.equal((await lebna()).image, null);
  // The style turned off: the frame again.
  res = await call(ctx, '/minimarts/shops', { method: 'POST', body: JSON.stringify({ link: 't.sshoco', style: null }) });
  assert.equal((await res.json()).shop.style, null);
  assert.equal((await lebna()).image, `/minimarts/image?key=${encodeURIComponent(frameKey)}`);

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
