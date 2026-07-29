// Offline tests for the Shopping Lexicon (lexicon/shopping.js, HISTORY §47).
//
// Run: node src/lexicon/shopping.test.mjs

import {
  CATEGORY_BY_ID,
  DESCRIPTOR_BY_ID,
  DESCRIPTOR_ROLES,
  SHOPPING_CATEGORIES,
  SHOPPING_DESCRIPTORS,
  SHOPPING_LEXICON_SIZE,
  SHOPPING_LEXICON_VERSION,
  SHOPPING_PHRASE_COLLISIONS,
  SHOPPING_STOPWORDS,
  descriptorRoleRank,
  resolveCategory,
  resolveDescriptors,
  resolvePackageType,
} from './shopping.js';
import { AISLE_BY_ID } from '../browse/taxonomy.js';
import { BRAND_LEXICON } from './brands.js';

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

const roles = new Set(Object.values(DESCRIPTOR_ROLES));

console.log('lexicon shape:');
check('the version is stamped', SHOPPING_LEXICON_VERSION === 'shopping-lexicon-v1');
check('category ids are unique', new Set(SHOPPING_CATEGORIES.map((e) => e.id)).size === SHOPPING_CATEGORIES.length);
check('descriptor ids are unique', new Set(SHOPPING_DESCRIPTORS.map((e) => e.id)).size === SHOPPING_DESCRIPTORS.length);
check('no phrase is claimed by two entries',
  SHOPPING_PHRASE_COLLISIONS.length === 0 || !console.error(SHOPPING_PHRASE_COLLISIONS));
check('every category carries an Arabic phrase',
  SHOPPING_CATEGORIES.every((e) => typeof e.ar === 'string' && e.ar.trim().length > 0));
check('every descriptor carries an Arabic phrase',
  SHOPPING_DESCRIPTORS.every((e) => typeof e.ar === 'string' && e.ar.trim().length > 0));
check('every descriptor declares a known role', SHOPPING_DESCRIPTORS.every((e) => roles.has(e.role)));
check('every declared aisle exists in the Browse taxonomy (one namespace, not two)',
  SHOPPING_CATEGORIES.every((e) => !e.aisle || AISLE_BY_ID.has(e.aisle)));
check('no Arabic category phrase carries a leading definite article (the builder composes it)',
  SHOPPING_CATEGORIES.every((e) => !e.ar.startsWith('ال ')));
// Seed floors, not exact counts: adding vocabulary is free, an accidentally
// truncated table fails loudly.
check('the seed vocabulary is present', SHOPPING_LEXICON_SIZE.categories >= 150 && SHOPPING_LEXICON_SIZE.descriptors >= 100);
check('every role has at least one term', [...roles].every((role) => SHOPPING_DESCRIPTORS.some((e) => e.role === role)));
check('role ranking is total and stable',
  [...roles].every((role) => descriptorRoleRank(role) < descriptorRoleRank('not-a-role')));

console.log('\nno term collides with a brand name (rule 4 of the curation rules):');
{
  const brandNames = new Set(BRAND_LEXICON.flatMap((b) => [b.display_en, b.display_ar])
    .filter(Boolean).map((n) => n.toLowerCase()));
  const clashing = [...SHOPPING_CATEGORIES, ...SHOPPING_DESCRIPTORS]
    .flatMap((e) => e.en).filter((term) => brandNames.has(term.toLowerCase()));
  check('no lexicon term is also a canonical brand name', clashing.length === 0 || !console.error(clashing));
}

console.log('\nthe head-noun rule (longest phrase wins, ties go rightmost):');
check('"Ice Cream" is ice cream, not dairy cream — the case matching.js gets wrong',
  resolveCategory('Baskin Ice Cream').id === 'ice-cream');
check('a flavour word never becomes the category',
  resolveCategory('Baskin Ice Cream Vanilla with Chocolate').id === 'ice-cream');
check('"Basmati Rice" beats "rice"', resolveCategory('Abu Kass Basmati Rice').id === 'basmati-rice');
check('"Chocolate Milk" is milk (rightmost head)', resolveCategory('Chocolate Milk').id === 'milk');
check('"Milk Chocolate" is chocolate (rightmost head)', resolveCategory('Milk Chocolate').id === 'chocolate');
check('"Cream Cheese" is cheese, not cream', resolveCategory('Alsafi Cream Cheese').id === 'cream-cheese');
check('"Cooking Cream" is its own category', resolveCategory('Almarai Cooking Cream').id === 'cooking-cream');
check('"Peanut Butter" is not butter', resolveCategory('Jif Peanut Butter').id === 'peanut-butter');
check('"Body Wash" is not a category matching.js knows at all', resolveCategory('Dove Body Wash').id === 'body-wash');
check('a safe production phrase resolves to the curated expansion category',
  resolveCategory('Vanish Oxi Max Stain Remover').id === 'stain-remover');
check('a safe spelling variant resolves through the existing category',
  resolveCategory('Signal Cavity Fighter Tooth Paste').id === 'toothpaste');
check('an unknown product yields NO category, never a wrong one',
  resolveCategory('Keqiwear KW86 3in1') === null);
check('an empty name yields no category', resolveCategory('') === null);
check('a null name yields no category', resolveCategory(null) === null);
check('the matched phrase is reported for auditing',
  resolveCategory('Arwa Bottled Water').matched_phrase === 'bottled water');
check('the span locates the head noun in the name',
  JSON.stringify(resolveCategory('Arwa Bottled Water').span) === '[1,3]');
check('skipTokens keeps a brand from naming the product',
  resolveCategory('Cream Fresh Chicken', { skipTokens: new Set([0]) }).id === 'chicken');

console.log('\nneighbour vetoes (the guard of last resort):');
check('"water pump" is not water', resolveCategory('Geepas Water Pump') === null);
check('"water heater" is its own category, matched before the veto',
  resolveCategory('Geepas Water Heater').id === 'water-heater');
check('"bottled water" still resolves next to the veto list',
  resolveCategory('Arwa Bottled Water').id === 'bottled-water');
check('"beauty cream bar" is the exact soap phrase, never dairy cream',
  resolveCategory('Dove beauty cream bar').id === 'beauty-cream-bar');
check('an unqualified "cream bar" is still absent',
  resolveCategory('Dove cream bar') === null);
check('"hand cream" is not dairy cream', resolveCategory('Nivea Hand Cream') === null);
check('plain "cream" still resolves', resolveCategory('Puck Thick Cream').id === 'cream');

console.log('\nambiguous production heads remain review-only:');
check('bare notebook is still context-dependent and absent',
  resolveCategory('HP Victus Gaming Notebook Core i5') === null);
check('dishwasher tablet resolves to detergent, never the dishwasher appliance',
  resolveCategory('Finish Ultimate Dishwasher Tablet').id === 'dishwasher-tablet');
check('bare tablet remains blocked across electronics/food meanings',
  resolveCategory('Godiva Signature Tablet') === null);
check('the reviewed dinner-set phrase is admitted',
  resolveCategory('Homeway Dinner Set').id === 'dinner-set');
check('bare set remains absent', resolveCategory('Kids Set') === null);
check('bare roll remains absent', resolveCategory('Fine Mega Roll') === null);
check('bare bar remains absent', resolveCategory('Creamy Bar') === null);
check('modifiers remain non-categories',
  ['Assorted', 'Small', 'Blue', 'Classic', 'Inverter'].every((word) => resolveCategory(word) === null));

console.log('\ndescriptors:');
{
  const d = resolveDescriptors('Fresh Whole Chicken Cut Up');
  // "chicken" is here because a food word that can HEAD a product can also
  // season one — it has an ingredient twin. In a real name the category pass
  // consumes it first (see structuredProduct.test.mjs).
  check('descriptors are found in reading order',
    d.map((x) => x.id).join(',') === 'fresh,whole,chicken-ingredient,cut-up');
  check('each descriptor carries its role', d.every((x) => roles.has(x.role)));
}
check('a repeated descriptor is recorded once',
  resolveDescriptors('Original Plain Original').filter((x) => x.id === 'plain').length === 1);
check('multi-word descriptors win over their parts',
  resolveDescriptors('Almarai Full Fat').map((x) => x.id).join(',') === 'full-fat');
check('"extra long grain" beats both "extra long" and "long grain"',
  resolveDescriptors('Basmati Extra Long Grain').map((x) => x.id).join(',') === 'extra-long-grain');
check('skipTokens excludes tokens the category already consumed',
  resolveDescriptors('Instant Coffee', { skipTokens: new Set([0, 1]) }).length === 0);
check('a name with no descriptors yields an empty list', resolveDescriptors('Refrigerator').length === 0);
check('flavours carry the flavour role',
  resolveDescriptors('Vanilla').every((x) => x.role === DESCRIPTOR_ROLES.FLAVOR));

console.log('\npackage types:');
check('a known package type resolves', resolvePackageType('jar').ar === 'برطمان');
check('package types are case-insensitive', resolvePackageType('JAR').id === 'jar');
check('an unknown package type resolves to null, never a guess', resolvePackageType('blister') === null);
check('a null package type is null', resolvePackageType(null) === null);

console.log('\nstopwords:');
check('function words are stopwords', SHOPPING_STOPWORDS.has('with') && SHOPPING_STOPWORDS.has('and'));
check('flavour MARKERS are stopwords, flavours are not',
  SHOPPING_STOPWORDS.has('flavour') && !SHOPPING_STOPWORDS.has('vanilla'));
check('no stopword is also a lexicon term',
  ![...SHOPPING_CATEGORIES, ...SHOPPING_DESCRIPTORS]
    .flatMap((e) => e.en).some((term) => SHOPPING_STOPWORDS.has(term)));

console.log('\ncontract stability:');
check('resolution is pure — same input, same output',
  JSON.stringify(resolveCategory('Almarai Halloumi Cheese')) === JSON.stringify(resolveCategory('Almarai Halloumi Cheese')));
check('every category id round-trips through the index',
  SHOPPING_CATEGORIES.every((e) => CATEGORY_BY_ID.get(e.id) === e));
check('every descriptor id round-trips through the index',
  SHOPPING_DESCRIPTORS.every((e) => DESCRIPTOR_BY_ID.get(e.id) === e));
check('every category term resolves to its own id',
  SHOPPING_CATEGORIES.every((e) => e.en.every((term) => resolveCategory(term)?.id === e.id)));

console.log(failures ? `\n${failures} FAILED` : '\nAll Shopping Lexicon tests passed.');
process.exit(failures ? 1 : 0);
