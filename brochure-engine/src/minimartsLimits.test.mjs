// Mini marts after the first week (2026-11-11), over the real schema:
//   • both Claude accounts at their limit: the snaps wait for the reader when
//     the reset is at most 2 h away, Mistral reads at once when it is further,
//     and Mistral reads when the PC goes quiet;
//   • a quiet shop is checked every 6 h, and every check is kept;
//   • a shop whose videos rarely carry a price gets the fewest frames;
//   • pictures of offers long expired leave R2, and a deal posted again
//     takes the new posting's picture.
import assert from 'node:assert/strict';
import {
  runMinimartTick,
  claimForReader,
  saveReaderReadings,
  setReaderLimit,
  isQuietShop,
  lowYield,
  sha256Hex,
  PICTURE_PROMPT,
  PRICES_PROMPT,
  TEXT_PROMPT,
  READER_HOLD_MAX_MS,
  QUIET_CHECK_MS,
  SHOP_CHECK_MS,
  MIN_FRAMES_PER_VIDEO,
} from './minimarts.js';
import { createMinimartStore } from './storage/minimartStore.js';
import { createSqliteD1 } from './storage/testSqliteD1.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const enc = (text) => new TextEncoder().encode(text);
const copy = (lines, offers) => ({ lines, offers });
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
const newBucket = () => ({
  objects: new Map(),
  async put(key, bytes) { this.objects.set(key, bytes); },
  async get(key) {
    const bytes = this.objects.get(key);
    return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null;
  },
  async delete(keys) { for (const key of [].concat(keys)) this.objects.delete(key); },
});
// Mistral: every picture is the same tea poster. `reads: false` = it must not read.
let strayReads = 0;
function mistral({ reads = true } = {}) {
  const ask = async (text) => {
    if (text === PICTURE_PROMPT) return '{"kind":"logo"}';
    if (!reads) strayReads += 1; // counted, not thrown: the tick would swallow a throw
    if (text === PRICES_PROMPT) return '{"prices":[{"price":7,"words":"شاي 7 ريال"}]}';
    if (text === TEXT_PROMPT) return '{"lines":["شاي 7 ريال"]}';
    return '{"offers":[{"name":"شاي","price":7,"count":1}]}';
  };
  return ask;
}
const photo = (id, iso) => ({ id, postedAt: iso, mediaType: 'image', mediaUrl: `https://cdn/${id}`, previewUrl: null });
const reader = (db, id) => db.prepare('SELECT status, reader, claimed_at FROM minimart_snaps WHERE snap_id = ?').bind(id).first();

// --- the pure rules ----------------------------------------------------------------------
{
  const at = new Date('2026-11-11T12:00:00Z');
  assert.equal(isQuietShop({ lastPostAt: '2026-11-08T11:00:00Z' }, at), true); // 3 days and an hour
  assert.equal(isQuietShop({ lastPostAt: '2026-11-09T12:00:00Z' }, at), false);
  assert.equal(isQuietShop({ lastPostAt: null, addedAt: '2026-11-04T21:00:00Z' }, at), true); // never posted
  assert.equal(isQuietShop({ lastPostAt: null, addedAt: '2026-11-11T09:00:00Z' }, at), false); // just added
  assert.equal(isQuietShop({}, at), false);

  assert.equal(lowYield({ videos: 172, priced: 31 }), true); // measured 2026-11-11
  assert.equal(lowYield({ videos: 68, priced: 66 }), false);
  assert.equal(lowYield({ videos: 9, priced: 0 }), false); // too few to judge
  assert.equal(lowYield({ videos: 20, priced: 5 }), false); // a quarter is enough
}

// --- both Claude accounts at their limit ---------------------------------------------------
{
  const fixture = createSqliteD1(['schema.sql']);
  try {
    const store = createMinimartStore(fixture.db);
    const bucket = newBucket();
    const t0 = Date.parse('2026-11-05T10:00:00Z');
    let nowMs = t0;
    const now = () => new Date(nowMs);
    const state = { story: [], media: { 'https://p/pic.jpg': enc('PIC') } };
    const add = async (id) => {
      state.media[`https://cdn/${id}`] = enc(`IMG:${id}`);
      await store.addSnaps('bshaaral', [photo(id, now().toISOString())], now().toISOString());
    };
    const tick = (reads) => runMinimartTick({ store, bucket, media, ask: mistral({ reads }), fetchImpl: fetchFor(state), now });
    await store.addShop('bshaaral', now().toISOString());

    assert.equal(await setReaderLimit({ store, until: 'soon', now }), null); // not a time

    // The reader is on; a snap is prepared for it.
    await claimForReader({ store, now });
    await add('s1');
    let report = await tick(false);
    assert.deepEqual([report.reader, report.prepared], ['on', 1]);
    assert.deepEqual((await claimForReader({ store, now })).map((s) => s.snapId), ['s1']);

    // Both accounts are at their limit for 90 minutes: at most 2 h, so the
    // snap waits for the reader. Saying so lets its claim go.
    const until = new Date(t0 + 90 * MIN).toISOString();
    assert.deepEqual(await setReaderLimit({ store, until, note: { main: until }, now }), { limitedUntil: until, reads: 'reader' });
    assert.equal((await reader(fixture.db, 's1')).reader, null);
    assert.deepEqual((await store.readerStatus()).limitNote, { main: until });

    // 70 minutes on, the snap has waited over an hour: still not Mistral's.
    nowMs = t0 + 70 * MIN;
    await setReaderLimit({ store, until, now }); // the reader's 15-minute round: still limited
    report = await tick(false);
    assert.deepEqual([report.reader, report.read, report.limitedUntil], ['holding', 0, until]);

    // The limit has reset; the reader's next round is minutes away. Mistral
    // still leaves the snap, and the reader takes it however long it waited.
    nowMs = t0 + 85 * MIN;
    await setReaderLimit({ store, until, now });
    nowMs = t0 + 100 * MIN;
    report = await tick(false);
    assert.deepEqual([report.reader, report.read], ['on', 0]);
    const [held] = await claimForReader({ store, now });
    assert.equal(held.snapId, 's1');
    const results = await saveReaderReadings({ store, bucket, now, readings: [{
      snapId: 's1',
      pictures: [{ ref: 'photo', copies: [copy(['قهوة 9 ريال'], [{ name: 'قهوة', price: 9, count: 1 }]), copy(['قهوة 9 ريال'], [{ name: 'قهوة', price: 9, count: 1 }])] }],
    }] });
    assert.equal(results[0].status, 'read');

    // A limit that resets in 5 hours is too long to wait: Mistral reads at
    // once, the snap the reader held and a new one alike.
    nowMs = t0 + 3 * HOUR;
    await claimForReader({ store, now });
    await add('s2');
    report = await tick(false);
    assert.equal(report.prepared, 1);
    assert.deepEqual((await claimForReader({ store, now })).map((s) => s.snapId), ['s2']);
    const long = new Date(nowMs + 5 * HOUR).toISOString();
    assert.deepEqual(await setReaderLimit({ store, until: long, now }), { limitedUntil: long, reads: 'mistral' });
    await add('s3');
    report = await tick(true);
    assert.deepEqual([report.reader, report.prepared, report.read], ['limited', 0, 2]);
    assert.deepEqual([(await reader(fixture.db, 's2')).reader, (await reader(fixture.db, 's3')).reader], ['mistral', 'mistral']);

    // Under 2 hours are left: a new snap waits for the reader again.
    nowMs += 5 * HOUR - READER_HOLD_MAX_MS + 10 * MIN;
    await setReaderLimit({ store, until: long, now });
    await add('s4');
    report = await tick(false);
    assert.deepEqual([report.reader, report.prepared, report.read], ['holding', 1, 0]);

    // The PC goes quiet (no round for 40 minutes): Mistral reads, limit or not.
    nowMs += 40 * MIN;
    report = await tick(true);
    assert.deepEqual([report.reader, report.read], ['off', 1]);

    // The reader says it reads again (a time already past): it is simply on.
    assert.equal((await setReaderLimit({ store, until: now().toISOString(), now })).reads, 'reader');
    nowMs += MIN;
    await add('s5');
    report = await tick(false);
    assert.deepEqual([report.reader, report.prepared], ['on', 1]);

    // A limit far away is capped (a typo never silences the reader for good).
    const capped = await setReaderLimit({ store, until: '2099-01-01T00:00:00Z', now });
    assert.ok(Date.parse(capped.limitedUntil) - nowMs <= 8 * DAY);
  } finally {
    fixture.close();
  }
}

// --- a quiet shop, and the checks' history ---------------------------------------------------
{
  const fixture = createSqliteD1(['schema.sql']);
  try {
    const store = createMinimartStore(fixture.db);
    const bucket = newBucket();
    let nowMs = Date.parse('2026-11-11T12:00:00Z');
    const now = () => new Date(nowMs);
    const state = { story: [], media: { 'https://p/pic.jpg': enc('PIC') } };
    const tick = () => runMinimartTick({ store, bucket, media, ask: mistral(), fetchImpl: fetchFor(state), now });
    await store.addShop('mazaya.t', new Date(nowMs - 7 * DAY).toISOString());
    const nextCheck = async () => Date.parse((await store.listShops())[0].nextCheckAt) - nowMs;

    // No story snap in a week: checked again in 6 hours.
    let report = await tick();
    assert.deepEqual(report.checked.map((c) => [c.shop, c.status, c.quiet]), [['mazaya.t', 'ok', true]]);
    assert.equal(await nextCheck(), QUIET_CHECK_MS);

    // It posts: the snap is caught at that check, and the 2 h checks resume.
    nowMs += QUIET_CHECK_MS;
    state.story = [snapEntry('s-back', 0, new Date(nowMs - 3 * HOUR).toISOString(), 'https://cdn/back')];
    state.media['https://cdn/back'] = enc('IMG:back');
    report = await tick();
    assert.deepEqual(report.checked.map((c) => [c.added, c.quiet]), [[1, undefined]]);
    assert.equal(await nextCheck(), SHOP_CHECK_MS);

    // Every check is kept; the ones that were not "ok" are listed.
    const { results } = await fixture.db.prepare('SELECT status, snaps, added FROM minimart_checks ORDER BY id').all();
    assert.deepEqual(results.map((r) => [r.status, r.snaps, r.added]), [['ok', 0, 0], ['ok', 1, 1]]);
    await store.logCheck('mazaya.t', { status: 'blocked', error: 'HTTP 403', checkedAt: now().toISOString() });
    assert.deepEqual(await store.checkProblems(new Date(nowMs - DAY).toISOString()), [
      { username: 'mazaya.t', status: 'blocked', checks: 1, last: now().toISOString(), error: 'HTTP 403' },
    ]);
    await store.pruneChecks(new Date(nowMs + MIN).toISOString());
    assert.deepEqual(await store.checkProblems(new Date(0).toISOString()), []);
  } finally {
    fixture.close();
  }
}

// --- a shop whose videos rarely carry a price ------------------------------------------------
{
  const fixture = createSqliteD1(['schema.sql']);
  try {
    const store = createMinimartStore(fixture.db);
    const bucket = newBucket();
    const nowMs = Date.parse('2026-11-05T10:00:00Z');
    const now = () => new Date(nowMs);
    const state = { story: [], media: { 'https://p/pic.jpg': enc('PIC') } };
    for (const shop of ['sweet-st', 'albarakaoffers']) await store.addShop(shop, now().toISOString());
    // A week of videos: one shop's almost never show a price, the other's always do.
    const dayAgo = new Date(nowMs - DAY).toISOString();
    for (let i = 0; i < 20; i += 1) {
      for (const [shop, ids] of [['sweet-st', i < 2 ? '["x:1"]' : '[]'], ['albarakaoffers', '["y:1"]']]) {
        await fixture.db
          .prepare(
            `INSERT INTO minimart_snaps (snap_id, username, posted_at, media_type, media_url, status, seen_at, read_at, offer_ids)
             VALUES (?, ?, ?, 'video', 'https://cdn/old', 'read', ?, ?, ?)`,
          )
          .bind(`${shop}-old-${i}`, shop, dayAgo, dayAgo, dayAgo, ids)
          .run();
      }
    }
    assert.deepEqual(await store.videoYield('sweet-st', new Date(nowMs - 7 * DAY).toISOString()), { videos: 20, priced: 2 });

    for (const shop of ['sweet-st', 'albarakaoffers']) {
      state.media[`https://cdn/${shop}-new`] = new Uint8Array([...fakeMp4(12), ...enc(shop)]);
      await store.addSnaps(shop, [{ id: `${shop}-new`, postedAt: now().toISOString(), mediaType: 'video', mediaUrl: `https://cdn/${shop}-new`, previewUrl: null }], now().toISOString());
    }
    await claimForReader({ store, now }); // on: the tick prepares
    await runMinimartTick({ store, bucket, media, ask: mistral({ reads: false }), fetchImpl: fetchFor(state), now });
    const frames = (shop) => [...bucket.objects.keys()].filter((key) => key.startsWith(`minimarts/${shop}/`)).length;
    assert.equal(frames('sweet-st'), MIN_FRAMES_PER_VIDEO);
    assert.ok(frames('albarakaoffers') > MIN_FRAMES_PER_VIDEO, `the other shop keeps the month's pace (${frames('albarakaoffers')} frames)`);
  } finally {
    fixture.close();
  }
}

// --- pictures of offers long expired -----------------------------------------------------------
{
  const fixture = createSqliteD1(['schema.sql']);
  try {
    const store = createMinimartStore(fixture.db);
    const bucket = newBucket();
    let nowMs = Date.parse('2026-11-20T10:00:00Z');
    const now = () => new Date(nowMs);
    const iso = (ms) => new Date(ms).toISOString();
    const state = { story: [], media: { 'https://p/pic.jpg': enc('PIC') } };
    await store.addShop('bshaaral', now().toISOString());
    const offer = (id, name, price, key, expiresMs) => ({
      id, username: 'bshaaral', snapId: id.split(':')[0], name, shownName: name, brand: null, size: null, count: 1, unit: null,
      price, wasPrice: null, imageKey: key, postedAt: iso(expiresMs - 7 * DAY), expiresAt: iso(expiresMs), votes: 2, createdAt: iso(expiresMs - 7 * DAY),
    });
    await store.insertOffers([
      offer('a:1', 'لبنة تركية', 11.5, 'minimarts/bshaaral/a-photo.jpg', nowMs - 8 * DAY), // expired 8 days ago
      offer('b:1', 'جبنة شيدر', 5.75, 'minimarts/bshaaral/b-photo.jpg', nowMs - 8 * DAY), // expired, but its picture…
      offer('b:2', 'زبدة', 9, 'minimarts/bshaaral/b-photo.jpg', nowMs + DAY), // …is a live offer's too
      offer('c:1', 'عصير', 3, 'minimarts/bshaaral/c-photo.jpg', nowMs - 2 * DAY), // expired 2 days ago: kept a week
    ]);
    for (const key of ['a', 'b', 'c']) await bucket.put(`minimarts/bshaaral/${key}-photo.jpg`, enc(key));
    // A presenter shop's product crops (2026-11-14) go with their offers.
    for (const key of ['a', 'c']) {
      await bucket.put(`minimarts/bshaaral/${key}-photo.crop.${key}-1.jpg`, enc(`${key} crop`));
      await store.saveCrop(`${key}:1`, `minimarts/bshaaral/${key}-photo.jpg`, `minimarts/bshaaral/${key}-photo.crop.${key}-1.jpg`);
    }

    await claimForReader({ store, now }); // on
    let report = await runMinimartTick({ store, bucket, media, ask: mistral({ reads: false }), fetchImpl: fetchFor(state), now });
    assert.equal(report.picturesDropped, 2); // a's picture and a's crop
    assert.deepEqual([...bucket.objects.keys()].sort(),
      ['minimarts/bshaaral/b-photo.jpg', 'minimarts/bshaaral/c-photo.crop.c-1.jpg', 'minimarts/bshaaral/c-photo.jpg']);
    const cropOf = async (id) => fixture.db.prepare('SELECT crop_key, crop_of FROM minimart_offers WHERE id = ?').bind(id).first();
    assert.deepEqual({ ...(await cropOf('a:1')) }, { crop_key: null, crop_of: null });
    assert.equal((await cropOf('c:1')).crop_key, 'minimarts/bshaaral/c-photo.crop.c-1.jpg');
    const imageOf = async (id) => (await fixture.db.prepare('SELECT image_key FROM minimart_offers WHERE id = ?').bind(id).first()).image_key;
    assert.deepEqual([await imageOf('a:1'), await imageOf('b:1'), await imageOf('c:1')], [null, 'minimarts/bshaaral/b-photo.jpg', 'minimarts/bshaaral/c-photo.jpg']);
    assert.deepEqual(await store.picturelessOffers(['a:1', 'b:1', 'nope']), ['a:1']);

    // The shop posts the labneh deal again: it is the same offer, back on
    // show, with the new posting's picture.
    nowMs += 10 * MIN;
    state.media['https://cdn/again'] = enc('IMG:again');
    await store.addSnaps('bshaaral', [photo('again', now().toISOString())], now().toISOString());
    await claimForReader({ store, now });
    await runMinimartTick({ store, bucket, media, ask: mistral({ reads: false }), fetchImpl: fetchFor(state), now });
    const [again] = await claimForReader({ store, now });
    const labneh = copy(['لبنة تركية 11.5 ريال'], [{ name: 'لبنة تركية', price: 11.5, count: 1 }]);
    const [saved] = await saveReaderReadings({ store, bucket, now, readings: [{ snapId: again.snapId, pictures: [{ ref: 'photo', copies: [labneh, labneh] }] }] });
    assert.deepEqual([saved.status, saved.offers, saved.reposted], ['read', 0, 1]);
    assert.equal(await imageOf('a:1'), 'minimarts/bshaaral/again-photo.jpg');
    assert.ok(bucket.objects.has('minimarts/bshaaral/again-photo.jpg'));
    assert.ok((await store.liveOffers(now().toISOString())).some((o) => o.id === 'a:1'));

    // The very same file posted again after its picture left: the file itself is the picture.
    await bucket.delete(['minimarts/bshaaral/again-photo.jpg']);
    await store.clearPictures(['minimarts/bshaaral/again-photo.jpg']);
    assert.equal(await imageOf('a:1'), null);
    assert.equal((await fixture.db.prepare("SELECT media_hash FROM minimart_snaps WHERE snap_id = 'again'").first()).media_hash, await sha256Hex(enc('IMG:again')));
    nowMs += 10 * MIN;
    state.media['https://cdn/same'] = enc('IMG:again');
    await store.addSnaps('bshaaral', [photo('same', now().toISOString())], now().toISOString());
    await claimForReader({ store, now });
    report = await runMinimartTick({ store, bucket, media, ask: mistral({ reads: false }), fetchImpl: fetchFor(state), now });
    assert.equal(report.repeats, 1);
    assert.equal(await imageOf('a:1'), 'minimarts/bshaaral/same-photo.jpg');
    assert.ok(bucket.objects.has('minimarts/bshaaral/same-photo.jpg'));
  } finally {
    fixture.close();
  }
}

assert.equal(strayReads, 0, 'Mistral read a snap that was the reader\'s');
console.log('minimartsLimits.test.mjs OK');
