import assert from 'node:assert/strict';
import {
  ARABIC_TYPO_RULES,
  correctArabicProductName,
  proposeArabicTypoCorrection,
} from './arabicTypoCorrection.js';
import { canonicalRowFromResult } from '../offers/enrich.js';

let tests = 0;
function test(name, fn) {
  fn();
  tests += 1;
  console.log(`  ok  ${name}`);
}

const correction = (englishName, arabicName) => (
  correctArabicProductName({ englishName, arabicName })
);

console.log('Arabic typo correction:');

const validated = [
  ['Puck Cream Cheese Spread 500g', 'بوك جينة كريم 500 جم', 'بوك جبنة كريم 500 جم'],
  ['C.Garden Foul Medammas', 'كاليفورنيا جاردن فول مدامس', 'كاليفورنيا جاردن فول مدمس'],
  ['KDD Tomato Paste 8x135g', 'مجون طماطم كي دي دي ٨×١٣٥ غرام', 'معجون طماطم كي دي دي ٨×١٣٥ غرام'],
  ['Sapil Solid Deo', 'مزل عرق سابيل صلب', 'مزيل عرق سابيل صلب'],
  ['Kojic Gold Caviar Body Lotion', 'كوجيك جولد كافيار لوسين الجسم', 'كوجيك جولد كافيار لوشن الجسم'],
  ['Puck Processed Analogue Cream Cheese Spread', 'شيبية جبنة كريم مطبوخة', 'شبيه جبنة كريم مطبوخة'],
  ['Plain Greek Yoghurt', 'زبادي يوناني صادة', 'زبادي يوناني سادة'],
  ['Peanut Butter Smooth', 'وجبة الفول السوداني ناعم', 'زبدة الفول السوداني ناعم'],
  ['Peanut Butter Creamy', 'جدة الفول السوداني كريمي', 'زبدة الفول السوداني كريمي'],
  ['Air Fryer 5L', 'قلابة هوائية 5 لتر', 'قلاية هوائية 5 لتر'],
  ['Mixed Nuts 500g', 'مكسورات مشكلة 500 جم', 'مكسرات مشكلة 500 جم'],
  ['Whitening Toothpaste', 'معجون إستان مبيض', 'معجون أسنان مبيض'],
  ['Mens Jeans', 'بنطال جنز رجالي', 'بنطال جينز رجالي'],
  ['Hazelnut Chocolate', 'شوكولاتة بنديق', 'شوكولاتة بندق'],
  ['Chicken Breast Bone In', 'صدور دجاج بالظم', 'صدور دجاج بالعظم'],
  ['Basmati Rice 5kg', 'أريز بسمتي 5 كجم', 'أرز بسمتي 5 كجم'],
  ['Fried Onion', 'بصل مقلبي', 'بصل مقلي'],
  ['Evaporated Milk', 'حليب مبهر', 'حليب مبخر'],
  ['Large Eggs 30 pcs', 'بيض كيبر 30 حبة', 'بيض كبير 30 حبة'],
  ['Tomato Ketchup', 'كيتشب طماطم', 'كاتشب طماطم'],
  ['Butter Biscuit', 'بسكت بالزبدة', 'بسكويت بالزبدة'],
  ['Date Maamoul', 'مامول بالتمر', 'معمول بالتمر'],
  ['Chocolate Wafer', 'وافير شوكولاتة', 'ويفر شوكولاتة'],
  ['Spicy Chicken', 'دجاج حات', 'دجاج حار'],
  ['Chicken Strips 450g', 'سبرسس دجاج 450 جم', 'ستربس دجاج 450 جم'],
  ['Granite Cookware', 'أواني نيجرانيت', 'أواني جرانيت'],
  ['Steam Iron 2200W', 'مكوي بخار 2200 واط', 'مكواة بخار 2200 واط'],
  ['Cardamom 200g', 'هل 200 جم', 'هيل 200 جم'],
  ['Maxi Pads', 'فوط مكسى', 'فوط ماكسي'],
  ['Mango Juice', 'عصير مانشو', 'عصير مانجو'],
  ['Non Alcoholic Malt Drink', 'مشروب شير بدون كحول', 'مشروب شعير بدون كحول'],
  ['Whole Chicken 1000g', 'دجاج خامل 1000 جم', 'دجاج كامل 1000 جم'],
  ['Beef Burger', 'برجر يقري', 'برجر بقري'],
  ['Frozen Vegetables', 'خضار أجمد', 'خضار مجمد'],
  ['Stainless Steel Pot', 'قدر استنلس ستيل', 'قدر ستانلس ستيل'],
];

test('all manually validated exact typo patterns are corrected', () => {
  for (const [english, before, after] of validated) {
    assert.equal(correction(english, before), after, `${before} -> ${after}`);
  }
});

test('each proposal replaces exactly one token and preserves all other words', () => {
  for (const [english, before, after] of validated) {
    const proposal = proposeArabicTypoCorrection({ englishName: english, arabicName: before });
    assert.ok(proposal);
    assert.equal(proposal.name, after);
    const beforeWords = before.match(/[\p{L}\p{M}\p{N}]+/gu);
    const afterWords = after.match(/[\p{L}\p{M}\p{N}]+/gu);
    assert.equal(beforeWords.length, afterWords.length);
    assert.equal(beforeWords.filter((word, index) => word !== afterWords[index]).length, 1);
  }
});

test('English evidence is mandatory', () => {
  assert.equal(correction('Family Meal', 'وجبة الفول السوداني ناعم'), 'وجبة الفول السوداني ناعم');
  assert.equal(correction('Canned Beans', 'فول مدامس'), 'فول مدامس');
  assert.equal(correction('', 'مجون طماطم'), 'مجون طماطم');
});

test('ambiguous multi-token corrections are refused', () => {
  assert.equal(correction('Cheese with Foul Medammes', 'جينة فول مدامس'), 'جينة فول مدامس');
  assert.equal(correction('Cheese Slices', 'جينة جينة شرائح'), 'جينة جينة شرائح');
});

test('context anchors are mandatory for potentially valid Arabic words', () => {
  assert.equal(correction('Peanut Butter Offer', 'زيادة العرض'), 'زيادة العرض');
  assert.equal(correction('Solid Deo', 'مزل سابيل'), 'مزل سابيل');
  assert.equal(correction('Air Fryer', 'قلابة كهربائية'), 'قلابة كهربائية');
});

test('brands, variants, punctuation, sizes, units and numbers remain byte-identical', () => {
  const before = 'بوك جينة كريم (2 × 500g) - الأصلي';
  const after = correction('Puck Original Cream Cheese 2 x 500g', before);
  assert.equal(after, 'بوك جبنة كريم (2 × 500g) - الأصلي');
  assert.equal(after.replace('جبنة', 'جينة'), before);
  assert.equal(correction('President Cheddar Cream Cheese', 'جينة كريم شيدر بريزدن'),
    'جبنة كريم شيدر بريزدن');
});

test('known correct Arabic and language variants are never improved or rewritten', () => {
  assert.equal(correction('Frozen Chicken', 'دجاج مجمد'), 'دجاج مجمد');
  assert.equal(correction('Womens Frozen Chicken', 'دجاج مجمدة نسائية'), 'دجاج مجمدة نسائية');
  assert.equal(correction('Cheese', 'جبن طبيعي'), 'جبن طبيعي');
});

test('rules are explicit and deterministic', () => {
  assert.equal(new Set(ARABIC_TYPO_RULES.map((item) => item.id)).size, ARABIC_TYPO_RULES.length);
  assert.equal(correction('Tomato Paste', 'مجون طماطم'), correction('Tomato Paste', 'مجون طماطم'));
});

test('the canonical enrichment row stores the corrected Arabic but retains raw audit evidence', () => {
  const result = {
    extraction: {
      productName: 'KDD Tomato Paste 8x135g',
      arabicName: 'مجون طماطم كي دي دي ٨×١٣٥ غرام',
      brand: 'KDD',
      size: '8x135g',
      packCount: '8x',
    },
    confidence: 0.95,
    provenance: { productName: 'Human', arabicName: 'Human' },
    diagnostics: { visionOutput: {
      name_en: 'KDD Tomato Paste 8x135g',
      name_ar: 'مجون طماطم كي دي دي ٨×١٣٥ غرام',
      brand: 'KDD',
      package_size: '8x135g',
    } },
  };
  const row = canonicalRowFromResult('test:offer', null, result, {
    enrichedAt: '2026-07-31T00:00:00.000Z',
  });
  assert.equal(row.name_ar, 'معجون طماطم كي دي دي ٨×١٣٥ غرام');
  assert.equal(row.structured_product.observed.name_ar, row.name_ar);
  assert.equal(row.extraction_json.name_ar, 'مجون طماطم كي دي دي ٨×١٣٥ غرام');
});

console.log(`\n${tests} Arabic typo-correction tests passed`);
