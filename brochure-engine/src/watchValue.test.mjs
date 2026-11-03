// watchValue.test.mjs — the Value Watch contract (watchValue.js): per-item
// size + pack reading, per-item value, deterministic identity rules, the judge
// reply parser and the alert state machine. Pure; no stores, no network.
import assert from 'node:assert/strict';
import {
  buildJudgeRequest,
  buildValueReference,
  combineVotes,
  decideAlert,
  dealKey,
  judgedVerdict,
  listingValue,
  parseJudgeReply,
  readPackPhrase,
  referenceQueries,
  ruleVerdict,
  conflictWith,
  sameItemSize,
  shortQuery,
  watchQuantity,
  withoutPackCount,
} from './watchValue.js';

let passed = 0;
const ok = (condition, message) => { assert.ok(condition, message); passed += 1; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); passed += 1; };

// --- size per item + pack -----------------------------------------------------

eq(watchQuantity({ name: 'نوفا مياه شرب 40 × 330 مل' }),
  { each: { value: 330, unit: 'ml' }, pack: 40, packSource: 'text' }, '40 × 330 ml is 40 items of 330 ml');
eq(watchQuantity({ name: 'Nadec Skimmed Milk Long Life 1 Liter (Pack of 12)' }).pack, 12,
  '"Pack of 12" is a 12-pack');
eq(watchQuantity({ name: 'بيبسي 24 علبة 330 مل' }).pack, 24, '"24 علبة" counts cans');
eq(watchQuantity({ name: 'Pepsi Cola 330ml x 6 cans' }).pack, 6, '"330ml x 6 cans" is a 6-pack');
eq(watchQuantity({ name: 'تونة تندرينا عبوه من 4 × 185 جرام' }).each, { value: 185, unit: 'g' },
  'a tuna 4-pack keeps the size per tin');
eq(watchQuantity({ name: 'تندرينا تونه ناعمه', size: '185 غرام' }).each, { value: 185, unit: 'g' },
  'the store size field supplies a size the title leaves out');
eq(watchQuantity({ name: 'المراعي حليب 6 قطع 1 لتر' }).pack, 1,
  'a bare piece word is not believed as a pack count on its own');
eq(watchQuantity({ name: 'المراعي حليب 6 قطع 1 لتر' }, { aiItems: 6 }).pack, 6,
  '… but the judge agreeing with the written number makes it one');
eq(watchQuantity({ name: 'المراعي حليب 1 لتر' }, { aiItems: 6 }).pack, 1,
  'a count the judge read that is not written in the listing is not believed');
{
  const q = watchQuantity({ name: 'نادك حليب كامل الدسم طويل الأجل عبوة متعددة 1x4 لتر', size: '1 لتر' });
  ok(q.each?.value === 1000 && q.pack === 4, 'Panda size-first "1x4 لتر" beside a 1 L size field is four 1 L cartons');
  const y = watchQuantity({ name: 'نادك زبادي كامل الدسم عبوة متعددة 170x6 جرام', size: '170 جرام' });
  ok(y.each?.value === 170 && y.pack === 6, '"170x6 جرام" beside a 170 g size field is six 170 g cups');
  const l = watchQuantity({ name: 'المراعي حليب كامل الدسم 12×1 ل', size: '1 لتر' });
  ok(l.each?.value === 1000 && l.pack === 12, 'the short litre sign "12×1 ل" still counts twelve cartons');
  const bare = watchQuantity({ name: 'حليب 1x4 لتر' });
  ok(bare.each?.value === 4000 && bare.pack === 1, 'without a size field the title is read as written');
  const big = watchQuantity({ name: 'نوفا مياه 4 لتر', size: '4 لتر' });
  ok(big.each?.value === 4000 && big.pack === 1, 'a single 4 L bottle stays one 4 L bottle');
}
ok(readPackPhrase('Pack of 12')?.strong === true, '"pack of N" is a strong phrase');
ok(readPackPhrase('كيتكات 4 أصابع') === null, '"4 fingers" is not a pack of 4');

ok(sameItemSize({ value: 80, unit: 'g' }, { value: 185, unit: 'g' }) === false, '80 g is not 185 g');
ok(sameItemSize({ value: 180, unit: 'g' }, { value: 185, unit: 'g' }) === true, '180 g ≈ 185 g (within 6%)');
ok(sameItemSize(null, { value: 185, unit: 'g' }) === null, 'an unstated size is unknown, not different');
ok(sameItemSize({ value: 1, unit: 'pcs' }, { value: 1000, unit: 'ml' }) === false, 'different units differ');

// --- the reference --------------------------------------------------------------

const milk = buildValueReference({
  listing: { id: 'nadec-12', provider: 'danube', name: 'نادك حليب طويل الأجل كامل الدسم 12 × 1 لتر' },
  query: 'حليب نادك',
  targetPrice: 50,
});
eq(milk.item, { value: 1000, unit: 'ml' }, 'the reference reads the size per carton');
eq(milk.pack, 12, 'and the pack the shopper saw');
eq(milk.targetValue, 4.1667, '50 SAR for 12 is a 4.17 SAR per-carton target');
ok(milk.queries.length >= 2 && milk.queries.length <= 4, 'up to four store queries');
ok(milk.queries.includes('Nadec milk'), 'an Arabic-only title also searches in English (brand + the noun from the lexicon)');
eq(referenceQueries({ name: 'بيبسي علب 18*330مل', brand: { display_ar: 'بيبسي', display_en: 'Pepsi' } }).at(-1), 'Pepsi',
  'no known noun: the English brand alone (Tamimi files the regular can as "علبة")');
{
  const can = watchQuantity({ name: 'علبة', size: '18 x 330-355 مل' });
  ok(can.each?.value === 330 && can.pack === 18, 'Tamimi "18 x 330-355 مل" is eighteen 330 ml cans');
  eq(watchQuantity({ name: 'رز', size: '1-2 كجم' }).each?.value, 2000, 'a wide range is not collapsed');
}
ok(milk.queries.every((q) => !/\d/.test(q)), 'queries carry no sizes (a store search must find every pack)');
ok(referenceQueries({ name: 'Nadec Skimmed Milk Long Life 1 Liter', brand: { display_ar: 'نادك', display_en: 'Nadec' } })
  .every((q) => !(/[a-z]/i.test(q) && /[؀-ۿ]/u.test(q))), 'a query never mixes Arabic and English');
ok(!referenceQueries({ name: 'تندرينا تونة', userQuery: 'تونة' }).includes('تونة'),
  'a one-word typed query is too broad to be a store query');
// Danube searches literally: "تونة" finds the tin, the folded "تونه" did not.
eq(shortQuery('قودي تونة تندرينا في زيت دوار الشمس، 80غ، مثالية للساندوتشات'), 'قودي تونة تندرينا في زيت دوار',
  "a store query keeps the listing's own spelling (ة, أ) and drops the size and the shop copy");
eq(shortQuery('نادك حليب طويل الأجل كامل الدسم 12*1لتر'), 'نادك حليب طويل الأجل كامل الدسم', 'a pack size written 12*1لتر drops');
eq(shortQuery('Nadec Skimmed Milk Long Life 1 Liter (Pack of 12)'), 'Nadec Skimmed Milk Long Life', 'English keeps its case');

// --- value: "12 cans at 50 is better than one can at 5" ------------------------

const single = listingValue({ name: 'نادك حليب طويل الأجل كامل الدسم 1 لتر', price: 5 }, milk);
const twelve = listingValue({ name: 'نادك حليب طويل الأجل كامل الدسم 12 × 1 لتر', price: 48 }, milk);
ok(single.value === 5 && twelve.value === 4, 'per-item value: 48/12 = 4.00 beats 5.00 for one');
ok(twelve.value < single.value, 'the 12-pack is the better value');
ok(twelve.sizeVerified && single.sizeVerified, 'both state the watched size per item');
eq(listingValue({ name: 'نادك حليب 12 × 1 لتر', price: 55, salePrice: 44, wasPrice: 55 }, milk).purchasePrice, 44,
  'the price a shopper pays (the sale price) is what is compared');
const nova = buildValueReference({ listing: { name: 'نوفا مياه شرب 40 × 330 مل' }, targetPrice: 15 });
ok(Math.abs(listingValue({ name: 'نوفا مياه 330 مل × 48', price: 18 }, nova).value - 0.375) < 1e-9,
  'a 48-pack at 18 equals the 40-pack target of 15 per bottle');
const tuna185 = buildValueReference({ listing: { name: 'تندرينا تونه ناعمه', size: '185 غرام' }, targetPrice: 6 });
ok(Math.abs(listingValue({ name: 'تندرينا تونة ناعمة 180 جم', price: 5.4 }, tuna185).value - 5.55) < 1e-9,
  'a 180 g tin is normalized to the watched 185 g');

// --- the user's case: the size per item is identity -----------------------------

const tuna80 = buildValueReference({
  listing: { id: '2674', provider: 'danube', name: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام' },
  targetPrice: 6,
});
const panda80 = { id: '21028', name: 'تندرينا تونة قطع خفيفة في زيت دوار الشمس 80 جم', price: 3.66 };
const panda185 = { id: '21029', name: 'تندرينا تونة ناعمة 185 جم', price: 10.5 };
ok(listingValue(panda80, tuna80).value === 3.66, 'Panda 80 g at 3.66 is a 3.66 value for the 80 g watch');
ok(listingValue(panda80, tuna185) === null, 'Panda 80 g has NO value for a 185 g watch');
eq(ruleVerdict(panda80, tuna185, { store: 'panda' }).verdict, 'reject', 'the rules reject 80 g for a 185 g watch');
eq(ruleVerdict(panda185, tuna80, { store: 'panda' }).verdict, 'reject', 'and 185 g for an 80 g watch');
eq(ruleVerdict({ id: '2674', name: 'anything' }, tuna80, { store: 'danube' }).by, 'anchor',
  'the listing the watch was created from is the product by definition');
eq(ruleVerdict({ id: 'x', name: 'تندرينا تونة قطع خفيفة بزيت دوار الشمس 80 جرام' }, tuna80, { store: 'panda' }).verdict,
  'match', 'the same title and size in another store matches without the judge');
eq(ruleVerdict(panda80, tuna80, { store: 'panda' }), null, 'a reworded title goes to the judge');
eq(ruleVerdict({ id: 'y', name: 'حليب المراعي 1 لتر' }, tuna80, { store: 'panda' }).verdict, 'reject',
  'nothing in common is rejected without the judge');

// --- the judge's answer -----------------------------------------------------------

const reply = parseJudgeReply('```json\n{"reference":{"items":1,"itemSize":"80 g"},"results":['
  + '{"i":1,"same":"yes","items":1,"itemSize":"80g","why":"same"},{"i":2,"same":"maybe"},{"i":9,"same":"yes"}]}\n```', 3);
eq(reply.results.map((r) => r?.same ?? null), ['yes', 'unsure', null], 'unknown answers are unsure, missing ones null');
eq(reply.reference.item, { value: 80, unit: 'g' }, 'the judge reads the reference size');
eq(parseJudgeReply('not json', 2).results, [null, null], 'garbage is no answer at all');
{
  // A reply cut off by the token cap keeps every answer it finished.
  const cut = parseJudgeReply([
    '{',
    ' "reference": {"items": 1, "itemSize": "80 g"},',
    ' "results": [',
    '  {"i": 1, "same": "yes", "items": 1, "itemSize": "80 g", "why": "same"},',
    '  {"i": 2, "same": "no", "items": 1, "itemSize": "80 g", "why": "jalapeno"},',
    '  {"i": 3, "same": "ye',
  ].join('\n'), 3);
  eq(cut.results.map((r) => r?.same ?? null), ['yes', 'no', null], 'a cut-off reply keeps its complete answers');
  eq(cut.reference?.items, 1, '… and the reference it read');
  const big = buildJudgeRequest({ name: 'x', item: { value: 80, unit: 'g' } }, Array.from({ length: 20 }, (_, i) => ({ store: 'panda', listing: { id: i, name: 'x' } })), { model: 'm' });
  ok(big.max_tokens >= 20 * 60, 'twenty pretty-printed answers fit the token cap');
}
eq([judgedVerdict(panda80, tuna80, { same: 'unsure', why: 'flavour' })].map((v) => [v.verdict, v.by])[0], ['pending', 'ai'],
  'unsure waits, as the checker\'s answer (kept, not asked again)');
eq([judgedVerdict(panda80, tuna80, null)].map((v) => [v.verdict, v.by])[0], ['pending', null], 'no answer waits, to be asked again');
{
  const yes = { same: 'yes', items: 4, item: { value: 80, unit: 'g' }, why: 'same' };
  eq(combineVotes(yes, { ...yes }).same, 'yes', 'two yeses are a yes');
  eq(combineVotes(yes, { ...yes, items: 6 }).items, null, '… but a pack count they disagree on is not stated');
  eq(combineVotes(yes, { same: 'unsure', why: 'no line' }).same, 'unsure', 'a yes and an unsure are an unsure');
  eq(combineVotes({ same: 'no', why: 'chili' }, yes).same, 'unsure', 'a yes and a no are an unsure');
  eq(combineVotes({ same: 'unsure' }, { same: 'no', why: 'chili' }).why, 'chili', 'an unsure and a no are the no');
  eq(combineVotes(yes, null), null, 'a missing vote is no answer');
}
eq(withoutPackCount('Nadec Skimmed Milk Long Life 1 Liter (Pack of 12)'), 'Nadec Skimmed Milk Long Life 1 Liter', 'the judge never sees "(Pack of 12)"');
eq(withoutPackCount('نادك حليب خالي الدسم طويل الأجل 12×1 لتر'), 'نادك حليب خالي الدسم طويل الأجل 1 لتر', 'nor "12×1 لتر"');
eq(withoutPackCount('Nova Water 330ml x 40'), 'Nova Water 330ml', 'nor a trailing "x 40"');
eq(withoutPackCount('قودي تونة تندرينا في زيت دوار الشمس 80غرام'), 'قودي تونة تندرينا في زيت دوار الشمس 80غرام', 'a single item is unchanged');
eq(judgedVerdict(panda185, tuna80, { same: 'yes' }).verdict, 'reject',
  'a "yes" the stated size contradicts is still a reject');
eq(judgedVerdict(panda80, tuna80, { same: 'yes', items: 1 }).verdict, 'match', 'a consistent "yes" is a match');

// --- the alert state machine --------------------------------------------------------

const obs = (value, store = 'panda', listingId = '21028', price = value) => ({
  value, store, listingId, purchasePrice: price, dealKey: dealKey({ store, name: 'tuna', purchasePrice: price }),
});
let state = { isBelow: false, isClose: false, deal: null, lastAlert: null, episode: 0 };
const round = (best, dealStatus = null, closeBoundary = null) => {
  const d = decideAlert(state, { best, target: 6, closeBoundary, dealStatus });
  state = { isBelow: d.isBelow, isClose: d.isClose, deal: d.deal, lastAlert: d.lastAlert, episode: d.episode };
  return d.alertType;
};
eq(round(obs(3.66)), 'target', 'the first time under target alerts');
eq(round(obs(3.66), 'seen-below'), null, 'the same deal next round does not alert again');
eq(round(null, 'unknown'), null, 'a round that cannot see the deal store says nothing …');
ok(state.isBelow, '… and keeps the watch where it was (no re-arm on silence)');
eq(round(obs(3.66), 'seen-below'), null, 'the deal seen again after a quiet round is not news');
eq(round(obs(3.4), 'seen-below'), 'lower', 'a 5%+ better deal while below alerts as "lower"');
eq(round(obs(3.35), 'seen-below'), null, 'a 1.5% wiggle does not');
eq(round(obs(6.25), 'seen-above'), null, 'price back above target: no alert …');
ok(!state.isBelow && state.episode === 1, '… the deal episode ended');
eq(round(obs(3.4), 'seen-above'), 'target', 'the price coming back down is a new event');
eq(round(null, 'gone'), null, 'the deal listing gone (store answered) ends the episode quietly');
eq(round(obs(3.4), null), null, 'the same deal back unchanged after it went away is not news');
state = { isBelow: false, isClose: false, deal: null, lastAlert: null, episode: 0 };
eq(round(obs(6.3), null, 6.6), 'close', 'within the close band alerts "close" once');
eq(round(obs(6.2), 'seen-below', 6.6), null, 'and only once');

// --- conflicts -------------------------------------------------------------------
{
  const milk = { name: 'المراعي حليب طازج كامل الدسم 1 لتر', brand: { id: 'almarai', ar: 'المراعي', en: 'Almarai' } };
  ok(/fat/.test(conflictWith({ name: 'المراعي حليب ق الدسم عبوة متعددة 4×1 لتر' }, milk) || ''), 'low fat (ق الدسم) is not full fat');
  ok(/dairy/.test(conflictWith({ name: 'المراعي لبن طازج كامل الدسم 1لتر' }, milk) || ''), 'laban is not milk');
  ok(/brand/.test(conflictWith({ name: 'حليب طازج كامل الدسم 1 لتر', brand: 'ALSAFI' }, milk) || ''), 'another known brand conflicts');
  eq(conflictWith({ name: 'حليب طازج كامل الدسم', brand: 'المراعي' }, milk), null, 'a title without a brand takes the store brand field');
  eq(conflictWith({ name: 'المراعي حليب كامل الدسم 1 لتر' }, milk), null, 'an unstated freshness is no conflict (stores drop "طازج")');
  const tuna = { name: 'قودي تونة تندرينا في زيت دوار الشمس 80غرام', brand: { id: 'goody', ar: 'قودي', en: 'Goody' } };
  ok(/medium/.test(conflictWith({ name: 'قودي تونة تندرينا بالماء والملح 80غرام' }, tuna) || ''), 'tuna in brine is not tuna in oil');
  ok(/brand/.test(conflictWith({ name: 'الخير تونا تيرنا بزيت دوار الشمس 4 حبات 80 جم', brand: 'ALKHAIR-TUNA' }, tuna) || ''), 'Al Khair is not Goody');
  eq(conflictWith({ name: 'قودي تونة خفيفة في زيت دوار الشمس 90غ' }, tuna), null, '"light" tuna (light meat) is no diet marker');
  ok(/bundle/.test(conflictWith({ name: 'سويتز كيك العائلة بالفانيليا 280 جم & المراعي حليب طازج كامل الدسم 1 لتر' }, milk) || ''), 'a cake + milk bundle is not the milk');
  eq(conflictWith({ name: 'المراعي حليب طازج كامل الدسم 1 لتر', nameEn: 'Almarai Fresh Milk Rich & Creamy 1L' }, milk), null, '"Rich & Creamy" is one product');
  eq(conflictWith({ name: 'قودي تونة تندرينا في زيت دوار الشمس 10 + 2 x 80 جم' }, tuna), null, 'a "10 + 2" bonus pack is one product');
  ok(/flavour/.test(conflictWith({ name: 'قودي تونة تندرينا بالليمون والفلفل الأسود، 80غ' }, tuna) || ''), 'lemon-pepper tuna is not the plain tin');
  ok(/flavour/.test(conflictWith({ name: 'المراعي حليب بنكهة الفراولة 200مل' }, milk) || ''), 'strawberry milk is not plain milk');
  ok(/chocolate/.test(conflictWith({ name: 'المراعي حليب بالشوكوﻻتة 360 مل' }, milk) || ''), 'nor is chocolate milk, written with the ligature ﻻ');
  eq(conflictWith({ name: 'قودي تونة تندرينا بالليمون والفلفل الأسود 80غرام' }, { name: 'تونة تندرينا بالليمون والفلفل', brand: tuna.brand }), null,
    'two flavoured titles are left to the judge');
  const sprite = { name: 'سبرايت مشروب غازي 330 مل', brand: { id: 'sprite', ar: 'سبرايت', en: 'Sprite' } };
  eq(conflictWith({ name: 'سبرايت مشروب غازي بنكهة الليمون والليمون الأخضر 1لتر' }, sprite), null,
    'no flavour rule for drinks: plain Sprite is titled "lemon and lime" (مشروب is not روب)');
}

console.log(`watchValue.test: ${passed} passed, 0 failed`);
