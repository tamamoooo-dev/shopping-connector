import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { selectSaleObservation, readSaleObservation, saleObservationSql, printedSaleCount } from './saleObservation.js';
import { applyUnitPrice, preservedObservation } from './enrich.js';

const observation = options => ({ parsedObject: { name_en: 'Sadia Chicken', package_size: '10x1000g', quantity: '10', sale_options: options } });
const option = (price, size, count, text) => ({ current_price: price, package_size: size, sale_count: count, sale_count_text: text });
const choices = [option(154.99, '10x1000g', null, null), option(49.99, '1000g', 3, '3 PCS')];
const selected = selectSaleObservation(observation(choices), { price: 49.99 });
assert.equal(selected.parsedObject.package_size, '1000g');
assert.equal(selected.parsedObject._sale.count, 3);
assert.equal(selected.parsedObject.quantity, null);
const stored = preservedObservation(selected.parsedObject);
assert.equal(stored.sale_options, undefined, 'Raw model prices remain in evidence only');
assert.equal(stored._sale.price, 49.99, 'Only the authoritative offer price is retained');
assert.equal(stored._sale.original.package_size,'10x1000g','The unselected original model size remains auditable');
assert.equal(stored._sale.original.quantity,'10','The original count is preserved independently of the admitted package count');
assert.equal(readSaleObservation(stored, 154.99).status, 'stale', 'Stale evidence cannot price another offer');
assert.equal(selectSaleObservation(observation(choices), { price: 44.99 }).parsedObject._sale.status, 'unmatched');
assert.equal(selectSaleObservation(observation([...choices, option(49.99, '800g', 3, '3 PCS')]), { price: 49.99 }).parsedObject._sale.status, 'unmatched');
assert.equal(selectSaleObservation(observation([option(5, '170g', 4, 'SAVE 4')]), { price: 5 }).parsedObject._sale.status, 'ambiguous');
for (const [badge, count] of [['٤ حبات',4],['2 PC',2],['3 PCS حبات',3],['حبتين',2],['1+1 FREE',2],['BUY 2 GET 1 FREE',3],['SAVE 4',null],['10 slices',null]]) {
  assert.equal(printedSaleCount(badge), count, badge);
}
function priced(size, count, price, name = 'Food') {
  const sale = selectSaleObservation(observation([option(price,size,count,`${count} PCS`)]), {price}).parsedObject._sale;
  const offer = {price,name};
  applyUnitPrice(offer,{e_size:size,e_sale:sale,e_pack_count:'9 PCS'});
  return offer;
}
assert.equal(priced('200g',2,14.5).unitPrice.value,36.25, 'Two 200g cheese packages, not twenty slices');
assert.equal(priced('200g',2,14.5,"Nadec Cheese Slices Burger 10's").unitPrice.value,36.25, 'Internal slices in the title cannot multiply the net weight');
assert.equal(priced('500g',2,10.5,'Chicken Thighs 2x500g').unitPrice.value,10.5, 'The selected package size wins over a combined caption size');
assert.equal(priced('6x1.5L',2,12.5).unitPrice.value,12.5/18, 'Two six-packs total eighteen litres');
assert.equal(priced('6x1.5L',2,12.5).eachPrice.pack,12, 'No lost internal multiplier');
assert.equal(priced('5x70g',3,15.99).saleQuantity.packagePrice,15.99/3);
assert.ok(Math.abs(priced('800g',3,44.99).unitPrice.value-44.99/2.4)<1e-10);
const uncertain={name:'Chicken 10x1000g',price:49.99};
applyUnitPrice(uncertain,{e_size:'10x1000g',e_sale:{version:'sale-reading-v1',price:49.99,status:'unmatched'}});
assert.equal(uncertain.unitPrice,null); assert.equal(uncertain.quantityReviewRequired,true);
const db = new DatabaseSync(':memory:');db.exec('CREATE TABLE o(price REAL); CREATE TABLE e(extraction_json TEXT)');
db.prepare('INSERT INTO o VALUES(?)').run(49.99);db.prepare('INSERT INTO e VALUES(?)').run(JSON.stringify(stored));
assert.deepEqual(JSON.parse(db.prepare(`SELECT ${saleObservationSql()} AS sale FROM o,e`).get().sale),readSaleObservation(stored,49.99));
db.exec('UPDATE o SET price=154.99');assert.equal(readSaleObservation(db.prepare(`SELECT ${saleObservationSql()} AS sale FROM o,e`).get().sale,154.99).status,'stale');
db.close();
console.log('Sale reading: price/quantity association, stale/conflicting evidence, Arabic badges, internal/external packs and SQLite parity passed.');
