// minimarts.js — Mini marts: the offers small shops post on their PUBLIC
// Snapchat story (2026-11-04, the owner's request: "follow the minimart, capture
// the offers, show them in a mini mart section"). Shown on the Brochures page.
//
// HOW IT WORKS (measured 2026-11-04, see HISTORY §69):
//   • The owner adds a shop by its Snapchat link. Only a Public Profile works:
//     its page (snapchat.com/add/<user>) carries the story's snaps in
//     __NEXT_DATA__, one media URL per snap. No account, no login, no app —
//     the same page anyone's browser gets. A personal account shows no story
//     there (`not_public`) and cannot be followed.
//   • Each shop's page is read every SHOP_CHECK_MS on the */2 tick (a story
//     lasts 24 h, so nothing posted is missed). A snap is queued once, by id.
//   • A PHOTO snap is read twice by ministral-14b (T=0.3); a price both
//     readings show is a candidate. A VIDEO snap is cut into one frame per
//     second (Media Transformations, the MEDIA binding) and each frame is read
//     once; a price two frames show is a candidate, a price one frame shows is
//     read again and kept only if that reading shows it too.
//   • Every candidate is then CONFIRMED by a narrower question ("is <price>
//     printed here as a current price?"): the reply must say yes AND quote
//     printed words that contain the price and are not app text ("منذ ٢٣").
//     Measured: the two readings alone kept a made-up 6.9 on a photo with no
//     price; the confirmation rejects it while keeping 13/13 real prices.
//   • A snap with no confirmed price is an ad: it leaves no offer (owner's rule).
//   • REPEATS (owner, 2026-11-04: shops post the same deal again on a later
//     day, after the 24 h story is gone). A deal stays ONE offer:
//       – the same file posted again (SHA-256) is not read at all: the offers
//         its first posting showed are re-posted;
//       – a deal read again (same shop, same price, same count, similar name,
//         within REPEAT_LOOKBACK_MS) is re-posted instead of added;
//       – the same product (same name, count and size) at a NEW price
//         replaces the older offer.
//     A re-post moves `last_posted_at` and `expires_at` on and counts in
//     `reposts`; `created_at` (first seen, the "new" badge) never changes.
//   • An offer is shown for OFFER_TTL_MS after the shop last posted it, with
//     the picture it was read from (R2), so a misread is visible at a glance.
//   • 403/429 or a challenge page = `blocked`: the shop waits BLOCKED_RETRY_MS
//     and is never worked around (the Lulu rule).
//   • Frames are capped at FRAME_MONTHLY_CAP a month (Cloudflare's free
//     allowance) and PACED to last the month (pacedFrames): a video gets
//     what is left shared over the videos expected before the month ends,
//     3 to 15 frames. Past the cap a video is read from its cover only.
//   • THE PC READER (2026-11-05, owner: "Build PC reader"): Claude Haiku 5.5
//     on the owner's PC (pc-reader/, the Agent SDK on the owner's Claude
//     login) reads the snaps instead of Mistral while it is on. A reader that
//     asked for work within READER_ON_MS is on: the tick then only PREPARES
//     new snaps (the file fetched, a repeat caught by its hash, a video cut
//     into frames, the pictures put in R2) and the reader claims them, reads
//     every picture twice in batches and posts both copies back
//     (offersFromCopies: an offer stands when both copies list it, a name or
//     size only when printed in both). Mistral reads as before whenever the
//     reader is off, and takes any prepared snap the reader left for
//     READER_WAIT_MS. Bench, 55 snaps / 47 printed prices: Haiku 47/0/1/0,
//     Mistral 43/2/0/2 (HISTORY §69 addendum 5).

import { MISTRAL_URL, postMistral, toBase64, fetchWithTimeout } from './offers/enrich.js';
import { withFailover, classifyMistralError } from './offers/mistralKeys.js';

const DAY_MS = 24 * 60 * 60 * 1000;
export const SHOP_CHECK_MS = 2 * 60 * 60 * 1000;
export const BLOCKED_RETRY_MS = 6 * 60 * 60 * 1000;
export const ERROR_RETRY_MS = 30 * 60 * 1000;
export const OFFER_TTL_MS = 7 * DAY_MS;
export const REPEAT_LOOKBACK_MS = 90 * DAY_MS;
export const FRAME_MONTHLY_CAP = 5000;
export const MAX_FRAMES_PER_VIDEO = 15;
export const MIN_FRAMES_PER_VIDEO = 3;
export const PACE_LOOKBACK_MS = 7 * DAY_MS;
export const MAX_SHOPS = 30;
export const SNAP_MAX_ATTEMPTS = 3;
export const SHOPS_PER_TICK = 3;
export const SNAPS_PER_TICK = 4;
export const TICK_DEADLINE_MS = 100 * 1000;
export const READ_TEMPERATURE = 0.3;
// The PC reader: on when it asked within READER_ON_MS (it asks every 15 min);
// a claim it leaves unanswered expires after READER_CLAIM_MS; a prepared snap
// still unread after READER_WAIT_MS is Mistral's.
export const READER = 'haiku';
export const READER_ON_MS = 25 * 60 * 1000;
export const READER_CLAIM_MS = 20 * 60 * 1000;
export const READER_WAIT_MS = 60 * 60 * 1000;
export const READER_MAX_PICTURES = 112;
export const PREPARE_PER_TICK = 12;
const PAGE_TIMEOUT_MS = 20 * 1000;
const MEDIA_TIMEOUT_MS = 30 * 1000;
const MAX_PRICE = 20000;
const MIN_PRICE = 0.25;

// A desktop browser's headers: the public page is served to browsers, and this
// is the page a browser gets. Nothing here bypasses anything — a 403, 429 or
// challenge is reported as `blocked` and the shop simply waits.
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  'Accept-Language': 'ar,en;q=0.8',
};

// --- shop links -------------------------------------------------------------------
// Snapchat usernames: a letter first, then letters, digits, '.', '-' or '_'.
const USERNAME = /^[a-z][a-z0-9._-]{1,31}$/;

// The owner's input -> { username } | { shortLink } | null. Accepts a bare
// username ("sweet-st", "@t.sshoco") and the profile links Snapchat's Share
// button copies (snapchat.com/add/<u>, snapchat.com/@<u>, story.snapchat.com/@<u>,
// with or without ?share_id=…). A snapchat.com/t/<code> short link has to be
// followed once to learn the username (resolveShopLink).
export function parseShopLink(input) {
  let text = String(input || '').trim();
  if (!text) return null;
  const urlMatch = /https?:\/\/\S+/i.exec(text);
  if (urlMatch) text = urlMatch[0];
  if (/^(?:https?:\/\/)?(?:[a-z]+\.)?snapchat\.com\//i.test(text)) {
    let url;
    try {
      url = new URL(/^https?:/i.test(text) ? text : `https://${text}`);
    } catch {
      return null;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 't' && parts[1]) return { shortLink: `https://www.snapchat.com/t/${parts[1]}` };
    let candidate = null;
    if (parts[0] === 'add' && parts[1]) candidate = parts[1];
    else if (parts[0]?.startsWith('@')) candidate = parts[0].slice(1);
    if (!candidate) return null;
    const username = decodeURIComponent(candidate).toLowerCase();
    return USERNAME.test(username) ? { username } : null;
  }
  const username = text.replace(/^@/, '').toLowerCase();
  return USERNAME.test(username) ? { username } : null;
}

export async function resolveShopLink(input, { fetchImpl = fetch } = {}) {
  const parsed = parseShopLink(input);
  if (!parsed || parsed.username) return parsed?.username || null;
  const res = await fetchWithTimeout(fetchImpl, parsed.shortLink, { headers: PAGE_HEADERS, redirect: 'manual' }, {
    timeoutMs: PAGE_TIMEOUT_MS, label: 'snapchat short link',
  });
  const location = res.headers.get('location');
  const next = location ? parseShopLink(new URL(location, parsed.shortLink).toString()) : null;
  return next?.username || null;
}

export function profileUrl(username) {
  return `https://www.snapchat.com/add/${encodeURIComponent(username)}`;
}

// --- the public profile page ---------------------------------------------------------
const NEXT_DATA = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;
const CHALLENGE = /captcha|challenge-platform|cf-chl|are you a robot|access denied/i;

function valueOf(field) {
  if (field == null) return null;
  if (typeof field === 'object') return field.value ?? null;
  return field;
}

// HTTP status + page HTML -> { status, profile, snaps }. status: ok |
// not_public | not_found | blocked | error.
export function parseProfilePage(httpStatus, html) {
  if (httpStatus === 403 || httpStatus === 429) return { status: 'blocked', snaps: [] };
  if (httpStatus === 404) return { status: 'not_found', snaps: [] };
  const match = NEXT_DATA.exec(String(html || ''));
  if (!match) {
    if (CHALLENGE.test(String(html || ''))) return { status: 'blocked', snaps: [] };
    return { status: httpStatus >= 500 ? 'error' : 'not_found', snaps: [], error: `no page data (HTTP ${httpStatus})` };
  }
  let props;
  try {
    props = JSON.parse(match[1])?.props?.pageProps || {};
  } catch {
    return { status: 'error', snaps: [], error: 'unreadable page data' };
  }
  const profile = props.userProfile;
  if (!profile) return { status: 'not_found', snaps: [] };
  if (profile.$case !== 'publicProfileInfo' || !profile.publicProfileInfo) {
    return {
      status: 'not_public',
      profile: { title: profile.userInfo?.displayName || null, address: null, picture: null },
      snaps: [],
    };
  }
  const info = profile.publicProfileInfo;
  const snaps = [];
  for (const snap of props.story?.snapList || []) {
    const id = valueOf(snap.snapId);
    const mediaUrl = snap.snapUrls?.mediaUrl;
    const kind = Number(snap.snapMediaType);
    if (!id || !mediaUrl || snap.isSponsored) continue;
    if (kind !== 0 && kind !== 1) continue;
    const seconds = Number(valueOf(snap.timestampInSec));
    snaps.push({
      id: String(id),
      mediaType: kind === 0 ? 'image' : 'video',
      mediaUrl,
      previewUrl: valueOf(snap.snapUrls?.mediaPreviewUrl),
      postedAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
    });
  }
  return {
    status: 'ok',
    profile: {
      title: info.title || info.username || null,
      address: info.address || null,
      picture: info.profilePictureUrl || null,
    },
    snaps,
  };
}

export async function fetchProfile(username, { fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, profileUrl(username), { headers: PAGE_HEADERS }, {
      timeoutMs: PAGE_TIMEOUT_MS, label: 'snapchat profile',
    });
  } catch (err) {
    return { status: 'error', snaps: [], error: String(err?.message || err).slice(0, 160) };
  }
  const html = res.ok || res.status >= 500 ? await res.text() : '';
  return parseProfilePage(res.status, html);
}

// --- video frames ------------------------------------------------------------------------
// The movie length from the mp4 'mvhd' box (seconds), or null.
export function mp4DurationSec(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 4; i + 32 < b.length && i < 4 * 1024 * 1024; i += 1) {
    if (b[i] !== 0x6d || b[i + 1] !== 0x76 || b[i + 2] !== 0x68 || b[i + 3] !== 0x64) continue; // 'mvhd'
    const view = new DataView(b.buffer, b.byteOffset + i + 4);
    const version = view.getUint8(0);
    const timescale = version === 1 ? view.getUint32(20) : view.getUint32(12);
    const duration = version === 1 ? Number(view.getBigUint64(24)) : view.getUint32(16);
    if (!timescale || !duration) return null;
    return duration / timescale;
  }
  return null;
}

// Frame times: one a second (0.5, 1.5, …) inside the video; a longer video is
// spread evenly over `max` frames. An unknown length tries the first 10 s
// (a time past the end is simply refused by the binding).
export function frameTimes(durationSec, max = MAX_FRAMES_PER_VIDEO) {
  if (max <= 0) return [];
  const length = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 10;
  const n = Math.min(max, Math.max(1, Math.floor(length)));
  if (length <= max) return Array.from({ length: n }, (_, i) => Math.round((i + 0.5) * 100) / 100).filter((t) => t < length);
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * length / n) * 100) / 100);
}

async function cutFrame(media, bytes, seconds) {
  const res = await media.input(new Blob([bytes]).stream())
    .transform({ width: 480, height: 854, fit: 'contain' })
    .output({ mode: 'frame', time: `${seconds}s`, format: 'jpg' })
    .response();
  // The binding reports "Seek time exceeds media duration" either by throwing
  // or in an error body; both reach the caller's end-of-video check.
  if (!res.ok) throw new Error(`frame ${seconds}s: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return new Uint8Array(await res.arrayBuffer());
}

export async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// --- reading -------------------------------------------------------------------------------
// The reading prompt, v4 (2026-11-05): the 2026-11-04 prompt with two
// changes. Its "copy the digits (6.90, 11.5, 20.70)" list is gone: the reader
// put 20.7 on a tea poster that prints only "3 كرتون ب 10". And a one-digit
// price is named: "1 ريال" was read as 0 or 3. Rewriting the count and size
// rules too (v2, v3) made pack counts worse on the bench, so they stay as
// they were, examples included; the blind check stands behind any number.
export const SNAP_READ_PROMPT = `This picture is one snap (a photo or one frame of a video) from a shop's Snapchat story. List every product whose PRICE is printed in the picture.

Rules:
- A price counts only when it is printed with the product: a caption or text written over the picture, a price tag, sticker, label, shelf card or poster. Text may be rotated or vertical.
- Ignore the phone and app interface: status bar, clock, battery, "منذ" or "ago" times, dates, view counts, usernames, buttons, phone numbers, QR codes, discount percentages.
- A crossed-out price is the OLD price ("was_price") of the product it belongs to. It is never a product of its own.
- "count" is how many units the price buys, as printed: "4 حبات بـ 11.5" is count 4, "2 كراتين بـ 15" is count 2, a single item is count 1. "unit" is the unit word as printed (حبة, كرتون, علبة, كيس) or null.
- "size" is the size of ONE unit only when printed (for example "400 جرام", "4 كيلو", "2.75 كجم"), otherwise null. "24 حبة" inside one carton is the size of the carton, not the count. A number with a weight or volume word is a size, never the price or the count.
- "name": the product name as printed in the caption, tag or poster, in the same language. If none is printed, name the product from its package in a few Arabic words. Never use the shop's name or slogan as the name. Never invent a brand.
- "brand" only when printed on the package or poster, otherwise null.
- Prices are Saudi riyals. Copy every digit of the price exactly as printed, with its decimals. A price can be a single digit: "فقط ب 1 ريال" is price 1.

Return JSON only, with numbers for count, price and was_price:
{"offers":[{"name":"...","brand":null,"size":null,"count":1,"unit":null,"price":P,"was_price":null}]}
If no price is printed, return {"offers":[]}.`;

// The check, blind (v2): it lists the prices printed in the picture without
// being told which one is being checked. Told the number, the old check
// agreed with the reader's made-up 20.7 three times out of three.
export const PRICES_PROMPT = `Look at this picture from a shop's Snapchat story. List every SELLING price printed in it (in a caption, price tag, sticker or poster), with the exact printed words around each price.
Do not list weights or sizes (a number followed by جرام, جم, كيلو, كجم, مل, لتر, g, kg, ml), counts, dates, times, phone numbers, percentages, app text, or crossed-out old prices.
Return JSON only: {"prices":[{"price":P,"words":"the printed words that show it"}]}
If no selling price is printed, return {"prices":[]}.`;

// What the picture prints, copied (2026-11-05). A name or size is shown only
// when its words are printed there (owner: "if the system is not sure it must
// not guess"): the reader once called Almarai chicken strips "مربى الفراولة"
// under a caption that says "استربس المراعي". Asked for one "text", the copy
// ended with a line of its own, "مربى الطماطم", under a poster that prints
// "معجون الطماطم"; line by line, with "never name the product yourself", it
// did not.
export const TEXT_PROMPT = `Copy the text printed in this picture, word for word: captions, stickers, banners, price tags and the writing on the packages. Copy only what is actually written. Never add a word that is not printed, never name or describe the product yourself, never translate. Keep each piece of text in its own script.
Return JSON only: {"lines":["..."]}`;

// The PC reader's prompt (Claude Haiku 5.5, several pictures per call, each
// labelled "Picture n"): the reading prompt's Rules word for word, except the
// name, which is the words printed for the product; each picture's printed
// lines come first, so a price and a name can be checked against them.
// Measured on the bench at 28 pictures a call: no text or offer moved from one
// picture to another.
const READ_RULES = SNAP_READ_PROMPT.slice(SNAP_READ_PROMPT.indexOf('Rules:'), SNAP_READ_PROMPT.indexOf('Return JSON only'))
  .replace(/- "name":[^\n]*\n/, '- "name": the product name in the words printed for it (caption, tag, poster or package), in the language printed. Never use the shop\'s name or slogan as the name. Never invent a brand or a word that is not printed.\n');
export const BATCH_READ_PROMPT = `Each picture above is one snap (a photo or one frame of a video) from a shop's Snapchat story, labelled "Picture 1", "Picture 2", and so on. Read every picture on its own: never move text or offers from one picture to another.
For each picture, first "lines": copy the text printed in it, word for word: captions, stickers, banners, price tags and the writing on the packages. Copy only what is actually written. Never add a word, never translate. Keep each piece of text in its own script.
Then "offers": every product whose PRICE is printed in that picture. A price written as a word counts: "بريال" (for a riyal, often drawn out "بريااال") is price 1.

${READ_RULES}
Return JSON only: one entry for every picture, in order, with numbers for count, price and was_price:
{"pictures":[{"picture":1,"lines":["..."],"offers":[{"name":"...","brand":null,"size":null,"count":1,"unit":null,"price":P,"was_price":null}]}]}
A picture with no printed price has "offers": [].`;

function visionRequest(model, text, base64, contentType, temperature) {
  return {
    model,
    temperature,
    top_p: 1,
    response_format: { type: 'json_object' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: `data:${contentType};base64,${base64}` },
      ],
    }],
  };
}

function parseJson(raw) {
  try {
    const match = /\{[\s\S]*\}/.exec(String(raw || ''));
    return JSON.parse(match ? match[0] : raw);
  } catch {
    return null;
  }
}

const round2 = (n) => Math.round(n * 100) / 100;
const samePrice = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.005;

function cleanText(value, max = 120) {
  if (value == null) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text && text.toLowerCase() !== 'null' ? text.slice(0, max) : null;
}

// Pack words. "الكرتون 24 حبة بـ 20.70" is 24 pieces in ONE carton; the
// reader has returned it as count 24, unit "كرتون" (measured on 7up,
// 2026-11-04). A deal on 12 or more cartons is not a mini-mart offer, so such
// a count is pieces: the unit is dropped and the per-piece price stands.
const PACK_UNIT = /^(?:ال)?(?:كرتون[ةه]?|كراتين|صندوق|صناديق|شد|كيس|اكياس|أكياس|باكيت|بكت|carton|cartons|box|boxes|case|pack)$/i;
const PIECES_IN_A_PACK = 12;

// One model reply -> valid offers. A price must be a number in range; an old
// price is kept only when it is higher; count is a small positive integer.
// A weight, volume or money word given as the unit: the "count" is a size
// (measured: Loacker 2.5 read as "45 جرام", chicken 37.5 as "2.5 ريال").
const SIZE_UNIT = /^(?:ال)?(?:جرام|غرام|جم|غم|كيلو(?:\s?جرام)?|كجم|كغ|كلغ|ملي(?:\s?لتر)?|مل|لتر|g|gm|gr|grams?|kg|ml|l|ltr|ريال|sar)$/iu;

export function parseSnapReading(raw) {
  const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!parsed || !Array.isArray(parsed.offers)) return null;
  const offers = [];
  for (const item of parsed.offers) {
    if (!item || typeof item !== 'object') continue;
    const price = numberIn(item.price);
    if (!Number.isFinite(price) || price < MIN_PRICE || price > MAX_PRICE) continue;
    const was = numberIn(item.was_price);
    let size = cleanText(item.size, 40);
    let unit = cleanText(item.unit, 20);
    let count = Number(item.count);
    if (unit && SIZE_UNIT.test(unit)) {
      if (!size && unit !== 'ريال' && Number.isFinite(count)) size = `${count} ${unit}`;
      unit = null;
      count = 1;
    }
    // Units are whole: "2.5" is a weight, not two and a half packs.
    if (!Number.isInteger(count) || count < 1 || count > 100) count = 1;
    if (unit && count >= PIECES_IN_A_PACK && PACK_UNIT.test(unit)) unit = null;
    offers.push({
      name: cleanText(item.name),
      brand: cleanText(item.brand, 60),
      size,
      count,
      unit,
      price: round2(price),
      wasPrice: Number.isFinite(was) && was > price && was <= MAX_PRICE ? round2(was) : null,
    });
  }
  return offers;
}

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export function normalizeDigits(text) {
  return String(text || '')
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٫,]/g, '.');
}

// App text the check sometimes quotes as a "price" (measured: "منذ ٢٣", the
// story's "23 hours ago").
const INTERFACE_WORDS = /منذ|ago|ساعة|ساعات|دقيقة|دقائق|\bmin\b|\bhrs?\b|\d{1,2}:\d{2}/i;
// A weight or volume word right after a number makes it a size ("2,5 كجم").
const WEIGHT_AFTER = /^\s*(?:جرام|جم|غرام|غم|كيلو|كجم|كغ|كلغ|ملي|مل|لتر|g|gm|gr|kg|ml|l)(?![\p{L}])/iu;
// "بريال" — for a riyal, the letters often drawn out ("العبوة بريااال") — is
// the price 1 written as a word (never "ريالين", never "بـ 5 ريال").
const ONE_RIYAL_WORD = /(?:^|[^\p{L}])بـ?\s?ر[يى]ا+ل(?![\p{L}])/u;

// The first number in a value: 11.5, "6,90", "15 ريال", "١١٫٥" -> a number.
// The check often gives its price as text (measured: "15 ريال", "6,90").
function numberIn(value) {
  if (typeof value === 'number') return value;
  const m = /\d+(?:\.\d+)?/.exec(normalizeDigits(value));
  return m ? Number(m[0]) : NaN;
}

// The text shows this number, and every time with a weight word after it.
function shownAsSize(text, price) {
  let seen = false;
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
    if (!samePrice(Number(m[0]), price)) continue;
    if (!WEIGHT_AFTER.test(text.slice(m.index + m[0].length))) return false;
    seen = true;
  }
  return seen;
}

// The blind check's reply -> true when it lists this price, unless what it
// quotes is app text or shows the number only as a weight. The quoted words
// may miss the price itself (measured: 34.95 quoted as "السعر 5 ريال فقط"):
// not being told the price, the listing is the evidence.
export function priceListed(reply, price) {
  const parsed = typeof reply === 'string' ? parseJson(reply) : reply;
  if (!parsed || !Array.isArray(parsed.prices)) return false;
  return parsed.prices.some((p) => {
    if (!p || !samePrice(numberIn(p.price), price)) return false;
    const said = normalizeDigits(p.price);
    const words = normalizeDigits(p.words);
    if (INTERFACE_WORDS.test(said) || INTERFACE_WORDS.test(words)) return false;
    return !shownAsSize(said, price) && !shownAsSize(words, price);
  });
}

// A price that is a size printed in the same snap ("2,5 كجم ب 37,5" read as
// a second offer at 2.5) is that size, never a product of its own.
export function dropSizeTwins(offers) {
  return offers.filter((o) => !offers.some((other) => {
    if (other === o) return false; // "10 كيلو بصل بـ 10" is a price
    const size = normalizeDigits(other.size || '');
    for (const m of size.matchAll(/\d+(?:\.\d+)?/g)) {
      if (samePrice(Number(m[0]), o.price) && WEIGHT_AFTER.test(size.slice(m.index + m[0].length))) return true;
    }
    return false;
  }));
}

// --- names and sizes: printed, or not shown -------------------------------------
// Every string in the reply, whatever its shape: the model answers {"text":
// "..."}, but also lists of lines or of {"text": ...} objects (measured).
function strings(value) {
  if (typeof value === 'string') return [value];
  if (typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

export function parseText(raw) {
  const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
  if (parsed == null) return typeof raw === 'string' ? raw : '';
  return strings(parsed).join('\n');
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

// Arabic letters as Latin sounds, so a brand written in either script
// compares: "كادبوري" and "Cadbury" are both k-d-b-r (vowels left out).
const AR_SOUNDS = {
  ب: 'b', ت: 't', ث: 't', ج: 'j', ح: 'h', خ: 'k', د: 'd', ذ: 'd', ر: 'r', ز: 's', س: 's', ش: 'S', ص: 's', ض: 'd',
  ط: 't', ظ: 's', غ: 'j', ف: 'f', ق: 'k', ك: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h', پ: 'b', ڤ: 'f', چ: 'S', گ: 'j',
};
const ARABIC = /[؀-ۿ]/;
function sounds(word) {
  const out = ARABIC.test(word)
    ? [...word.replace(/ه$/, '')].map((c) => AR_SOUNDS[c] || '').join('')
    : word.replace(/tion/g, 'Sn').replace(/sh|ch/g, 'S').replace(/th/g, 't').replace(/ph/g, 'f')
      .replace(/c(?=[eiy])/g, 's').replace(/ck|c|q/g, 'k').replace(/x/g, 'ks').replace(/p/g, 'b')
      .replace(/v/g, 'f').replace(/g/g, 'j').replace(/z/g, 's').replace(/[^bdfhjklmnrstS]/g, '');
  return out.replace(/(.)\1+/g, '$1');
}

// One word as printed: allowing a copying slip ("بابل" for "بابلي",
// "شوكلاته" for "شوكولاته"), or the same word in the other script
// ("شيتوس" over "Cheetos").
function sameWord(a, b) {
  if (a === b) return true;
  if (ARABIC.test(a) !== ARABIC.test(b)) {
    const sa = sounds(a);
    const sb = sounds(b);
    const short = Math.min(sa.length, sb.length);
    if (short < 2) return false;
    if (short < 3) return sa === sb;
    return editDistance(sa, sb) <= Math.floor(Math.max(sa.length, sb.length) / 4);
  }
  if (Math.min(a.length, b.length) < 4) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return editDistance(a, b) <= (Math.max(a.length, b.length) >= 7 ? 2 : 1);
}

// The name as shown: only its words that are printed in the picture, in
// their order (owner, 2026-11-05: "if the system is not sure it must not
// guess"). Null when fewer than half are printed: the name is mostly the
// reader's own ("مربى الفراولة" under a caption that says "استربس المراعي").
// `ignore`: the shop's own words, never part of a product's name, even
// misspelt ("بشار" for "بشائر"). A bare number is left out: it is the price
// or a count as often as part of the name ("5 منتجات من هانتيرز").
// `texts`: one copy of the picture's text, or several; a word counts only
// when every copy has it.
export const MIN_PRINTED_SHARE = 0.5;
export function printedName(name, texts, ignore = null) {
  const copies = [].concat(texts).map((text) => [...nameTokens(text)]);
  const shop = [...(ignore || [])];
  const kept = [];
  let words = 0;
  let printed = 0;
  for (const word of String(name || '').split(/\s+/)) {
    const tokens = [...nameTokens(word)].filter((t) => !shop.some((u) => sameWord(t, u)));
    if (!tokens.length) continue;
    words += 1;
    if (tokens.every((t) => copies.every((seen) => seen.some((u) => sameWord(t, u))))) {
      printed += 1;
      kept.push(word);
    }
  }
  if (!words || printed / words < MIN_PRINTED_SHARE) return null;
  return tidyName(kept.join(' ')) || null;
}

// Brackets and dashes a dropped word left open.
function tidyName(text) {
  let out = text.replace(/\(\s*\)/g, ' ');
  if ((out.match(/\(/g) || []).length !== (out.match(/\)/g) || []).length) out = out.replace(/[()]/g, ' ');
  return out.replace(/\s+[-–&,،/]+(?=\s|$)/g, ' ').replace(/^[\s\-–&,،/]+|[\s\-–&,،/]+$/g, '').replace(/\s{2,}/g, ' ').trim();
}

// A size is printed when its numbers are ("45 جرام" over "45g").
export function sizePrintedIn(size, texts) {
  const numbers = normalizeDigits(size).match(/\d+(?:\.\d+)?/g);
  if (!numbers) return false;
  return [].concat(texts).every((text) => {
    const seen = (normalizeDigits(text).match(/\d+(?:\.\d+)?/g) || []).map(Number);
    return numbers.every((n) => seen.some((m) => samePrice(m, Number(n))));
  });
}

// --- names: telling one deal from another ---------------------------------------------
// Words every caption carries ("عرض", "ريال", "حبة") and the shops' slogan
// words ("للحلويات والمواد الغذائية"): they say nothing about which product
// it is. Measured 2026-11-05: two readings named after the shop's slogan made
// a TUC poster a "repeat" of a Pillsbury one.
const FILLER = new Set(['عرض', 'عروض', 'سعر', 'ريال', 'رس', 'فقط', 'حبه', 'حبات', 'حبتين', 'كرتون', 'كراتين',
  'علبه', 'علب', 'كيس', 'اكياس', 'جديد', 'وصل', 'متوفر', 'offer', 'sar', 'sr', 'only', 'new', 'pcs', 'pc',
  'حلويات', 'مواد', 'غذائيه', 'مخفضه', 'مستورده', 'مع', 'من', 'في', 'with', 'and', 'of', 'the',
  // Weights say which size, never which product ("الحلوى 45 جرام" is not "جرام").
  'وزن', 'جرام', 'جم', 'غرام', 'غم', 'كيلو', 'كجم', 'كغ', 'كغم', 'مل', 'لتر', 'gm', 'gr', 'kg', 'ml']);

// `ignore`: more words to leave out, e.g. the shop's own name (shopWords).
export function nameTokens(name, ignore = null) {
  const tokens = String(name || '')
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.replace(/^(?:بال|وال|لل|ال)(?=\p{L}{2})/u, ''))
    .filter((t) => t.length >= 2 && !/^\p{N}+$/u.test(t) && !FILLER.has(t) && !ignore?.has(t));
  return new Set(tokens);
}

// A shop's own name never tells two of its products apart.
export function shopWords(title) {
  return nameTokens(title);
}

// Two readings name the same product when half the shorter name's words are
// in the other (readings of one picture vary: "لبنة تركية" / "لبنة").
export function similarNames(a, b, ignore = null) {
  const ta = nameTokens(a, ignore);
  const tb = nameTokens(b, ignore);
  if (!ta.size || !tb.size) return !ta.size && !tb.size;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / Math.min(ta.size, tb.size) >= 0.5;
}

// The same deal: same price, same count, similar name. Two names with no
// product word left (only the shop's slogan) can't say it is the same product,
// so they are two offers: a hidden offer is worse than a second card.
export function sameDeal(a, b, ignore = null) {
  return samePrice(a.price, b.price) && (a.count || 1) === (b.count || 1)
    && nameTokens(a.name, ignore).size > 0 && similarNames(a.name, b.name, ignore);
}

const sameTokens = (a, b) => a.size === b.size && [...a].every((t) => b.has(t));
const digitsOf = (text) => String(text || '').replace(/\D/g, '');

// The same product, priced again: identical name words, count and size.
export function sameProduct(a, b, ignore = null) {
  const ta = nameTokens(a.name, ignore);
  if (!ta.size || !sameTokens(ta, nameTokens(b.name, ignore))) return false;
  return (a.count || 1) === (b.count || 1)
    && sameTokens(nameTokens(a.size), nameTokens(b.size))
    && digitsOf(a.size) === digitsOf(b.size);
}

export function dedupeDeals(offers) {
  const out = [];
  for (const offer of offers) if (!out.some((o) => sameDeal(o, offer))) out.push(offer);
  return out;
}

// Two readings of one photo -> the offers both show (same price). The first
// reading's fields win; an old price survives only if both report it.
export function agreePhoto(first, second) {
  if (!first || !second) return [];
  const out = [];
  for (const a of first) {
    const b = second.find((o) => samePrice(o.price, a.price) && similarNames(o.name, a.name))
      || second.find((o) => samePrice(o.price, a.price));
    if (!b) continue;
    out.push({ ...a, wasPrice: samePrice(a.wasPrice, b.wasPrice) ? a.wasPrice : null, votes: 2, names: [b.name] });
  }
  return dropOldPriceTwins(dedupeDeals(out));
}

function mode(values) {
  const counts = new Map();
  for (const v of values) if (v != null) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (best == null || n > counts.get(best)) best = v;
  return best;
}

function frameOffer(frames, entries) {
  const was = mode(entries.map((e) => e.wasPrice));
  const wasVotes = entries.filter((e) => samePrice(e.wasPrice, was)).length;
  return {
    ...entries[0],
    count: mode(entries.map((e) => e.count)) || 1,
    names: [...new Set(entries.flatMap((e, i) => [...(i ? [e.name] : []), ...(e.names || [])]))],
    wasPrice: wasVotes >= 2 ? was : null,
    frame: Math.min(...frames),
    votes: frames.size,
  };
}

// Frame readings (one array per frame, null for an unreadable reply) ->
// { accepted, single }. A price two frames show is accepted — one offer per
// product name seen in two frames, else one offer for the price (one product
// whose name was read differently). A price only one frame shows is returned
// in `single` for one more reading of that frame.
export function groupFrames(frameReadings) {
  const groups = [];
  frameReadings.forEach((offers, frame) => {
    for (const offer of offers || []) {
      let group = groups.find((g) => samePrice(g.price, offer.price));
      if (!group) {
        group = { price: offer.price, frames: new Set(), clusters: [] };
        groups.push(group);
      }
      group.frames.add(frame);
      let cluster = group.clusters.find((c) => similarNames(c.entries[0].name, offer.name));
      if (!cluster) {
        cluster = { frames: new Set(), entries: [] };
        group.clusters.push(cluster);
      }
      cluster.frames.add(frame);
      cluster.entries.push(offer);
    }
  });
  // One offer whose two copies named it differently (the caption in one, the
  // package in the other: agreeCopies keeps the other copy's in `names`) is
  // one product: its clusters become one.
  const readAs = (o) => [o.name, ...(o.names || [])].filter((n) => nameTokens(n).size);
  const aliases = (a, b) => [[a, b], [b, a]].some(([x, y]) => (x.names || []).some((n) => nameTokens(n).size
    && readAs(y).some((m) => similarNames(n, m))));
  for (const g of groups) {
    for (let i = 0; i < g.clusters.length; i += 1) {
      for (let j = g.clusters.length - 1; j > i; j -= 1) {
        if (!g.clusters[i].entries.some((a) => g.clusters[j].entries.some((b) => aliases(a, b)))) continue;
        const [other] = g.clusters.splice(j, 1);
        other.frames.forEach((f) => g.clusters[i].frames.add(f));
        g.clusters[i].entries.push(...other.entries);
        j = g.clusters.length;
      }
    }
  }
  const accepted = [];
  const single = [];
  for (const g of groups) {
    const strong = g.clusters.filter((c) => c.frames.size >= 2);
    if (strong.length) accepted.push(...strong.map((c) => frameOffer(c.frames, c.entries)));
    else if (g.frames.size >= 2) accepted.push(frameOffer(g.frames, g.clusters.flatMap((c) => c.entries)));
    else single.push(...g.clusters.map((c) => frameOffer(c.frames, c.entries)));
  }
  return { accepted, single };
}

// A price that is another offer's old price in the same snap is that offer's
// crossed-out tag, never a product of its own.
export function dropOldPriceTwins(offers) {
  return offers.filter((o) => !offers.some((other) => other !== o && samePrice(other.wasPrice, o.price)));
}

// --- the PC reader's copies -------------------------------------------------------------
// A price counts only when a copied line prints it: not in the app's own text
// ("منذ ٢٣", a clock) and at least once not as a weight; "بريال" prints 1.
export function pricePrinted(lines, price) {
  return [].concat(lines || []).some((line) => {
    const text = normalizeDigits(line);
    if (INTERFACE_WORDS.test(text)) return false;
    if (samePrice(price, 1) && ONE_RIYAL_WORD.test(text)) return true;
    return [...text.matchAll(/\d+(?:\.\d+)?/g)].some((m) => samePrice(Number(m[0]), price)
      && !WEIGHT_AFTER.test(text.slice(m.index + m[0].length)));
  });
}

// One copy of one picture ({ lines, offers } as the reader answered) -> its
// printed lines and the offers whose price those lines print.
export function copyOfPicture(entry) {
  const lines = Array.isArray(entry?.lines) ? entry.lines.map((l) => String(l ?? '')) : [];
  const read = parseSnapReading(entry) || [];
  const offers = dropSizeTwins(dropOldPriceTwins(dedupeDeals(read))).filter((o) => pricePrinted(lines, o.price));
  return { lines, offers };
}

// Two copies of one picture -> the offers both list, ONE TO ONE: an offer of
// the second copy vouches for one offer of the first (the same name first,
// else the same price), so a second flavour only one copy saw does not stand.
export function agreeCopies(first, second) {
  const left = [...second];
  const out = [];
  for (const a of first) {
    let k = left.findIndex((o) => samePrice(o.price, a.price) && similarNames(o.name, a.name));
    if (k < 0) k = left.findIndex((o) => samePrice(o.price, a.price));
    if (k < 0) continue;
    const [b] = left.splice(k, 1);
    out.push({ ...a, wasPrice: samePrice(a.wasPrice, b.wasPrice) ? a.wasPrice : null, votes: 2, names: [b.name] });
  }
  return dropOldPriceTwins(dedupeDeals(out));
}

// The reader's copies of one snap -> its offers, by readSnap's rules.
// pictures: [{ ref, copies: [entry, entry] }] in frame order; framed: a
// video's frames (a price in two frames, or in one frame by both copies,
// stands). A name shows only its words printed in both copies of its
// picture, a size only when its numbers are. -> [{ …offer, frame }]
export function offersFromCopies(pictures, { framed = false, ignore = null } = {}) {
  const read = pictures.map((p) => {
    const copies = (p.copies || []).slice(0, 2).map(copyOfPicture);
    return {
      texts: copies.map((c) => c.lines.join('\n')),
      offers: copies.length === 2 ? agreeCopies(copies[0].offers, copies[1].offers) : [],
    };
  });
  let candidates;
  if (framed) {
    const { accepted, single } = groupFrames(read.map((r) => r.offers));
    candidates = dropSizeTwins(dropOldPriceTwins(dedupeDeals([...accepted, ...single])));
  } else {
    candidates = dropSizeTwins(read[0]?.offers || []).map((o) => ({ ...o, frame: 0 }));
  }
  return candidates.map((offer) => {
    const { texts } = read[offer.frame];
    const { names = [], ...rest } = offer;
    let best = { name: offer.name, shown: '' };
    for (const name of [offer.name, ...names]) {
      const shown = printedName(name, texts, ignore);
      if (shown && shown.length > best.shown.length) best = { name, shown };
    }
    return {
      ...rest,
      name: best.name,
      shownName: best.shown,
      sizePrinted: offer.size ? Number(sizePrintedIn(offer.size, texts)) : null,
    };
  });
}

// --- one snap ----------------------------------------------------------------------------
async function fetchMedia(url, fetchImpl) {
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, url, { headers: PAGE_HEADERS }, { timeoutMs: MEDIA_TIMEOUT_MS, label: 'snap media' });
  } catch (err) {
    err.stage = 'media';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`snap media HTTP ${res.status}`);
    err.stage = 'media';
    err.status = res.status;
    throw err;
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/jpeg' };
}

// The pictures of one snap: a photo; a video's frames (`framed`), or its
// cover when frames can't be cut. A file posted before (the same SHA-256) is
// not cut or read: -> { repeatOf }. `report` collects { frames, hash }.
// -> { pictures: [{ bytes, contentType, ref }], framed, repeatOf }
export async function loadSnapPictures(snap, { media = null, framesAllowed = MAX_FRAMES_PER_VIDEO, fetchImpl = fetch, findRepeat = null, report = {} }) {
  report.frames ??= 0;
  const video = snap.mediaType === 'video';
  const framed = Boolean(video && media && framesAllowed > 0);
  const url = video && !framed ? snap.previewUrl : snap.mediaUrl;
  if (!url) return { pictures: [], framed, repeatOf: null };
  const file = await fetchMedia(url, fetchImpl);
  report.hash = await sha256Hex(file.bytes);
  const earlier = findRepeat ? await findRepeat(report.hash) : null;
  if (earlier) return { pictures: [], framed, repeatOf: earlier };
  if (!framed) return { pictures: [{ ...file, ref: video ? 'cover' : 'photo' }], framed, repeatOf: null };
  const pictures = [];
  for (const t of frameTimes(mp4DurationSec(file.bytes), framesAllowed)) {
    report.frames += 1; // a refused cut still counts against the monthly allowance
    try {
      pictures.push({ bytes: await cutFrame(media, file.bytes, t), contentType: 'image/jpeg', ref: `f${Math.round(t * 10)}` });
    } catch (err) {
      if (/exceeds media duration/i.test(String(err?.message))) break;
      throw err;
    }
  }
  return { pictures, framed, repeatOf: null };
}

// A prepared picture's ref says what it is: "f15" a frame (1.5 s).
export const isFrameRef = (ref) => /^f\d+$/.test(String(ref));

// Reads one snap with Mistral. `ask(text, image, temperature)` returns the
// model's raw reply; `findRepeat(hash)` returns an earlier read snap of the
// same file (or null). `prepared`: the snap's pictures, already loaded
// ({ pictures, framed }), for a snap the PC reader left. `report` collects
// { frames, readings, hash } even when this throws.
// -> { offers: [{…, image: {bytes, contentType, ref}}], repeatOf }
export async function readSnap(snap, { ask, media = null, framesAllowed = MAX_FRAMES_PER_VIDEO, fetchImpl = fetch, findRepeat = null, prepared = null, report = {} }) {
  report.frames ??= 0;
  report.readings ??= 0;
  const read = async (image) => {
    report.readings += 1;
    return parseSnapReading(await ask(SNAP_READ_PROMPT, image, READ_TEMPERATURE));
  };
  // One blind check per picture, however many prices it carries.
  const checks = new Map();
  const confirm = async (frame, price) => {
    if (!checks.has(frame)) {
      report.readings += 1;
      checks.set(frame, await ask(PRICES_PROMPT, pictures[frame], 0));
    }
    return priceListed(checks.get(frame), price);
  };

  const loaded = prepared || await loadSnapPictures(snap, { media, framesAllowed, fetchImpl, findRepeat, report });
  if (loaded.repeatOf) return { offers: [], repeatOf: loaded.repeatOf };
  const { pictures, framed } = loaded;
  if (!pictures.length) return { offers: [], repeatOf: null };

  let candidates;
  if (framed) {
    const readings = [];
    for (const picture of pictures) readings.push(await read(picture));
    const { accepted, single } = groupFrames(readings);
    candidates = accepted;
    for (const offer of single) {
      const again = await read(pictures[offer.frame]);
      if (again?.some((o) => samePrice(o.price, offer.price))) candidates.push({ ...offer, votes: 2 });
    }
    candidates = dropSizeTwins(dropOldPriceTwins(dedupeDeals(candidates)));
  } else {
    // A photo, or a video read from its cover (no binding, or the month's
    // frame allowance is spent).
    const first = await read(pictures[0]);
    // No price in the first reading: an ad (owner's rule) — no second call.
    if (!first?.length) return { offers: [], repeatOf: null };
    let second = await read(pictures[0]);
    // An empty second reading of a priced photo is a slip: one more look.
    if (!second?.length) second = await read(pictures[0]);
    candidates = dropSizeTwins(agreePhoto(first, second)).map((o) => ({ ...o, frame: 0 }));
  }

  // What each picture prints, copied twice: a name shows only its words both
  // copies have, and a size only when printed. One copy in five added a line
  // of its own, "مربى الطماطم", under a poster that prints "معجون الطماطم"
  // (measured); words truly printed were in 5 copies of 5. The reading with
  // the most printed words wins; a guess is kept for telling repeats apart,
  // never shown.
  const ignore = shopWords(snap.shopTitle);
  const texts = new Map();
  const printed = async (frame) => {
    if (!texts.has(frame)) {
      const copies = [];
      for (let i = 0; i < 2; i += 1) {
        report.readings += 1;
        copies.push(parseText(await ask(TEXT_PROMPT, pictures[frame], 0)));
      }
      texts.set(frame, copies);
    }
    return texts.get(frame);
  };

  const offers = [];
  for (const offer of candidates) {
    const picture = pictures[offer.frame];
    if (!picture || !(await confirm(offer.frame, offer.price))) continue;
    // The price check quotes printed words too.
    const quoted = parseText(checks.get(offer.frame));
    const copies = (await printed(offer.frame)).map((text) => `${text}\n${quoted}`);
    const { names = [], ...rest } = offer;
    let best = { name: offer.name, shown: '' };
    for (const name of [offer.name, ...names]) {
      const shown = printedName(name, copies, ignore);
      if (shown && shown.length > best.shown.length) best = { name, shown };
    }
    offers.push({
      ...rest,
      name: best.name,
      shownName: best.shown,
      sizePrinted: offer.size ? Number(sizePrintedIn(offer.size, copies)) : null,
      image: picture,
    });
  }
  return { offers, repeatOf: null };
}

// --- the shop's picture: its logo, or not -----------------------------------------------------
// The Brochures tile shows a shop's picture only when it is the shop's own
// logo, and the shop's name otherwise (owner, 2026-11-05: "if you dont have a
// logo write the name of the shop dont show the snapchat logo"). Snapchat's
// own pictures (a Snapcode, the default silhouette) and photos of shelves or a
// storefront are not logos. Measured on the 5 shops, 3 runs each: 15/15 right
// at 400 px; at Snapchat's 90 px the same model was wrong on 2 of 5.
export const PICTURE_PROMPT = `This is a shop's Snapchat profile picture. Classify the MAIN content of the picture (ignore small icons in a corner).
- "logo": the shop's own logo: designed lettering of the shop's name, or a graphic emblem, usually on a plain background.
- "photo": a camera photograph of a real scene: shelves, products, a storefront or sign on a building, a street, people.
- "snapchat": the whole picture is a Snapchat graphic: a Snapcode (yellow square with a ghost and dots) or the default avatar (a plain yellow silhouette of a person).
Return JSON only: {"kind": "logo" or "photo" or "snapchat"}`;

const PICTURE_KINDS = new Set(['logo', 'photo', 'snapchat']);

export function parsePictureKind(raw) {
  const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
  const kind = String(parsed?.kind || '').trim().toLowerCase();
  return PICTURE_KINDS.has(kind) ? kind : null;
}

// Snapchat serves profile pictures at 90 px ("_RS0,90_"); the same address
// gives 400 px.
export function largePicture(url) {
  return String(url).replace(/_RS0,\d+_/, '_RS0,400_');
}

async function pictureKind(url, { ask, fetchImpl }) {
  const file = await fetchMedia(largePicture(url), fetchImpl);
  return parsePictureKind(await ask(PICTURE_PROMPT, file, 0));
}

// --- the tick ---------------------------------------------------------------------------------
async function checkShops({ store, ask, fetchImpl, now, report }) {
  for (const shop of await store.dueShops(now().toISOString(), SHOPS_PER_TICK)) {
    const page = await fetchProfile(shop.username, { fetchImpl });
    const at = now();
    const retryMs = page.status === 'blocked' ? BLOCKED_RETRY_MS : page.status === 'error' ? ERROR_RETRY_MS : SHOP_CHECK_MS;
    const added = page.status === 'ok' ? await store.addSnaps(shop.username, page.snaps, at.toISOString()) : 0;
    const newest = page.snaps.map((s) => s.postedAt).filter(Boolean).sort().pop() || null;
    await store.recordCheck(shop.username, {
      status: page.status,
      error: page.error || null,
      profile: page.profile || null,
      lastPostAt: newest,
      checkedAt: at.toISOString(),
      nextCheckAt: new Date(at.getTime() + retryMs).toISOString(),
    });
    const entry = { shop: shop.username, status: page.status, snaps: page.snaps.length, added };
    // Once per picture: a shop that changes its picture is looked at again,
    // and a failed look is tried again at the next check.
    const picture = page.status === 'ok' ? page.profile?.picture : null;
    if (ask && picture && picture !== shop.pictureKindOf) {
      try {
        const kind = await pictureKind(picture, { ask, fetchImpl });
        report.readings += 1;
        if (kind) {
          await store.setPictureKind(shop.username, kind, picture);
          entry.picture = kind;
        }
      } catch {
        /* the next check tries again */
      }
    }
    report.checked.push(entry);
  }
}

// Saves what one snap showed: a deal the shop posted before (within the
// lookback, live or expired) is re-posted; the same product at a new price
// replaces the older offer; anything else is a new offer.
// A snap READ AGAIN (snap.reread) corrects its own earlier offers instead:
// an offer at the same price (the same count first) is rewritten in place
// (its id, first-seen time and postings stay), an earlier offer the new
// reading doesn't show is retired, and a new one is saved as above.
async function saveOffers({ store, bucket, snap, offers, at }) {
  const nowIso = at.toISOString();
  const posted = snap.postedAt || nowIso;
  const expiresAt = new Date(Date.parse(posted) + OFFER_TTL_MS).toISOString();
  let history = await store.recentOffers(snap.username, new Date(at.getTime() - REPEAT_LOOKBACK_MS).toISOString());
  const own = snap.reread ? await store.offersOfSnap(snap.snapId) : [];
  if (snap.reread) history = history.filter((o) => o.snapId !== snap.snapId);
  const ignore = shopWords(snap.shopTitle);
  const shown = [];
  const fresh = [];
  const stored = new Set();
  const keep = async (offer) => {
    const imageKey = pictureKey(snap, offer.image.ref);
    if (bucket && !stored.has(imageKey)) {
      // A prepared picture is in R2 already.
      if (offer.image.bytes) await bucket.put(imageKey, offer.image.bytes, { httpMetadata: { contentType: offer.image.contentType || 'image/jpeg' } });
      stored.add(imageKey);
    }
    return bucket ? imageKey : null;
  };
  let n = snap.reread ? 100 : 0; // a re-read's new offers never take an earlier id
  let rewritten = 0;
  for (const offer of offers) {
    n += 1;
    if (snap.reread) {
      let k = own.findIndex((o) => !o.used && samePrice(o.price, offer.price) && (o.count || 1) === (offer.count || 1));
      if (k < 0) k = own.findIndex((o) => !o.used && samePrice(o.price, offer.price));
      if (k >= 0) {
        own[k].used = true;
        await store.rewriteOffer(own[k].id, { ...offer, imageKey: await keep(offer) });
        if (!shown.includes(own[k].id)) shown.push(own[k].id);
        rewritten += 1;
        continue;
      }
    }
    const earlier = history.find((o) => sameDeal(o, offer, ignore));
    if (earlier) {
      if (!shown.includes(earlier.id)) {
        await store.repostOffer(earlier.id, { postedAt: posted, expiresAt });
        shown.push(earlier.id);
      }
      continue;
    }
    for (const older of history) {
      if (older.expiresAt > nowIso && (older.lastPostedAt || older.postedAt || '') <= posted && sameProduct(older, offer, ignore)) {
        await store.retireOffer(older.id, nowIso);
        older.expiresAt = nowIso;
      }
    }
    const imageKey = await keep(offer);
    const row = {
      id: `${snap.snapId}:${n}`,
      username: snap.username,
      snapId: snap.snapId,
      name: offer.name,
      shownName: offer.shownName ?? null,
      brand: offer.brand,
      size: offer.size,
      sizePrinted: offer.sizePrinted ?? null,
      count: offer.count || 1,
      unit: offer.unit,
      price: offer.price,
      wasPrice: offer.wasPrice,
      imageKey,
      postedAt: posted,
      lastPostedAt: posted,
      expiresAt,
      votes: offer.votes || 2,
      createdAt: nowIso,
    };
    fresh.push(row);
    history.push(row); // a later offer of this snap sees it
    shown.push(row.id);
  }
  await store.insertOffers(fresh);
  let retired = 0;
  for (const old of own) {
    if (old.used || old.expiresAt <= nowIso) continue;
    await store.retireOffer(old.id, nowIso);
    retired += 1;
  }
  return { shown, added: fresh.length, rewritten, retired, keys: stored };
}

// Where a snap's picture lives in R2 (served by GET /minimarts/image).
export function pictureKey(snap, ref) {
  return `minimarts/${snap.username}/${snap.snapId}-${ref}.jpg`;
}

// The same file posted again: what it showed the first time is re-posted.
async function repostRepeat(store, snap, repeatOf, at) {
  const posted = snap.postedAt || at.toISOString();
  const expiresAt = new Date(Date.parse(posted) + OFFER_TTL_MS).toISOString();
  const ids = repeatOf.offerIds || [];
  for (const id of ids) await store.repostOffer(id, { postedAt: posted, expiresAt });
  return { shown: ids, added: 0 };
}

// A read prepared snap: its pictures no offer shows (an ad, frames without a
// price) leave R2.
async function dropUnusedPictures(bucket, snap, used) {
  const unused = (snap.pictures || []).map((ref) => pictureKey(snap, ref)).filter((key) => !used.has(key));
  if (bucket && unused.length) await bucket.delete(unused).catch(() => {});
}

// The month's frames, PACED so they last to its end (owner, 2026-11-06; at
// one shop's 48 videos a day the 5,000 would be gone by the 17th): what is
// left is shared over the videos expected before the month ends (the last
// week's videos a day × the days left). A video gets that share, never more
// than MAX_FRAMES_PER_VIDEO or than is left, and never fewer than
// MIN_FRAMES_PER_VIDEO: measured 2026-11-06, 33 of 35 video prices showed in
// every frame and the least in 5 of 9, and three spread frames always put
// one inside any stretch longer than a third of the video.
export function pacedFrames({ used, videosPerDay, at }) {
  const left = FRAME_MONTHLY_CAP - used;
  if (left <= 0) return 0;
  const monthEnd = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  const expected = Math.max(1, videosPerDay * Math.max(0, (monthEnd - at.getTime()) / DAY_MS));
  return Math.min(left, MAX_FRAMES_PER_VIDEO, Math.max(MIN_FRAMES_PER_VIDEO, Math.floor(left / expected)));
}

// The frames one video may be cut into now. Videos a day are counted over
// the last week, or since the first snap seen when that is later.
async function framesAllowedNow(store, media, now) {
  if (!media) return 0;
  const at = now();
  const used = await store.framesSince(`${at.toISOString().slice(0, 7)}-01T00:00:00.000Z`);
  const pace = await store.videoPace(new Date(at.getTime() - PACE_LOOKBACK_MS).toISOString());
  const since = Math.max(at.getTime() - PACE_LOOKBACK_MS, Date.parse(pace.firstSeen || at.toISOString()));
  return pacedFrames({ used, videosPerDay: pace.videos / Math.max(1, (at.getTime() - since) / DAY_MS), at });
}

// Readies one new snap for the PC reader: the file fetched (a repeat is
// re-posted at once), a video cut into frames, every picture put in R2.
async function prepareSnap({ store, bucket, media, snap, fetchImpl, now, report }) {
  const usage = {};
  try {
    const loaded = await loadSnapPictures(snap, {
      media,
      framesAllowed: snap.mediaType === 'video' ? await framesAllowedNow(store, media, now) : 0,
      fetchImpl,
      findRepeat: snap.reread ? null : (hash) => store.findReadSnapByHash(snap.username, hash, snap.snapId),
      report: usage,
    });
    const at = now();
    if (snap.reread && !loaded.pictures.length) {
      // Nothing to read again (a video with no cover): it keeps what it was read as.
      await store.endReread(snap.snapId, 'reread: nothing to read');
      return;
    }
    if (loaded.repeatOf || !loaded.pictures.length) {
      const saved = loaded.repeatOf ? await repostRepeat(store, snap, loaded.repeatOf, at) : { shown: [], added: 0 };
      await store.finishSnap(snap.snapId, {
        status: 'read', attempts: snap.attempts + 1, frames: usage.frames || 0, offerIds: saved.shown,
        mediaHash: usage.hash || null, repeatOf: loaded.repeatOf?.snapId || null, readAt: at.toISOString(),
      });
      if (loaded.repeatOf) report.repeats += 1;
      report.reposted += saved.shown.length;
      report.frames += usage.frames || 0;
      return;
    }
    for (const p of loaded.pictures) {
      await bucket.put(pictureKey(snap, p.ref), p.bytes, { httpMetadata: { contentType: p.contentType || 'image/jpeg' } });
    }
    await store.prepareSnap(snap.snapId, {
      pictures: loaded.pictures.map((p) => p.ref), frames: usage.frames || 0, mediaHash: usage.hash || null, preparedAt: at.toISOString(),
    });
    report.prepared += 1;
    report.frames += usage.frames || 0;
  } catch (err) {
    const gone = err?.stage === 'media' && [403, 404, 410].includes(err.status);
    const attempts = snap.attempts + 1;
    const failed = gone || attempts >= SNAP_MAX_ATTEMPTS;
    report.errors.push(String(err?.message || err).slice(0, 160));
    if (failed && snap.reread) {
      // Its file is gone: the snap keeps what it was read as.
      await store.endReread(snap.snapId, `reread: ${String(err?.message || err).slice(0, 160)}`);
      return;
    }
    await store.finishSnap(snap.snapId, {
      status: failed ? 'failed' : 'new', attempts, frames: usage.frames || 0, mediaHash: usage.hash || null,
      error: `${gone ? 'media_gone' : err?.stage || 'prepare'}: ${String(err?.message || err).slice(0, 160)}`,
      readAt: failed ? now().toISOString() : null,
    });
    if (failed) report.failed += 1;
    report.frames += usage.frames || 0;
  }
}

// A prepared snap's pictures back from R2, for Mistral -> { pictures, framed } | null.
async function loadPrepared(bucket, snap) {
  const pictures = [];
  for (const ref of snap.pictures || []) {
    const object = await bucket.get(pictureKey(snap, ref));
    if (!object) return null;
    pictures.push({ bytes: new Uint8Array(await object.arrayBuffer()), contentType: 'image/jpeg', ref });
  }
  return { pictures, framed: pictures.some((p) => isFrameRef(p.ref)), repeatOf: null };
}

// One */2 fire: check the shops that are due, then, while the PC reader is
// on, prepare new snaps for it; Mistral reads new snaps while it is off, and
// prepared snaps it left (READER_WAIT_MS), until the deadline.
// deps: { store, bucket, media, ask, fetchImpl, now, clock, deadlineMs }.
export async function runMinimartTick({ store, bucket = null, media = null, ask = null, fetchImpl = fetch, now = () => new Date(), clock = () => Date.now(), deadlineMs = TICK_DEADLINE_MS }) {
  const started = clock();
  const report = { checked: [], read: 0, offers: 0, reposted: 0, repeats: 0, frames: 0, readings: 0, deferred: 0, failed: 0, prepared: 0, errors: [] };
  await checkShops({ store, ask, fetchImpl, now, report });
  const late = () => clock() - started >= deadlineMs;

  const cutoffs = readerCutoffs(now());
  const readerOn = Boolean(bucket) && await store.readerSeenSince(cutoffs.onSince);
  report.reader = readerOn ? 'on' : 'off';
  if (readerOn) {
    for (const snap of await store.pendingSnaps(PREPARE_PER_TICK, { reread: true })) {
      if (late()) {
        report.yielded = 'deadline';
        return report;
      }
      await prepareSnap({ store, bucket, media, snap, fetchImpl, now, report });
    }
  }

  if (!ask) {
    report.skipped = 'no_model';
    return report;
  }
  const queue = readerOn ? [] : await store.pendingSnaps(SNAPS_PER_TICK);
  if (bucket && queue.length < SNAPS_PER_TICK) queue.push(...await store.lateSnaps({ ...cutoffs, limit: SNAPS_PER_TICK - queue.length }));
  for (const snap of queue) {
    if (late()) {
      report.yielded = 'deadline';
      break;
    }
    const usage = {};
    let prepared = null;
    if (snap.status === 'prepared') {
      if (!(await store.claimForMistral(snap.snapId, { nowIso: now().toISOString(), claimBefore: cutoffs.claimBefore }))) continue;
      prepared = await loadPrepared(bucket, snap);
      if (!prepared) {
        // Its pictures are gone from R2: fetched and read again from Snapchat.
        await store.finishSnap(snap.snapId, { status: 'new', attempts: snap.attempts, error: 'prepared pictures missing' });
        snap.status = 'new';
      }
    }
    const back = snap.status === 'prepared' ? 'prepared' : 'new';
    const findRepeat = (hash) => store.findReadSnapByHash(snap.username, hash, snap.snapId);
    let result;
    try {
      const framesAllowed = prepared || snap.mediaType !== 'video' ? 0 : await framesAllowedNow(store, media, now);
      result = await readSnap(snap, { ask, media, framesAllowed, fetchImpl, findRepeat, prepared, report: usage });
    } catch (err) {
      report.frames += usage.frames || 0;
      report.readings += usage.readings || 0;
      const kind = err?.stage === 'media' ? 'media' : classifyMistralError(err);
      if (kind === 'rate') {
        // A spent key window costs the snap nothing; the next fire resumes.
        await store.noteUsage(snap.snapId, { frames: usage.frames || 0, readings: usage.readings || 0 });
        report.deferred += 1;
        report.yielded = 'rate_limited';
        break;
      }
      const gone = err?.stage === 'media' && [403, 404, 410].includes(err.status);
      const attempts = Number(snap.attempts || 0) + 1;
      const failed = gone || attempts >= SNAP_MAX_ATTEMPTS || kind === 'auth' || kind === 'restriction';
      await store.finishSnap(snap.snapId, {
        status: failed ? 'failed' : back,
        attempts,
        frames: usage.frames || 0,
        readings: usage.readings || 0,
        mediaHash: usage.hash || null,
        error: `${gone ? 'media_gone' : kind}: ${String(err?.message || err).slice(0, 160)}`,
        readAt: failed ? now().toISOString() : null,
      });
      if (failed) {
        report.failed += 1;
        if (prepared) await dropUnusedPictures(bucket, snap, new Set());
      }
      report.errors.push(String(err?.message || err).slice(0, 160));
      if (kind === 'auth' || kind === 'restriction' || /no API key available|all API keys exhausted/.test(String(err?.message))) {
        report.stopped = 'keys_unavailable';
        break;
      }
      continue;
    }
    const at = now();
    let saved;
    if (result.repeatOf) {
      saved = await repostRepeat(store, snap, result.repeatOf, at);
      report.repeats += 1;
    } else {
      saved = await saveOffers({ store, bucket, snap, offers: result.offers, at });
    }
    await store.finishSnap(snap.snapId, {
      status: 'read',
      attempts: Number(snap.attempts || 0) + 1,
      frames: usage.frames || 0,
      readings: usage.readings || 0,
      offers: saved.added,
      offerIds: saved.shown,
      mediaHash: usage.hash || null,
      repeatOf: result.repeatOf?.snapId || null,
      reader: 'mistral',
      readAt: at.toISOString(),
    });
    if (prepared) await dropUnusedPictures(bucket, snap, saved.keys || new Set());
    report.read += 1;
    report.offers += saved.added;
    report.reposted += saved.shown.length - saved.added;
    report.frames += usage.frames || 0;
    report.readings += usage.readings || 0;
  }
  return report;
}

// The PC reader's clock: on when it asked since `onSince`; a claim older than
// `claimBefore` has expired; a snap prepared before `waitBefore` is Mistral's.
export function readerCutoffs(at) {
  const ms = at.getTime();
  return {
    onSince: new Date(ms - READER_ON_MS).toISOString(),
    claimBefore: new Date(ms - READER_CLAIM_MS).toISOString(),
    waitBefore: new Date(ms - READER_WAIT_MS).toISOString(),
  };
}

// POST /minimarts/reader/reread: read snaps queued to be read again by the PC
// reader (owner, 2026-11-05: "for one time only re read the mini mart offers
// using haiku"). Mistral never reads them; each corrects its own offers when
// saved (saveOffers). snapIds: the snaps, or null for every read snap of the
// shops followed. -> how many were queued.
export async function queueReread({ store, snapIds = null }) {
  const ids = snapIds?.length ? snapIds.map(String) : await store.readSnapIds();
  let queued = 0;
  for (let i = 0; i < ids.length; i += 50) queued += await store.requeueForReread(ids.slice(i, i + 50));
  return queued;
}

// GET /minimarts/reader/queue: the reader asked (so it is on), and claims the
// oldest prepared snaps, up to `maxPictures` pictures (always one snap).
// -> [{ snapId, username, shopTitle, mediaType, framed, pictures: [{ ref, key }] }]
export async function claimForReader({ store, now = () => new Date(), maxPictures = READER_MAX_PICTURES }) {
  const at = now();
  await store.noteReader(at.toISOString());
  const { claimBefore, waitBefore } = readerCutoffs(at);
  const snaps = await store.claimForReader({ nowIso: at.toISOString(), claimBefore, waitBefore, maxPictures, reader: READER });
  return snaps.map((s) => ({
    snapId: s.snapId,
    username: s.username,
    shopTitle: s.shopTitle,
    mediaType: s.mediaType,
    framed: s.pictures.some(isFrameRef),
    pictures: s.pictures.map((ref) => ({ ref, key: pictureKey(s, ref) })),
  }));
}

// POST /minimarts/reader/readings: the reader's two copies of every picture
// of each snap it claimed -> offers saved like Mistral's. A snap the reader no
// longer holds (Mistral took it, or it was read) is a conflict and changes
// nothing. readings: [{ snapId, pictures: [{ ref, copies: [entry, entry] }] }]
// -> [{ snapId, status: read | conflict | invalid | error, offers, reposted }]
export async function saveReaderReadings({ store, bucket = null, readings, now = () => new Date() }) {
  const results = [];
  for (const reading of [].concat(readings || [])) {
    const snapId = String(reading?.snapId || '');
    const snap = snapId ? await store.heldSnap(snapId, READER) : null;
    if (!snap) {
      results.push({ snapId, status: 'conflict' });
      continue;
    }
    const byRef = new Map((Array.isArray(reading.pictures) ? reading.pictures : []).map((p) => [String(p?.ref), p]));
    if (snap.pictures.some((ref) => !byRef.has(ref))) {
      results.push({ snapId, status: 'invalid', error: 'a picture is missing' });
      continue;
    }
    const pictures = snap.pictures.map((ref) => ({ ref, copies: Array.isArray(byRef.get(ref).copies) ? byRef.get(ref).copies : [] }));
    const offers = offersFromCopies(pictures, { framed: snap.pictures.some(isFrameRef), ignore: shopWords(snap.shopTitle) })
      .map((o) => ({ ...o, image: { ref: pictures[o.frame].ref } }));
    if (!(await store.startSaving(snapId, READER))) {
      results.push({ snapId, status: 'conflict' });
      continue;
    }
    const at = now();
    let saved;
    try {
      saved = await saveOffers({ store, bucket, snap, offers, at });
    } catch (err) {
      await store.stopSaving(snapId);
      results.push({ snapId, status: 'error', error: String(err?.message || err).slice(0, 160) });
      continue;
    }
    await store.finishSnap(snapId, {
      status: 'read',
      attempts: snap.attempts + 1,
      readings: 2,
      offers: saved.added + saved.rewritten,
      offerIds: saved.shown,
      reader: READER,
      readAt: at.toISOString(),
    });
    await dropUnusedPictures(bucket, snap, saved.keys);
    results.push({
      snapId,
      status: 'read',
      offers: saved.added,
      reposted: saved.shown.length - saved.added - saved.rewritten,
      ...(snap.reread ? { reread: true, rewritten: saved.rewritten, retired: saved.retired } : {}),
    });
  }
  return results;
}

// The model call, bound to the shared Mistral pool (createKeyChain + failover),
// as runMinimartTick's `ask`. One wait for the next minute window at most.
export function createSnapAsker({ keyChain, model, fetchImpl = fetch }) {
  return async (text, image, temperature) => {
    const body = visionRequest(model, text, image.base64 || toBase64(image.bytes), image.contentType || 'image/jpeg', temperature);
    const { raw } = await withFailover(keyChain, async (apiKey) => {
      const response = await postMistral(MISTRAL_URL, body, { apiKey, fetchImpl, stage: 'minimart-read', timeoutMs: 45000 });
      return { raw: response.body?.choices?.[0]?.message?.content ?? null, rateLimit: response.rateLimit };
    }, { maxRateRetries: 1 });
    return raw;
  };
}
