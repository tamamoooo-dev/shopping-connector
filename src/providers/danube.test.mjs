// danube.test.mjs — Danube's search results carry the package size. The bare
// `name` has none ("تندرينا تونه ناعمه"); the size lives in `pack_size` with
// Arabic-Indic digits and in the full names. Price Monitoring compares per
// item, so a size-less result made an 80 g and a 185 g tin indistinguishable.
//
// Fixture shaped from a live /api/products.json response (2026-11-03). Run:
//   node src/providers/danube.test.mjs

import { danubeProvider, foldDigits, likePattern, normalize, searchPlan, searchWords } from './danube.js';

let passed = 0;
const fail = (m) => {
  console.error('❌', m);
  process.exit(1);
};
const ok = (cond, m) => {
  if (!cond) fail(m);
  passed++;
};

const soft = {
  id: 2669,
  name: 'تندرينا تونه ناعمه',
  name_en: 'Tenderina Soft Tuna',
  full_name: 'قودي تندرينا تونه ناعمه ١٨٥غرام',
  full_name_en: 'Goody Tenderina Soft Tuna 185g',
  pack_size: '١٨٥',
  pack_unit: 'غرام',
  brand: 'قودي',
  brand_en: 'Goody',
  price: '9.99',
  on_sale: false,
  slug: 'goody-tenderina-soft-tuna-185g',
  master: { images: [{ large_url: 'https://cdn.example/soft.jpg' }] },
};

const ar = normalize(soft, 'ar');
ok(ar.name === 'تندرينا تونه ناعمه', 'the Arabic name is unchanged');
ok(ar.size === '185 غرام', `pack_size + pack_unit reach the result with ASCII digits (got "${ar.size}")`);
ok(normalize({ ...soft, pack_unit: null }, 'ar').size === '185', 'a missing unit leaves the number');
ok(ar.nameEn === 'Tenderina Soft Tuna', 'the English name ships too');
ok(ar.fullNameEn === 'Goody Tenderina Soft Tuna 185g', 'the full English title (brand + size) ships');
ok(ar.fullName === 'قودي تندرينا تونه ناعمه 185غرام', 'the full Arabic title with ASCII digits');
ok(ar.brand === 'قودي' && ar.brandEn === 'Goody', 'both brand spellings');
ok(ar.price === 9.99 && ar.oldPrice === null, 'prices unchanged');
ok(ar.link === 'https://danube.sa/ar/products/goody-tenderina-soft-tuna-185g', 'link unchanged');

const en = normalize(soft, 'en');
ok(en.name === 'Tenderina Soft Tuna' && en.size === '185 غرام', 'an English search gets the same size');

const bare = normalize({ id: 1, name: 'خبز', price: '2', slug: 'x' }, 'ar');
ok(bare.size === '' && bare.nameEn === null && bare.fullName === null, 'missing fields stay empty');

ok(foldDigits('١٢ × ١٫٥ لتر') === '12 × 1.5 لتر', 'Arabic-Indic digits and decimal separator fold');
ok(foldDigits('۴۰ عدد') === '40 عدد', 'Persian digits fold');

// --- search plan (measured on the live API 2026-11-03) -------------------------
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
ok(same(searchWords('تندرينا 185'), ['تندرينا']), 'a size is not a name word ("تندرينا 185" found nothing)');
ok(same(searchWords('قودي تونة تندرينا في زيت دوار الشمس 185 جم'), ['قودي', 'تونة', 'تندرينا', 'زيت', 'دوار']),
  'sizes, units after a number and filler words drop; the spelling stays; at most 5 words');
ok(same(searchWords('نادك حليب طويل الأجل 12*1لتر'), ['نادك', 'حليب', 'طويل', 'الأجل']), 'a pack size written as 12*1لتر drops');
ok(same(searchWords('Nadec Skimmed Milk 1 L'), ['Nadec', 'Skimmed', 'Milk']), 'English works the same way');
ok(likePattern('تونة') === '%تون_%', 'ة at the end matches ة or ه (and ا: تونا)');
ok(likePattern('الأجل') === '%_ل_جل%', 'every alef form inside a word matches every other');
ok(likePattern('قودي') === '%قود_%', 'ي at the end matches ى');
ok(likePattern('نوفا') === '%نوفا%', 'a final ا stays literal ("%نوف_%" matched نوفلتي)');
ok(likePattern('50%_off') === '%50off%', 'LIKE wildcards in the text are removed, never passed through');

const d = (filter) => decodeURIComponent(filter);
const plan = searchPlan('قودي تونة تندرينا');
ok(plan.length === 3, 'Arabic, 3 words: name; line + leading brand; line + trailing brand');
ok(d(plan[0]) === 'q[name_matches_all][]=%قود_%&q[name_matches_all][]=%تون_%&q[name_matches_all][]=%تندرينا%',
  'step 1: every word in the name, any order');
ok(d(plan[1]) === 'q[name_matches_all][]=%تون_%&q[name_matches_all][]=%تندرينا%&q[description_matches_all][]=%قود_%',
  'step 2: the line in the name AND the leading word (the brand) in the description');
ok(d(plan[2]) === 'q[name_matches_all][]=%قود_%&q[name_matches_all][]=%تون_%&q[description_matches_all][]=%تندرينا%',
  'step 3: the same with the trailing word ("مياه نوفا")');
const enPlan = searchPlan('nadec long life').map(d);
ok(enPlan.includes('q[name_matches_all][]=%long%&q[name_matches_all][]=%life%&q[slug_cont_all][]=nadec'),
  'an English leading word is looked for in the slug (the English full title)');
ok(enPlan[enPlan.length - 1] === 'q[slug_cont_all][]=nadec&q[slug_cont_all][]=long&q[slug_cont_all][]=life', '… and every English word in the slug');
ok(searchPlan('بيبسي').map(d).join(' ') === 'q[name_matches_all][]=%بيبس_% q[description_matches_all][]=%بيبس_%', 'one Arabic word: the name, then the description (a brand)');
ok(same(searchWords('بيبسي علب'), ['بيبسي']), 'pack words are not name words');
ok(likePattern('مياه') === '%ميا_%', 'a medial ا is literal, so the ending can match ة or ه');
ok(likePattern('مياة') === '%ميا_%', '… and "مياة" finds the "مياه" Danube writes (measured 2026-11-03: 6 Nova listings missed)');
ok(likePattern('الاجل') === '%ال_جل%', 'an alef after the article matches أ');
ok(likePattern('اصلي') === '%_صلي%', 'an alef starting the word matches أ / إ');
ok(likePattern('لبن') === '%لبن%', 'at least 3 letters stay literal');
ok(searchPlan('pepsi').map(d).join(' ') === 'q[name_matches_all][]=%pepsi% q[description_matches_all][]=%pepsi% q[slug_cont_all][]=pepsi', 'one English word: name, description, slug');
ok(d(searchPlan('185')[0]) === 'q[name_cont]=185', 'no name word at all: the old phrase search');

// Shopping search: a later step runs only while nothing is found. The first
// step's failure is the store's failure; a later step's failure after empty
// answers is unknown, never "no such product".
const realFetch = globalThis.fetch;
const reply = (products) => ({ ok: true, status: 200, text: async () => JSON.stringify({ products }) });
const tin = { id: 2674, name: 'تونة تندرينا في زيت دوار الشمس', price: '5.99', slug: 'goody-tenderina-fancy-tuna-80g' };
const softTin = { id: 2669, name: 'تندرينا تونه ناعمه', price: '9.99', slug: 'goody-tenderina-soft-tuna-185g' };
async function withFetch(answers, fn) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const i = calls.length;
    calls.push(decodeURIComponent(String(url)));
    const a = answers[i];
    if (a instanceof Error) throw Object.assign(a, { final: true });
    return reply(a || []);
  };
  try { return { value: await fn(), calls }; } catch (err) { return { err, calls }; } finally { globalThis.fetch = realFetch; }
}
const strategy = danubeProvider.strategies[0];
const q = 'قودي تونة تندرينا';
let r = await withFetch([[tin]], () => strategy.run(q));
ok(r.value.length === 1 && r.calls.length === 1, 'found by the first step: one request');
r = await withFetch([[], [tin]], () => strategy.run(q));
ok(r.value[0].id === 2674 && r.calls.length === 2 && r.calls[1].includes('description_matches_all'), 'empty name search widens to the brand');
r = await withFetch([[], [], []], () => strategy.run(q));
ok(Array.isArray(r.value) && r.value.length === 0 && r.calls.length === 3, 'every step answered empty: the store has no match');
r = await withFetch([new Error('HTTP 503')], () => strategy.run(q));
ok(r.err && r.calls.length === 1, 'the first step failing fails the store');
r = await withFetch([[], new Error('HTTP 503'), []], () => strategy.run(q));
ok(r.err, 'a widening step failed and nothing was found: unknown, reported as a failure');

// Price Monitoring (wide): every step at once, merged round-robin.
r = await withFetch([[softTin], [tin, softTin], []], () => strategy.run(q, { wide: true }));
ok(r.calls.length === 3 && r.value.map((x) => x.id).join() === '2669,2674', 'wide: all steps run; results merge without duplicates');
r = await withFetch([[], new Error('HTTP 503'), [tin]], () => strategy.run(q, { wide: true }));
ok(r.value.length === 1, 'wide: a widening step may fail when another found the product');
r = await withFetch([new Error('HTTP 503'), [tin], [tin]], () => strategy.run(q, { wide: true }));
ok(r.err, "wide: the first step failing still fails the store");

console.log(`✅ danube.test: ${passed} passed`);
