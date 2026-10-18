import assert from 'node:assert/strict';
import { marketDate } from './marketDate.js';
import { canonicalMatchText, matchStage, queryTokens } from './matching.js';
import { observedText } from './observedText.js';
import { hasUsableEnglish } from './usableEnglish.js';
import { validateVisionOutput, validateOcrOutput } from './offers/smartExtraction.js';
import { applyUnitPrice, applyEnrichment, servable } from './offers/enrich.js';
import { resolveComparableQuantity } from './lexicon/comparableQuantity.js';
import { createD1OfferStore } from './storage/offerStore.js';
import { createSqliteD1, insertOffers } from './storage/testSqliteD1.mjs';
import { getBrowseOffersDoc } from './browse/api.js';
import { quantityForOffer, unitPriceFor } from './priceWatch.js';

assert.equal(marketDate(new Date('2026-10-17T20:59:59Z')), '2026-10-17');
assert.equal(marketDate(new Date('2026-10-17T21:00:00Z')), '2026-10-18');
assert.equal(marketDate(new Date('2026-12-31T21:00:00Z')), '2027-01-01');
for (const value of ['null', ' NULL ', '\u00a0NULL\ufeff', '\u2003none\u2003', 'undefined', 'none', 'n/a', '']) {
  assert.equal(observedText(value), null);
  assert.equal(hasUsableEnglish(value), false);
  assert.equal(servable({ name: value, corroboration: 1 }), false);
  const validation = validateVisionOutput({ name_en: value, name_ar: null });
  assert.notEqual(validation.fields.name_en.status, 'Accepted');
}
for (const [a, b] of [['cornflakes', 'corn flakes'], ['sunflower', 'sun flower'],
  ['dishwashing', 'dish washing'], ['mouthwash', 'mouth wash'], ['almond', 'almonds'],
  ['diaper', 'diapers'], ['ويفر لواكر', 'وافر لوكر']]) {
  assert.deepEqual(queryTokens(a), queryTokens(b));
  assert.equal(canonicalMatchText(a), canonicalMatchText(b));
}
assert.ok(matchStage({ name: 'Fresh Salmon' }, 'salmon') > matchStage({ name: 'Salmon Cat Food' }, 'salmon'));
assert.ok(matchStage({ name: 'White Eggs' }, 'eggs') > matchStage({ name: 'Egg Slicer' }, 'eggs'));
assert.ok(matchStage({ name: 'White Eggs' }, 'eggs') > matchStage({ name: 'نستله كوفي ميت بيض القهوة 400جم' }, 'eggs'));
assert.equal(matchStage({ name: 'Eggkizhi بيض' }, 'eggs'), 1);
assert.ok(matchStage({ name: 'Rice', size: '1kg' }, 'rice 1kg') > matchStage({ name: 'Rice', size: '5kg' }, 'rice 1kg'));
assert.ok(validateOcrOutput('حليب مبخر\n170 جم × 6').sizeCandidates.some(c => c.value.includes('جم')));

function price(name, size, price = 10, text = '') {
  const offer = { name, price };
  applyUnitPrice(offer, { e_size: size, search_text: text });
  return offer.unitPrice;
}
assert.equal(price('Noor Sunflower Oil', '2 x 1.5L + 500ml', 36.99).value, 36.99 / 3.5);
assert.equal(price('Baby Life Diapers', '7-14 kg', 48.99), null);
assert.equal(price('Whole Salmon', '2-3 kg', 54.99), null);
assert.equal(price('Cereal', '375g OR 700g', 15.99), null);
assert.equal(price('Soap', '3+1 x 120g', 13.99).value, 13.99 / .48);
assert.equal(price('Dettol Soap (3 + 1x 120g)', '120g', 13.99).value, 13.99 / .48);
assert.equal(price('Lulu Corn Flakes 375g 2s', '375g', 10.99).value, 10.99 / .75);
assert.equal(price('Ketchup EACH', '505g', 5.95).value, 5.95 / .505);
assert.equal(price('Tuna in Sunflower Oil', '185g', 10).value, 10 / .185);
assert.equal(price('Diapers 7-14kg', '88 pcs', 48.99).value, 48.99 / 88);
const quantity = resolveComparableQuantity({ name: 'Diapers', size: '7-14kg' });
assert.equal(quantity.reference, null);
assert.equal(unitPriceFor(48.99,quantityForOffer({name:'Diapers 7-14kg',price:48.99,unitPrice:null,unitPriceResolved:true})),null);
const oilPrice=36.99/3.5;
assert.equal(unitPriceFor(36.99,quantityForOffer({name:'Oil 2x1.5L+500ml',price:36.99,unitPrice:{value:oilPrice,unit:'l'},unitPriceResolved:true})).value,oilPrice);

// Exercise the actual SQL prefilter, including old rows without reindexing.
const { raw, db, close } = createSqliteD1(['schema.sql']);
raw.exec(`INSERT INTO brochures (id,store,region,edition,detected_at,source_type,checksum,collector,storage_key)
  VALUES ('b','store','region','e','2026-10-18','images','checksum','test','test')`);
insertOffers(raw, [{ id: 'store:region:d4d:1', name: 'Cereal', price: 10, valid_to: '2026-10-20' }]);
raw.exec(`UPDATE offers SET brochure_id='b', page_index=0, search_text='corn flakes لوكر'`);
raw.prepare(`INSERT INTO offer_enrichments (id,name,corroboration,enriched_at,match_text,size,extraction_json)
  VALUES (?,?,?,?,?,?,?)`).run('store:region:d4d:1', 'Cereal', .8, '2026-10-18', 'cereal', '375g', JSON.stringify({attributes:['crunchy'], package_type:'box'}));
const store = createD1OfferStore(db);
for (const q of ['cornflakes', 'corn flakes', 'لواكر', 'crunchy', 'box']) {
  const rows = await store.search({ q, currentOn: '2026-10-18' });
  assert.equal(rows.length, 1, `SQL retrieves existing evidence for ${q}`);
  const offer = {};
  const hay = applyEnrichment(offer, rows[0]);
  assert.ok(hay.includes('corn flakes'));
}
assert.equal((await store.search({q:'cornflakes',currentOn:'2026-10-21'})).length, 0);
raw.exec("UPDATE offer_enrichments SET name='NULL',name_ar='null',match_text='unsafeidentity'");
raw.prepare('UPDATE offer_enrichments SET name=?').run('\u00a0NULL\ufeff');
assert.equal((await store.search({q:'unsafeidentity',currentOn:'2026-10-18'})).length,0);
assert.equal((await store.search({q:'cornflakes',currentOn:'2026-10-18'})).length,1,'source text remains searchable');
const browse=await getBrowseOffersDoc({browseStore:{list:async()=>[{id:'null-name',name:'NULL',name_ar:'null',price:10,source:'d4d'}]}},{},'2026-10-18');
assert.equal(browse.offers[0].name,null);
assert.equal(browse.offers[0].nameAr,null);
close();
console.log('Resource usage regressions passed: Saudi dates, names, wording, ranking, quantity and real SQL retrieval.');
