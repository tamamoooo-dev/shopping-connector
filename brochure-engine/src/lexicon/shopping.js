// lexicon/shopping.js — the SHOPPING LEXICON: what a product IS, and what is
// said about it, read from the ENGLISH extraction.
//
// Phase 2 of the post-extraction lexicon work (HISTORY §47), after the Brand
// Lexicon (§45). The pipeline this module sits in:
//
//   Vision -> English name (primary) -> Brand Lexicon -> [Shopping Lexicon]
//   -> Package Size Parser -> Descriptor Parser -> Structured Product
//   -> Arabic Builder
//
// WHY ENGLISH IS THE INPUT. Measured on both production corpora (2026-07-26):
// a usable English name is present on 99% of observations (990/1000) and 96% of
// the frozen 50, and it is the field the model reads most accurately. The
// Arabic OCR text is a FALLBACK source, never the input to this module.
//
// WHAT IT IS
//   Two curated bilingual vocabularies over the English name:
//     CATEGORY_TERMS   — head nouns naming WHAT the product is  ("bottled water")
//     DESCRIPTOR_TERMS — everything said ABOUT it   ("vanilla", "full fat", "frozen")
//   plus PACKAGE_TYPE_TERMS for the model's own `package_type` field. Every
//   entry carries the canonical Arabic phrase, so category/descriptor resolution
//   and Arabic generation read from ONE table instead of two that can drift.
//
// WHAT IT IS NOT
//   Not a translator, not a model call, not fuzzy matching. A term either is in
//   the table or the name simply has no category — exactly the Brand Lexicon's
//   posture, for the same reason: a WRONG category silently mis-files a product
//   for every phase downstream, a MISSING one costs nothing a later term cannot
//   fix.
//
// PHRASES, NOT TOKENS — the load-bearing difference from matching.js. The
// matching mirror's `productFamily()` is single-token by design, and on the
// English names this phase must read that is measurably wrong: "Ice Cream"
// resolves to the `cream` (dairy) family, and "Baskin Ice Cream Vanilla with
// Chocolate" resolves to `chocolate` because the derived tier fires on the
// FLAVOUR word. This module indexes multi-word phrases and matches
// LONGEST-FIRST, so "ice cream" beats "cream" and the flavour words fall
// through to the descriptor pass where they belong. matching.js is untouched:
// it answers a different question (which aisle band does this rank in) for a
// different input (bilingual OCR text), and it is a MIRRORED file (rule 2).
//
// FAILURE MODE (the project rule, unchanged): "no category", never "wrong
// category".

import { normalizeText } from '../matching.js';

// Bumped when the resolution BEHAVIOUR changes (fold, match ladder, veto rules,
// or output shape) — not when a term is added.
export const SHOPPING_LEXICON_VERSION = 'shopping-lexicon-v1';

// Descriptor roles, in the order the Arabic Builder renders them. A role is
// part of the data contract, not a comment: the builder groups by it, and the
// flavour role is the only one that gets joined into a phrase.
export const DESCRIPTOR_ROLES = Object.freeze({
  PREPARATION: 'preparation', // what was done to it: frozen, roasted, minced
  FORM: 'form',               // what shape it takes: sliced, powder, roll on
  ATTRIBUTE: 'attribute',     // what it is like: full fat, organic, concentrated
  GRADE: 'grade',             // size/quality grade: large, mini, premium
  MATERIAL: 'material',       // what it is made of: stainless steel, cotton
  COLOR: 'color',             // white, black, gold
  AUDIENCE: 'audience',       // baby, men, ladies
  FLAVOR: 'flavor',           // vanilla, strawberry — joined into one phrase
});

const ROLE_ORDER = Object.freeze([
  DESCRIPTOR_ROLES.PREPARATION,
  DESCRIPTOR_ROLES.FORM,
  DESCRIPTOR_ROLES.ATTRIBUTE,
  DESCRIPTOR_ROLES.GRADE,
  DESCRIPTOR_ROLES.MATERIAL,
  DESCRIPTOR_ROLES.COLOR,
  DESCRIPTOR_ROLES.AUDIENCE,
  DESCRIPTOR_ROLES.FLAVOR,
]);

export function descriptorRoleRank(role) {
  const index = ROLE_ORDER.indexOf(role);
  return index === -1 ? ROLE_ORDER.length : index;
}

// --- the category vocabulary ---------------------------------------------------
// SEED SCOPE (this phase): the categories that actually occur in the measured
// corpora, chosen by frequency, not intuition — the ranking that produced this
// list is reproducible with `node validation/shopping-lexicon-coverage.mjs`.
// Vocabulary growth is DATA work from here on, not engineering.
//
// CURATION RULES (each one exists because breaking it produces a wrong category)
//   1. Prefer a PHRASE over an ambiguous bare word. "chocolate spread" and
//      "hair oil" are entries; bare "bar", "pack", "care", "light" and "roll"
//      are deliberately absent because their meaning flips with context.
//   2. `ar` is the phrase a Saudi shopper would read on a shelf label, in bare
//      noun form (no leading definite article) — the Arabic Builder composes it.
//   3. `family` links the entry to the matching mirror's family id where one
//      exists, so this layer and search speak the SAME ids. `aisle` does the
//      same for the Browse taxonomy. Both are optional and purely additive;
//      neither is used for matching here.
//   4. Never add a term that is also a common BRAND name.
const CATEGORY_TERMS = [
  // --- dairy & eggs ------------------------------------------------------------
  { id: 'milk', en: ['milk'], ar: 'حليب', family: 'milk', aisle: 'milk-laban' },
  { id: 'fresh-milk', en: ['fresh milk'], ar: 'حليب طازج', family: 'milk', aisle: 'milk-laban' },
  { id: 'long-life-milk', en: ['long life milk', 'uht milk'], ar: 'حليب طويل الأجل', family: 'milk', aisle: 'milk-laban' },
  { id: 'milk-powder', en: ['milk powder', 'powdered milk', 'instant milk powder'], ar: 'حليب مجفف', family: 'milk', aisle: 'milk-powder' },
  { id: 'evaporated-milk', en: ['evaporated milk'], ar: 'حليب مبخر', family: 'milk', aisle: 'milk-powder' },
  { id: 'condensed-milk', en: ['condensed milk', 'sweetened condensed milk'], ar: 'حليب مكثف محلى', family: 'milk', aisle: 'milk-powder' },
  { id: 'baby-formula', en: ['infant formula', 'baby milk', 'growing up milk'], ar: 'حليب أطفال', aisle: 'baby-feeding' },
  { id: 'laban', en: ['laban', 'buttermilk'], ar: 'لبن', family: 'laban', aisle: 'milk-laban' },
  { id: 'yogurt', en: ['yoghurt', 'yogurt'], ar: 'زبادي', family: 'yogurt', aisle: 'yogurt-labneh' },
  { id: 'greek-yogurt', en: ['greek yoghurt', 'greek yogurt'], ar: 'زبادي يوناني', family: 'yogurt', aisle: 'yogurt-labneh' },
  { id: 'labneh', en: ['labneh', 'labaneh'], ar: 'لبنة', family: 'cheese', aisle: 'yogurt-labneh' },
  { id: 'cheese', en: ['cheese'], ar: 'جبن', family: 'cheese', aisle: 'cheese-cream' },
  { id: 'cream-cheese', en: ['cream cheese'], ar: 'جبن كريمي', family: 'cheese', aisle: 'cheese-cream' },
  { id: 'cheddar-cheese', en: ['cheddar cheese', 'cheddar'], ar: 'جبن شيدر', family: 'cheese', aisle: 'cheese-cream' },
  { id: 'mozzarella-cheese', en: ['mozzarella cheese', 'mozzarella'], ar: 'جبن موزاريلا', family: 'cheese', aisle: 'cheese-cream' },
  { id: 'halloumi-cheese', en: ['halloumi cheese', 'halloumi', 'haloumi'], ar: 'جبن حلوم', family: 'cheese', aisle: 'cheese-cream' },
  { id: 'feta-cheese', en: ['feta cheese', 'feta'], ar: 'جبن فيتا', family: 'cheese', aisle: 'cheese-cream' },
  { id: 'processed-cheese', en: ['processed cheese', 'triangle cheese', 'spreadable cheese'], ar: 'جبن مثلثات', family: 'cheese', aisle: 'cheese-cream' },
  { id: 'cream', en: ['cream'], ar: 'قشطة', family: 'cream', aisle: 'cheese-cream' },
  { id: 'cooking-cream', en: ['cooking cream'], ar: 'كريمة طبخ', family: 'cream', aisle: 'cheese-cream' },
  { id: 'whipping-cream', en: ['whipping cream', 'whipped cream'], ar: 'كريمة خفق', family: 'cream', aisle: 'cheese-cream' },
  { id: 'butter', en: ['butter'], ar: 'زبدة', family: 'butter', aisle: 'butter-margarine' },
  { id: 'ghee', en: ['ghee'], ar: 'سمن', family: 'butter', aisle: 'butter-margarine' },
  { id: 'margarine', en: ['margarine'], ar: 'مارجرين', family: 'butter', aisle: 'butter-margarine' },
  { id: 'eggs', en: ['eggs', 'egg'], ar: 'بيض', family: 'eggs', aisle: 'eggs' },

  // --- bakery & sweets ---------------------------------------------------------
  { id: 'bread', en: ['bread'], ar: 'خبز', family: 'bread', aisle: 'bread' },
  { id: 'toast-bread', en: ['toast bread', 'toast'], ar: 'خبز توست', family: 'bread', aisle: 'bread' },
  { id: 'arabic-bread', en: ['arabic bread', 'pita bread', 'flat bread'], ar: 'خبز عربي', family: 'bread', aisle: 'bread' },
  { id: 'croissant', en: ['croissant', 'croissants'], ar: 'كرواسون', family: 'cake', aisle: 'cakes-pastry' },
  { id: 'cake', en: ['cake', 'cakes', 'sponge cake'], ar: 'كيك', family: 'cake', aisle: 'cakes-pastry' },
  { id: 'maamoul', en: ['maamoul', 'mamoul'], ar: 'معمول', family: 'cake', aisle: 'cakes-pastry' },
  { id: 'donut', en: ['donut', 'donuts', 'doughnut'], ar: 'دونات', family: 'cake', aisle: 'cakes-pastry' },
  { id: 'pancake', en: ['pancake', 'pancakes'], ar: 'بان كيك', family: 'cake', aisle: 'cakes-pastry' },
  { id: 'rusk', en: ['rusk', 'rusks'], ar: 'قرشلة', family: 'biscuit', aisle: 'biscuits' },
  { id: 'biscuit', en: ['biscuit', 'biscuits'], ar: 'بسكويت', family: 'biscuit', aisle: 'biscuits' },
  { id: 'cookies', en: ['cookies', 'cookie'], ar: 'كوكيز', family: 'biscuit', aisle: 'biscuits' },
  { id: 'wafer', en: ['wafer', 'wafers'], ar: 'ويفر', family: 'biscuit', aisle: 'biscuits' },
  { id: 'crackers', en: ['crackers', 'cracker'], ar: 'كراكرز', family: 'biscuit', aisle: 'biscuits' },
  { id: 'chocolate', en: ['chocolate', 'chocolates'], ar: 'شوكولاتة', family: 'chocolate', aisle: 'chocolates-candies' },
  { id: 'chocolate-bar', en: ['chocolate bar'], ar: 'لوح شوكولاتة', family: 'chocolate', aisle: 'chocolates-candies' },
  { id: 'chocolate-spread', en: ['chocolate spread', 'cocoa spread'], ar: 'شوكولاتة للدهن', family: 'chocolate', aisle: 'sauces-spreads' },
  { id: 'candy', en: ['candy', 'sweets', 'toffee'], ar: 'حلوى', family: 'candy', aisle: 'chocolates-candies' },
  { id: 'chewing-gum', en: ['chewing gum'], ar: 'علكة', family: 'candy', aisle: 'chocolates-candies' },
  { id: 'lollipop', en: ['lollipop', 'lollipops', 'lollies'], ar: 'مصاصة', family: 'candy', aisle: 'chocolates-candies' },
  { id: 'marshmallow', en: ['marshmallow', 'marshmallows'], ar: 'مارشميلو', family: 'candy', aisle: 'chocolates-candies' },
  { id: 'halawa', en: ['halawa', 'halva', 'halwa'], ar: 'حلاوة طحينية', aisle: 'sauces-spreads' },
  { id: 'ice-cream', en: ['ice cream', 'icecream'], ar: 'آيس كريم', family: 'icecream', aisle: 'ice-cream' },
  { id: 'dessert', en: ['dessert', 'desserts'], ar: 'حلى', family: 'dessert', aisle: 'cakes-pastry' },
  { id: 'custard', en: ['custard'], ar: 'كاسترد', family: 'dessert', aisle: 'cakes-pastry' },
  { id: 'jelly', en: ['jelly'], ar: 'جيلي', family: 'dessert', aisle: 'cakes-pastry' },

  // --- beverages ---------------------------------------------------------------
  { id: 'water', en: ['water'], ar: 'مياه', family: 'water', aisle: 'water' },
  { id: 'bottled-water', en: ['bottled water'], ar: 'مياه معبأة', family: 'water', aisle: 'water' },
  { id: 'drinking-water', en: ['drinking water'], ar: 'مياه شرب', family: 'water', aisle: 'water' },
  { id: 'mineral-water', en: ['mineral water'], ar: 'مياه معدنية', family: 'water', aisle: 'water' },
  { id: 'juice', en: ['juice', 'juices', 'nectar'], ar: 'عصير', family: 'juice', aisle: 'juices' },
  { id: 'soft-drink', en: ['soft drink', 'soft drinks', 'carbonated drink', 'cola'], ar: 'مشروب غازي', family: 'soda', aisle: 'soft-drinks' },
  { id: 'energy-drink', en: ['energy drink'], ar: 'مشروب طاقة', family: 'soda', aisle: 'soft-drinks' },
  { id: 'malt-drink', en: ['malt drink', 'malt beverage', 'non alcoholic malt'], ar: 'شراب شعير', family: 'soda', aisle: 'malt-drinks' },
  { id: 'powder-drink', en: ['powder drink', 'powdered drink', 'drink mix'], ar: 'مشروب بودرة', family: 'syrup', aisle: 'drink-mixes' },
  { id: 'syrup', en: ['syrup'], ar: 'شراب مركز', family: 'syrup', aisle: 'drink-mixes' },
  { id: 'tea', en: ['tea'], ar: 'شاي', family: 'tea', aisle: 'tea-coffee' },
  { id: 'green-tea', en: ['green tea'], ar: 'شاي أخضر', family: 'tea', aisle: 'tea-coffee' },
  { id: 'black-tea', en: ['black tea'], ar: 'شاي أسود', family: 'tea', aisle: 'tea-coffee' },
  { id: 'coffee', en: ['coffee'], ar: 'قهوة', family: 'coffee', aisle: 'tea-coffee' },
  { id: 'instant-coffee', en: ['instant coffee'], ar: 'قهوة سريعة التحضير', family: 'coffee', aisle: 'tea-coffee' },
  { id: 'ground-coffee', en: ['ground coffee', 'coffee powder'], ar: 'قهوة مطحونة', family: 'coffee', aisle: 'tea-coffee' },
  { id: 'coffee-beans', en: ['coffee beans'], ar: 'حبوب قهوة', family: 'coffee', aisle: 'tea-coffee' },
  { id: 'cappuccino', en: ['cappuccino', 'latte'], ar: 'كابتشينو', family: 'coffee', aisle: 'tea-coffee' },

  // --- pantry ------------------------------------------------------------------
  { id: 'rice', en: ['rice'], ar: 'أرز', family: 'rice', aisle: 'rice' },
  { id: 'basmati-rice', en: ['basmati rice'], ar: 'أرز بسمتي', family: 'rice', aisle: 'rice' },
  { id: 'egyptian-rice', en: ['egyptian rice'], ar: 'أرز مصري', family: 'rice', aisle: 'rice' },
  { id: 'pasta', en: ['pasta', 'macaroni', 'chifferini'], ar: 'معكرونة', family: 'pasta', aisle: 'pasta-noodles' },
  { id: 'spaghetti', en: ['spaghetti'], ar: 'سباغيتي', family: 'pasta', aisle: 'pasta-noodles' },
  { id: 'noodles', en: ['noodles', 'cup noodles'], ar: 'نودلز', family: 'pasta', aisle: 'pasta-noodles' },
  { id: 'vermicelli', en: ['vermicelli'], ar: 'شعيرية', family: 'pasta', aisle: 'pasta-noodles' },
  { id: 'flour', en: ['flour'], ar: 'دقيق', family: 'flour', aisle: 'flour-baking' },
  { id: 'sugar', en: ['sugar'], ar: 'سكر', family: 'sugar', aisle: 'flour-baking' },
  { id: 'icing-sugar', en: ['icing sugar', 'powdered sugar'], ar: 'سكر بودرة', family: 'sugar', aisle: 'flour-baking' },
  { id: 'salt', en: ['salt'], ar: 'ملح', aisle: 'spices' },
  { id: 'yeast', en: ['yeast'], ar: 'خميرة', aisle: 'flour-baking' },
  { id: 'baking-powder', en: ['baking powder'], ar: 'بيكنج بودر', aisle: 'flour-baking' },
  { id: 'oil', en: ['oil'], ar: 'زيت', family: 'oil', aisle: 'oil-ghee' },
  { id: 'sunflower-oil', en: ['sunflower oil'], ar: 'زيت دوار الشمس', family: 'oil', aisle: 'oil-ghee' },
  { id: 'vegetable-oil', en: ['vegetable oil'], ar: 'زيت نباتي', family: 'oil', aisle: 'oil-ghee' },
  { id: 'olive-oil', en: ['olive oil'], ar: 'زيت زيتون', family: 'oil', aisle: 'oil-ghee' },
  { id: 'corn-oil', en: ['corn oil'], ar: 'زيت ذرة', family: 'oil', aisle: 'oil-ghee' },
  { id: 'vinegar', en: ['vinegar'], ar: 'خل', family: 'vinegar', aisle: 'sauces-spreads' },
  { id: 'tomato-paste', en: ['tomato paste'], ar: 'معجون طماطم', family: 'sauce', aisle: 'sauces-spreads' },
  { id: 'ketchup', en: ['ketchup', 'tomato ketchup'], ar: 'كاتشب', family: 'sauce', aisle: 'sauces-spreads' },
  { id: 'mayonnaise', en: ['mayonnaise'], ar: 'مايونيز', family: 'sauce', aisle: 'sauces-spreads' },
  { id: 'mustard', en: ['mustard'], ar: 'مسطردة', family: 'sauce', aisle: 'sauces-spreads' },
  { id: 'sauce', en: ['sauce'], ar: 'صوص', family: 'sauce', aisle: 'sauces-spreads' },
  { id: 'soy-sauce', en: ['soy sauce'], ar: 'صوص صويا', family: 'sauce', aisle: 'sauces-spreads' },
  { id: 'hot-sauce', en: ['hot sauce', 'chilli sauce', 'chili sauce'], ar: 'صوص حار', family: 'sauce', aisle: 'sauces-spreads' },
  { id: 'honey', en: ['honey'], ar: 'عسل', family: 'honey', aisle: 'sauces-spreads' },
  { id: 'jam', en: ['jam', 'marmalade'], ar: 'مربى', family: 'jam', aisle: 'sauces-spreads' },
  { id: 'peanut-butter', en: ['peanut butter'], ar: 'زبدة الفول السوداني', aisle: 'sauces-spreads' },
  { id: 'tahini', en: ['tahini', 'tahina'], ar: 'طحينة', aisle: 'sauces-spreads' },
  { id: 'dates', en: ['dates'], ar: 'تمر', family: 'dates', aisle: 'dates-dried-fruits' },
  { id: 'oats', en: ['oats', 'oat'], ar: 'شوفان', family: 'cereal', aisle: 'cereals' },
  { id: 'corn-flakes', en: ['corn flakes', 'cornflakes'], ar: 'رقائق الذرة', family: 'cereal', aisle: 'cereals' },
  { id: 'cereal', en: ['cereal', 'breakfast cereal', 'granola', 'muesli'], ar: 'حبوب إفطار', family: 'cereal', aisle: 'cereals' },
  { id: 'soup', en: ['soup'], ar: 'شوربة', family: 'soup', aisle: 'canned-food' },
  { id: 'tuna', en: ['tuna'], ar: 'تونة', family: 'fish', aisle: 'canned-food' },
  { id: 'sardines', en: ['sardines', 'sardine'], ar: 'سردين', family: 'fish', aisle: 'canned-food' },
  { id: 'sweet-corn', en: ['sweet corn', 'kernel corn'], ar: 'ذرة حلوة', aisle: 'canned-food' },
  { id: 'beans', en: ['beans', 'fava beans', 'foul medames'], ar: 'فول', aisle: 'canned-food' },
  { id: 'chickpeas', en: ['chickpeas', 'hummus'], ar: 'حمص', aisle: 'canned-food' },
  { id: 'lentils', en: ['lentils', 'lentil'], ar: 'عدس', aisle: 'rice' },
  { id: 'pickles', en: ['pickles', 'pickle'], ar: 'مخلل', family: 'pickle', aisle: 'sauces-spreads' },
  { id: 'nuts', en: ['nuts', 'mixed nuts'], ar: 'مكسرات', aisle: 'dates-dried-fruits' },
  { id: 'almonds', en: ['almonds', 'almond'], ar: 'لوز', aisle: 'dates-dried-fruits' },
  { id: 'cashew', en: ['cashew', 'cashews'], ar: 'كاجو', aisle: 'dates-dried-fruits' },
  { id: 'pistachio', en: ['pistachio', 'pistachios'], ar: 'فستق', aisle: 'dates-dried-fruits' },
  { id: 'walnut', en: ['walnut', 'walnuts'], ar: 'جوز', aisle: 'dates-dried-fruits' },
  { id: 'raisins', en: ['raisins'], ar: 'زبيب', aisle: 'dates-dried-fruits' },
  { id: 'chips', en: ['chips', 'crisps', 'potato chips'], ar: 'شيبس', family: 'chips', aisle: 'biscuits' },
  { id: 'popcorn', en: ['popcorn'], ar: 'فشار', aisle: 'biscuits' },
  { id: 'spices', en: ['spices', 'spice', 'seasoning', 'masala'], ar: 'بهارات', aisle: 'spices' },
  { id: 'black-pepper', en: ['black pepper'], ar: 'فلفل أسود', aisle: 'spices' },
  { id: 'cardamom', en: ['cardamom'], ar: 'هيل', aisle: 'spices' },
  { id: 'cinnamon', en: ['cinnamon'], ar: 'قرفة', aisle: 'spices' },
  { id: 'saffron', en: ['saffron'], ar: 'زعفران', aisle: 'spices' },

  // --- meat, poultry, fish -----------------------------------------------------
  { id: 'chicken', en: ['chicken'], ar: 'دجاج', family: 'chicken', aisle: 'chicken-poultry' },
  { id: 'whole-chicken', en: ['whole chicken'], ar: 'دجاج كامل', family: 'chicken', aisle: 'chicken-poultry' },
  { id: 'chicken-breast', en: ['chicken breast', 'chicken breasts'], ar: 'صدور دجاج', family: 'chicken', aisle: 'chicken-poultry' },
  { id: 'chicken-nuggets', en: ['chicken nuggets', 'nuggets'], ar: 'ناجتس دجاج', family: 'chicken', aisle: 'frozen-poultry' },
  { id: 'chicken-strips', en: ['chicken strips'], ar: 'ستربس دجاج', family: 'chicken', aisle: 'frozen-poultry' },
  { id: 'chicken-popcorn', en: ['chicken popcorn', 'popcorn chicken'], ar: 'بوب كورن دجاج', family: 'chicken', aisle: 'frozen-poultry' },
  { id: 'meat', en: ['meat'], ar: 'لحم', family: 'meat', aisle: 'meat' },
  { id: 'beef', en: ['beef'], ar: 'لحم بقري', family: 'meat', aisle: 'meat' },
  { id: 'mutton', en: ['mutton'], ar: 'لحم غنم', family: 'meat', aisle: 'meat' },
  { id: 'lamb', en: ['lamb'], ar: 'لحم ضأن', family: 'meat', aisle: 'meat' },
  { id: 'veal', en: ['veal'], ar: 'لحم عجل', family: 'meat', aisle: 'meat' },
  { id: 'minced-meat', en: ['minced meat', 'ground beef'], ar: 'لحم مفروم', family: 'meat', aisle: 'meat' },
  { id: 'burger', en: ['burger', 'burgers', 'hamburger'], ar: 'برجر', family: 'prepared', aisle: 'frozen-meat' },
  { id: 'sausage', en: ['sausage', 'sausages'], ar: 'سجق', aisle: 'deli' },
  { id: 'mortadella', en: ['mortadella'], ar: 'مرتديلا', aisle: 'deli' },
  { id: 'luncheon-meat', en: ['luncheon meat', 'luncheon'], ar: 'لانشون', aisle: 'deli' },
  { id: 'kofta', en: ['kofta', 'kobeba', 'kibbeh'], ar: 'كفتة', aisle: 'frozen-meat' },
  { id: 'shawarma', en: ['shawarma'], ar: 'شاورما', family: 'prepared', aisle: 'deli' },
  { id: 'fish', en: ['fish'], ar: 'سمك', family: 'fish', aisle: 'fish' },
  { id: 'fish-fillet', en: ['fish fillet'], ar: 'فيليه سمك', family: 'fish', aisle: 'fish' },
  { id: 'salmon', en: ['salmon'], ar: 'سلمون', family: 'fish', aisle: 'fish' },
  { id: 'shrimp', en: ['shrimp', 'shrimps', 'prawns', 'prawn'], ar: 'روبيان', family: 'fish', aisle: 'fish' },

  // --- produce (top of the measured corpus only; Browse owns the long tail) -----
  { id: 'potato', en: ['potato', 'potatoes'], ar: 'بطاطس', family: 'potato', aisle: 'vegetables' },
  { id: 'potato-fries', en: ['potato fries', 'french fries', 'frenchfries', 'fries'], ar: 'بطاطس مقلية', aisle: 'frozen-fruits-veg' },
  { id: 'tomato', en: ['tomato', 'tomatoes'], ar: 'طماطم', family: 'tomato', aisle: 'vegetables' },
  { id: 'onion', en: ['onion', 'onions'], ar: 'بصل', family: 'onion', aisle: 'vegetables' },
  { id: 'cucumber', en: ['cucumber', 'cucumbers'], ar: 'خيار', family: 'cucumber', aisle: 'vegetables' },
  { id: 'carrot', en: ['carrot', 'carrots'], ar: 'جزر', family: 'carrot', aisle: 'vegetables' },
  { id: 'garlic', en: ['garlic'], ar: 'ثوم', family: 'garlic', aisle: 'vegetables' },
  { id: 'lettuce', en: ['lettuce'], ar: 'خس', family: 'lettuce', aisle: 'vegetables' },
  { id: 'mixed-vegetables', en: ['mixed vegetables', 'vegetables'], ar: 'خضار مشكلة', aisle: 'frozen-fruits-veg' },
  { id: 'peas', en: ['peas', 'green peas'], ar: 'بازلاء', aisle: 'frozen-fruits-veg' },
  { id: 'okra', en: ['okra'], ar: 'بامية', aisle: 'frozen-fruits-veg' },
  { id: 'olives', en: ['olives'], ar: 'زيتون', aisle: 'canned-food' },
  // "Salad" is a product; "Salad Bowl" is a dish. The longer phrase is matched
  // first, which is the whole reason phrases beat bare words here.
  { id: 'salad', en: ['salad'], ar: 'سلطة', aisle: 'vegetables' },
  { id: 'salad-bowl', en: ['salad bowl'], ar: 'وعاء سلطة', aisle: 'kitchen-dining' },
  { id: 'banana', en: ['banana', 'bananas'], ar: 'موز', family: 'banana', aisle: 'fruits' },
  { id: 'apple', en: ['apple', 'apples'], ar: 'تفاح', family: 'apple', aisle: 'fruits' },
  { id: 'orange-fruit', en: ['oranges'], ar: 'برتقال', family: 'orange', aisle: 'fruits' },
  { id: 'mango-fruit', en: ['mangoes'], ar: 'مانجو', family: 'mango', aisle: 'fruits' },
  { id: 'grapes', en: ['grapes'], ar: 'عنب', family: 'grapes', aisle: 'fruits' },
  { id: 'watermelon', en: ['watermelon'], ar: 'بطيخ', family: 'watermelon', aisle: 'fruits' },
  { id: 'pineapple', en: ['pineapple'], ar: 'أناناس', family: 'pineapple', aisle: 'fruits' },

  // --- household & cleaning ----------------------------------------------------
  { id: 'detergent', en: ['detergent'], ar: 'منظف', family: 'care', aisle: 'laundry' },
  { id: 'washing-powder', en: ['washing powder', 'laundry powder'], ar: 'مسحوق غسيل', family: 'care', aisle: 'laundry' },
  { id: 'liquid-detergent', en: ['liquid detergent', 'laundry liquid'], ar: 'منظف سائل', family: 'care', aisle: 'laundry' },
  { id: 'fabric-softener', en: ['fabric softener', 'fabric conditioner'], ar: 'منعم أقمشة', family: 'care', aisle: 'laundry' },
  { id: 'dishwashing-liquid', en: ['dishwashing liquid', 'dish washing liquid', 'dish wash'], ar: 'سائل غسيل الصحون', family: 'care', aisle: 'cleaning' },
  { id: 'floor-cleaner', en: ['floor cleaner', 'surface cleaner'], ar: 'منظف أرضيات', family: 'care', aisle: 'cleaning' },
  { id: 'disinfectant', en: ['disinfectant'], ar: 'مطهر', family: 'care', aisle: 'cleaning' },
  { id: 'bleach', en: ['bleach'], ar: 'مبيض', family: 'care', aisle: 'cleaning' },
  { id: 'air-freshener', en: ['air freshener'], ar: 'معطر جو', aisle: 'cleaning' },
  { id: 'facial-tissue', en: ['facial tissue', 'facial tissues', 'tissue', 'tissues'], ar: 'مناديل ورقية', aisle: 'tissues' },
  { id: 'toilet-paper', en: ['toilet paper', 'toilet tissue', 'toilet roll'], ar: 'ورق تواليت', aisle: 'tissues' },
  { id: 'kitchen-towel', en: ['kitchen towel', 'paper towel', 'kitchen roll'], ar: 'مناديل مطبخ', aisle: 'tissues' },
  { id: 'trash-bag', en: ['trash bag', 'garbage bag', 'garbage bags', 'bin bag', 'trash bags'], ar: 'أكياس قمامة', aisle: 'cleaning' },
  { id: 'aluminium-foil', en: ['aluminium foil', 'aluminum foil'], ar: 'ورق ألمنيوم', aisle: 'tissues' },
  { id: 'scourer', en: ['scourer', 'sponge scourer', 'scrub pad'], ar: 'إسفنجة جلي', aisle: 'cleaning' },
  { id: 'soap', en: ['soap'], ar: 'صابون', family: 'care', aisle: 'bath-body' },
  { id: 'hand-wash', en: ['hand wash', 'handwash', 'liquid soap'], ar: 'غسول يدين', family: 'care', aisle: 'bath-body' },

  // --- personal care -----------------------------------------------------------
  { id: 'shampoo', en: ['shampoo'], ar: 'شامبو', family: 'care', aisle: 'hair-care' },
  { id: 'conditioner', en: ['conditioner', 'hair conditioner'], ar: 'بلسم', family: 'care', aisle: 'hair-care' },
  { id: 'hair-oil', en: ['hair oil'], ar: 'زيت شعر', aisle: 'hair-care' },
  { id: 'hair-color', en: ['hair color', 'hair colour', 'hair dye'], ar: 'صبغة شعر', aisle: 'hair-care' },
  { id: 'hair-serum', en: ['hair serum'], ar: 'سيروم شعر', aisle: 'hair-care' },
  { id: 'body-wash', en: ['body wash', 'shower gel'], ar: 'غسول الجسم', family: 'care', aisle: 'bath-body' },
  { id: 'body-lotion', en: ['body lotion', 'moisturizing lotion'], ar: 'لوشن الجسم', family: 'care', aisle: 'bath-body' },
  { id: 'face-wash', en: ['face wash', 'facial cleanser', 'foaming cleanser'], ar: 'غسول الوجه', family: 'care', aisle: 'skin-face' },
  { id: 'face-cream', en: ['face cream', 'facial cream'], ar: 'كريم الوجه', aisle: 'skin-face' },
  { id: 'sunscreen', en: ['sunscreen', 'sun block'], ar: 'واقي شمس', aisle: 'skin-face' },
  { id: 'serum', en: ['serum'], ar: 'سيروم', aisle: 'skin-face' },
  { id: 'toothpaste', en: ['toothpaste', 'tooth paste'], ar: 'معجون أسنان', aisle: 'dental' },
  { id: 'toothbrush', en: ['toothbrush'], ar: 'فرشاة أسنان', aisle: 'dental' },
  { id: 'mouthwash', en: ['mouthwash', 'mouth wash'], ar: 'غسول فم', aisle: 'dental' },
  { id: 'deodorant', en: ['deodorant', 'deo', 'antiperspirant'], ar: 'مزيل عرق', aisle: 'bath-body' },
  { id: 'perfume', en: ['perfume', 'eau de toilette', 'edt', 'eau de parfum', 'edp'], ar: 'عطر', aisle: 'fragrance' },
  { id: 'razor', en: ['razor', 'razors', 'shaving razor'], ar: 'شفرة حلاقة', aisle: 'shaving' },
  { id: 'shaving-foam', en: ['shaving foam', 'shaving gel', 'shaving cream'], ar: 'رغوة حلاقة', aisle: 'shaving' },
  { id: 'sanitary-pads', en: ['sanitary pads', 'sanitary napkins', 'sanitary towels'], ar: 'فوط صحية', aisle: 'feminine-care' },
  { id: 'diapers', en: ['diapers', 'diaper', 'nappies'], ar: 'حفاضات', aisle: 'baby-care' },
  { id: 'wet-wipes', en: ['wet wipes', 'baby wipes', 'wipes'], ar: 'مناديل مبللة', aisle: 'baby-care' },
  { id: 'baby-food', en: ['baby food'], ar: 'طعام أطفال', aisle: 'baby-feeding' },

  // --- pet ---------------------------------------------------------------------
  { id: 'cat-food', en: ['cat food'], ar: 'طعام قطط', aisle: 'pets' },
  { id: 'dog-food', en: ['dog food'], ar: 'طعام كلاب', aisle: 'pets' },
  { id: 'cat-litter', en: ['cat litter'], ar: 'رمل قطط', aisle: 'pets' },

  // --- general merchandise -----------------------------------------------------
  // A Saudi hypermarket flyer is ~a third non-food, and the measurement showed
  // it is exactly where the grocery vocabulary produces nothing. These are the
  // measured head nouns; anything not here simply yields no category.
  { id: 'refrigerator', en: ['refrigerator', 'fridge'], ar: 'ثلاجة', aisle: 'appliances' },
  { id: 'washing-machine', en: ['washing machine'], ar: 'غسالة', aisle: 'appliances' },
  { id: 'television', en: ['television', 'tv', 'led tv', 'smart tv'], ar: 'تلفزيون', aisle: 'electronics' },
  { id: 'air-fryer', en: ['air fryer'], ar: 'قلاية هوائية', aisle: 'appliances' },
  { id: 'blender', en: ['blender', 'mixer grinder'], ar: 'خلاط', aisle: 'appliances' },
  { id: 'kettle', en: ['kettle', 'electric kettle'], ar: 'غلاية', aisle: 'appliances' },
  { id: 'toaster', en: ['toaster', 'bread toaster'], ar: 'محمصة خبز', aisle: 'appliances' },
  { id: 'microwave', en: ['microwave', 'microwave oven'], ar: 'ميكروويف', aisle: 'appliances' },
  { id: 'iron', en: ['steam iron', 'dry iron'], ar: 'مكواة', aisle: 'appliances' },
  { id: 'vacuum-cleaner', en: ['vacuum cleaner'], ar: 'مكنسة كهربائية', aisle: 'appliances' },
  { id: 'hair-clipper', en: ['hair clipper', 'hair trimmer', 'trimmer', 'clipper'], ar: 'ماكينة حلاقة', aisle: 'appliances' },
  { id: 'shopping-trolley', en: ['shopping trolley', 'trolley'], ar: 'عربة تسوق', aisle: 'home-essentials' },
  { id: 'water-heater', en: ['water heater'], ar: 'سخان ماء', aisle: 'appliances' },
  { id: 'fan', en: ['stand fan', 'ceiling fan', 'table fan', 'box fan', 'pedestal fan'], ar: 'مروحة', aisle: 'appliances' },
  { id: 'cookware', en: ['cookware', 'cooking set', 'cookware set'], ar: 'أواني طهي', aisle: 'kitchen-dining' },
  { id: 'frying-pan', en: ['frying pan', 'fry pan'], ar: 'مقلاة', aisle: 'kitchen-dining' },
  { id: 'cooking-pot', en: ['cooking pot', 'casserole'], ar: 'قدر طهي', aisle: 'kitchen-dining' },
  { id: 'thermos', en: ['thermos', 'vacuum flask'], ar: 'ترمس', aisle: 'kitchen-dining' },
  { id: 'smart-watch', en: ['smart watch', 'smartwatch'], ar: 'ساعة ذكية', aisle: 'electronics' },
  { id: 'watch', en: ['wrist watch'], ar: 'ساعة يد', aisle: 'electronics' },
  { id: 'mobile-phone', en: ['mobile phone', 'smartphone'], ar: 'جوال', aisle: 'electronics' },
  { id: 'headphones', en: ['headphone', 'headphones', 'earphone', 'earphones', 'earbuds'], ar: 'سماعة', aisle: 'electronics' },
  { id: 'power-bank', en: ['power bank'], ar: 'بنك طاقة', aisle: 'electronics' },
  { id: 'charger', en: ['charger'], ar: 'شاحن', aisle: 'electronics' },
  { id: 'bath-towel', en: ['bath towel', 'towel', 'towels'], ar: 'منشفة', aisle: 'home-essentials' },
  { id: 'bed-sheet', en: ['bed sheet', 'bedsheet', 'bed sheets'], ar: 'شرشف', aisle: 'home-essentials' },
  { id: 'hand-bag', en: ['hand bag', 'handbag'], ar: 'حقيبة يد', aisle: 'home-essentials' },
  { id: 'jeans', en: ['jeans'], ar: 'جينز', aisle: 'fashion' },
  { id: 'shoes', en: ['shoes', 'shoe'], ar: 'حذاء', aisle: 'fashion' },
  { id: 'slippers', en: ['slipper', 'slippers'], ar: 'شبشب', aisle: 'fashion' },
  { id: 'tshirt', en: ['t shirt', 't shirts', 'tshirt', 'shirts'], ar: 'تيشيرت', aisle: 'fashion' },
  { id: 'colour-pencils', en: ['colour pencils', 'color pencils'], ar: 'أقلام تلوين', aisle: 'toys-stationery' },
  // "note book" only. Bare "notebook" is a LAPTOP as often as it is stationery
  // in a hypermarket flyer ("HP Victus Gaming Notebook Core i5" — found in the
  // 1000-row corpus, where only the head-final guard stopped it becoming دفتر).
  // Curation rule 1: prefer the phrase, drop the ambiguous bare word.
  { id: 'notebook', en: ['note book', 'exercise book'], ar: 'دفتر', aisle: 'toys-stationery' },
  { id: 'charcoal', en: ['charcoal', 'bbq charcoal'], ar: 'فحم', aisle: 'home-essentials' },

  // --- production expansion (2026-07-21 corpus) ------------------------------
  // Safe-only import from validation/shopping-lexicon-candidates-2026-07-21.tsv.
  // Ambiguous bare heads stay out of this table. When the production evidence
  // supports only a phrase, only that phrase is admitted (curation rule 1).
  { id: 'fruit-pulp', en: ['fruit pulp', 'mango pulp', 'guava pulp'], ar: 'لب فاكهة', aisle: 'frozen-fruits-veg' },
  { id: 'drink', en: ['drink', 'drinks', 'plant based drink'], ar: 'مشروب', aisle: 'soft-drinks' },
  { id: 'cocktail', en: ['cocktail'], ar: 'كوكتيل', aisle: 'soft-drinks' },
  { id: 'stain-remover', en: ['stain remover', 'stain odour remover'], ar: 'مزيل بقع', family: 'care', aisle: 'laundry' },
  { id: 'pool', en: ['pool', 'frame pool', 'ring pool'], ar: 'مسبح', aisle: 'outdoors-tools' },
  { id: 'powder', en: ['powder'], ar: 'مسحوق', aisle: 'other' },
  { id: 'grape-leaves', en: ['grape leaves', 'vine leaves'], ar: 'ورق عنب', aisle: 'canned-food' },
  { id: 'jar', en: ['jar', 'glass jar'], ar: 'مرطبان', aisle: 'kitchen-dining' },
  { id: 'flashlight', en: ['flash light', 'led flash light', 'ledflash light'], ar: 'مصباح يدوي', aisle: 'outdoors-tools' },
  { id: 'skin-cream', en: ['creme', 'body cream', 'day night cream'], ar: 'كريم عناية بالبشرة', family: 'care', aisle: 'skin-face' },
  { id: 'turkey-breast', en: ['turkey breast'], ar: 'صدر ديك رومي', family: 'meat', aisle: 'deli' },
  { id: 'cloth-dryer', en: ['cloth dryer'], ar: 'منشر ملابس', aisle: 'home-essentials' },
  { id: 'bottle', en: ['water bottle', 'vacuum bottle'], ar: 'قارورة', aisle: 'kitchen-dining' },
  { id: 'molasses', en: ['molasses', 'pomegranate molasses'], ar: 'دبس', aisle: 'sauces-spreads' },
  { id: 'plate', en: ['plate', 'dinner plate'], ar: 'طبق', aisle: 'kitchen-dining' },
  { id: 'strawberry-fruit', en: ['strawberry'], ar: 'فراولة', aisle: 'fruits' },
  { id: 'insect-killer', en: ['insect killer'], ar: 'مبيد حشرات', family: 'care', aisle: 'cleaning' },
  { id: 'chana-dal', en: ['chana dal'], ar: 'حمص مجروش', aisle: 'pulses-grains' },
  { id: 'makeup-set', en: ['makeup set', 'make up set', 'makeupset'], ar: 'طقم مكياج', aisle: 'cosmetics' },
  { id: 'wallet', en: ['wallet'], ar: 'محفظة', aisle: 'fashion' },
  { id: 'nail-polish', en: ['nail polish'], ar: 'طلاء أظافر', aisle: 'cosmetics' },
  { id: 'shampoo-color', en: ['shampoo color', 'shampoocolor'], ar: 'صبغة شعر بالشامبو', aisle: 'hair-care' },
  { id: 'window-ac', en: ['window ac'], ar: 'مكيف شباك', aisle: 'appliances' },
  { id: 'printer', en: ['printer'], ar: 'طابعة', aisle: 'electronics' },
  { id: 'pudding', en: ['pudding'], ar: 'بودينغ', family: 'dessert', aisle: 'desserts' },
  { id: 'paprika', en: ['paprika'], ar: 'بابريكا', aisle: 'spices' },
  { id: 'heavy-iron', en: ['heavy iron'], ar: 'مكواة', aisle: 'appliances' },
  { id: 'trackpants', en: ['trackpants', 'track pants'], ar: 'بنطال رياضي', aisle: 'fashion' },
  { id: 'backpack', en: ['backpack', 'school backpack'], ar: 'حقيبة ظهر', aisle: 'fashion' },
  { id: 'lantern', en: ['lantern', 'led lantern'], ar: 'فانوس', aisle: 'outdoors-tools' },
  { id: 'pressure-cooker', en: ['pressure cooker'], ar: 'قدر ضغط', aisle: 'kitchen-dining' },
  { id: 'eclair', en: ['eclair'], ar: 'إكلير', family: 'cake', aisle: 'cakes-pastry' },
  // Spaced appliance noun only. Bare "dishwasher" is also a modifier in
  // "dishwasher tablet/capsule" and must not turn detergent into an appliance.
  { id: 'dishwasher', en: ['dish washer'], ar: 'غسالة صحون', aisle: 'appliances' },
  { id: 'choco-spread', en: ['choco spread'], ar: 'شوكولاتة للدهن', family: 'chocolate', aisle: 'sauces-spreads' },
  { id: 'fig', en: ['fig', 'figs'], ar: 'تين', aisle: 'dates-dried-fruits' },
  { id: 'edamame', en: ['edamame'], ar: 'إدامامي', aisle: 'frozen-fruits-veg' },
  { id: 'jogger', en: ['jogger'], ar: 'بنطال رياضي', aisle: 'fashion' },
  { id: 'mushroom', en: ['mushroom', 'mushrooms'], ar: 'فطر', aisle: 'canned-food' },
  { id: 'multi-purpose-cleaner', en: ['multi purpose cleaner', 'multipurpose cleaner'], ar: 'منظف متعدد الاستخدامات', family: 'care', aisle: 'cleaning' },
  { id: 'cargo-pants', en: ['cargos', 'cargo pants'], ar: 'بنطال كارغو', aisle: 'fashion' },
  { id: 'hair-tonic', en: ['hair tonic'], ar: 'تونك شعر', aisle: 'hair-care' },
  { id: 'blanket', en: ['blanket'], ar: 'بطانية', aisle: 'home-essentials' },
  { id: 'lip-balm', en: ['lip balm', 'lips balm'], ar: 'مرطب شفاه', family: 'care', aisle: 'skin-face' },
  { id: 'lemon-substitute', en: ['lemon substitute'], ar: 'بديل الليمون', aisle: 'sauces-spreads' },
  { id: 'apricot', en: ['apricot', 'apricots'], ar: 'مشمش', aisle: 'dates-dried-fruits' },
  { id: 'tortilla', en: ['tortilla'], ar: 'خبز تورتيلا', family: 'bread', aisle: 'bread' },
  { id: 'table-cover', en: ['table cover'], ar: 'مفرش طاولة', aisle: 'home-essentials' },
  { id: 'papaya', en: ['papaya'], ar: 'بابايا', aisle: 'fruits' },
  { id: 'hair-straightener', en: ['hair straightener', 'straightener'], ar: 'مملس شعر', aisle: 'hair-care' },
  { id: 'dumpling', en: ['dumpling', 'dumplings'], ar: 'دامبلنغ', aisle: 'frozen-food' },
  { id: 'laundry-basket', en: ['laundry basket'], ar: 'سلة غسيل', aisle: 'home-essentials' },
  { id: 'snacks', en: ['snack', 'snacks'], ar: 'وجبات خفيفة', aisle: 'chips-snacks' },
  { id: 'pajama', en: ['pajama', 'pyjama'], ar: 'بيجامة', aisle: 'fashion' },
  { id: 'travel-bag', en: ['trolly bag', 'trolley bag'], ar: 'حقيبة سفر', aisle: 'travel' },
  { id: 'speaker', en: ['speaker', 'portable speaker'], ar: 'مكبر صوت', aisle: 'electronics' },
  { id: 'garment-steamer', en: ['garment steamer'], ar: 'مكواة بخار للملابس', aisle: 'appliances' },
  { id: 'cap', en: ['cap'], ar: 'قبعة', aisle: 'fashion' },
  { id: 'sweetener', en: ['sweetener'], ar: 'محلٍ', aisle: 'sugar' },
  { id: 'fresh-fruit', en: ['fresh fruit'], ar: 'فواكه طازجة', aisle: 'fruits' },
  { id: 'sea-bream', en: ['sea bream'], ar: 'دنيس', family: 'fish', aisle: 'fish' },
  { id: 'talc', en: ['talc'], ar: 'بودرة تلك', family: 'care', aisle: 'bath-body' },
  { id: 'tricycle', en: ['tricycle'], ar: 'دراجة ثلاثية', aisle: 'toys-stationery' },
  { id: 'stunt-car', en: ['stunt car'], ar: 'سيارة ألعاب', aisle: 'toys-stationery' },
  { id: 'quail', en: ['quail'], ar: 'سمان', family: 'chicken', aisle: 'chicken-poultry' },
  { id: 'bundt-form', en: ['bundt form'], ar: 'قالب كيك', aisle: 'kitchen-dining' },
  { id: 'coconut-food', en: ['coconut'], ar: 'جوز هند', aisle: 'flour-baking' },
  { id: 'molokhia', en: ['molokhia'], ar: 'ملوخية', aisle: 'frozen-fruits-veg' },
  { id: 'air-cooler', en: ['air cooler'], ar: 'مبرد هواء', aisle: 'appliances' },
  { id: 'beer', en: ['beer'], ar: 'مشروب شعير', aisle: 'malt-drinks' },
  { id: 'cellulose-sponge', en: ['cellulose sponge'], ar: 'إسفنجة تنظيف', aisle: 'cleaning' },
  { id: 'beauty-case', en: ['beauty case'], ar: 'حقيبة تجميل', aisle: 'cosmetics' },
  { id: 'belt', en: ['belt'], ar: 'حزام', aisle: 'fashion' },
  { id: 'hair-styler', en: ['hair styler'], ar: 'مصفف شعر', aisle: 'hair-care' },
  { id: 'melon', en: ['melon'], ar: 'شمام', aisle: 'fruits' },
  { id: 'hot-cups', en: ['hot cups'], ar: 'أكواب مشروبات ساخنة', aisle: 'disposables' },
  { id: 'comb', en: ['comb', 'pet comb'], ar: 'مشط', aisle: 'home-essentials' },
  { id: 'tawa', en: ['tawa', 'flat tawa'], ar: 'صاج', aisle: 'kitchen-dining' },
  { id: 'toilet-cleanser', en: ['bowl cleanser', 'toilet cleanser'], ar: 'منظف مرحاض', family: 'care', aisle: 'cleaning' },
  { id: 'mosquito-repellent', en: ['mosquito repellent', 'mosquitoes repellent'], ar: 'طارد بعوض', family: 'care', aisle: 'cleaning' },
  { id: 'shovel-loader', en: ['shovel loader'], ar: 'جرافة ألعاب', aisle: 'toys-stationery' },
  { id: 'toilet-ball', en: ['toilet ball'], ar: 'كرة تنظيف المرحاض', family: 'care', aisle: 'cleaning' },
  { id: 'marker', en: ['marker', 'colour marker', 'color marker'], ar: 'قلم تحديد', aisle: 'toys-stationery' },
  { id: 'koosa', en: ['koosa'], ar: 'كوسة', aisle: 'vegetables' },
  { id: 'swing', en: ['swing'], ar: 'أرجوحة', aisle: 'toys-stationery' },
  { id: 'dishwasher-capsule', en: ['dishwasher capsule'], ar: 'كبسولة غسالة صحون', family: 'care', aisle: 'dishwashing' },
  { id: 'dishwash', en: ['dishwash'], ar: 'سائل غسيل صحون', family: 'care', aisle: 'dishwashing' },
  { id: 'cologne-spray', en: ['cologne spray'], ar: 'بخاخ كولونيا', aisle: 'fragrance' },
  { id: 'jalabiya', en: ['jalabiya'], ar: 'جلابية', aisle: 'fashion' },
  { id: 'lotion', en: ['lotion'], ar: 'لوشن', family: 'care', aisle: 'skin-face' },
  { id: 'tartlets', en: ['tartlet', 'tartlets'], ar: 'تارتليت', family: 'cake', aisle: 'cakes-pastry' },
  { id: 'hash-browns', en: ['hash browns'], ar: 'هاش براون', aisle: 'frozen-fruits-veg' },

  // --- review pass: exact phrase-only admissions (2026-07-21 corpus) ---------
  // The corresponding bare heads remain absent. These rules exist only where
  // the complete observed phrase fixes one category deterministically.
  { id: 'dinner-set', en: ['dinner set'], ar: 'طقم سفرة', aisle: 'kitchen-dining' },
  { id: 'colour-set', en: ['colour set', 'color set'], ar: 'طقم تلوين', aisle: 'toys-stationery' },
  { id: 'building-block-castle-set', en: ['building block castle set'], ar: 'طقم مكعبات بناء قلعة', aisle: 'toys-stationery' },
  { id: 'cutting-board-knife-set', en: ['cutting board w knife'], ar: 'طقم لوح تقطيع وسكين', aisle: 'kitchen-dining' },
  { id: 'roll-on-deodorant', en: ['anti perspirant roll on'], ar: 'مزيل عرق رول أون', family: 'care', aisle: 'bath-body' },
  { id: 'beauty-cream-bar', en: ['beauty cream bar'], ar: 'صابون كريمي', family: 'care', aisle: 'bath-body' },
  { id: 'kabsa-mix', en: ['kabsa mix'], ar: 'خلطة كبسة', aisle: 'spices' },
  { id: 'whipping-topping-mix', en: ['vanilla whipping topping mix', 'whipped topping mix'], ar: 'خليط كريمة خفق', aisle: 'flour-baking' },
  { id: 'dumpling-mix', en: ['dumpling mix'], ar: 'خليط لقيمات', aisle: 'flour-baking' },
  { id: 'pencil-box', en: ['magnetic pencil box'], ar: 'مقلمة مغناطيسية', aisle: 'toys-stationery' },
  { id: 'dishwasher-tablet', en: ['dishwasher tablet'], ar: 'قرص غسالة صحون', family: 'care', aisle: 'dishwashing' },
  { id: 'cleaning-gel', en: ['multipurpose cleaning gel'], ar: 'جل تنظيف متعدد الاستخدامات', family: 'care', aisle: 'cleaning' },
  { id: 'feminine-pads', en: ['feminine pads'], ar: 'فوط صحية', aisle: 'feminine-care' },
  { id: 'cocoa-dip', en: ['dip with cocoa'], ar: 'صوص كاكاو', aisle: 'sauces-spreads' },
  { id: 'cocoa-spread', en: ['spread with cocoa'], ar: 'شوكولاتة للدهن', family: 'chocolate', aisle: 'sauces-spreads' },
  { id: 'mens-lip-care', en: ['lip care for men'], ar: 'مرطب شفاه للرجال', family: 'care', aisle: 'skin-face' },
  { id: 'mens-white-musk', en: ['white musk for men'], ar: 'مسك أبيض للرجال', aisle: 'fragrance' },
  { id: 'body-mist-charming', en: ['body mist charming'], ar: 'بخاخ معطر للجسم شيرمنغ', family: 'care', aisle: 'fragrance' },
  { id: 'spicy-broasted-mix', en: ['broasted powder reg spicy'], ar: 'خلطة بروستد حارة', aisle: 'spices' },
  { id: 'bukhoor-burner', en: ['bukhoor burner'], ar: 'مبخرة', aisle: 'home-essentials' },
  { id: 'gas-stove', en: ['gas stove'], ar: 'موقد غاز', aisle: 'appliances' },
  { id: 'baby-travel-pack', en: ['baby travel pack'], ar: 'طقم عناية أطفال للسفر', aisle: 'baby-care' },
  { id: 'badami-mango', en: ['mango sunehra pakistan badami'], ar: 'مانجو بدامي باكستاني', aisle: 'fruits' },
  { id: 'chair-metal-legs', en: ['chair metal legs'], ar: 'كرسي بأرجل معدنية', aisle: 'home-essentials' },
  { id: 'whole-green-moong', en: ['moong green whole'], ar: 'ماش أخضر كامل', aisle: 'pulses-grains' },
  { id: 'drill-grinder-set', en: ['drill grinder'], ar: 'طقم مثقاب وجلاخة', aisle: 'outdoors-tools' },
  { id: 'striped-midi-dress', en: ['midi dress stripe'], ar: 'فستان ميدي مخطط', aisle: 'fashion' },
  { id: 'baby-pants-daily-care', en: ['baby pants daily care'], ar: 'حفاضات أطفال يومية', aisle: 'diapers' },
  { id: 'laundry-hamper-rope-handle', en: ['hamper with rope handle'], ar: 'سلة غسيل بمقبض حبل', aisle: 'home-essentials' },
  { id: 'paneer-cubes', en: ['paneer cubes'], ar: 'مكعبات جبن بانير', family: 'cheese', aisle: 'cheese-cream' },
  { id: 'peru-pomegranate', en: ['anar peru'], ar: 'رمان بيرو', aisle: 'fruits' },
  { id: 'hair-clip', en: ['hair clip'], ar: 'مشبك شعر', aisle: 'hair-care' },
  { id: 'touch-control-cooker', en: ['cooker with touch control'], ar: 'موقد بتحكم باللمس', aisle: 'appliances' },
  { id: 'basmati-long-grain', en: ['basmati long grain'], ar: 'أرز بسمتي طويل الحبة', family: 'rice', aisle: 'rice' },
  { id: 'antibacterial-bodywash', en: ['bodywash anti bacterial'], ar: 'غسول جسم مضاد للبكتيريا', family: 'care', aisle: 'bath-body' },
  { id: 'star-eggplant', en: ['eggplant star'], ar: 'باذنجان ستار', aisle: 'vegetables' },
  { id: 'king-comforter', en: ['comforter king'], ar: 'لحاف مقاس كينغ', aisle: 'home-essentials' },
  { id: 'fillet-portions', en: ['fillet portions'], ar: 'قطع فيليه سمك', family: 'fish', aisle: 'fish' },
  { id: 'neem-daily-scrub', en: ['purifying neem daily scrub'], ar: 'مقشر نيم يومي', family: 'care', aisle: 'skin-face' },
  { id: 'mint-chocs', en: ['mint chocs'], ar: 'شوكولاتة بالنعناع', family: 'chocolate', aisle: 'chocolates-candies' },
  { id: 'coco-pops-cereal', en: ['coco pops', 'coco pops choco balls'], ar: 'حبوب إفطار بالشوكولاتة', family: 'cereal', aisle: 'cereals' },
  { id: 'penne-lisce', en: ['penne lisce'], ar: 'معكرونة بيني ملساء', family: 'pasta', aisle: 'pasta-noodles' },
  { id: 'seedless-vietnam-lemon', en: ['lemon vietnam seedless'], ar: 'ليمون فيتنامي بدون بذور', aisle: 'fruits' },
  { id: 'foul-medammes', en: ['fou medammes'], ar: 'فول مدمس', aisle: 'canned-food' },
  { id: 'split-ac-inverter', en: ['splitac inverter'], ar: 'مكيف سبليت إنفرتر', aisle: 'appliances' },
  { id: 'hybrid-kadai', en: ['kadai hybrid'], ar: 'مقلاة كاداي هجينة', aisle: 'kitchen-dining' },
  { id: 'maxi-pads-wings', en: ['maxi classic with wings'], ar: 'فوط صحية بأجنحة', aisle: 'feminine-care' },
  { id: 'plastic-spoon', en: ['plastic spoon'], ar: 'ملعقة بلاستيك', aisle: 'disposables' },
  { id: 'deep-clean-washing-powder', en: ['powder deep clean blue'], ar: 'مسحوق غسيل عميق التنظيف', family: 'care', aisle: 'laundry' },
];

// --- the descriptor vocabulary -------------------------------------------------
// Modifiers only. A descriptor is matched ONLY over tokens the category did not
// consume, so a word that is BOTH (chocolate, cream, corn) is safe: as the head
// noun it becomes the category, and only a leftover occurrence becomes a
// descriptor. Same curation rules as above.
const DESCRIPTOR_TERMS = [
  // flavours — rendered as one joined phrase by the Arabic Builder
  { id: 'vanilla', en: ['vanilla'], ar: 'فانيليا', role: 'flavor' },
  { id: 'chocolate-flavor', en: ['chocolate', 'choco', 'cocoa'], ar: 'شوكولاتة', role: 'flavor' },
  { id: 'strawberry', en: ['strawberry'], ar: 'فراولة', role: 'flavor' },
  { id: 'mango', en: ['mango'], ar: 'مانجو', role: 'flavor' },
  { id: 'banana-flavor', en: ['banana'], ar: 'موز', role: 'flavor' },
  { id: 'orange-flavor', en: ['orange'], ar: 'برتقال', role: 'flavor' },
  { id: 'lemon', en: ['lemon'], ar: 'ليمون', role: 'flavor' },
  { id: 'apple-flavor', en: ['apple'], ar: 'تفاح', role: 'flavor' },
  { id: 'caramel', en: ['caramel'], ar: 'كراميل', role: 'flavor' },
  { id: 'hazelnut', en: ['hazelnut'], ar: 'بندق', role: 'flavor' },
  { id: 'pistachio-flavor', en: ['pistachio'], ar: 'فستق', role: 'flavor' },
  { id: 'coconut', en: ['coconut'], ar: 'جوز الهند', role: 'flavor' },
  { id: 'mint', en: ['mint', 'menthol'], ar: 'نعناع', role: 'flavor' },
  { id: 'honey-flavor', en: ['honey'], ar: 'عسل', role: 'flavor' },
  { id: 'peanut', en: ['peanut'], ar: 'فول سوداني', role: 'flavor' },
  { id: 'berry', en: ['berry', 'berries'], ar: 'توت', role: 'flavor' },
  { id: 'cherry', en: ['cherry'], ar: 'كرز', role: 'flavor' },
  { id: 'peach', en: ['peach'], ar: 'خوخ', role: 'flavor' },
  { id: 'rose', en: ['rose'], ar: 'ورد', role: 'flavor' },
  { id: 'zaatar', en: ['zaatar', 'zatar'], ar: 'زعتر', role: 'flavor' },
  { id: 'cheese-flavor', en: ['cheese'], ar: 'جبن', role: 'flavor' },
  { id: 'beef-flavor', en: ['beef'], ar: 'لحم بقري', role: 'flavor' },
  { id: 'milk-flavor', en: ['milk'], ar: 'حليب', role: 'flavor' },
  // Ingredient twins of category words. Measured need: on the 1000-row corpus
  // "chicken" was the single most-dropped token inside BUILT names (21×) —
  // "Chicken Burger" resolved to برجر and silently lost what it is made of.
  // A food word that can head a product AND season one needs both entries.
  { id: 'chicken-ingredient', en: ['chicken'], ar: 'دجاج', role: 'flavor' },
  { id: 'cream-ingredient', en: ['cream'], ar: 'كريمة', role: 'flavor' },
  { id: 'butter-ingredient', en: ['butter'], ar: 'زبدة', role: 'flavor' },
  { id: 'corn-ingredient', en: ['corn'], ar: 'ذرة', role: 'flavor' },
  { id: 'olive-ingredient', en: ['olive', 'olives'], ar: 'زيتون', role: 'flavor' },
  { id: 'garlic-ingredient', en: ['garlic'], ar: 'ثوم', role: 'flavor' },

  // preparation
  { id: 'fresh', en: ['fresh'], ar: 'طازج', role: 'preparation' },
  { id: 'frozen', en: ['frozen'], ar: 'مجمد', role: 'preparation' },
  { id: 'chilled', en: ['chilled'], ar: 'مبرد', role: 'preparation' },
  { id: 'dried', en: ['dried', 'dry'], ar: 'مجفف', role: 'preparation' },
  { id: 'smoked', en: ['smoked'], ar: 'مدخن', role: 'preparation' },
  { id: 'roasted', en: ['roasted'], ar: 'محمص', role: 'preparation' },
  { id: 'grilled', en: ['grilled'], ar: 'مشوي', role: 'preparation' },
  { id: 'fried', en: ['fried'], ar: 'مقلي', role: 'preparation' },
  { id: 'boiled', en: ['boiled'], ar: 'مسلوق', role: 'preparation' },
  { id: 'steamed', en: ['steamed'], ar: 'مطهو بالبخار', role: 'preparation' },
  { id: 'breaded', en: ['breaded'], ar: 'مغطى بالبقسماط', role: 'preparation' },
  { id: 'canned', en: ['canned'], ar: 'معلب', role: 'preparation' },
  { id: 'salted', en: ['salted'], ar: 'مملح', role: 'preparation' },
  { id: 'marinated', en: ['marinated'], ar: 'متبل', role: 'preparation' },

  // form
  { id: 'minced', en: ['minced', 'ground'], ar: 'مفروم', role: 'form' },
  { id: 'shredded', en: ['shredded', 'grated'], ar: 'مبشور', role: 'form' },
  { id: 'sliced', en: ['sliced', 'slices'], ar: 'شرائح', role: 'form' },
  { id: 'diced', en: ['diced', 'cubes', 'cubed'], ar: 'مكعبات', role: 'form' },
  { id: 'peeled', en: ['peeled'], ar: 'مقشر', role: 'form' },
  { id: 'whole', en: ['whole'], ar: 'كامل', role: 'form' },
  { id: 'cut-up', en: ['cut up'], ar: 'مقطع', role: 'form' },
  { id: 'boneless', en: ['boneless'], ar: 'بدون عظم', role: 'form' },
  { id: 'bone-in', en: ['bone in', 'bone inn'], ar: 'بالعظم', role: 'form' },
  { id: 'skinless', en: ['skinless'], ar: 'بدون جلد', role: 'form' },
  { id: 'seedless', en: ['seedless'], ar: 'بدون بذور', role: 'form' },
  { id: 'powder-form', en: ['powder'], ar: 'بودرة', role: 'form' },
  { id: 'liquid-form', en: ['liquid'], ar: 'سائل', role: 'form' },
  { id: 'gel-form', en: ['gel'], ar: 'جل', role: 'form' },
  { id: 'spray-form', en: ['spray'], ar: 'بخاخ', role: 'form' },
  { id: 'roll-on', en: ['roll on'], ar: 'رول أون', role: 'form' },
  { id: 'stick-form', en: ['stick', 'sticks'], ar: 'أصابع', role: 'form' },
  { id: 'set-form', en: ['set'], ar: 'طقم', role: 'form' },

  // attribute
  { id: 'full-fat', en: ['full fat', 'full cream'], ar: 'كامل الدسم', role: 'attribute' },
  { id: 'low-fat', en: ['low fat', 'light fat', 'half fat'], ar: 'قليل الدسم', role: 'attribute' },
  { id: 'fat-free', en: ['fat free', 'skimmed', 'non fat'], ar: 'خالي الدسم', role: 'attribute' },
  { id: 'sugar-free', en: ['sugar free', 'no sugar', 'no added sugar'], ar: 'خالي السكر', role: 'attribute' },
  { id: 'organic', en: ['organic'], ar: 'عضوي', role: 'attribute' },
  { id: 'natural', en: ['natural'], ar: 'طبيعي', role: 'attribute' },
  { id: 'pure', en: ['pure'], ar: 'نقي', role: 'attribute' },
  { id: 'concentrated', en: ['concentrated', 'concentrate'], ar: 'مركز', role: 'attribute' },
  { id: 'instant', en: ['instant'], ar: 'سريع التحضير', role: 'attribute' },
  { id: 'ready-to-eat', en: ['ready to eat', 'ready meal'], ar: 'جاهز للأكل', role: 'attribute' },
  { id: 'plain', en: ['plain', 'original'], ar: 'سادة', role: 'attribute' },
  { id: 'regular', en: ['regular'], ar: 'عادي', role: 'attribute' },
  { id: 'light', en: ['light'], ar: 'خفيف', role: 'attribute' },
  { id: 'creamy', en: ['creamy'], ar: 'كريمي', role: 'attribute' },
  { id: 'smooth', en: ['smooth', 'soft'], ar: 'ناعم', role: 'attribute' },
  { id: 'crunchy', en: ['crunchy', 'crispy'], ar: 'مقرمش', role: 'attribute' },
  { id: 'unsalted', en: ['unsalted'], ar: 'غير مملح', role: 'attribute' },
  { id: 'mild', en: ['mild'], ar: 'خفيف الحدة', role: 'attribute' },
  { id: 'spicy', en: ['spicy', 'hot'], ar: 'حار', role: 'attribute' },
  { id: 'sweetened', en: ['sweetened'], ar: 'محلى', role: 'attribute' },
  { id: 'unsweetened', en: ['unsweetened'], ar: 'غير محلى', role: 'attribute' },
  { id: 'assorted', en: ['assorted', 'asstd', 'astd', 'mixed', 'variety'], ar: 'متنوع', role: 'attribute' },
  { id: 'scented', en: ['scented', 'perfumed'], ar: 'معطر', role: 'attribute' },
  { id: 'antibacterial', en: ['antibacterial', 'anti bacterial'], ar: 'مضاد للبكتيريا', role: 'attribute' },
  { id: 'moisturizing', en: ['moisturizing', 'moisturising'], ar: 'مرطب', role: 'attribute' },
  { id: 'whitening', en: ['whitening'], ar: 'مبيض', role: 'attribute' },
  { id: 'anti-dandruff', en: ['anti dandruff'], ar: 'ضد القشرة', role: 'attribute' },
  { id: 'sensitive', en: ['sensitive', 'for sensitive skin'], ar: 'للبشرة الحساسة', role: 'attribute' },
  { id: 'extra-virgin', en: ['extra virgin'], ar: 'بكر ممتاز', role: 'attribute' },
  { id: 'extra-long-grain', en: ['extra long grain'], ar: 'حبة طويلة جداً', role: 'attribute' },
  { id: 'long-grain', en: ['long grain'], ar: 'حبة طويلة', role: 'attribute' },
  { id: 'whole-grain', en: ['whole grain', 'wholemeal', 'whole wheat'], ar: 'حبوب كاملة', role: 'attribute' },
  { id: 'rechargeable', en: ['rechargeable'], ar: 'قابل للشحن', role: 'attribute' },
  { id: 'wireless', en: ['wireless'], ar: 'لاسلكي', role: 'attribute' },
  { id: 'portable', en: ['portable'], ar: 'محمول', role: 'attribute' },
  { id: 'smart', en: ['smart'], ar: 'ذكي', role: 'attribute' },
  { id: 'electric', en: ['electric', 'electrical'], ar: 'كهربائي', role: 'attribute' },
  { id: 'non-stick', en: ['non stick', 'nonstick'], ar: 'غير لاصق', role: 'attribute' },

  // grade
  { id: 'large', en: ['large'], ar: 'كبير', role: 'grade' },
  { id: 'medium-size', en: ['medium'], ar: 'متوسط', role: 'grade' },
  { id: 'small', en: ['small'], ar: 'صغير', role: 'grade' },
  { id: 'mini', en: ['mini'], ar: 'ميني', role: 'grade' },
  { id: 'jumbo', en: ['jumbo'], ar: 'جامبو', role: 'grade' },
  { id: 'maxi', en: ['maxi'], ar: 'ماكسي', role: 'grade' },
  { id: 'mega', en: ['mega'], ar: 'ميجا', role: 'grade' },
  { id: 'premium', en: ['premium'], ar: 'فاخر', role: 'grade' },
  { id: 'extra-long', en: ['extra long'], ar: 'طويل جداً', role: 'grade' },

  // material
  { id: 'stainless-steel', en: ['stainless steel', 'steel'], ar: 'ستانلس ستيل', role: 'material' },
  { id: 'ceramic', en: ['ceramic'], ar: 'سيراميك', role: 'material' },
  { id: 'granite', en: ['granite'], ar: 'جرانيت', role: 'material' },
  { id: 'glass-material', en: ['glass'], ar: 'زجاج', role: 'material' },
  { id: 'cotton', en: ['cotton'], ar: 'قطن', role: 'material' },
  { id: 'plastic', en: ['plastic'], ar: 'بلاستيك', role: 'material' },

  // colour
  { id: 'white', en: ['white'], ar: 'أبيض', role: 'color' },
  { id: 'black', en: ['black'], ar: 'أسود', role: 'color' },
  { id: 'red', en: ['red'], ar: 'أحمر', role: 'color' },
  { id: 'green', en: ['green'], ar: 'أخضر', role: 'color' },
  { id: 'blue', en: ['blue'], ar: 'أزرق', role: 'color' },
  { id: 'gold-color', en: ['gold', 'golden'], ar: 'ذهبي', role: 'color' },
  { id: 'silver', en: ['silver'], ar: 'فضي', role: 'color' },
  { id: 'dark', en: ['dark'], ar: 'داكن', role: 'color' },

  // audience
  { id: 'baby', en: ['baby', 'infant'], ar: 'للأطفال', role: 'audience' },
  { id: 'kids', en: ['kids', 'children'], ar: 'للأطفال', role: 'audience' },
  { id: 'men', en: ['men', 'mens', 'for men'], ar: 'رجالي', role: 'audience' },
  { id: 'women', en: ['women', 'womens', 'ladies', 'for women'], ar: 'نسائي', role: 'audience' },
];

// The model's own `package_type` field (Expanded JSON, §44) — a small closed
// vocabulary, so it gets a table rather than a parser.
const PACKAGE_TYPE_TERMS = [
  { id: 'bottle', en: ['bottle'], ar: 'قارورة' },
  { id: 'can', en: ['can', 'tin'], ar: 'علبة' },
  { id: 'jar', en: ['jar'], ar: 'برطمان' },
  { id: 'box', en: ['box', 'carton'], ar: 'علبة' },
  { id: 'pack', en: ['pack', 'packet'], ar: 'عبوة' },
  { id: 'bag', en: ['bag', 'sack', 'pouch'], ar: 'كيس' },
  { id: 'cup', en: ['cup', 'tub'], ar: 'كوب' },
  { id: 'sachet', en: ['sachet', 'stick pack'], ar: 'ظرف' },
  { id: 'roll', en: ['roll'], ar: 'لفة' },
  { id: 'tube', en: ['tube'], ar: 'أنبوب' },
  { id: 'set', en: ['set', 'kit'], ar: 'طقم' },
  { id: 'piece', en: ['piece', 'pc', 'pcs'], ar: 'قطعة' },
];

// --- neighbour vetoes ----------------------------------------------------------
// The precision guard of last resort, borrowed from browse/brands.js
// VETO_PREV/VETO_NEXT. A PHRASE entry is always the better tool — reach for a
// veto only when the ambiguous reading has no head noun of its own to name.
// Keyed by category id; values are normalized single tokens.
const VETO_NEXT = Object.freeze({
  // "water pump/filter/dispenser/tank" is a MACHINE whose purpose is water —
  // the same class of error HANDOFF §10 records for "ماء أروى" matching a food
  // steamer. `water heater` has its own entry and is matched before this.
  water: ['pump', 'filter', 'dispenser', 'tank', 'cooler', 'proof', 'heater', 'melon', 'bottle'],
  // "cream bar" is a soap bar; "cream cheese"/"cooking cream" are phrases.
  cream: ['bar', 'soap'],
  // "oil filter", "oil pump" — automotive, not edible.
  oil: ['filter', 'pump'],
  // "salt lamp", "salt shaker".
  salt: ['lamp', 'shaker', 'grinder'],
});
const VETO_PREV = Object.freeze({
  // "shaving cream"/"face cream" are phrases; this catches the open-ended tail
  // ("hand cream", "foot cream") that must not become dairy قشطة.
  cream: ['hand', 'foot', 'body', 'skin', 'shaving', 'sun', 'eye', 'night', 'day', 'bb'],
  // "bath soap" is fine (soap), but "soap dish"/"soap dispenser" is hardware —
  // covered by VETO_NEXT below via the dish/dispenser guard.
  soap: [],
  // "corn oil" is a phrase; "pop corn" must never read as the vegetable.
  'sweet-corn': ['pop'],
});

// --- stopwords -----------------------------------------------------------------
// English function words and flyer filler. They carry no product information,
// so leaving them in the residual would understate coverage ("Ice Cream Vanilla
// WITH Chocolate" is fully understood) and dropping them from the Arabic name
// loses nothing. Curated and short by design — a word only belongs here if its
// absence from the Arabic name is always correct.
export const SHOPPING_STOPWORDS = Object.freeze(new Set([
  'with', 'and', 'or', 'for', 'the', 'of', 'in', 'on', 'to', 'from', 'by', 'per',
  'item', 'items', 'each', 'new', 'free', 'offer', 'special', 'plus',
  // Flavour MARKERS, not flavours: the descriptor role already records that
  // "Beef Flavour" is a flavour, so the marker word itself adds nothing.
  'flavour', 'flavor', 'flavoured', 'flavored', 'flavours', 'flavors',
]));

// --- the fold ------------------------------------------------------------------
// The SAME normalizeText the matching mirror uses, so a lexicon key and a
// matching token are the same string for the same word. English input only in
// practice, but the fold is bilingual, which keeps the door open for reading
// Arabic attributes later without a second normalizer.
export function normalizeShoppingText(value) {
  return normalizeText(value);
}

function tokenize(value) {
  const normalized = normalizeShoppingText(value);
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

// Longest phrase in the tables, in tokens — the match window.
const MAX_PHRASE_TOKENS = 4;

function buildIndex(terms, kind) {
  const index = new Map(); // normalized phrase -> entry
  const collisions = [];
  const entries = [];
  for (const term of terms) {
    const entry = Object.freeze({ ...term, kind, phrases: Object.freeze(term.en.map(normalizeShoppingText)) });
    entries.push(entry);
    for (const phrase of entry.phrases) {
      if (!phrase) continue;
      const existing = index.get(phrase);
      if (existing === undefined) index.set(phrase, entry);
      else if (existing.id !== entry.id) collisions.push({ phrase, kind, kept: existing.id, dropped: entry.id });
    }
  }
  return { index, entries: Object.freeze(entries), collisions };
}

const categoryIndex = buildIndex(CATEGORY_TERMS, 'category');
const descriptorIndex = buildIndex(DESCRIPTOR_TERMS, 'descriptor');
const packageTypeIndex = buildIndex(PACKAGE_TYPE_TERMS, 'package_type');

export const SHOPPING_CATEGORIES = categoryIndex.entries;
export const SHOPPING_DESCRIPTORS = descriptorIndex.entries;
export const SHOPPING_PACKAGE_TYPES = packageTypeIndex.entries;

export const CATEGORY_BY_ID = new Map(SHOPPING_CATEGORIES.map((e) => [e.id, e]));
export const DESCRIPTOR_BY_ID = new Map(SHOPPING_DESCRIPTORS.map((e) => [e.id, e]));

// Two entries claiming one phrase would make resolution declaration-order
// dependent. Recorded, never swallowed — shopping.test.mjs asserts these stay
// empty, so a bad term fails the tests instead of shadowing another in
// production. Same contract as BRAND_ALIAS_COLLISIONS (§45).
export const SHOPPING_PHRASE_COLLISIONS = Object.freeze([
  ...categoryIndex.collisions,
  ...descriptorIndex.collisions,
  ...packageTypeIndex.collisions,
]);

function vetoed(entry, tokens, start, end) {
  const next = tokens[end];
  const prev = tokens[start - 1];
  if (next && (VETO_NEXT[entry.id] || []).includes(next)) return true;
  if (prev && (VETO_PREV[entry.id] || []).includes(prev)) return true;
  return false;
}

// Every non-overlapping match of an index over a token array, longest-first at
// each position. Returns spans so callers can tell which tokens were consumed.
function matchSpans(index, tokens, { skip = () => false } = {}) {
  const spans = [];
  let i = 0;
  while (i < tokens.length) {
    if (skip(i)) { i += 1; continue; }
    let matched = null;
    for (let width = Math.min(MAX_PHRASE_TOKENS, tokens.length - i); width >= 1; width -= 1) {
      const end = i + width;
      if (skip(end - 1)) continue;
      const entry = index.get(tokens.slice(i, end).join(' '));
      if (entry && !vetoed(entry, tokens, i, end)) { matched = { entry, start: i, end }; break; }
    }
    if (matched) { spans.push(matched); i = matched.end; } else i += 1;
  }
  return spans;
}

// --- category resolution -------------------------------------------------------
// THE HEAD-NOUN RULE: longest phrase wins; ties break RIGHTMOST.
//
// English retail names are head-final noun compounds, so the last noun is what
// the product IS: "Chocolate Milk" is milk, "Milk Chocolate" is chocolate, and
// both fall out of one rule. Longest-first is what makes "Ice Cream" beat
// "cream" and "Basmati Rice" beat "rice". Deterministic, no scoring, no model.
//
// `skipTokens` is how the caller removes brand and size tokens before the head
// noun is chosen — a brand called "Cream" must never become the category.
export function resolveCategory(englishName, { skipTokens = new Set() } = {}) {
  const tokens = tokenize(englishName);
  const spans = matchSpans(categoryIndex.index, tokens, { skip: (i) => skipTokens.has(i) });
  if (!spans.length) return null;
  const best = spans.reduce((a, b) => {
    const widthA = a.end - a.start;
    const widthB = b.end - b.start;
    if (widthB > widthA) return b;
    if (widthB < widthA) return a;
    return b.start > a.start ? b : a;
  });
  return {
    id: best.entry.id,
    en: best.entry.en[0],
    ar: best.entry.ar,
    family: best.entry.family ?? null,
    aisle: best.entry.aisle ?? null,
    matched_phrase: tokens.slice(best.start, best.end).join(' '),
    span: [best.start, best.end],
  };
}

// --- descriptor resolution -----------------------------------------------------
// Every descriptor phrase in the leftover tokens, in reading order, deduped by
// id (a name that says "Original ... Original" carries one descriptor).
export function resolveDescriptors(englishName, { skipTokens = new Set() } = {}) {
  const tokens = tokenize(englishName);
  const spans = matchSpans(descriptorIndex.index, tokens, { skip: (i) => skipTokens.has(i) });
  const seen = new Set();
  const out = [];
  for (const span of spans) {
    if (seen.has(span.entry.id)) continue;
    seen.add(span.entry.id);
    out.push({
      id: span.entry.id,
      role: span.entry.role,
      en: span.entry.en[0],
      ar: span.entry.ar,
      matched_phrase: tokens.slice(span.start, span.end).join(' '),
      span: [span.start, span.end],
    });
  }
  return out;
}

// The model's `package_type` string -> canonical bilingual package type, or
// null. Exact table lookup, never a guess.
export function resolvePackageType(value) {
  const key = normalizeShoppingText(value);
  const entry = key ? packageTypeIndex.index.get(key) : null;
  return entry ? { id: entry.id, en: entry.en[0], ar: entry.ar } : null;
}

export const SHOPPING_LEXICON_SIZE = Object.freeze({
  categories: SHOPPING_CATEGORIES.length,
  descriptors: SHOPPING_DESCRIPTORS.length,
  packageTypes: SHOPPING_PACKAGE_TYPES.length,
  categoryPhrases: categoryIndex.index.size,
  descriptorPhrases: descriptorIndex.index.size,
});
