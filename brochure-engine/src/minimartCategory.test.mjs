// Mini marts offer groups (minimartCategory.js): frozen, food, drinks,
// snacks (the owner's four), other, unknown.
import assert from 'node:assert/strict';
import { CATEGORIES, CATEGORY_PROMPT, categoryOf, parseCategories, categoryLabel } from './minimartCategory.js';

assert.deepEqual(CATEGORIES, ['frozen', 'food', 'drinks', 'snacks', 'other', 'unknown']);
for (const c of CATEGORIES) assert.ok(CATEGORY_PROMPT.includes(`"${c}"`), c);

assert.equal(categoryOf(' Snacks '), 'snacks');
assert.equal(categoryOf('dessert'), null);
assert.equal(categoryOf(null), null);

const found = parseCategories('Here: {"offers":[{"picture":1,"group":"frozen"},{"picture":2,"group":"sweets"},{"picture":"3","category":"drinks"},{"picture":1,"group":"food"}]}');
assert.deepEqual([...found], [[1, 'frozen'], [3, 'drinks']]); // an unknown group is left out, the first answer stands
assert.equal(parseCategories('no json').size, 0);
assert.equal(parseCategories('{"offers":"x"}').size, 0);

assert.equal(categoryLabel(2, { name: 'شيبس ليز', brand: 'Lays', size: '23 جرام' }), 'Picture 2 — the offer: شيبس ليز · Lays · 23 جرام');
assert.equal(categoryLabel(1, { name: null }), 'Picture 1 — the offer: (no name)');

console.log('minimartCategory.test.mjs OK');
