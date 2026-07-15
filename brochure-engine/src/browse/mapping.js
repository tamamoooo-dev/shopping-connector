// browse/mapping.js — PER-PROVIDER category mappings into the canonical Browse
// taxonomy (BROWSE-DESIGN.md §5, KB #1b). This is the ONLY place a provider's
// category vocabulary is known; everything above it (API, rails, frontend)
// speaks canonical aisle/department ids exclusively.
//
//   Provider category  ──(this file)──►  canonical aisle  ──►  department
//
// DISCIPLINE (same as matching.js CATEGORY_FAMILY): map a provider category to
// exactly ONE aisle, or leave it out. An unmapped/unknown/null category lands
// in the visible `other` aisle — nothing breaks, nothing hides, and the fix is
// one line here whenever convenient. Canonicalization happens at READ time (a
// pure in-memory lookup), so a mapping improvement applies retroactively to
// every stored offer on the next request.
//
// Adding a new offers source = adding one object here. Zero code changes.

import { AISLE_BY_ID, OTHER_AISLE } from './taxonomy.js';

// D4D's global taxonomy (the `offers.category` slug) → canonical aisle id.
// Complete over every slug observed in production as of 2026-07-15; a slug D4D
// adds later degrades visibly to `other` until mapped.
const D4D = {
  // fresh
  'fresh-fruits': 'fruits',
  'fresh-vegetables': 'vegetables',
  'fresh-chicken-poultry': 'chicken-poultry',
  'meat-fresh-chilled': 'meat',
  'fresh-fish': 'fish',
  'deli-speaclity-meats': 'deli',
  // dairy & eggs
  'milk-laban': 'milk-laban',
  'yogurt-labneh': 'yogurt-labneh',
  'cheese-creame': 'cheese-cream',
  'butter-margarine': 'butter-margarine',
  eggs: 'eggs',
  'powdered-condensed-milk': 'milk-powder',
  // beverages
  water: 'water',
  'juices-drinks': 'juices',
  'soft-drinks': 'soft-drinks',
  'malt-beverages': 'malt-drinks',
  'tea-coffee': 'tea-coffee',
  'powdered-drinks-syrups': 'drink-mixes',
  // pantry
  rice: 'rice',
  'pasta-noodles': 'pasta-noodles',
  'oil-ghee': 'oil-ghee',
  'flour-baking': 'flour-baking',
  'canned-packeted': 'canned-food',
  'sauces-spreads': 'sauces-spreads',
  'salts-spices-paste': 'spices',
  'pulses-beans-grains': 'pulses-grains',
  'sugar-sweetener': 'sugar',
  'ready-to-eat': 'ready-meals',
  // snacks & sweets
  'chocolates-candies': 'chocolates-candies',
  sweets: 'chocolates-candies',
  biscuits: 'biscuits',
  snacks: 'chips-snacks',
  'cereals-bars': 'cereals',
  'dried-fruits-dates': 'dates-dried-fruits',
  'pudding-desserts': 'desserts',
  'ice-ice-cream': 'ice-cream',
  // bakery
  'bread-buns': 'bread',
  'cakes-pastry': 'cakes-pastry',
  // frozen
  'frozen-chicken-poultry': 'frozen-poultry',
  'frozen-meat': 'frozen-meat',
  'frozen-fish': 'frozen-fish',
  'frozen-fruits-veg': 'frozen-fruits-veg',
  'other-frozen-food': 'frozen-food',
  // baby
  'baby-care': 'baby-care',
  'baby-diapers': 'diapers',
  'baby-feeding': 'baby-feeding',
  'baby-toys-accesories': 'baby-toys',
  // beauty & health
  'skin-face-care': 'skin-face',
  'hair-care': 'hair-care',
  'bath-body': 'bath-body',
  'dental-care': 'dental',
  fragrance: 'fragrance',
  'shaving-hair-removal': 'shaving',
  'feminine-hygiene': 'feminine-care',
  'health-care': 'health',
  cosmetics: 'cosmetics',
  // household
  laundry: 'laundry',
  cleaning: 'cleaning',
  dishwasher: 'dishwashing',
  'toilet-paper-tissue': 'tissues',
  'facial-tissue': 'tissues',
  'foils-cling': 'wraps-foils',
  disposables: 'disposables',
  'household-essentials': 'home-essentials',
  'insect-repellent': 'home-essentials',
  pets: 'pets',
  // home, electronics & more
  'kitchen-appliance': 'appliances',
  'small-appliances': 'appliances',
  'large-appliances': 'appliances',
  tv: 'electronics',
  mobiles: 'electronics',
  tabs: 'electronics',
  'computer-laptop': 'electronics',
  camera: 'electronics',
  'monitors-projectors': 'electronics',
  printer: 'electronics',
  gaming: 'electronics',
  'smart-watch': 'electronics',
  cookware: 'kitchen-dining',
  'dining-serving': 'kitchen-dining',
  'home-furnishing-decor': 'home-decor',
  furniture: 'home-decor',
  'home-fixtures-fittings': 'home-decor',
  lighting: 'home-decor',
  'men-clothing': 'fashion',
  'women-clothing': 'fashion',
  'kids-wear': 'fashion',
  footwear: 'fashion',
  'sports-wear': 'fashion',
  'accessories-fashion': 'fashion',
  accessories: 'fashion',
  'gifts-toys': 'toys-stationery',
  'school-stationary': 'toys-stationery',
  'outdoors-garden': 'outdoors-tools',
  'tools-hardware': 'outdoors-tools',
  luggage: 'travel',
};

// source id (offers.source) -> { providerCategory -> canonical aisle id }
export const PROVIDER_AISLES = { d4d: D4D };

// The canonical aisle of one offer row's (source, category) — `other` when the
// category is null, unknown, or the source has no mapping yet.
export function canonicalAisle(source, category) {
  const map = PROVIDER_AISLES[source];
  if (!map || !category) return OTHER_AISLE;
  return map[String(category).toLowerCase()] || OTHER_AISLE;
}

// Reverse map for SQL prefilters: canonical aisle ids -> the provider
// categories that feed them, per source: [{ source, categories: [...] }].
// The `other` aisle is special (it is "everything NOT mapped") — callers test
// for it with `includesOther` and use `mappedCategories` to build a NOT IN.
export function providerCategoriesFor(aisleIds) {
  const wanted = new Set(aisleIds);
  const out = [];
  for (const [source, map] of Object.entries(PROVIDER_AISLES)) {
    const categories = Object.keys(map).filter((cat) => wanted.has(map[cat]));
    if (categories.length) out.push({ source, categories });
  }
  return out;
}

// Every provider category a source maps (the complement defines `other`).
export function mappedCategories(source) {
  return Object.keys(PROVIDER_AISLES[source] || {});
}

// Startup sanity: a mapping that points at a non-existent aisle is a
// programming error, not data drift — fail loudly at module load (tests catch
// it long before deploy).
for (const [source, map] of Object.entries(PROVIDER_AISLES)) {
  for (const [cat, aisle] of Object.entries(map)) {
    if (!AISLE_BY_ID.has(aisle)) {
      throw new Error(`browse mapping: ${source}:${cat} -> unknown aisle '${aisle}'`);
    }
  }
}
