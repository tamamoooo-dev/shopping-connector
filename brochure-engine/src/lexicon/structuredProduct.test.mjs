// Offline tests for the Structured Product + Arabic Builder (§47).
//
// Run: node src/lexicon/structuredProduct.test.mjs

import {
  PRODUCT_SOURCES,
  STRUCTURED_PRODUCT_VERSION,
  buildStructuredProduct,
  hasUsableEnglish,
} from './structuredProduct.js';
import { ARABIC_BUILD_STATUS, buildArabicName, joinFlavors } from './arabicBuilder.js';

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}
const arabic = (observation) => buildArabicName(buildStructuredProduct(observation)).name;

console.log('the brief\'s own two examples, end to end:');
{
  const s = buildStructuredProduct({ name_en: 'Arwa Bottled Water 330 ml', brand: 'Arwa', package_size: '330 ml' });
  const a = buildArabicName(s);
  check('category is bottled water', s.category.id === 'bottled-water' && s.category.ar === 'مياه معبأة');
  check('brand resolves to its Arabic name', s.brand.brand_id === 'arwa' && s.brand.display_ar === 'أروى');
  check('size renders in Arabic', s.size.display_ar === '330 مل');
  check('nothing is left unexplained', s.coverage === 1 && a.dropped.length === 0);
  check('the composed name reads as one Arabic phrase', a.name === 'مياه معبأة أروى 330 مل');
  check('the card lines split as the brief shows them',
    a.lines.category === 'مياه معبأة' && a.lines.brand === 'أروى' && a.lines.size === '330 مل');
}
{
  const s = buildStructuredProduct({ name_en: 'Baskin Ice Cream Vanilla with Chocolate', brand: 'Baskin' });
  const a = buildArabicName(s);
  check('category is ice cream, NOT the flavour word', s.category.id === 'ice-cream');
  check('both flavours are structured, in reading order',
    s.descriptors.filter((d) => d.role === 'flavor').map((d) => d.ar).join(',') === 'فانيليا,شوكولاتة');
  check('the flavour phrase joins with بـ as the brief specifies', a.lines.descriptors === 'فانيليا بالشوكولاتة');
  check('the composed name matches the brief', a.name === 'آيس كريم فانيليا بالشوكولاتة باسكن روبنز');
  check('"with" is a stopword, so it is not counted as lost', s.coverage === 1);
}

console.log('\nEnglish is the source of truth; Arabic OCR is only a fallback:');
{
  const s = buildStructuredProduct({ name_en: 'Almarai Halloumi Cheese 200g', name_ar: 'جبنة حلوم المراعي ٢٠٠ جم', brand: 'Almarai', package_size: '200g' });
  check('the source is english when a usable English name exists', s.source === PRODUCT_SOURCES.ENGLISH);
  check('the observed Arabic is carried, never consumed', s.observed.name_ar === 'جبنة حلوم المراعي ٢٠٠ جم');
  check('the built name comes from the English structure', arabic({ name_en: 'Almarai Halloumi Cheese 200g', brand: 'Almarai', package_size: '200g' }) === 'جبن حلوم المراعي 200 جم');
}
{
  const s = buildStructuredProduct({ name_en: null, name_ar: 'تمر برحي', brand: null });
  check('no usable English falls back', s.source === PRODUCT_SOURCES.ARABIC_FALLBACK);
  check('NO structure is invented from Arabic', s.category === null && s.descriptors.length === 0);
  check('the builder refuses rather than guessing',
    buildArabicName(s).status === ARABIC_BUILD_STATUS.NOT_ENGLISH && buildArabicName(s).name === null);
}
check('a name with no usable script at all is source none',
  buildStructuredProduct({ name_en: null, name_ar: null }).source === PRODUCT_SOURCES.NONE);
check('hasUsableEnglish matches the extraction contract (2 Latin letters)',
  hasUsableEnglish('Milk') && !hasUsableEnglish('A') && !hasUsableEnglish('١٢٣') && !hasUsableEnglish(null));

console.log('\nbrand and size tokens can never name the product:');
{
  const s = buildStructuredProduct({ name_en: 'Puck Cream Cheese 500g', brand: 'Puck', package_size: '500g' });
  check('a brand word is excluded from the head-noun search', s.category.id === 'cream-cheese');
  check('size tokens are excluded from coverage', !s.residual_en.includes('500g'));
}
check('a brand that IS a category word does not become the category',
  buildStructuredProduct({ name_en: 'Cream Fresh Chicken 1kg', brand: 'Cream', package_size: '1kg' }).category.id === 'chicken');

console.log('\nthe measured defects that shaped this layer:');
check('a model code is never read as a package count (NRF110N26S)',
  buildStructuredProduct({ name_en: 'Refrigerator NRF110N26S', brand: 'NIKAI' }).size === null);
check('an attribute already inside the category phrase is not repeated',
  arabic({ name_en: 'NAJJAR INSTANT COFFEE RED / GOLD 190G', brand: 'NAJJAR', package_size: '190G', attributes: ['INSTANT COFFEE', 'RED', 'GOLD'] })
    === 'قهوة سريعة التحضير أحمر ذهبي 190 جم');
check('attributes still contribute descriptors the name did not carry',
  buildStructuredProduct({ name_en: 'Zoflora Disinfectant Spray 800ml', brand: 'Zoflora', package_size: '800ml', attributes: ['Concentrated'] })
    .descriptors.some((d) => d.id === 'concentrated' && d.from === 'attributes'));

console.log('\nthe head-final guard (a modifier must never become the category):');
check('an unknown head noun with a known modifier before it refuses',
  buildStructuredProduct({ name_en: 'Nutri Milk Wheat Biscotti Sticks Bites' }).category === null);
check('two trailing unknowns is the refusal threshold',
  buildStructuredProduct({ name_en: 'Chocolate Alfa Beta' }).category === null);
check('ONE trailing unknown still builds — a variant word is not a head noun',
  buildStructuredProduct({ name_en: 'Indian Sella Rice Ponni' }).category.id === 'rice');
check('trailing DESCRIPTORS never trip the guard (they are understood, not unknown)',
  buildStructuredProduct({ name_en: 'Fresh Whole Chicken Cut Up Boneless Skinless' }).category.id === 'whole-chicken');
check('trailing stopwords never trip the guard',
  buildStructuredProduct({ name_en: 'Ice Cream with and for the' }).category.id === 'ice-cream');
check('a head-final name is unaffected',
  buildStructuredProduct({ name_en: 'Deligos Milk Wheat Rusk', brand: 'Deligos' }).category.id === 'rusk');
check('a refusal is recorded with its would-be category, so coverage work can tell it from a vocabulary miss',
  buildStructuredProduct({ name_en: 'Chocolate Alfa Beta' }).category_diagnostics.reason === 'head_final_guard'
  && buildStructuredProduct({ name_en: 'Chocolate Alfa Beta' }).category_diagnostics.candidate === 'chocolate');
check('a plain vocabulary miss is recorded as no_match',
  buildStructuredProduct({ name_en: 'Keqiwear KW86' }).category_diagnostics.reason === 'no_match');
check('a resolved category records no diagnostics',
  buildStructuredProduct({ name_en: 'Almarai Halloumi Cheese' }).category_diagnostics === null);

console.log('\nlossiness is by directive — dropped, not transliterated, and always reported:');
{
  const observation = { name_en: 'Mughal ROYAL DIAMOND STEAMED 1121 BASMATI RICE XXL EXTRA LONG GRAIN 5kg', brand: 'Mughal', package_size: '5kg' };
  const a = buildArabicName(buildStructuredProduct(observation));
  check('the name is clean Arabic with no Latin left in it', !/[A-Za-z]/.test(a.name));
  check('the head noun and the understood descriptors survive',
    a.name === 'أرز بسمتي مطهو بالبخار حبة طويلة جداً 5 كجم');
  check('everything dropped is listed', a.dropped.map((d) => d.token).includes('royal'));
  check('an unresolvable brand is dropped WITH a reason, never transliterated',
    a.dropped.some((d) => d.token === 'Mughal' && d.reason === 'brand_has_no_arabic_name'));
  check('coverage measures the real loss', buildStructuredProduct(observation).coverage < 1);
}

console.log('\nthe builder refuses when it cannot name the product:');
{
  const a = buildArabicName(buildStructuredProduct({ name_en: "Fine Baby Diaper5Maxi Jumbo Pk40's", brand: 'Fine Baby' }));
  check('no category means no built name', a.status === ARABIC_BUILD_STATUS.NO_CATEGORY && a.name === null);
  check('the loss is still reported so the miss is measurable', a.dropped.length > 0);
}
check('a brand-only name builds nothing', buildArabicName(buildStructuredProduct({ name_en: 'Pepsi Bottles', brand: 'Pepsi' })).name === null);

console.log('\nflavour joining:');
check('one flavour reads bare', joinFlavors(['فانيليا']) === 'فانيليا');
check('two join with بال', joinFlavors(['فانيليا', 'شوكولاتة']) === 'فانيليا بالشوكولاتة');
check('a term that already carries ال takes the bare بـ', joinFlavors(['فانيليا', 'الشوكولاتة']) === 'فانيليا بالشوكولاتة');
check('three or more join with و', joinFlavors(['فانيليا', 'شوكولاتة', 'فراولة']) === 'فانيليا والشوكولاتة والفراولة');
check('an empty list is null', joinFlavors([]) === null);

console.log('\ncomposition order is fixed (category → descriptors → brand → size):');
check('two products of the same kind read in the same shape',
  arabic({ name_en: 'Alsafi Greek Yoghurt', brand: 'Alsafi', package_size: '150g' }) === 'زبادي يوناني الصافي 150 جم'
  && arabic({ name_en: 'Almarai Greek Yoghurt', brand: 'Almarai', package_size: '160g' }) === 'زبادي يوناني المراعي 160 جم');
check('a preparation descriptor precedes a colour one',
  arabic({ name_en: 'Fresh Whole Chicken Cut Up 800 GM', brand: null, package_size: '800 GM' }) === 'دجاج كامل طازج مقطع 800 جم');

console.log('\npurity and contract:');
check('the version is stamped', buildStructuredProduct({ name_en: 'Milk 1L' }).version === STRUCTURED_PRODUCT_VERSION);
check('the record is frozen', Object.isFrozen(buildStructuredProduct({ name_en: 'Milk 1L' })));
check('same input, same output',
  JSON.stringify(buildStructuredProduct({ name_en: 'Almarai Halloumi Cheese 200g', brand: 'Almarai' }))
  === JSON.stringify(buildStructuredProduct({ name_en: 'Almarai Halloumi Cheese 200g', brand: 'Almarai' })));
check('an empty observation is safe', buildStructuredProduct().source === PRODUCT_SOURCES.NONE);
check('a null structured product is safe', buildArabicName(null).status === ARABIC_BUILD_STATUS.NOT_ENGLISH);
check('the stored-row field shape is accepted too (name/name_ar/size)',
  buildStructuredProduct({ name: 'Almarai Halloumi Cheese', name_ar: 'جبن', brand: 'Almarai', size: '200g' }).category.id === 'halloumi-cheese');

console.log(failures ? `\n${failures} FAILED` : '\nAll Structured Product tests passed.');
process.exit(failures ? 1 : 0);
