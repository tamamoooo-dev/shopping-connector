import assert from 'node:assert/strict';
import {parseSize} from './matching.js';
import {resolveComparableQuantity,unitPriceFromReference} from './lexicon/comparableQuantity.js';
for(const [size,each,pack] of [['١٨×٢٠٠ مل',200,18],['18*200 مل',200,18],['18×125 مل',125,18],['٢٠٠ مل×١٨',200,18],['9+3×200 مل',200,12]]){
 const parsed=parseSize('',size);assert.equal(parsed.each,each,size);assert.equal(parsed.pack,pack,size);assert.equal(parsed.total,each*pack,size);
 const quantity=resolveComparableQuantity({size,name:'Milk'});assert.equal(quantity.reference.quantity,each*pack/1000,size);
}
assert.ok(Math.abs(unitPriceFromReference(29.99,resolveComparableQuantity({size:'١٨×٢٠٠ مل',name:'Saudia Milk'}).reference).value-29.99/3.6)<1e-9);
assert.equal(parseSize('','18x200 ملف').unit,null,'unit must end at a Unicode boundary');
assert.equal(resolveComparableQuantity({size:'7-14kg',name:'Baby Diapers'}).reference,null,'body-weight range remains withheld');
assert.equal(resolveComparableQuantity({size:'170g + 50ml',name:'Tuna in oil'}).reference,null,'mixed products remain withheld');
console.log('Arabic multipacks: explicit ml counts reach the denominator; ambiguity guards remain.');
