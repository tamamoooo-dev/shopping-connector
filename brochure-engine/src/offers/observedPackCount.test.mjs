import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {corroboratedPackCount,corroboratedPackCountSql} from './observedPackCount.js';
import {applyUnitPrice} from './enrich.js';
import {readExtractionPackCount} from '../storage/enrichStore.js';
const fixtures=[
 ['3 PCS','حبات 3 pcs', '3 PCS'],[' 2pc ','2 pc حبة','2 PCS'],
 ['2 PCS','حبات 12 pcs',null],['3 PCS','حبات 3 pcsmodel',null],
 ['2 PCS','حبات ١2 pcs',null],['2 PCS\n','حبات 2 pcs',null],
 ['6 PCS','قطعة 6 PCS NET WT 550g',null],['4PCS','4 قطع perfume 100ml',null],
 ['3','حبات 3 pcs',null],['3+1','حبات 3 pcs',null],
 ['3 PCS','حبات 2 pcs',null],[null,'حبات 3 pcs',null],
 ['2 PCS','حبات 2 PCS', '2 PCS'],['3 PCS','حبات 3\tpcs',null],
];
const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE o(search_text TEXT); CREATE TABLE e(extraction_json TEXT);');
for(const [quantity,text,expected] of fixtures){
 db.exec('DELETE FROM o; DELETE FROM e;');db.prepare('INSERT INTO o VALUES(?)').run(text);db.prepare('INSERT INTO e VALUES(?)').run(JSON.stringify({quantity}));
 assert.equal(corroboratedPackCount(quantity,text),expected);
 assert.equal(readExtractionPackCount(JSON.stringify({quantity}),text),expected);
 assert.equal(db.prepare(`SELECT ${corroboratedPackCountSql()} AS value FROM o,e`).get().value,expected);
}
db.exec("UPDATE e SET extraction_json='{broken';");assert.equal(db.prepare(`SELECT ${corroboratedPackCountSql()} AS value FROM o,e`).get().value,null);
db.close();
const price=(size,pack='3 PCS',extra={})=>{
 const offer={name:'Activia Greek Yoghurt',price:11.99,...extra};
 applyUnitPrice(offer,{e_size:size,e_pack_count:pack},extra.servable??true);return offer;
};
const yoghurt=price('150g');assert.ok(Math.abs(yoghurt.unitPrice.value-11.99/.45)<1e-9);assert.equal(yoghurt.size,'3 x 150 g');assert.equal(yoghurt.eachPrice.pack,3);assert.ok(Math.abs(yoghurt.eachPrice.value-11.99/3)<1e-9);
assert.equal(price('3x150g','2 PCS').size,'3x150g','An existing multiplier wins');
assert.equal(price('300/340g').size,'300/340g','Never complete an alternative-size expression');
assert.equal(price('150g','3 PCS',{servable:false}).size,null,'Rejected observations cannot contribute count or size');
assert.equal(price('150g','3 PCS',{category:'tv'}).size,'150g','Non-grocery never acquires a new mass multiplier');
assert.equal(price('150g',null).size,'150g');
console.log('Corroborated counts: real SQLite/JS parity, substring/type guards, measured package completion and unchanged ambiguity/serving guards passed.');
