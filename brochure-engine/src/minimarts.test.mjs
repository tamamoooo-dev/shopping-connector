import assert from 'node:assert/strict';
import {
  parseShopLink,
  parseProfilePage,
  mp4DurationSec,
  frameTimes,
  parseSnapReading,
  confirmed,
  agreePhoto,
  groupFrames,
  dropOldPriceTwins,
  similarNames,
  sameDeal,
  sameProduct,
  runMinimartTick,
  readSnap,
  BLOCKED_RETRY_MS,
  OFFER_TTL_MS,
} from './minimarts.js';
import { createMinimartStore } from './storage/minimartStore.js';
import { createSqliteD1 } from './storage/testSqliteD1.mjs';

// --- shop links ---------------------------------------------------------------------
assert.deepEqual(parseShopLink('sweet-st'), { username: 'sweet-st' });
assert.deepEqual(parseShopLink('@T.SShoco'), { username: 't.sshoco' });
assert.deepEqual(parseShopLink('https://www.snapchat.com/add/mazaya.t?share_id=abc&locale=ar-SA'), { username: 'mazaya.t' });
assert.deepEqual(parseShopLink('شوف العروض https://snapchat.com/@albarakaoffers'), { username: 'albarakaoffers' });
assert.deepEqual(parseShopLink('story.snapchat.com/@t.sshoco'), { username: 't.sshoco' });
assert.deepEqual(parseShopLink('https://snapchat.com/t/AbC123'), { shortLink: 'https://www.snapchat.com/t/AbC123' });
assert.equal(parseShopLink('https://instagram.com/sweet_stt'), null);
assert.equal(parseShopLink('1abc'), null);
assert.equal(parseShopLink(''), null);

// --- the public profile page ------------------------------------------------------------
function pageHtml(pageProps) {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script></html>`;
}
function snapEntry(id, kind, seconds, url, extra = {}) {
  return {
    snapId: { value: id },
    snapMediaType: kind,
    timestampInSec: { value: String(seconds) },
    snapUrls: { mediaUrl: url, mediaPreviewUrl: { value: `${url}-cover` } },
    ...extra,
  };
}
const publicProfile = (snaps) => ({
  userProfile: { $case: 'publicProfileInfo', publicProfileInfo: { title: 'وقت التحليهـ', address: 'الروابي', profilePictureUrl: 'https://p/pic.jpg' } },
  story: { snapList: snaps },
});

{
  const page = parseProfilePage(200, pageHtml(publicProfile([
    snapEntry('a1', 0, 1793738741, 'https://cdn/a1'),
    snapEntry('v1', 1, 1793738800, 'https://cdn/v1'),
    snapEntry('ad', 0, 1793738900, 'https://cdn/ad', { isSponsored: true }),
    snapEntry('x', 5, 1793738900, 'https://cdn/x'),
  ])));
  assert.equal(page.status, 'ok');
  assert.equal(page.profile.title, 'وقت التحليهـ');
  assert.deepEqual(page.snaps.map((s) => [s.id, s.mediaType]), [['a1', 'image'], ['v1', 'video']]);
  assert.equal(page.snaps[0].postedAt, new Date(1793738741 * 1000).toISOString());
  assert.equal(page.snaps[1].previewUrl, 'https://cdn/v1-cover');
}
assert.equal(parseProfilePage(200, pageHtml({ userProfile: { $case: 'userInfo', userInfo: { displayName: 'x' } } })).status, 'not_public');
assert.equal(parseProfilePage(403, '').status, 'blocked');
assert.equal(parseProfilePage(429, '').status, 'blocked');
assert.equal(parseProfilePage(200, '<html>cf-chl challenge</html>').status, 'blocked');
assert.equal(parseProfilePage(404, '').status, 'not_found');
assert.equal(parseProfilePage(200, pageHtml(publicProfile([]))).snaps.length, 0);

// --- video frames --------------------------------------------------------------------------
function fakeMp4(durationSec, timescale = 1000) {
  const bytes = new Uint8Array(64);
  bytes.set([0x6d, 0x76, 0x68, 0x64], 8); // 'mvhd' at 8, version 0 at 12
  const view = new DataView(bytes.buffer);
  view.setUint32(12 + 12, timescale);
  view.setUint32(12 + 16, Math.round(durationSec * timescale));
  return bytes;
}
assert.equal(mp4DurationSec(fakeMp4(10.032)), 10.032);
assert.equal(mp4DurationSec(new Uint8Array(100)), null);
assert.deepEqual(frameTimes(3.2), [0.5, 1.5, 2.5]);
assert.deepEqual(frameTimes(0.7), [0.5]);
assert.equal(frameTimes(60).length, 15);
assert.ok(frameTimes(60).every((t) => t < 60));
assert.equal(frameTimes(null).length, 10);
assert.deepEqual(frameTimes(10, 0), []);

// --- readings --------------------------------------------------------------------------------
{
  const offers = parseSnapReading(JSON.stringify({ offers: [
    { name: 'لبنة تركية', price: 11.5, was_price: 27.75, count: 1 },
    { name: 'جبنة', price: '6.90', was_price: 5, count: 4, unit: 'حبة' },
    { name: 'bad', price: 0 },
    { name: 'huge', price: 99999 },
    { name: 'x', price: 3, count: 500, brand: 'null' },
  ] }));
  assert.deepEqual(offers.map((o) => [o.price, o.wasPrice, o.count]), [[11.5, 27.75, 1], [6.9, null, 4], [3, null, 1]]);
  assert.equal(offers[2].brand, null);
  // 24 cans in one carton (7up, measured): pieces, not 24 cartons; 2 cartons stay cartons.
  const packs = parseSnapReading({ offers: [
    { name: '7up', price: 20.7, count: 24, unit: 'كرتون' },
    { name: 'جبنة شيدر', price: 15, count: 2, unit: 'كراتين' },
  ] });
  assert.deepEqual(packs.map((o) => [o.count, o.unit]), [[24, null], [2, 'كراتين']]);
  assert.equal(parseSnapReading('not json'), null);
  assert.deepEqual(parseSnapReading('```json\n{"offers":[]}\n```'), []);
}

// The confirmation: an explicit yes whose quoted words hold the price.
assert.equal(confirmed('{"printed":true,"words":"لبنة ١١٫٥ ريال"}', 11.5), true);
assert.equal(confirmed({ printed: true, words: '٢٠٫٧٠ ريال' }, 20.7), true);
assert.equal(confirmed({ printed: true, words: 'منذ ٢٣' }, 23), false); // the story's "23 h ago" (measured)
assert.equal(confirmed({ printed: true, words: '9.99' }, 21.99), false); // words without the price (measured)
assert.equal(confirmed({ printed: false, words: '6.9' }, 6.9), false);
assert.equal(confirmed({ printed: true, words: '' }, 6.9), false);
assert.equal(confirmed('garbage', 6.9), false);

// Two readings of a photo agree on a price; an old price needs both.
{
  const agreed = agreePhoto(
    [{ name: 'لبنة تركية', price: 11.5, wasPrice: 14, count: 1 }, { name: 'شاي', price: 8, count: 1 }],
    [{ name: 'لبنة', price: 11.5, wasPrice: null, count: 1 }, { name: 'قهوة', price: 9, count: 1 }],
  );
  assert.deepEqual(agreed.map((o) => [o.name, o.price, o.wasPrice]), [['لبنة تركية', 11.5, null]]);
  assert.deepEqual(agreePhoto(null, []), []);
}
// A price that is another offer's crossed-out price is that tag, not a product.
assert.deepEqual(dropOldPriceTwins([{ price: 10, wasPrice: 15 }, { price: 15, wasPrice: null }]).map((o) => o.price), [10]);

// Video frames: two frames agree; a single-frame price goes back for one more look.
{
  const { accepted, single } = groupFrames([
    [{ name: 'شوكولاتة', price: 12.5, count: 1, wasPrice: 20 }],
    [{ name: 'شوكولاته جالكسي', price: 12.5, count: 1, wasPrice: 20 }],
    [{ name: 'قهوة', price: 30, count: 2 }],
    null,
  ]);
  assert.deepEqual(accepted.map((o) => [o.price, o.frame, o.votes, o.wasPrice]), [[12.5, 0, 2, 20]]);
  assert.deepEqual(single.map((o) => [o.price, o.frame, o.count]), [[30, 2, 2]]);
}
// Two products at one price, each seen in two frames, stay two offers.
{
  const { accepted } = groupFrames([
    [{ name: 'لبنة', price: 11.5, count: 1 }, { name: 'زيتون', price: 11.5, count: 1 }],
    [{ name: 'لبنة', price: 11.5, count: 1 }, { name: 'زيتون اسود', price: 11.5, count: 1 }],
  ]);
  assert.deepEqual(accepted.map((o) => o.name), ['لبنة', 'زيتون']);
}

// --- names: one deal or two ------------------------------------------------------------------
assert.equal(similarNames('لبنة تركية', 'لبنة'), true);
assert.equal(similarNames('اللبنة التركية', 'لبنه تركيه'), true);
assert.equal(similarNames('عرض لبنة', 'عرض زيتون'), false); // "عرض" says nothing
assert.equal(similarNames('', null), true);
assert.equal(similarNames('', 'لبنة'), false);
assert.equal(sameDeal({ name: 'لبنة', price: 11.5, count: 1 }, { name: 'لبنة تركية', price: 11.5, count: 1 }), true);
assert.equal(sameDeal({ name: 'لبنة', price: 11.5, count: 1 }, { name: 'لبنة', price: 11.5, count: 2 }), false);
assert.equal(sameDeal({ name: 'لبنة', price: 11.5, count: 1 }, { name: 'لبنة', price: 9.99, count: 1 }), false);
assert.equal(sameProduct({ name: 'لبنة تركية', count: 1, size: '400 جرام' }, { name: 'اللبنة التركيه', count: 1, size: '400 جرام' }), true);
assert.equal(sameProduct({ name: 'لبنة تركية', count: 1, size: '400 جرام' }, { name: 'لبنة', count: 1, size: '400 جرام' }), false);
assert.equal(sameProduct({ name: 'لبنة تركية', count: 1, size: '400 جرام' }, { name: 'لبنة تركية', count: 1, size: '800 جرام' }), false);

// --- the tick, end to end on the real schema ---------------------------------------------------
const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);

// What each picture shows, keyed by its bytes. `reads` = the reading prompt's
// replies (in turn), `printed` = prices the confirmation says yes to.
const PICTURES = {
  'IMG:labneh': { reads: [[{ name: 'لبنة تركية', price: 11.5, count: 1 }]], printed: { 11.5: 'لبنة تركية ١١٫٥' } },
  'IMG:labneh-again': { reads: [[{ name: 'لبنه تركيه', price: 11.5, count: 1 }]], printed: { 11.5: '11.5 ريال' } },
  'IMG:labneh-cheaper': { reads: [[{ name: 'لبنة تركية', price: 9.99, count: 1 }]], printed: { 9.99: '9.99' } },
  'IMG:labneh-cheaper-2': { reads: [[{ name: 'لبنة تركية', price: 9.99, count: 1 }]], printed: { 9.99: '9.99 ريال' } },
  'IMG:ad': { reads: [[]], printed: {} },
  // The mozzarella case (measured): both readings say 6.9, nothing is printed.
  'IMG:mozzarella': { reads: [[{ name: 'جبنة موزاريلا', price: 6.9, count: 1 }]], printed: {} },
  'FRAME:0.5': { reads: [[{ name: 'شوكولاتة', price: 12.5, count: 1 }]], printed: { 12.5: '12.5' } },
  'FRAME:1.5': { reads: [[{ name: 'شوكولاته جالكسي', price: 12.5, count: 1 }]], printed: { 12.5: '12.5' } },
  'FRAME:2.5': { reads: [[{ name: 'قهوة', price: 30, count: 2, unit: 'علبة' }]], printed: { 30: '2 علبة بـ 30' } },
};

function createAsk({ rateLimitOn = null } = {}) {
  const calls = [];
  const ask = async (text, image) => {
    const key = dec(image.bytes);
    calls.push({ key, kind: text.startsWith('Look at this picture') ? 'confirm' : 'read' });
    if (rateLimitOn && key === rateLimitOn) {
      const err = new Error('mistral 429: rate limit exceeded');
      err.status = 429;
      throw err;
    }
    const picture = PICTURES[key];
    assert.ok(picture, `unexpected picture ${key}`);
    if (text.startsWith('Look at this picture')) {
      const price = Number(/price ([\d.]+)/.exec(text)[1]);
      const words = picture.printed[price];
      return JSON.stringify(words ? { printed: true, words } : { printed: false, words: '' });
    }
    return JSON.stringify({ offers: picture.reads[0] });
  };
  return { ask, calls };
}

function createFetch(state) {
  return async (url) => {
    if (url.startsWith('https://www.snapchat.com/add/')) {
      const username = decodeURIComponent(url.split('/add/')[1]);
      if (state.blocked?.has(username)) return new Response('', { status: 403 });
      return new Response(pageHtml(publicProfile(state.stories[username] || [])), { status: 200 });
    }
    const body = state.media[url];
    if (!body) return new Response('', { status: 404 });
    return new Response(body, { status: 200, headers: { 'content-type': url.includes('video') ? 'video/mp4' : 'image/jpeg' } });
  };
}

const fakeMedia = {
  input() {
    let time = null;
    const chain = {
      transform: () => chain,
      output: (opts) => {
        time = Number(String(opts.time).replace('s', ''));
        return chain;
      },
      response: async () => new Response(enc(`FRAME:${time}`), { status: 200 }),
    };
    return chain;
  },
};

const bucket = {
  objects: new Map(),
  async put(key, bytes) {
    this.objects.set(key, bytes);
  },
};

const fixture = createSqliteD1(['schema.sql']);
try {
  const store = createMinimartStore(fixture.db);
  let nowMs = Date.parse('2026-11-04T09:00:00Z');
  const now = () => new Date(nowMs);
  const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
  const video = new Uint8Array([...fakeMp4(3.2), ...enc('video')]);
  const state = {
    stories: {
      't.sshoco': [
        snapEntry('s-labneh', 0, sec('2026-11-04T07:00:00Z'), 'https://cdn/labneh'),
        snapEntry('s-ad', 0, sec('2026-11-04T07:10:00Z'), 'https://cdn/ad'),
        snapEntry('s-mozz', 0, sec('2026-11-04T07:20:00Z'), 'https://cdn/mozz'),
        snapEntry('s-video', 1, sec('2026-11-04T07:30:00Z'), 'https://cdn/video'),
      ],
    },
    media: {
      'https://cdn/labneh': enc('IMG:labneh'),
      'https://cdn/ad': enc('IMG:ad'),
      'https://cdn/mozz': enc('IMG:mozzarella'),
      'https://cdn/video': video,
    },
  };
  await store.addShop('t.sshoco', now().toISOString());

  // Day 1: the story is read; the ad and the made-up price leave nothing.
  const day1 = createAsk();
  let report = await runMinimartTick({ store, bucket, media: fakeMedia, ask: day1.ask, fetchImpl: createFetch(state), now });
  assert.deepEqual(report.checked, [{ shop: 't.sshoco', status: 'ok', snaps: 4, added: 4 }]);
  assert.equal(report.read, 4);
  assert.equal(report.frames, 3);
  let live = await store.liveOffers(now().toISOString());
  assert.deepEqual(live.map((o) => [o.name, o.price, o.count]).sort(), [
    ['شوكولاتة', 12.5, 1],
    ['قهوة', 30, 2],
    ['لبنة تركية', 11.5, 1],
  ]);
  // Ad: one reading and no second call. Mozzarella: read twice, refused by the confirmation.
  assert.equal(day1.calls.filter((c) => c.key === 'IMG:ad').length, 1);
  assert.deepEqual(day1.calls.filter((c) => c.key === 'IMG:mozzarella').map((c) => c.kind), ['read', 'read', 'confirm']);
  const labneh = live.find((o) => o.price === 11.5);
  assert.equal(labneh.imageKey, 'minimarts/t.sshoco/s-labneh-photo.jpg');
  assert.ok(bucket.objects.has(labneh.imageKey));
  assert.equal(labneh.expiresAt, new Date(Date.parse('2026-11-04T07:00:00Z') + OFFER_TTL_MS).toISOString());
  const firstSeen = labneh.createdAt;

  // Nothing new: the next fire before the 2 h check reads nothing.
  nowMs += 60 * 1000;
  report = await runMinimartTick({ store, bucket, media: fakeMedia, ask: createAsk().ask, fetchImpl: createFetch(state), now });
  assert.equal(report.checked.length, 0);
  assert.equal(report.read, 0);

  // Day 3, the 24 h story long gone: the SAME file posted again is not read.
  nowMs = Date.parse('2026-11-06T09:00:00Z');
  state.stories['t.sshoco'] = [snapEntry('s-labneh-2', 0, sec('2026-11-06T08:00:00Z'), 'https://cdn/labneh-2')];
  state.media['https://cdn/labneh-2'] = enc('IMG:labneh');
  const day3 = createAsk();
  report = await runMinimartTick({ store, bucket, media: fakeMedia, ask: day3.ask, fetchImpl: createFetch(state), now });
  assert.equal(report.repeats, 1);
  assert.equal(day3.calls.length, 0);
  live = await store.liveOffers(now().toISOString());
  let again = live.find((o) => o.price === 11.5);
  assert.equal(live.filter((o) => o.price === 11.5).length, 1);
  assert.equal(again.reposts, 1);
  assert.equal(again.lastPostedAt, '2026-11-06T08:00:00.000Z');
  assert.equal(again.expiresAt, new Date(Date.parse('2026-11-06T08:00:00Z') + OFFER_TTL_MS).toISOString());
  assert.equal(again.createdAt, firstSeen); // not "new" again

  // Day 12: a new photo of the same deal (the first one has expired) is the same offer, shown again.
  nowMs = Date.parse('2026-11-16T09:00:00Z');
  assert.equal((await store.liveOffers(now().toISOString())).some((o) => o.price === 11.5), false);
  state.stories['t.sshoco'] = [snapEntry('s-labneh-3', 0, sec('2026-11-16T08:00:00Z'), 'https://cdn/labneh-3')];
  state.media['https://cdn/labneh-3'] = enc('IMG:labneh-again');
  report = await runMinimartTick({ store, bucket, media: fakeMedia, ask: createAsk().ask, fetchImpl: createFetch(state), now });
  assert.equal(report.offers, 0);
  assert.equal(report.reposted, 1);
  live = await store.liveOffers(now().toISOString());
  assert.deepEqual(live.map((o) => [o.id, o.reposts, o.createdAt]), [[labneh.id, 2, firstSeen]]);

  // Day 13: the same product at a new price replaces the older offer.
  nowMs = Date.parse('2026-11-17T09:00:00Z');
  state.stories['t.sshoco'] = [snapEntry('s-labneh-4', 0, sec('2026-11-17T08:00:00Z'), 'https://cdn/labneh-4')];
  state.media['https://cdn/labneh-4'] = enc('IMG:labneh-cheaper');
  report = await runMinimartTick({ store, bucket, media: fakeMedia, ask: createAsk().ask, fetchImpl: createFetch(state), now });
  assert.equal(report.offers, 1);
  live = await store.liveOffers(now().toISOString());
  assert.deepEqual(live.map((o) => [o.name, o.price, o.reposts]), [['لبنة تركية', 9.99, 0]]);

  // A spent key window: the snap stays queued and the fire stops.
  nowMs = Date.parse('2026-11-17T12:00:00Z');
  state.stories['t.sshoco'] = [snapEntry('s-rate', 0, sec('2026-11-17T11:00:00Z'), 'https://cdn/rate')];
  state.media['https://cdn/rate'] = enc('IMG:labneh-cheaper-2');
  report = await runMinimartTick({ store, bucket, media: fakeMedia, ask: createAsk({ rateLimitOn: 'IMG:labneh-cheaper-2' }).ask, fetchImpl: createFetch(state), now });
  assert.equal(report.yielded, 'rate_limited');
  assert.equal((await store.pendingSnaps(5)).map((s) => s.snapId).join(), 's-rate');
  report = await runMinimartTick({ store, bucket, media: fakeMedia, ask: createAsk().ask, fetchImpl: createFetch(state), now });
  assert.equal(report.read, 1);
  assert.equal(report.reposted, 1); // the same 9.99 deal, posted again
  assert.equal((await store.pendingSnaps(5)).length, 0);

  // Blocked (403): recorded, and the shop waits 6 h — never worked around.
  nowMs = Date.parse('2026-11-18T09:00:00Z');
  state.blocked = new Set(['t.sshoco']);
  report = await runMinimartTick({ store, bucket, media: fakeMedia, ask: createAsk().ask, fetchImpl: createFetch(state), now });
  assert.deepEqual(report.checked.map((c) => c.status), ['blocked']);
  let [shop] = await store.listShops();
  assert.equal(shop.status, 'blocked');
  assert.equal(shop.nextCheckAt, new Date(nowMs + BLOCKED_RETRY_MS).toISOString());

  // A gone media file fails the snap at once; a removed shop leaves the page.
  state.blocked = new Set();
  nowMs += BLOCKED_RETRY_MS;
  state.stories['t.sshoco'] = [snapEntry('s-gone', 0, sec('2026-11-18T14:00:00Z'), 'https://cdn/gone')];
  report = await runMinimartTick({ store, bucket, media: fakeMedia, ask: createAsk().ask, fetchImpl: createFetch(state), now });
  assert.equal(report.failed, 1);
  [shop] = await store.listShops();
  assert.equal(shop.status, 'ok');
  assert.equal(await store.removeShop('t.sshoco'), true);
  assert.equal((await store.liveOffers(new Date(Date.parse('2026-11-18T16:00:00Z')).toISOString())).length, 0);
  assert.equal((await store.listShops()).length, 0);
  // The month's frames: the one video's three cuts.
  assert.equal(await store.framesSince('2026-11-01T00:00:00.000Z'), 3);
} finally {
  fixture.close();
}

// No video binding (or the month's frames spent): a video is read from its cover.
{
  const calls = [];
  const result = await readSnap(
    { snapId: 'v', mediaType: 'video', mediaUrl: 'https://cdn/video', previewUrl: 'https://cdn/cover' },
    {
      ask: async (text, image) => {
        calls.push(dec(image.bytes));
        return text.startsWith('Look at this picture')
          ? '{"printed":true,"words":"12.5"}'
          : '{"offers":[{"name":"شوكولاتة","price":12.5,"count":1}]}';
      },
      media: null,
      fetchImpl: async (url) => new Response(enc(url === 'https://cdn/cover' ? 'COVER' : 'VIDEO'), { status: 200 }),
    },
  );
  assert.deepEqual(result.offers.map((o) => [o.price, o.image.ref]), [[12.5, 'cover']]);
  assert.deepEqual(calls, ['COVER', 'COVER', 'COVER']);
}

console.log('minimarts.test.mjs OK');
