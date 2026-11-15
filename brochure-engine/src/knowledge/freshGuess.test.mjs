// A FRESH aisle guessed from a word in the name (classification.js
// freshGuessChallenge), and the route that re-files what was saved before the
// rule (POST /enrich/refile-fresh), on real SQLite and the real schema.
//
// Every name below is a live card read on 2026-11-15: 110 of the 688 Fresh
// cards had no retailer category and were placed by a name word, and about 60
// of those were not fresh food.

import assert from 'node:assert/strict';
import { classifyArchivedProduct as classify } from './classification.js';
import { productKnowledge } from '../offers/enrich.js';
import { rebuildRow } from '../offers/rebuild.js';
import { handleRequest } from '../engine.js';
import { createD1BrowseStore } from '../storage/browseStore.js';
import { createD1EnrichStore } from '../storage/enrichStore.js';
import { createSqliteD1, insertOffers } from '../storage/testSqliteD1.mjs';

let assertions = 0;
const placed = (input) => {
  const c = classify({ category: null, ...input });
  return c.status === 'classified' ? c.aisle : 'review';
};
const check = (input, expected, why) => {
  assert.equal(placed(input), expected, `${input.name || input.nameAr} — ${why}`);
  assertions += 1;
};

// --- 1. an explicit product phrase names the product ----------------------------
check({ name: 'Meat Grinder Steel 10Ltr E02430', nameAr: 'مفرمة لحم ستانلس ستيل' }, 'appliances', 'a machine');
check({ name: 'Tefoner Meat Grinder', nameAr: 'مفرمة لحم', brand: 'Tefoner' }, 'appliances', 'a machine');
check({ name: 'Lemon Squeezer Steel/Plastic', nameAr: 'ليمون ستانلس ستيل / ليمون بلاستيك' }, 'kitchen-dining', 'a tool');
check({ name: 'EXCELLENT HOUSEWARE POTATO MASHER PBT 245 MM', brand: 'Excellent Houseware' }, 'kitchen-dining', 'a tool');
check({ name: 'THAI CHEF CHICKEN OR DUCK INSTANT NOODLE CUP, 60 GRAMS', nameAr: 'دجاج', brand: 'THAI CHEF' }, 'pasta-noodles', 'noodles');
check({ name: "JACK LINK'S BEEF JERKY, SWEET & HOT", nameAr: 'لحم بقري', brand: "Jack Link's" }, 'chips-snacks', 'a snack');
check({ name: 'Argentina Corned Beef 200g', nameAr: 'لحم بقري', brand: 'Argentina' }, 'canned-food', 'a can');
check({ name: 'GOODY SIEVED TOMATOES, 350 GRAMS', nameAr: 'طماطم قودي', brand: 'Goody' }, 'canned-food', 'a can');

// --- 2. the brand's archive consensus is another department ----------------------
check({ name: 'SHEBA SUCCULENT CHICKEN BREAST OR TUNA WITH SALMON', nameAr: 'صدور دجاج / تونة', brand: 'Sheba' }, 'pets', 'pet food');
check({ name: 'Indomie Chicken 40x70g / Special Chicken 40x75g', nameAr: 'دجاج اندومي', brand: 'Indomie' }, 'pasta-noodles', 'noodles');
check({ name: 'Lamb Weston Potato Wedges W/Skin', nameAr: 'بطاطس ودجز', brand: 'Lamb Weston' }, 'frozen-food', 'the brand is not the meat');

// --- 3. a flavour word beside a brand is the flavour ------------------------------
check({ name: 'Biorepair Kids Strawberry', nameAr: 'فراولة', brand: 'Biorepair Kids' }, 'review', 'a toothpaste, not a fruit');
check({ name: 'tic tac STRAWBERRY MIX', nameAr: 'فراولة', brand: 'tic tac' }, 'review', 'a sweet');
check({ name: 'Jif Ultra Degreaser Lemon 470ML', nameAr: 'ليمون جيف', brand: 'Jif' }, 'review', 'a cleaner');
check({ name: 'PROTEIN FLATBREADS GARLIC & PARSELEY', nameAr: 'ثوم بروتين', brand: 'Befit' }, 'review', 'a brand read apart from the name still counts');
check({ name: 'HERFY Chicken Rings', nameAr: 'دجاج هرفي', brand: 'Herfy' }, 'review', 'chicken is the flavour of a made product');
// An Arabic-only reading gets the same answer as the English one.
check({ nameAr: 'فراولة', brand: 'Biorepair Kids', name: 'Biorepair Kids' }, 'review', 'Arabic word, same rule');

// --- a fresh guess with nothing against it stands, as before ----------------------
check({ name: 'LEMON/KG', nameAr: 'ليمون' }, 'fruits', 'loose fruit');
check({ name: 'CUCUMBER, KSA', nameAr: 'خيار' }, 'vegetables', 'loose vegetable');
check({ name: 'SHAHED STRAWBERRY', nameAr: 'فراولة' }, 'fruits', 'no brand, nothing against it');
check({ name: '', nameAr: 'شمام', brand: 'MUSKMELON' }, 'fruits', 'a "brand" that is the product itself is no brand');
check({ name: 'NORWEGIAN WHOLE SALMON, 2 - 3 KILO', nameAr: 'سلمون كامل' }, 'fish', 'fish counter');
check({ name: 'LAMB SHOULDER NZ', nameAr: 'كتف حمل نيوزيلندي' }, 'meat', 'meat counter');
check({ name: 'Golden Chicken Shawarma (400g)', nameAr: 'شاورما الفروج الذهبي', brand: 'Golden Chicken' }, 'deli', 'shawarma is a product, not a flavour');
// Kept beside a brand: the brand's own consensus is fresh, the name carries a
// frozen mark, or a meat name says it is fresh.
check({ name: 'Tanmiah Chicken 1000g', nameAr: 'دجاج', brand: 'Tanmiah' }, 'chicken-poultry', "the brand's consensus is fresh chicken");
check({ name: 'Seara Chicken Nuggets 750g', nameAr: 'ناجتس دجاج', brand: 'Seara' }, 'frozen-poultry', 'a frozen mark places it');
check({ name: 'Golden Chicken Fresh Chicken 900g', nameAr: 'دجاج طازج', brand: 'Golden Chicken' }, 'chicken-poultry', 'the name says fresh');
// "Fresh" is a flavour word on a sweet; it rescues meat only.
check({ name: 'TIC TAC FRESH MINT / ORANGE / SPEARMINT / STRAWBERRY MIX 18GR', nameAr: 'فراولة', brand: 'Tic Tac' }, 'review', '"fresh" does not make a sweet a fruit');

// A retailer category still wins outright, and the marker is only on a lost guess.
assert.equal(classify({ name: 'Biorepair Kids Strawberry', brand: 'Biorepair Kids', category: 'dental-care' }).aisle, 'dental');
assert.equal(classify({ name: 'Biorepair Kids Strawberry', brand: 'Biorepair Kids', category: null }).challenge, 'fresh_name_word');
assert.equal('challenge' in classify({ name: 'LEMON/KG', nameAr: 'ليمون', category: null }), false);
assert.equal('challenge' in classify({ name: 'Almarai Milk 1L', category: 'fresh-milk' }), false);
assertions += 4;

// The general rebuild (offers/rebuild.js) recomputes the saved classification
// too. It must do so with the retailer category, as enrichment did.
{
  const rebuilt = rebuildRow({
    id: 'danube:central:d4d:9', name: 'Biorepair Kids Strawberry', name_ar: 'فراولة',
    brand: 'Biorepair Kids', size: null, extraction_json: null, category: 'dental-care', price: 15, currency: 'SAR',
  });
  const saved = JSON.parse(rebuilt.extraction_json)._arabic_builder.product_title.classification;
  assert.equal(saved.aisle, 'dental', 'a rebuild keeps the retailer category');
  assert.equal(saved.source, 'retailer_category');
  assertions += 2;
}

// --- the route: re-file what was saved before the rule ----------------------------
const TODAY = new Date().toISOString().slice(0, 10);
const { db, raw, close } = createSqliteD1(['schema.sql']);
const live = { valid_from: '2020-01-01', valid_to: '2099-12-31' };
const OFFERS = [
  // Saved under fruits by a name word; the rule moves it.
  { id: 'danube:central:d4d:1', name: 'Biorepair Kids Strawberry', nameAr: 'فراولة', brand: 'Biorepair Kids', savedAisle: 'fruits' },
  // Saved under meat by a name word; the rule moves it to appliances.
  { id: 'marksave:central:d4d:2', name: 'Tefoner Meat Grinder', nameAr: 'مفرمة لحم', brand: 'Tefoner', savedAisle: 'meat' },
  // Saved under fruits by a name word and right: left alone.
  { id: 'almadina:central:d4d:3', name: 'LEMON/KG', nameAr: 'ليمون', brand: null, savedAisle: 'fruits' },
  // Saved under deli though today's classifier would say something else for a
  // reason that is NOT this rule: left alone (the route is not a full recompute).
  { id: 'aljazera:central:d4d:4', name: 'LEMON/KG', nameAr: 'ليمون', brand: null, savedAisle: 'deli' },
];
insertOffers(raw, OFFERS.map((o) => ({ id: o.id, name: o.name, name_ar: o.nameAr, price: 9, category: null, ...live })));
raw.exec("UPDATE offers SET brochure_id = 'fixture-brochure', page_index = 0");
const insert = raw.prepare(
  `INSERT INTO offer_enrichments (id, name, name_ar, brand, size, model, corroboration, extraction_json, enriched_at)
   VALUES (?, ?, ?, ?, NULL, 'fixture', 1, ?, '2026-11-01T00:00:00.000Z')`,
);
for (const o of OFFERS) {
  const knowledge = productKnowledge({ productName: o.name, arabicName: o.nameAr, brand: o.brand, size: null }, {}, { id: o.id, category: null });
  const title = knowledge.arabicBuilder.product_title;
  // What the OLD rule saved: classified into the fresh aisle by a name word.
  title.classification = {
    version: 'archive-classification-v1', aisle: o.savedAisle, department: 'fresh',
    category: { id: `aisle:${o.savedAisle}`, en: o.savedAisle, ar: o.savedAisle },
    source: 'english_dictionary', reviewRequired: false, status: 'classified', evidence: null,
    labelAr: o.savedAisle, departmentAr: 'الطازج',
  };
  insert.run(o.id, o.name, o.nameAr, o.brand, JSON.stringify({ product_name: o.name, _arabic_builder: knowledge.arabicBuilder }));
}

const ctx = {
  registry: {}, ingestSecret: 's3cret',
  enrichStore: createD1EnrichStore(db),
  browseStore: createD1BrowseStore(db),
  objectStore: (() => { const m = new Map(); return { async get(k) { return m.has(k) ? { bytes: m.get(k) } : null; }, async put(k, b) { m.set(k, b); } }; })(),
};
const call = (query = '', secret = 's3cret') => handleRequest(
  new Request(`https://engine.test/enrich/refile-fresh${query}`, { method: 'POST', headers: { 'X-Ingest-Secret': secret } }), ctx,
);
const savedAisle = (id) => {
  const row = raw.prepare("SELECT json_extract(extraction_json, '$._arabic_builder.product_title.classification') AS c FROM offer_enrichments WHERE id = ?").get(id);
  const c = JSON.parse(row.c);
  return c.status === 'classified' ? c.aisle : 'review';
};
const untouched = (id) => raw.prepare('SELECT name, name_ar, brand, identity_candidate, mint_verdict FROM offer_enrichments WHERE id = ?').get(id);
const beforeRow = JSON.stringify(untouched(OFFERS[0].id));
const gen = async () => { const g = await ctx.objectStore.get('cache/browse-generation.txt'); return g ? new TextDecoder().decode(g.bytes) : null; };

assert.equal((await call('', 'wrong')).status, 403, 'the route needs the ingest secret');

const dry = await (await call()).json();
assert.match(dry.mode, /dry-run/);
assert.equal(dry.scanned, 4);
assert.deepEqual(dry.changes.map((c) => [c.id, c.from, c.to]), [
  ['danube:central:d4d:1', 'fruits', 'review-required'],
  ['marksave:central:d4d:2', 'meat', 'appliances'],
], 'the dry run lists exactly the rows the rule moves');
assert.equal(dry.written, 0);
assert.equal(savedAisle('danube:central:d4d:1'), 'fruits', 'a dry run writes nothing');
assert.equal(await gen(), null, 'a dry run does not mark Browse changed');

const fruitsBefore = await ctx.browseStore.list({ include: [{ source: 'knowledge', categories: ['fruits'] }], currentOn: TODAY });
assert.equal(fruitsBefore.length, 2, 'before: the toothpaste is listed under fruits beside the lemon');

const applied = await (await call('?apply=1')).json();
assert.equal(applied.written, 2);
assert.equal(savedAisle('danube:central:d4d:1'), 'review');
assert.equal(savedAisle('marksave:central:d4d:2'), 'appliances');
assert.equal(savedAisle('almadina:central:d4d:3'), 'fruits', 'a right guess is left alone');
assert.equal(savedAisle('aljazera:central:d4d:4'), 'deli', 'a difference that is not this rule is left alone');
assert.equal(JSON.stringify(untouched(OFFERS[0].id)), beforeRow, 'only the one saved field changed');
assert.ok(await gen(), 'applying marks Browse changed');

const fruitsAfter = await ctx.browseStore.list({ include: [{ source: 'knowledge', categories: ['fruits'] }], currentOn: TODAY });
assert.deepEqual(fruitsAfter.map((r) => r.id), ['almadina:central:d4d:3'], 'after: fruits lists the lemon only');
const again = await (await call('?apply=1')).json();
assert.equal(again.written, 0, 'a second run finds nothing left to move');
assertions += 16;

close();
console.log(`fresh guess: ${assertions} assertions passed`);
