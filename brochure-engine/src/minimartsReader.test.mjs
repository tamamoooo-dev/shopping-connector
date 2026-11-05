// The Mini marts PC reader (minimarts.js): Claude Haiku 5.5 on the owner's PC
// reads prepared snaps twice and posts both copies back. Pure rules first,
// then the tick + claim + save cycle over the real schema: preparing while the
// reader is on, Mistral while it is off or when a snap waits too long, a late
// answer refused, and the owner's one-time re-read correcting offers in place.
import assert from 'node:assert/strict';
import {
  pricePrinted,
  copyOfPicture,
  agreeCopies,
  offersFromCopies,
  runMinimartTick,
  claimForReader,
  saveReaderReadings,
  queueReread,
  BATCH_READ_PROMPT,
  PICTURE_PROMPT,
  PRICES_PROMPT,
  TEXT_PROMPT,
  READER_WAIT_MS,
} from './minimarts.js';
import { createMinimartStore } from './storage/minimartStore.js';
import { createSqliteD1 } from './storage/testSqliteD1.mjs';

// --- the copies' rules -----------------------------------------------------------------
assert.ok(BATCH_READ_PROMPT.includes('"Picture 1"'));
assert.ok(BATCH_READ_PROMPT.includes('Never invent a brand or a word that is not printed.'));
assert.ok(BATCH_READ_PROMPT.includes('"count" is how many units the price buys')); // the count rules, word for word

assert.equal(pricePrinted(['الحبة بـ ٢٫٥ ريال فقط'], 2.5), true);
assert.equal(pricePrinted(['الوزن 45 جرام'], 45), false); // a weight
assert.equal(pricePrinted(['منذ 23 ساعة'], 23), false); // app text
assert.equal(pricePrinted(['3 كرتون ب 10'], 10), true);

const copy = (lines, offers) => ({ lines, offers });
assert.deepEqual(copyOfPicture(copy(['جبنة 15 ريال'], [{ name: 'جبنة', price: 15, count: 1 }, { name: 'شاي', price: 9, count: 1 }])).offers.map((o) => o.price), [15]);
assert.deepEqual(copyOfPicture(null), { lines: [], offers: [] });

// One to one: a second flavour only one copy saw does not stand.
{
  const a = [{ name: 'CREMKAKAO', price: 2.5, count: 1 }, { name: 'NAPOLITANER', price: 2.5, count: 1 }];
  const b = [{ name: 'Loacker Classic Cremkakao', price: 2.5, count: 1 }];
  assert.deepEqual(agreeCopies(a, b).map((o) => o.name), ['CREMKAKAO']);
  assert.equal(agreeCopies(a, [...b, { name: 'Napolitaner', price: 2.5, count: 1 }]).length, 2);
}

// A photo: the name shows only its words printed in BOTH copies; a guess hides.
{
  const lines1 = ['Pillsbury', 'Oranon Cake Mix', '3 حبات ب 11.5 ريال فقط'];
  const lines2 = ['Pillsbury', 'Oraon Cake Mix', '3 حبات ب 11.5 ريال فقط'];
  const offers = offersFromCopies([{
    ref: 'photo',
    copies: [
      copy(lines1, [{ name: 'Pillsbury Cake Mix Lemon', price: 11.5, count: 3, size: '500 g' }]),
      copy(lines2, [{ name: 'Pillsbury Cake Mix', price: 11.5, count: 3 }]),
    ],
  }]);
  assert.deepEqual(offers.map((o) => [o.price, o.count, o.shownName, o.sizePrinted, o.frame]), [[11.5, 3, 'Pillsbury Cake Mix', 0, 0]]);
  // One copy only (the batch reply lost the picture): nothing stands.
  assert.deepEqual(offersFromCopies([{ ref: 'photo', copies: [copy(lines1, [{ name: 'x', price: 11.5 }])] }]), []);
}

// A video: a price in one frame by both copies stands, one in two frames is one offer.
{
  const frame = (offers, lines) => ({ ref: 'f', copies: [copy(lines, offers), copy(lines, offers)] });
  const offers = offersFromCopies([
    frame([{ name: 'شوكولاتة جالكسي', price: 12.5, count: 1 }], ['شوكولاتة جالكسي 12.5']),
    frame([{ name: 'شوكولاتة جالكسي', price: 12.5, count: 1 }], ['شوكولاتة جالكسي 12.5']),
    frame([], ['عروض']),
    frame([{ name: 'قهوة', price: 30, count: 2 }], ['قهوة 2 علبة بـ 30']),
  ], { framed: true });
  assert.deepEqual(offers.map((o) => [o.price, o.count, o.shownName, o.frame]).sort(), [[12.5, 1, 'شوكولاتة جالكسي', 0], [30, 2, 'قهوة', 3]]);
}

// --- tick + reader, end to end on the real schema -------------------------------------------
const enc = (text) => new TextEncoder().encode(text);
const dec = (bytes) => new TextDecoder().decode(bytes);
function fakeMp4(durationSec, timescale = 1000) {
  const bytes = new Uint8Array(64);
  bytes.set([0x6d, 0x76, 0x68, 0x64], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(12 + 12, timescale);
  view.setUint32(12 + 16, Math.round(durationSec * timescale));
  return bytes;
}
const pageHtml = (pageProps) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script>`;
const snapEntry = (id, kind, iso, url) => ({
  snapId: { value: id }, snapMediaType: kind, timestampInSec: { value: String(Date.parse(iso) / 1000) },
  snapUrls: { mediaUrl: url, mediaPreviewUrl: { value: `${url}-cover` } },
});
const fetchFor = (state) => async (url) => {
  if (url.startsWith('https://www.snapchat.com/add/')) {
    return new Response(pageHtml({
      userProfile: { $case: 'publicProfileInfo', publicProfileInfo: { title: 'بشائر العروض', profilePictureUrl: 'https://p/pic.jpg' } },
      story: { snapList: state.story },
    }), { status: 200 });
  }
  return state.media[url] ? new Response(state.media[url], { status: 200 }) : new Response('', { status: 404 });
};
const media = {
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
  async put(key, bytes) { this.objects.set(key, bytes); },
  async get(key) {
    const bytes = this.objects.get(key);
    return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null;
  },
  async delete(keys) { for (const key of [].concat(keys)) this.objects.delete(key); },
};
// Mistral: the shop's picture, and (when allowed) the late photo.
function mistral({ reads = true } = {}) {
  const calls = [];
  const ask = async (text, image) => {
    const key = dec(image.bytes);
    calls.push(key);
    if (text === PICTURE_PROMPT) return '{"kind":"logo"}';
    assert.ok(reads, `Mistral read ${key} while the PC reader is on`);
    assert.equal(key, 'IMG:late');
    if (text === PRICES_PROMPT) return '{"prices":[{"price":7,"words":"شاي 7 ريال"}]}';
    if (text === TEXT_PROMPT) return '{"lines":["شاي 7 ريال"]}';
    return '{"offers":[{"name":"شاي","price":7,"count":1}]}';
  };
  return { ask, calls };
}
// The PC reader's answer: the same two copies for every picture of a snap.
const answer = (snap, byRef) => ({
  snapId: snap.snapId,
  pictures: snap.pictures.map((p) => ({ ref: p.ref, copies: [byRef[p.ref] || copy([], []), byRef[p.ref] || copy([], [])] })),
});

const fixture = createSqliteD1(['schema.sql']);
try {
  const store = createMinimartStore(fixture.db);
  let nowMs = Date.parse('2026-11-05T10:00:00Z');
  const now = () => new Date(nowMs);
  const state = {
    story: [
      snapEntry('s-labneh', 0, '2026-11-05T09:00:00Z', 'https://cdn/labneh'),
      snapEntry('s-ad', 0, '2026-11-05T09:01:00Z', 'https://cdn/ad'),
      snapEntry('s-video', 1, '2026-11-05T09:02:00Z', 'https://cdn/video'),
    ],
    media: {
      'https://cdn/labneh': enc('IMG:labneh'),
      'https://cdn/ad': enc('IMG:ad'),
      'https://cdn/video': new Uint8Array([...fakeMp4(3.2), ...enc('video')]),
      'https://p/pic.jpg': enc('PIC:logo'),
    },
  };
  await store.addShop('bshaaral', now().toISOString());

  // The reader asks (nothing yet): it is on, so the tick only prepares.
  assert.deepEqual(await claimForReader({ store, now }), []);
  let report = await runMinimartTick({ store, bucket, media, ask: mistral({ reads: false }).ask, fetchImpl: fetchFor(state), now });
  assert.equal(report.reader, 'on');
  assert.equal(report.prepared, 3);
  assert.equal(report.read, 0);
  assert.equal(report.frames, 3);
  assert.deepEqual([...bucket.objects.keys()].sort(), [
    'minimarts/bshaaral/s-ad-photo.jpg', 'minimarts/bshaaral/s-labneh-photo.jpg',
    'minimarts/bshaaral/s-video-f15.jpg', 'minimarts/bshaaral/s-video-f25.jpg', 'minimarts/bshaaral/s-video-f5.jpg',
  ]);

  // The reader claims them, oldest first, within its picture budget.
  nowMs += 5 * 60 * 1000;
  assert.deepEqual((await claimForReader({ store, now, maxPictures: 2 })).map((s) => s.snapId), ['s-labneh', 's-ad']);
  const [video] = await claimForReader({ store, now });
  assert.deepEqual(video.pictures.map((p) => p.ref), ['f5', 'f15', 'f25']);
  assert.equal(video.framed, true);
  assert.deepEqual(await claimForReader({ store, now }), []); // all held

  const labneh = { snapId: 's-labneh', pictures: [{ ref: 'photo' }] };
  const ad = { snapId: 's-ad', pictures: [{ ref: 'photo' }] };
  const lines = ['لبنة تركية 4 حبات بـ 11.5 ريال'];
  let results = await saveReaderReadings({ store, bucket, now, readings: [
    answer(labneh, { photo: copy(lines, [{ name: 'لبنة تركية', price: 11.5, count: 4, unit: 'حبات' }]) }),
    answer(ad, {}),
    answer(video, {
      f5: copy(['شوكولاتة 12.5'], [{ name: 'شوكولاتة', price: 12.5, count: 1 }]),
      f25: copy(['قهوة 2 علبة بـ 30'], [{ name: 'قهوة', price: 30, count: 2 }]),
    }),
    { snapId: 's-nope', pictures: [] },
  ] });
  assert.deepEqual(results.map((r) => [r.snapId, r.status, r.offers]), [
    ['s-labneh', 'read', 1], ['s-ad', 'read', 0], ['s-video', 'read', 2], ['s-nope', 'conflict', undefined],
  ]);
  let live = await store.liveOffers(now().toISOString());
  assert.deepEqual(live.map((o) => [o.snapId, o.price, o.count, o.shownName, o.imageKey]).sort(), [
    ['s-labneh', 11.5, 4, 'لبنة تركية', 'minimarts/bshaaral/s-labneh-photo.jpg'],
    ['s-video', 12.5, 1, 'شوكولاتة', 'minimarts/bshaaral/s-video-f5.jpg'],
    ['s-video', 30, 2, 'قهوة', 'minimarts/bshaaral/s-video-f25.jpg'],
  ]);
  // Pictures no offer shows left R2 (the ad, the empty frame).
  assert.deepEqual([...bucket.objects.keys()].sort(), [
    'minimarts/bshaaral/s-labneh-photo.jpg', 'minimarts/bshaaral/s-video-f25.jpg', 'minimarts/bshaaral/s-video-f5.jpg',
  ]);
  // The same answer again changes nothing.
  results = await saveReaderReadings({ store, bucket, now, readings: [answer(labneh, {})] });
  assert.equal(results[0].status, 'conflict');
  const firstSeen = live.find((o) => o.price === 11.5);

  // The reader goes quiet: a new snap is Mistral's at once.
  nowMs += 2 * 60 * 60 * 1000;
  state.story = [snapEntry('s-late', 0, '2026-11-05T11:30:00Z', 'https://cdn/late')];
  state.media['https://cdn/late'] = enc('IMG:late');
  const m = mistral();
  report = await runMinimartTick({ store, bucket, media, ask: m.ask, fetchImpl: fetchFor(state), now });
  assert.equal(report.reader, 'off');
  assert.equal(report.read, 1);
  assert.ok((await store.liveOffers(now().toISOString())).some((o) => o.price === 7));

  // A snap prepared while the reader was on, claimed and never answered:
  // Mistral reads it from R2 once it has waited READER_WAIT_MS.
  nowMs += 2 * 60 * 60 * 1000;
  state.story = [snapEntry('s-left', 0, '2026-11-05T13:50:00Z', 'https://cdn/left')];
  state.media['https://cdn/left'] = enc('IMG:late '); // another file of the same tea poster
  await claimForReader({ store, now }); // on
  report = await runMinimartTick({ store, bucket, media, ask: mistral({ reads: false }).ask, fetchImpl: fetchFor(state), now });
  assert.equal(report.reader, 'on');
  assert.equal(report.prepared, 1);
  const held = await claimForReader({ store, now });
  assert.deepEqual(held.map((s) => s.snapId), ['s-left']);
  nowMs += READER_WAIT_MS + 60 * 1000; // the reader stays on, but never answers
  await store.noteReader(now().toISOString());
  const lateAsk = async (text, image) => mistral().ask(text, { bytes: enc(dec(image.bytes).trim()) });
  report = await runMinimartTick({ store, bucket, media, ask: lateAsk, fetchImpl: fetchFor(state), now });
  assert.equal(report.read, 1);
  results = await saveReaderReadings({ store, bucket, now, readings: [answer(held[0], {})] });
  assert.equal(results[0].status, 'conflict'); // too late: Mistral read it

  // The owner's one-time re-read: never Mistral's; it corrects the snap's offers in place.
  assert.equal(await queueReread({ store, snapIds: ['s-labneh', 's-nope'] }), 1);
  nowMs += 60 * 60 * 1000;
  report = await runMinimartTick({ store, bucket, media, ask: mistral({ reads: false }).ask, fetchImpl: fetchFor(state), now });
  assert.equal(report.reader, 'off'); // off, and Mistral leaves it
  assert.equal(report.read, 0);
  await claimForReader({ store, now }); // on
  report = await runMinimartTick({ store, bucket, media, ask: mistral({ reads: false }).ask, fetchImpl: fetchFor(state), now });
  assert.equal(report.prepared, 1); // read afresh: no repeat check
  const [again] = await claimForReader({ store, now });
  assert.equal(again.snapId, 's-labneh');
  results = await saveReaderReadings({ store, bucket, now, readings: [answer(again, {
    photo: copy(['لبنة تركية 3 حبات بـ 11.5 ريال', 'جبنة 5 ريال'], [
      { name: 'لبنة تركية', price: 11.5, count: 3, unit: 'حبات' },
      { name: 'جبنة', price: 5, count: 1 },
    ]),
  })] });
  assert.deepEqual([results[0].status, results[0].rewritten, results[0].retired, results[0].offers], ['read', 1, 0, 1]);
  live = await store.liveOffers(now().toISOString());
  const fixed = live.find((o) => o.price === 11.5);
  assert.deepEqual([fixed.id, fixed.count, fixed.createdAt], [firstSeen.id, 3, firstSeen.createdAt]); // corrected in place
  assert.ok(live.some((o) => o.id === 's-labneh:102' && o.price === 5)); // a price the first reading missed
  // Read again with nothing printed: the snap's offers are retired.
  await queueReread({ store, snapIds: ['s-labneh'] });
  await runMinimartTick({ store, bucket, media, ask: mistral({ reads: false }).ask, fetchImpl: fetchFor(state), now });
  const [third] = await claimForReader({ store, now });
  results = await saveReaderReadings({ store, bucket, now, readings: [answer(third, {})] });
  assert.equal(results[0].retired, 2);
  assert.equal((await store.liveOffers(now().toISOString())).filter((o) => o.snapId === 's-labneh').length, 0);
  assert.deepEqual(await store.readerQueueCounts(), { fresh: 0, reread: 0, prepared: 0, claimed: 0, mistral: 0, saving: 0 });
} finally {
  fixture.close();
}

console.log('minimartsReader.test.mjs OK');
