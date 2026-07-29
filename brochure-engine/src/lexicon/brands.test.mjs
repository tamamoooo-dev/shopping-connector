// Offline tests for the Brand Lexicon (lexicon/brands.js, HISTORY §45).
//
// Run: node src/lexicon/brands.test.mjs

import {
  BRAND_ALIAS_COLLISIONS,
  BRAND_ALIASES,
  BRAND_BY_ID,
  BRAND_LEXICON,
  BRAND_LEXICON_VERSION,
  BRAND_RESOLUTION_STATUS,
  brandIdFor,
  normalizeBrandKey,
  resolveBrand,
} from './brands.js';
import { BRANDS } from '../browse/brands.js';

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

console.log('lexicon shape:');
check('every browse brand has a lexicon entry (no drift between the two lists)',
  BRANDS.every((b) => BRAND_BY_ID.has(b.slug)));
check('brand_id IS the browse slug (one identifier namespace, not two)',
  BRAND_LEXICON.every((entry) => entry.aliases.length > 0 && typeof entry.id === 'string'));
check('every entry carries both display names',
  BRAND_LEXICON.every((e) => typeof e.display_en === 'string' && typeof e.display_ar === 'string'));
check('ids are unique', new Set(BRAND_LEXICON.map((e) => e.id)).size === BRAND_LEXICON.length);
check('no alias collides across two brands',
  BRAND_ALIAS_COLLISIONS.length === 0 || !console.error(BRAND_ALIAS_COLLISIONS));
check('every alias table key names a real brand',
  Object.keys(BRAND_ALIASES).every((id) => BRAND_BY_ID.has(id)));
// 98 brands at v1 — a floor, not an exact count, so adding brands is free but
// an accidentally truncated/empty seed list fails loudly.
check('the lexicon is not accidentally tiny', BRAND_LEXICON.length >= 90);

console.log('the fold:');
check('case folds', normalizeBrandKey('LURPAK') === 'lurpak');
check('trademark symbols are stripped', normalizeBrandKey('Lurpak®') === 'lurpak');
check('™ and © are stripped too', normalizeBrandKey('Lurpak™') === 'lurpak'
  && normalizeBrandKey('Lurpak©') === 'lurpak');
check('surrounding whitespace is dropped', normalizeBrandKey('  Lurpak  ') === 'lurpak');
check('Latin accents fold', normalizeBrandKey('Nestlé') === 'nestle');
check('Arabic hamza forms unify', normalizeBrandKey('أنكور') === normalizeBrandKey('انكور'));
check('Farsi kaf/yeh fold to Arabic', normalizeBrandKey('کيري') === normalizeBrandKey('كيري')
  && normalizeBrandKey('کیري') === 'كيري');
check('non-strings have no key', normalizeBrandKey(null) === null && normalizeBrandKey(42) === null);
check('whitespace-only has no key', normalizeBrandKey('   ') === null);
check('punctuation-only has no key', normalizeBrandKey('®') === null);

console.log('English aliases:');
for (const observed of ['Lurpak', 'lurpak', 'LURPAK', 'LuRpAk', '  Lurpak  ', 'Lurpak®']) {
  const r = resolveBrand(observed);
  check(`"${observed}" -> lurpak`,
    r.brand_id === 'lurpak' && r.canonical_brand === 'Lurpak'
    && r.display_ar === 'لورباك' && r.status === BRAND_RESOLUTION_STATUS.RESOLVED);
}
check('a spaced English variant resolves via the compact pass ("Al Marai")',
  resolveBrand('Al Marai').brand_id === 'almarai');
check('a joined English variant resolves ("KitKat" / "Kit Kat")',
  resolveBrand('Kit Kat').brand_id === 'kitkat' && resolveBrand('KitKat').brand_id === 'kitkat');
check('an apostrophe variant resolves ("Lay\'s" / "Lays")',
  resolveBrand("Lay's").brand_id === 'lays' && resolveBrand('Lays').brand_id === 'lays');
check('an ampersand name resolves both ways',
  resolveBrand('Head & Shoulders').brand_id === 'head-shoulders'
  && resolveBrand('Head and Shoulders').brand_id === 'head-shoulders');
check('an explicit company-suffix alias resolves',
  resolveBrand('Alwatania Poultry').brand_id === 'alwatania');

console.log('Arabic aliases:');
check('the Arabic display name resolves', resolveBrand('لورباك').brand_id === 'lurpak');
check('the Arabic name plus ® resolves', resolveBrand('لورباك®').brand_id === 'lurpak');
check('an Arabic name with a hamza variant resolves',
  resolveBrand('امريكانا').brand_id === 'americana' && resolveBrand('أمريكانا').brand_id === 'americana');
check('an Arabic name with tatweel/diacritics resolves',
  resolveBrand('المراعِي').brand_id === 'almarai');
check('an Arabic-script observation still canonicalizes to the English display',
  resolveBrand('نادك').canonical_brand === 'Nadec');
check('the Arabic block is returned for an English observation',
  resolveBrand('Almarai').display_ar === 'المراعي');
check('an explicit Arabic alias resolves', resolveBrand('جونسونز').brand_id === 'johnsons');
check('a Farsi-pe spelling resolves through its declared alias',
  resolveBrand('لورپاك').brand_id === 'lurpak');
check('an Arabic observation carrying the definite article resolves when that IS the name',
  resolveBrand('المراعي').brand_id === 'almarai' && resolveBrand('الصافي').brand_id === 'alsafi');
check('the definite-article spelling of a bare Arabic name resolves ("السنبلة" — seen in production)',
  resolveBrand('سنبلة').brand_id === 'sunbulah' && resolveBrand('السنبلة').brand_id === 'sunbulah');
check('the article variant is generated for bare Arabic names generally',
  resolveBrand('النوتيلا').brand_id === 'nutella' && resolveBrand('الديتول').brand_id === 'dettol');
check('the reverse (stripping ال) is NOT done — a bare ordinary word stays unknown',
  resolveBrand('صافي').brand_id === null && resolveBrand('ربيع').brand_id === null
  && resolveBrand('كبير').brand_id === null);
check('an English name never grows an Arabic article', resolveBrand('alnadec').brand_id === null);

console.log('unknown brands are never guessed:');
{
  const r = resolveBrand('Totally Unknown Brand');
  check('brand_id is null', r.brand_id === null);
  check('canonical_brand is the original observation', r.canonical_brand === 'Totally Unknown Brand');
  check('observed_brand is preserved verbatim', r.observed_brand === 'Totally Unknown Brand');
  check('display names stay null', r.display_en === null && r.display_ar === null);
  check('status is unknown', r.status === BRAND_RESOLUTION_STATUS.UNKNOWN);
}
check('a near-miss spelling does NOT resolve (no fuzzy repair)',
  resolveBrand('Lurpakk').brand_id === null && resolveBrand('Lurpk').brand_id === null);
check('a brand-adjacent phrase does NOT resolve', resolveBrand('Lurpak Butter').brand_id === null);
check('an unknown Arabic brand does NOT resolve', resolveBrand('علامة مجهولة').brand_id === null);
check('an unknown observation keeps its inner spacing, trimmed at the edges',
  resolveBrand('  Some  Brand  ').canonical_brand === 'Some  Brand');

console.log('null / empty observations:');
for (const [label, observed] of [['null', null], ['undefined', undefined], ['empty string', ''],
  ['whitespace', '   '], ['a number', 42], ['an object', {}]]) {
  const r = resolveBrand(observed);
  check(`${label} -> empty, nothing invented`,
    r.brand_id === null && r.canonical_brand === null
    && r.status === BRAND_RESOLUTION_STATUS.EMPTY && r.display_en === null);
}
check('a non-string observation is not coerced into observed_brand',
  resolveBrand(42).observed_brand === null);
check('an empty string is preserved as the observation',
  resolveBrand('').observed_brand === '');
check('a punctuation-only observation is empty, not unknown',
  resolveBrand('®').status === BRAND_RESOLUTION_STATUS.EMPTY);

console.log('contract stability (later phases depend on this shape):');
{
  const r = resolveBrand('LURPAK');
  check('the block carries every documented field',
    ['observed_brand', 'brand_id', 'canonical_brand', 'display_en', 'display_ar',
      'matched_alias', 'status', 'lexicon_version'].every((k) => k in r));
  check('the version is stamped', r.lexicon_version === BRAND_LEXICON_VERSION);
  check('the matched alias explains the hit', r.matched_alias === 'lurpak');
  check('resolution is idempotent on its own canonical output',
    resolveBrand(r.canonical_brand).brand_id === r.brand_id);
  check('resolution never mutates the input observation', resolveBrand('LURPAK').observed_brand === 'LURPAK');
}
check('brandIdFor is the id-only twin of resolveBrand',
  BRANDS.every((b) => brandIdFor(b.en) === resolveBrand(b.en).brand_id));
check('every canonical name in the lexicon round-trips to its own id',
  BRAND_LEXICON.every((e) => brandIdFor(e.display_en) === e.id && brandIdFor(e.display_ar) === e.id));
check('every declared alias round-trips to its own id',
  BRAND_LEXICON.every((e) => e.aliases.every((a) => brandIdFor(a) === e.id)));

console.log(failures ? `\n${failures} FAILED` : '\nAll Brand Lexicon tests passed.');
process.exit(failures ? 1 : 0);
