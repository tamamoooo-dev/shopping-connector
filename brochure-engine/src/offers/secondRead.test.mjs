// secondRead.test.mjs — which crops are read a second time (owner, 2026-11-19:
// "read twice as an exception .. up to 5 percent"). Readings are the shapes
// Haiku returned in the 2026-11-19 experiments.
import assert from 'node:assert/strict';
import { chooseReading, priceFound, secondReadReason, secondReadsAllowed, SECOND_READ_SHARE } from './secondRead.js';

const line = (current_price, package_size = null, extra = {}) => ({ current_price, package_size, sale_count: null, sale_count_text: null, ...extra });

// A plain crop: one product, D4D's price on its line. Read once.
const plain = { name_en: 'Harpic Power Plus', name_ar: 'هاربيك', current_price: 15.99, sale_options: [line(15.99, '750ml')] };
assert.equal(secondReadReason(plain, 15.99), null);
assert.equal(secondReadReason(plain, '15.99'), null, 'a price sent as text is the same price');
// One product in two sizes at two prices: the size line already settles it.
const sizes = { name_en: 'Signature Select Coffee', current_price: 59.99, sale_options: [line(59.99, '1kg'), line(154.99, '3kg')] };
assert.equal(secondReadReason(sizes, 59.99), null, 'two sizes of one product are not two products');

// Kako: Brown 4.50 and White 3.95 in one crop, read as Brown with Brown's price.
const kako = { name_en: 'Kako Sliced Bread Brown', current_price: 4.5, sale_options: [line(4.5, '600g')] };
assert.equal(secondReadReason(kako, 3.95), 'price', "D4D's price on no line");
// KitKat: two products, two prices, a name that joins them.
const kitkat = { name_en: 'KITKAT 2 FINGER VALUE PACK OR KITKAT MINIATURES', current_price: 8.99, sale_options: [line(19.99, '20.5g'), line(8.99, '94.5g')] };
assert.equal(secondReadReason(kitkat, 8.99), 'products');
assert.equal(secondReadReason({ ...kitkat, name_en: null, name_ar: 'كيت كات ٢ فينجر أو كيت كات مينياتشر' }, 8.99), 'products', 'Arabic "أو" too');
assert.equal(secondReadReason({ ...kitkat, sale_options: [line(8.99, '94.5g')] }, 8.99), null, 'a joined name at ONE price is a choice the price covers');
// No name at all.
assert.equal(secondReadReason({ name_en: null, name_ar: '  ', current_price: 99, sale_options: [line(99)] }, 99), 'name');
// Rafa water: two sizes at the same price - the engine cannot pick a line.
const rafa = { name_en: 'Rafa Water', current_price: 4.95, sale_options: [line(4.95, '200ml x 24'), line(4.95, '330ml x 20')] };
assert.equal(priceFound(rafa, 4.95), false, 'two lines at one price that disagree select none (as the engine)');
// A reading with no price lines: its one current price.
assert.equal(priceFound({ name_en: 'Kettle', current_price: 59 }, 59), true);
assert.equal(priceFound({ name_en: 'Kettle', current_price: 59 }, 49), false);
// Nothing to ask about.
assert.equal(secondReadReason(plain, null), null, 'no D4D price: no second read');
assert.equal(secondReadReason(null, 15.99), null, 'no answer at all: the batch path retries it');

// Choosing: the second reading wins unless it is worse.
const kakoWhite = { name_en: 'Kako Sliced Bread White', current_price: 3.95, sale_options: [line(3.95, '600g')] };
assert.equal(chooseReading(kako, kakoWhite, 3.95), kakoWhite, 'found the price: the second wins');
const miniatures = { name_en: 'KITKAT MINIATURES', current_price: 8.99, sale_options: [line(8.99, '94.5g')] };
assert.equal(chooseReading(kitkat, miniatures, 8.99), miniatures, 'a tie: the reading asked the exact question wins');
const blenderFirst = { name_en: 'Philips Blender', current_price: null, sale_options: [] };
const blenderSecond = { name_en: null, current_price: null, sale_options: [] };
assert.equal(chooseReading(blenderFirst, blenderSecond, 1.9), blenderFirst, 'a second reading with less is not taken');
assert.equal(chooseReading(kitkat, { name_en: 'KitKat', current_price: null, sale_options: [] }, 8.99), kitkat, 'losing the price loses');
assert.equal(chooseReading(kako, null, 3.95), kako, 'no second answer keeps the first');
// A name is a must: a second reading that found the price but names nothing
// (or only in Arabic) never replaces a named first reading (2026-11-20).
const sony = { name_en: 'Sony 4K Google Smart TV K-75S20', name_ar: null, current_price: 2799, sale_options: [line(2799)] };
assert.equal(chooseReading(sony, { name_en: null, name_ar: null, current_price: 2499, sale_options: [line(2499)] }, 2499), sony, 'nameless with the price loses to named');
const mozzarella = { name_en: 'MOZZARELLA CHEESE - 3 COWS - PER KG', name_ar: 'جبنة موزاريلا ٣ بقرات', current_price: 29.99, sale_options: [line(29.99)] };
assert.equal(chooseReading(mozzarella, { name_en: null, name_ar: 'داري', current_price: 26.99, sale_options: [line(26.99)] }, 26.99), mozzarella, 'Arabic-only with the price loses to both names');
const pantene = { name_en: 'PANTENE Sun Care', name_ar: 'بانتين واقي الشمس', current_price: 15.99, sale_options: [line(15.99)] };
assert.equal(chooseReading({ name_en: null, name_ar: null, current_price: null }, pantene, 15.99), pantene, 'nothing first, everything second');

// The cap: 5% of the crops a run fetched.
assert.equal(SECOND_READ_SHARE, 0.05);
assert.equal(secondReadsAllowed(200), 10);
assert.equal(secondReadsAllowed(7708), 385);
assert.equal(secondReadsAllowed(20), 1);
assert.equal(secondReadsAllowed(19), 0, 'never over 5%: a small run reads none twice');
assert.equal(secondReadsAllowed(0), 0);
console.log('Second read: difficult crops (price off every line, no name, two products at two prices) chosen, better reading kept, capped at 5%.');
