// registry/registry.test.mjs — offline, dependency-free tests for the Product
// Registry data model (Phase 1: REGISTRY-DESIGN.md §1 — model + schema only,
// no behavior changes). Run with:
//   node brochure-engine/src/registry/registry.test.mjs   (repo root)
//
// Guards the milestone's promises:
//  • product ids are opaque mints, never content-derived, and never collide
//    across many mints,
//  • the token profile round-trips through TEXT and decodes corrupt blobs to
//    an empty profile instead of throwing (a bad row must not kill a drain),
//  • profileFromRead implements §3's CREATE outcome ("profile = this read"),
//  • row constructors emit complete, schema-shaped rows and reject rows that
//    would violate the model's invariants (P5: no evidence, no product),
//  • the registry DDL in migrate-2026-07-registry.sql is IDENTICAL to
//    schema.sql's (the migration file promises byte-identical definitions —
//    drift between fresh installs and the live DB must be impossible).

import { readFileSync } from 'node:fs';
import {
  REGISTRY_ALGO_VERSION,
  PRODUCT_STATUS,
  PRODUCT_KIND,
  MATCH_BAND,
  PROFILE_TOKEN_CAP,
  mintProductId,
  decodeProfile,
  encodeProfile,
  profileFromRead,
  profileTokens,
  newProductRow,
  newSightingRow,
} from './model.js';

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}
function throws(fn) {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

// --- id minting ----------------------------------------------------------------
console.log('id minting:');
const id = mintProductId();
check('shape pr_<12 hex>', /^pr_[0-9a-f]{12}$/.test(id));
const many = new Set(Array.from({ length: 5000 }, () => mintProductId()));
check('5000 mints, zero collisions', many.size === 5000);

// --- token profile -------------------------------------------------------------
console.log('token profile:');
const prof = profileFromRead(['samyang', 'ramen', 'bowl'], '2026-W29');
check('profile = this read (§3 CREATE)', Object.keys(prof).length === 3 && prof.ramen.count === 1 && prof.ramen.week === '2026-W29');
const round = decodeProfile(encodeProfile(prof));
check('round-trips through TEXT', JSON.stringify(round) === JSON.stringify(prof));
check('profileTokens lists every token', profileTokens(prof).sort().join(',') === 'bowl,ramen,samyang');
check('corrupt JSON -> empty profile, no throw', JSON.stringify(decodeProfile('{nope')) === '{}');
check('array blob -> empty profile', JSON.stringify(decodeProfile('[1,2]')) === '{}');
check('junk entries dropped, valid kept', (() => {
  const d = decodeProfile('{"good":{"count":3,"week":"2026-W28"},"bad":{"count":0},"worse":"x"}');
  return Object.keys(d).join(',') === 'good' && d.good.count === 3;
})());
check('empty tokens -> empty profile', Object.keys(profileFromRead([], 'w')).length === 0);
check('profile cap constant matches §5.2 (~24)', PROFILE_TOKEN_CAP === 24);

// --- product row constructor ---------------------------------------------------
console.log('newProductRow:');
const row = newProductRow({
  tokens: ['halah', 'oil', 'pure', 'sunflower'],
  week: '2026-W29',
  date: '2026-07-18',
  store: 'othaim',
  displayName: 'Halah Pure Sunflower Oil',
  brandText: 'Halah',
  sizeUnit: 'ml',
  sizeTotal: 1500,
  sizePack: 2,
});
check('opaque minted id', /^pr_/.test(row.id));
check('starts active, unmerged, unflagged', row.status === PRODUCT_STATUS.ACTIVE && row.merged_into === null && row.review_flag === null);
check('defaults to kind=product', row.kind === PRODUCT_KIND.PRODUCT);
check('founding read is the profile', Object.keys(decodeProfile(row.token_profile)).length === 4);
check('evidence summary: 1 sighting, founding store', row.sightings === 1 && row.stores_seen === '["othaim"]');
check('first_seen == last_seen == founding date', row.first_seen === '2026-07-18' && row.last_seen === '2026-07-18');
check('stamped with resolver version', row.algo_version === REGISTRY_ALGO_VERSION);
check('assortment kind accepted (IDENTITY-V2 §3 gate 2)', newProductRow({ tokens: ['x', 'y'], date: 'd', kind: PRODUCT_KIND.ASSORTMENT }).kind === 'assortment');
check('no tokens -> throws (P5)', throws(() => newProductRow({ tokens: [], date: '2026-07-18' })));
check('no date -> throws', throws(() => newProductRow({ tokens: ['a'] })));
check('unknown kind -> throws', throws(() => newProductRow({ tokens: ['a'], date: 'd', kind: 'bundle' })));

// The row must bind 1:1 onto the products table columns — no extras, none missing.
const PRODUCT_COLS = [
  'id', 'status', 'merged_into', 'kind', 'display_name', 'display_name_ar',
  'display_corroboration', 'display_week',
  'brand_slug', 'brand_text', 'size_unit', 'size_total', 'size_pack',
  'family', 'category', 'token_profile', 'sightings', 'stores_seen',
  'first_seen', 'last_seen', 'review_flag', 'algo_version',
];
check('row keys == products columns', JSON.stringify(Object.keys(row)) === JSON.stringify(PRODUCT_COLS));
check('display provenance stamped with the founding read',
  newProductRow({ tokens: ['a', 'b'], date: 'd', week: '2026-07-15', displayName: 'X Y', displayCorroboration: 0.8 }).display_week === '2026-07-15');
check('no display name -> no display provenance',
  newProductRow({ tokens: ['a', 'b'], date: 'd', week: '2026-07-15', displayCorroboration: 0.8 }).display_corroboration === null);

// --- sighting row constructor --------------------------------------------------
console.log('newSightingRow:');
const s = newSightingRow({
  offerId: 'othaim:riyadh:d4d:123',
  productId: row.id,
  band: MATCH_BAND.AUTO,
  score: 0.91,
  corroboration: 0.8,
  store: 'othaim',
  region: 'riyadh',
  week: '2026-07-15',
  price: 12.5,
  oldPrice: 15.0,
});
check('complete sighting row', s.offer_id === 'othaim:riyadh:d4d:123' && s.product_id === row.id && s.match_band === 'auto' && s.price === 12.5);
check('stamped with resolver version (§6)', s.algo_version === REGISTRY_ALGO_VERSION);
check('resolved_at defaults to now', typeof s.resolved_at === 'string' && s.resolved_at.length > 10);
check('real strike-through price kept', s.old_price === 15.0);
check('old_price <= price dropped (offers gate)', newSightingRow({ offerId: 'o', productId: 'p', band: 'auto', store: 's', region: 'r', week: 'w', price: 10, oldPrice: 10 }).old_price === null);
check('old_price defaults to null', newSightingRow({ offerId: 'o', productId: 'p', band: 'auto', store: 's', region: 'r', week: 'w', price: 10 }).old_price === null);
const SIGHTING_COLS = [
  'offer_id', 'product_id', 'match_band', 'match_score', 'corroboration',
  'store', 'region', 'week', 'price', 'old_price', 'algo_version', 'resolved_at',
];
check('row keys == product_sightings columns', JSON.stringify(Object.keys(s)) === JSON.stringify(SIGHTING_COLS));
check('unknown band -> throws', throws(() => newSightingRow({ offerId: 'o', productId: 'p', band: 'maybe', store: 's', region: 'r', week: 'w', price: 1 })));
check('non-positive price -> throws', throws(() => newSightingRow({ offerId: 'o', productId: 'p', band: 'auto', store: 's', region: 'r', week: 'w', price: 0 })));
check('missing store -> throws', throws(() => newSightingRow({ offerId: 'o', productId: 'p', band: 'auto', region: 'r', week: 'w', price: 1 })));

// --- schema/migration consistency ----------------------------------------------
// The migration file promises its DDL is byte-identical to schema.sql's
// registry section. Compare every registry CREATE statement (tables + indexes)
// after stripping comments/whitespace, so the live DB and fresh installs can
// never diverge silently.
console.log('schema/migration consistency:');
const here = new URL('.', import.meta.url);
const schema = readFileSync(new URL('../../schema.sql', here), 'utf8');
const migration = readFileSync(new URL('../../migrate-2026-07-registry.sql', here), 'utf8');

function registryDdl(sql) {
  const stmts = sql
    .replace(/--[^\n]*/g, ' ') // strip comments
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return stmts
    .filter((s) => /\b(products|product_tokens|product_sightings)\b/.test(s))
    .sort();
}
const a = registryDdl(schema);
const b = registryDdl(migration);
check('registry DDL present in schema.sql (3 tables + 5 indexes)', a.length === 8);
check('migration DDL identical to schema.sql', JSON.stringify(a) === JSON.stringify(b));

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll registry model tests passed.');
