import assert from 'node:assert/strict';
import {matchStage,offerFamily,offerMatchItem,productFamily,queryTokens,bestVariantScore,canonicalMatchText} from './matching.js';
import {createD1OfferStore} from './storage/offerStore.js';

// Concrete failures captured from the live catalogue, with adjacent intents
// that must remain searchable. These assertions run on both matcher mirrors.
const fruit={name:"DRISCOLL'S STRAWBERRY SOUTH AFRICA 250 GRAMS",category:'fresh-fruits'};
for(const item of [
 {name:'وافل محشوة فراولة',category:'biscuits'},
 {name:'حلاوي الجيليان كز/فراولة 6×80جم العلالي'},
 {name:'ناديك جو زادي يوناني فراولة 160 جم',category:'yogurt-labneh'},
]){
 assert.ok(matchStage(fruit,'فراوله')>matchStage(item,'فراوله'),item.name);
 assert.notEqual(offerFamily(item),'strawberry');
}
for(const [q,name] of [
 ['ويفر رينجو','Teashop Ringo Wafer 24x18g وافر سكويت رينغو تشوب'],
 ['زبادي يوناني نادك','ناديك زيادي يوناني 160 جرام'],
 ['nadec greek yoghurt','ناديك زيادي يوناني 160 جرام'],
 ['alsafi labneh','لبنة الصافي'],
 ['alsafi labneh','Al Safi Labneh'],
 ['ستربس دجاج دو','DOUX CHICKEN STRIPS REGULAR / SPICY 700G'],
 ['parachute shampoo','باراشوت شامبو بجوز الهند والخروع'],
 ['sunsilk shampoo','شامبو سنسليك 700ملي'],
 ['زبادي فراولة','Nadec Strawberry Yoghurt'],
 ['وافل فراولة','Strawberry Waffle'],
 ['جيلي فراولة','Strawberry Jelly'],
 ['egg roll','Sunbulah Egg Spring Roll Pastry'],
 ['هوت دوج الكبير','AL KABEER HOTDOG الكبير'],
 ['مجموعة سفر هيمالايا','Himalaya Baby Travel Pack'],
 ['nestle cereal','حبوب الإفطار نستله'],
 ['chest bag','حقيبة صدر عصرية'],
 ['ladies pants','سروال نسائي'],
 ['شباشب رجالية',"Men's Slipper"],
 ['geepas meat grinder','مطحنة لحم جيباس'],
 ['غلاية اولسنمارك','Olsenmark Electric Kettle'],
 ['عصارة ليمون','عصارة ليمون'],
])assert.ok(matchStage({name},q)>=3,`${q} -> ${name}`);
for(const [q,name] of [
 ['ويفر رينجو','Loacker Wafer'],
 ['زبادي يوناني نادك','Almarai Greek Yoghurt'],
 ['alsafi labneh','Puck Labneh'],
]){
 const hay=canonicalMatchText(name),words=new Set(hay.split(' '));
 assert.equal(queryTokens(q).every(t=>bestVariantScore(t,hay,words)>0),false,`wrong brand: ${q}`);
}
assert.equal(productFamily('Lemon Squeezer Steel/Plastic'),'houseware');
assert.equal(matchStage({name:'Lemon Squeezer Steel/Plastic'},'lemon'),1);
assert.equal(matchStage({name:'SUNBULAH SPRING ROLLS WHOLE WHEAT OR EGG ROLL'},'eggs'),1);
assert.equal(matchStage({name:'R C rice Makeup Kit'},'rice'),1);
assert.equal(matchStage({name:'Prime Rice Cooker with Steam'},'rice'),1);
assert.equal(matchStage({name:'Geepas Meat Grinder'},'meat'),1);
assert.equal(matchStage({name:'Rice Flour'},'rice'),1);
assert.equal(matchStage({name:'CRISPY RICE',category:'cereals-bars'},'rice'),1);
assert.equal(matchStage({name:'Rinzo Dish Wash Lemon'},'lemon'),1);
assert.equal(matchStage({name:'Olives Stuffed With Lemon'},'lemon'),1);
assert.equal(productFamily('AFIA Extra Virgin Olive Oil'),'oil');
assert.ok(matchStage({name:'AFIA Extra Virgin Olive Oil'},'زيت زيتون')>=3);
const diaper={nameAr:'كلوت جاميو هجين هجيز',category:'baby-diapers',brandSlug:'huggies',size:null};
assert.ok(matchStage(offerMatchItem(diaper),'huggies diapers')>=3);
assert.ok(matchStage(offerMatchItem(diaper),'حفاضات هجيز')>=3);
assert.equal(offerMatchItem(diaper).size,'','category supplies no quantity');
assert.equal(matchStage(offerMatchItem({...diaper,name:'Huggies Baby Soap'}),'huggies diapers'),1,'category cannot override a different named product');
assert.ok(matchStage({name:'Fresh Lemon'},'lemon')>=4);
assert.ok(matchStage({name:'Fresh Eggs'},'eggs')>=4);
assert.ok(matchStage({name:'Nadec Strawberry Yoghurt'},'زبادي فراولة')>=3);
assert.equal(matchStage({name:'Rice',size:'5kg'},'rice 1kg'),1);
assert.ok(matchStage({name:'Rice',size:'1kg'},'rice 1kg')>=3);
assert.equal(matchStage({name:'AMERICANA CHICKEN FRIES',nameAr:'بوب كورن دجاج'},'chicken'),4,'optional noisy Arabic cannot change a name-only surface');
console.log('Search quality: actual flavour/brand/category failures and contrasting intents passed.');

const bindCounts=[],sqlBytes=[];
const store=createD1OfferStore({prepare:sql=>{sqlBytes.push(new TextEncoder().encode(sql).length);assert.ok(sqlBytes.at(-1)<=100000,'expanded searches fit the D1 statement size budget');return {bind:(...args)=>{bindCounts.push(args.length);assert.ok(args.length<=100,'expanded searches fit the D1 parameter budget');return {all:async()=>({results:[]})};}};}});
for(const q of ['nuggets nugget ناجتس ناجت ناغتس nuggets','nuggets wafer yoghurt ladies water slipper','wafer yoghurt ladies slipper water eggs','زبادي يوناني نادك'])await store.search({q,store:'test',region:'central',currentOn:'2026-10-18',limit:300});
console.log(`Expanded query budgets: max ${Math.max(...bindCounts)}/100 parameters, ${Math.max(...sqlBytes)}/100000 SQL bytes.`);
