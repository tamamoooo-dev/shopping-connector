// browse/browse.test.mjs — offline tests for the Browse pillar's pure modules:
// canonical taxonomy integrity, provider-mapping discipline, deal scoring and
// badges (BROWSE-DESIGN.md §5, §7.5). Run: node src/browse/browse.test.mjs

import assert from 'node:assert/strict';
import {
  DEPARTMENTS,
  AISLES,
  AISLE_BY_ID,
  DEPARTMENT_BY_ID,
  OTHER_AISLE,
  OTHER_DEPT,
  aislesOf,
} from './taxonomy.js';
import {
  PROVIDER_AISLES,
  canonicalAisle,
  providerCategoriesFor,
  mappedCategories,
  FRESH_TO_FROZEN,
  isFrozenMarked,
  refineAisle,
} from './mapping.js';
import {
  dealSignals,
  scoreDeal,
  offerBadges,
  exceptionalDeal,
  compareDeals,
  EXCEPTIONAL_MIN,
} from './deals.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    process.exitCode = 1;
  }
}

const TODAY = '2026-07-15';

/* --- taxonomy integrity ----------------------------------------------------- */

test('department ids are unique', () => {
  assert.equal(new Set(DEPARTMENTS.map((d) => d.id)).size, DEPARTMENTS.length);
});

test('aisle ids are unique', () => {
  assert.equal(new Set(AISLES.map((a) => a.id)).size, AISLES.length);
});

test('every aisle belongs to a real department', () => {
  for (const a of AISLES) {
    assert.ok(DEPARTMENT_BY_ID.has(a.dept), `aisle ${a.id} -> unknown dept ${a.dept}`);
  }
});

test('every department and aisle is bilingual', () => {
  for (const d of DEPARTMENTS) assert.ok(d.en && d.ar, `department ${d.id}`);
  for (const a of AISLES) assert.ok(a.en && a.ar, `aisle ${a.id}`);
});

test('the other/more landing zone exists', () => {
  assert.ok(AISLE_BY_ID.has(OTHER_AISLE));
  assert.equal(AISLE_BY_ID.get(OTHER_AISLE).dept, OTHER_DEPT);
});

test('aislesOf returns a department slice in order', () => {
  const fresh = aislesOf('fresh');
  assert.ok(fresh.length >= 5);
  assert.ok(fresh.every((a) => a.dept === 'fresh'));
});

/* --- provider mapping discipline ---------------------------------------------- */

test('every mapping target is a real aisle (all sources)', () => {
  for (const [source, map] of Object.entries(PROVIDER_AISLES)) {
    for (const [cat, aisle] of Object.entries(map)) {
      assert.ok(AISLE_BY_ID.has(aisle), `${source}:${cat} -> ${aisle}`);
    }
  }
});

test('no provider category maps to the other aisle (other is DERIVED, never assigned)', () => {
  for (const map of Object.values(PROVIDER_AISLES)) {
    for (const aisle of Object.values(map)) assert.notEqual(aisle, OTHER_AISLE);
  }
});

test('canonicalAisle: known d4d slugs land on their aisle', () => {
  assert.equal(canonicalAisle('d4d', 'cheese-creame'), 'cheese-cream');
  assert.equal(canonicalAisle('d4d', 'fresh-chicken-poultry'), 'chicken-poultry');
  assert.equal(canonicalAisle('d4d', 'toilet-paper-tissue'), 'tissues');
  assert.equal(canonicalAisle('d4d', 'facial-tissue'), 'tissues'); // many->one is fine
});

test('canonicalAisle: unknown/null/foreign-source degrade to other, never throw', () => {
  assert.equal(canonicalAisle('d4d', 'brand-new-d4d-slug'), OTHER_AISLE);
  assert.equal(canonicalAisle('d4d', null), OTHER_AISLE);
  assert.equal(canonicalAisle('someFutureSource', 'cheese-creame'), OTHER_AISLE);
});

test('providerCategoriesFor inverts the mapping', () => {
  const inv = providerCategoriesFor(['tissues']);
  assert.equal(inv.length, 1);
  assert.equal(inv[0].source, 'd4d');
  assert.deepEqual(inv[0].categories.sort(), ['facial-tissue', 'toilet-paper-tissue']);
});

test('providerCategoriesFor of an unfed aisle is empty', () => {
  assert.deepEqual(providerCategoriesFor(['no-such-aisle']), []);
});

/* --- fresh -> frozen refinement ------------------------------------------------- */

test('frozen refinement pairs name real aisles on both sides', () => {
  for (const [freshA, frozenA] of Object.entries(FRESH_TO_FROZEN)) {
    assert.equal(AISLE_BY_ID.get(freshA).dept, 'fresh');
    assert.equal(AISLE_BY_ID.get(frozenA).dept, 'frozen');
  }
});

test('isFrozenMarked: مجمد (any form) and frozen, either language field', () => {
  assert.ok(isFrozenMarked('Frozen Chicken 1kg', null));
  assert.ok(isFrozenMarked(null, 'دجاج مجمد ١١٠٠ جرام'));
  assert.ok(isFrozenMarked(null, 'قطع دجاج مجمدة'));
  assert.ok(!isFrozenMarked('Fresh Chicken 1kg', 'دجاج طازج'));
});

test('refineAisle: frozen-marked fresh rows move to the counterpart, others stay', () => {
  const frozenRow = { name: 'Doux French Griller frozen chicken', name_ar: null };
  assert.equal(refineAisle('chicken-poultry', frozenRow), 'frozen-poultry');
  assert.equal(refineAisle('fish', { name: null, name_ar: 'روبيان مجمد' }), 'frozen-fish');
  assert.equal(refineAisle('chicken-poultry', { name: 'Fresh chicken', name_ar: null }), 'chicken-poultry');
  // No pair -> never moves, even with the marker (frozen yogurt stays dairy).
  assert.equal(refineAisle('yogurt-labneh', frozenRow), 'yogurt-labneh');
});

test('mappedCategories covers every production d4d slug (2026-07-15 snapshot)', () => {
  // The full distinct-category list observed in the production offers table.
  // A NEW slug D4D invents later is allowed to be unmapped (it degrades to
  // `other` visibly) — but the known world must stay fully covered.
  const production = [
    'accessories', 'accessories-fashion', 'baby-care', 'baby-diapers', 'baby-feeding',
    'baby-toys-accesories', 'bath-body', 'biscuits', 'bread-buns', 'butter-margarine',
    'cakes-pastry', 'camera', 'canned-packeted', 'cereals-bars', 'cheese-creame',
    'chocolates-candies', 'cleaning', 'computer-laptop', 'cookware', 'cosmetics',
    'deli-speaclity-meats', 'dental-care', 'dining-serving', 'dishwasher', 'disposables',
    'dried-fruits-dates', 'eggs', 'facial-tissue', 'feminine-hygiene', 'flour-baking',
    'foils-cling', 'footwear', 'fragrance', 'fresh-chicken-poultry', 'fresh-fish',
    'fresh-fruits', 'fresh-vegetables', 'frozen-chicken-poultry', 'frozen-fish',
    'frozen-fruits-veg', 'frozen-meat', 'furniture', 'gaming', 'gifts-toys', 'hair-care',
    'health-care', 'home-fixtures-fittings', 'home-furnishing-decor', 'household-essentials',
    'ice-ice-cream', 'insect-repellent', 'juices-drinks', 'kids-wear', 'kitchen-appliance',
    'large-appliances', 'laundry', 'lighting', 'luggage', 'malt-beverages',
    'meat-fresh-chilled', 'men-clothing', 'milk-laban', 'mobiles', 'monitors-projectors',
    'oil-ghee', 'other-frozen-food', 'outdoors-garden', 'pasta-noodles', 'pets',
    'powdered-condensed-milk', 'powdered-drinks-syrups', 'printer', 'pudding-desserts',
    'pulses-beans-grains', 'ready-to-eat', 'rice', 'salts-spices-paste', 'sauces-spreads',
    'school-stationary', 'shaving-hair-removal', 'skin-face-care', 'small-appliances',
    'smart-watch', 'snacks', 'soft-drinks', 'sports-wear', 'sugar-sweetener', 'sweets',
    'tabs', 'tea-coffee', 'toilet-paper-tissue', 'tools-hardware', 'tv', 'water',
    'women-clothing', 'yogurt-labneh',
  ];
  const mapped = new Set(mappedCategories('d4d'));
  const missing = production.filter((slug) => !mapped.has(slug));
  assert.deepEqual(missing, [], `unmapped production slugs: ${missing.join(', ')}`);
});

/* --- deal scoring (§7.5 — the documentation table IS this behaviour) ------------- */

const base = {
  price: 10, old_price: null, name: 'Almarai Milk 2L', name_ar: null,
  valid_to: '2026-07-20', weeks_seen: null, first_seen: null,
  min_price: null, max_price: null, points: null,
};

test('a verified lowest-ever qualifies on its own (+50)', () => {
  const row = { ...base, weeks_seen: 6, first_seen: '2026-05-01', min_price: 10, max_price: 14, points: 2 };
  const deal = exceptionalDeal(row, TODAY);
  assert.ok(deal && deal.score >= EXCEPTIONAL_MIN);
  assert.ok(dealSignals(row, TODAY).lowestEver);
});

test('an advertised 45% drop ALONE never qualifies (marketing is capped at +30)', () => {
  const row = { ...base, price: 11, old_price: 20 };
  assert.equal(exceptionalDeal(row, TODAY), null);
  assert.equal(scoreDeal(dealSignals(row, TODAY)), 30);
});

test('a deep drop corroborated by rarity qualifies (30+20)', () => {
  // Known for 12 weeks, on offer in only 2 of them, now 40% off.
  const row = {
    ...base, price: 12, old_price: 20, weeks_seen: 2, first_seen: '2026-04-20',
    min_price: 11, max_price: 12, points: 2,
  };
  const s = dealSignals(row, TODAY);
  assert.ok(s.rare, 'rare should fire');
  assert.ok(!s.lowestEver, 'not at its low (11 < 12)');
  const deal = exceptionalDeal(row, TODAY);
  assert.ok(deal && deal.score === 50);
});

test('single-price history is NOT lowest-ever (no signal in a flat line)', () => {
  const row = { ...base, weeks_seen: 6, first_seen: '2026-05-01', min_price: 10, max_price: 10, points: 1 };
  assert.ok(!dealSignals(row, TODAY).lowestEver);
});

test('returnLow needs the price to have LEFT the low and come back (points ≥ 3)', () => {
  const back = { ...base, weeks_seen: 8, first_seen: '2026-04-01', min_price: 10, max_price: 13, points: 3 };
  const firstTime = { ...back, points: 2 };
  assert.ok(dealSignals(back, TODAY).returnLow);
  assert.ok(!dealSignals(firstTime, TODAY).returnLow);
});

test('multibuy: 1+1 and Arabic مجانا fire; bare English "free" does not', () => {
  assert.ok(dealSignals({ ...base, name: 'Shampoo 1+1' }, TODAY).multibuy);
  assert.ok(dealSignals({ ...base, name: null, name_ar: 'شامبو الثاني مجانا' }, TODAY).multibuy);
  assert.ok(!dealSignals({ ...base, name: 'Fat Free Milk 2L' }, TODAY).multibuy);
});

test('rarity needs age ≥ 8 weeks', () => {
  const young = { ...base, weeks_seen: 1, first_seen: '2026-06-20' };
  assert.ok(!dealSignals(young, TODAY).rare);
});

test('badges: drop %, lowest-ever depth, ending-soon days', () => {
  const row = {
    ...base, price: 7.5, old_price: 10, valid_to: '2026-07-16',
    weeks_seen: 5, first_seen: '2026-05-01', min_price: 7.5, max_price: 10, points: 2,
  };
  const b = offerBadges(row, TODAY);
  assert.equal(b.drop, 25);
  assert.deepEqual(b.lowestEver, { weeks: 5 });
  assert.equal(b.endsInDays, 1);
});

test('badges: a history-less row still gets its advertised drop, nothing invented', () => {
  const b = offerBadges({ ...base, price: 8, old_price: 10 }, TODAY);
  assert.equal(b.drop, 20);
  assert.ok(!('lowestEver' in b) && !('rare' in b));
});

test('compareDeals ranks score, then drop depth, then price', () => {
  const mk = (score, dropPct, price) => ({ row: { price }, deal: { score, signals: { dropPct } } });
  const sorted = [mk(50, 0.3, 5), mk(80, 0.1, 9), mk(50, 0.3, 4)].sort(compareDeals);
  assert.equal(sorted[0].deal.score, 80);
  assert.equal(sorted[1].row.price, 4);
});

/* --- brand knowledge + detection (§5 KB #2, §6) ----------------------------------- */

import { BRANDS, BRAND_BY_SLUG, matchBrandToken, detectBrand } from './brands.js';

test('brand slugs are unique and every entry has an English name', () => {
  assert.equal(new Set(BRANDS.map((b) => b.slug)).size, BRANDS.length);
  for (const b of BRANDS) assert.ok(b.slug && b.en, b.slug);
});

test('detectBrand: canonical hits in both scripts', () => {
  assert.equal(detectBrand({ name: 'Almarai Fresh Milk 2L', nameAr: null }), 'almarai');
  assert.equal(detectBrand({ name: null, nameAr: 'جبنة المراعي ٥٠٠ جم' }), 'almarai');
  assert.equal(detectBrand({ name: 'NADEC Labneh', nameAr: null }), 'nadec');
});

test('detectBrand: OCR repairs — doubled letters and ligature fold survive', () => {
  assert.equal(matchBrandToken('sadiaa'), 'sadia');
  assert.equal(matchBrandToken('Ülker'), 'ulker');
});

test('detectBrand: the fuzzy trailing-junk layer is GONE (net harmful in production)', () => {
  assert.equal(matchBrandToken('ساديات'), null); // sadia+junk — omit, don\'t guess
  assert.equal(matchBrandToken('فيريرو'), null); // Ferrero, NOT Fairy
  assert.equal(matchBrandToken('comforter'), null); // bedding, NOT Comfort
  assert.equal(matchBrandToken('برينس'), null); // Royal Prince, NOT Berain
  assert.equal(matchBrandToken('اوريون'), null); // Orion, NOT Oreo
});

test('detectBrand: ambiguous ordinary words never tag ("fine tissue" ≠ brand until unambiguous)', () => {
  assert.equal(matchBrandToken('fine'), null);
  assert.equal(matchBrandToken('الكبير'), null);
  assert.equal(detectBrand({ name: 'Fresh Chicken 1kg', nameAr: 'دجاج طازج' }), null);
});

test('detectBrand: 2-char fragments of split brand names never index (LED ≠ KDD, 7up ≠ Closeup)', () => {
  assert.equal(matchBrandToken('دي'), null);
  assert.equal(matchBrandToken('كي'), null);
  assert.equal(matchBrandToken('اب'), null);
  assert.equal(detectBrand({ name: null, nameAr: 'شاشه ال اي دي سمارت', source: 'd4d', category: 'tv' }), null);
  assert.equal(detectBrand({ name: null, nameAr: 'بيبسي سفن اب ميرندا', source: 'd4d', category: 'soft-drinks' }), 'pepsi');
  assert.equal(matchBrandToken('kdd'), 'kdd'); // the English form still tags
});

test('detectBrand: generic sub-words of multi-word brands never tag alone', () => {
  assert.equal(matchBrandToken('garden'), null);
  assert.equal(matchBrandToken('واي'), null); // "بيست واي" split must not tag wifi
  assert.equal(matchBrandToken('california'), 'california-garden');
});

test('detectBrand: department guards — the same word is a brand only in its home context', () => {
  // Galaxy chocolate vs Samsung Galaxy vs Galaxy rice.
  assert.equal(detectBrand({ name: 'Galaxy Jewels 650g', source: 'd4d', category: 'chocolates-candies' }), 'galaxy');
  assert.equal(detectBrand({ name: 'Samsung Galaxy S26 Ultra', source: 'd4d', category: 'mobiles' }), 'samsung');
  assert.equal(detectBrand({ name: 'Galaxy Super Sella Basmati Rice', source: 'd4d', category: 'rice' }), null);
  // بوك is "book" outside the dairy/pantry context.
  assert.equal(detectBrand({ name: null, nameAr: 'بوك جبنه كريم', source: 'd4d', category: 'cheese-creame' }), 'puck');
  assert.equal(detectBrand({ name: null, nameAr: 'ماك بوك لابتوب', source: 'd4d', category: 'computer-laptop' }), null);
  // A dept-guarded brand with NO category context stays silent (omit > guess).
  assert.equal(detectBrand({ name: 'MacBook نوت بوك' }), null);
});

test('detectBrand: neighbor-word vetoes — net weight and Kerrygold', () => {
  assert.equal(detectBrand({ name: null, nameAr: 'ارز بسمتي الوزن الصافي ٥ كجم', source: 'd4d', category: 'rice' }), null);
  assert.equal(detectBrand({ name: null, nameAr: 'حليب الصافي كامل الدسم', source: 'd4d', category: 'milk-laban' }), 'alsafi');
  assert.equal(detectBrand({ name: null, nameAr: 'كيري جولد شرايح شيدر', source: 'd4d', category: 'cheese-creame' }), null);
  assert.equal(detectBrand({ name: null, nameAr: 'كيري جبنه مثلثات', source: 'd4d', category: 'cheese-creame' }), 'kiri');
});

test('detectBrand: noStrip — bare صافي/ربيع are ordinary words, the articled form tags', () => {
  assert.equal(matchBrandToken('صافي'), null);
  assert.equal(matchBrandToken('ربيع'), null);
  assert.equal(detectBrand({ name: null, nameAr: 'عصير الربيع ١ لتر', source: 'd4d', category: 'juices-drinks' }), 'alrabie');
  assert.equal(detectBrand({ name: null, nameAr: 'مطهر برايحه زهور الربيع', source: 'd4d', category: 'cleaning' }), null);
});

test('detectBrand: Hanaa (canned foods) replaced Hana — the water brand entry only mis-tagged', () => {
  assert.ok(!BRAND_BY_SLUG.has('hana'));
  assert.equal(detectBrand({ name: 'Hanaa Light Tuna 185g', source: 'd4d', category: 'canned-packeted' }), 'hanaa');
  assert.equal(detectBrand({ name: null, nameAr: 'طماطم هناء مقشره', source: 'd4d', category: 'canned-packeted' }), 'hanaa');
});

test('BRAND_BY_SLUG resolves display names for the API', () => {
  assert.equal(BRAND_BY_SLUG.get('kiri').ar, 'كيري');
});

/* --- the API document builders (stub store — no D1, no network) ------------------ */

import { getBrowseSummaryDoc, getBrowseOffersDoc } from './api.js';
import { handleRequest } from '../engine.js';

// A fixture row factory in the browse store's joined shape.
let seq = 0;
function row(over = {}) {
  seq += 1;
  return {
    id: `lulu:central:d4d:${seq}`, store: 'lulu', region: 'central', source: 'd4d',
    offer_id: String(seq), flyer_ref: '9', page_ref: '3', edition: '2026-W29',
    name: `Product ${seq}`, name_ar: null, price: 10, old_price: null, currency: 'SAR',
    category: 'cheese-creame', image_url: 'https://cdn/x.jpg', source_url: 'https://d4d/x',
    valid_from: '2026-07-14', valid_to: '2026-07-20', detected_at: '2026-07-14T06:00:00Z',
    identity: `ph_${seq}`, weeks_seen: null, first_seen: null,
    min_price: null, max_price: null, points: null,
    ...over,
  };
}

function stubCtx({ rows = [], candidates = [], brands = [] } = {}) {
  // The JS twin of browseStore's FROZEN_MARK_SQL, for the stub's filtering.
  const frozenMarked = (r) => isFrozenMarked(r.name, r.name_ar);
  const foldCounts = (pool) => {
    const m = new Map();
    for (const r of pool) {
      const key = [r.source, r.category, frozenMarked(r) ? 1 : 0].join(' ');
      m.set(key, (m.get(key) || 0) + 1);
    }
    return [...m].map(([k, n]) => {
      const [source, category, frz] = k.split(' ');
      return { source, category: category === 'null' ? null : category, frozen_marked: Number(frz), n };
    });
  };
  return {
    registry: { lulu: {}, danube: {} },
    browseStore: {
      async brandCounts() {
        return brands;
      },
      async brandFacets(slug) {
        return foldCounts(rows.filter((r) => r.brand_slug === slug));
      },
      async categoryCounts() {
        return foldCounts(rows);
      },
      // Mirrors the D1 store's include-group semantics (incl. the frozen
      // modes) so the API tests exercise the real categoryFilter shapes.
      async list({ include, excludeMapped, hasDrop, store, brand, limit = 60, offset = 0 }) {
        let out = rows;
        if (include) {
          out = out.filter((r) =>
            include.some(
              ({ source, categories, frozen }) =>
                r.source === source &&
                categories.includes(r.category) &&
                (frozen === 'exclude' ? !frozenMarked(r) : frozen === 'only' ? frozenMarked(r) : true),
            ),
          );
        }
        if (excludeMapped) {
          out = out.filter((r) =>
            excludeMapped.every(
              ({ source, categories }) =>
                r.source !== source || r.category == null || !categories.includes(r.category),
            ),
          );
        }
        if (hasDrop) out = out.filter((r) => r.old_price > r.price);
        if (store) out = out.filter((r) => r.store === store);
        if (brand) out = out.filter((r) => r.brand_slug === brand);
        return out.slice(offset, offset + limit);
      },
      async candidates() {
        return candidates;
      },
    },
    offerStore: { async counts() { return { total: rows.length, current: rows.length, stores: 2 }; } },
  };
}

const lowRow = () =>
  row({
    price: 8, old_price: 14, weeks_seen: 6, first_seen: '2026-05-01',
    min_price: 8, max_price: 14, points: 3,
  });

await (async () => {
  const rows = [
    row({ category: 'cheese-creame' }),
    row({ category: 'cheese-creame', old_price: 20, price: 10 }),
    row({ category: 'laundry', store: 'danube' }),
    row({ category: 'some-brand-new-slug' }), // -> other
  ];
  const candidates = [lowRow()];
  const ctx = stubCtx({
    rows,
    candidates,
    brands: [
      { brand_slug: 'almarai', n: 8, stores: 3 },
      { brand_slug: 'not-in-knowledge', n: 4, stores: 2 }, // dropped, never invented
    ],
  });

  const doc = await getBrowseSummaryDoc(ctx, TODAY);

  test('summary: dairy holds the cheese aisle with both offers', () => {
    const dairy = doc.departments.find((d) => d.id === 'dairy-eggs');
    assert.ok(dairy);
    const cheese = dairy.aisles.find((a) => a.id === 'cheese-cream');
    assert.equal(cheese.offers, 2);
  });

  test('summary: an unmapped slug lands visibly in more/other', () => {
    const more = doc.departments.find((d) => d.id === OTHER_DEPT);
    assert.ok(more, 'more department present');
    assert.equal(more.aisles[0].id, OTHER_AISLE);
    assert.equal(more.aisles[0].offers, 1);
  });

  test('summary: exactly the two kept rails, nothing else (V1.1 simplification)', () => {
    assert.deepEqual(doc.rails.map((r) => r.id).sort(), ['drops', 'lowest-ever']);
  });

  test('summary: lowest-ever carries the history-verified deal with its badge', () => {
    const lowest = doc.rails.find((r) => r.id === 'lowest-ever');
    assert.ok(lowest && lowest.items.length === 1);
    const card = lowest.items[0];
    assert.ok(card.badges.lowestEver, 'lowest-ever badge rides the card');
    assert.equal(card.aisle, 'cheese-cream');
    assert.equal(card.dept, 'dairy-eggs');
  });

  test('summary: totals ride along', () => {
    assert.deepEqual(doc.totals, { offers: 4, stores: 2 });
  });

  test('summary: brands carry bilingual names; unknown slugs are dropped', () => {
    assert.equal(doc.brands.length, 1);
    assert.deepEqual(doc.brands[0], { slug: 'almarai', en: 'Almarai', ar: 'المراعي', offers: 8, stores: 3 });
  });

  test('listing: unknown brand errors explicitly', async () => {
    assert.ok((await getBrowseOffersDoc(ctx, { brand: 'nope' }, TODAY)).error);
  });

  test('listing: unknown canonical ids error explicitly (incl. the RETIRED rails)', async () => {
    assert.ok((await getBrowseOffersDoc(ctx, { dept: 'nope' }, TODAY)).error);
    assert.ok((await getBrowseOffersDoc(ctx, { aisle: 'nope' }, TODAY)).error);
    assert.ok((await getBrowseOffersDoc(ctx, { rail: 'nope' }, TODAY)).error);
    assert.ok((await getBrowseOffersDoc(ctx, { rail: 'exceptional' }, TODAY)).error);
    assert.ok((await getBrowseOffersDoc(ctx, { rail: 'ending-soon' }, TODAY)).error);
    assert.ok((await getBrowseOffersDoc(ctx, { rail: 'new-this-week' }, TODAY)).error);
  });

  test('listing: rail=lowest-ever pages the history-verified pool', async () => {
    const d = await getBrowseOffersDoc(ctx, { rail: 'lowest-ever' }, TODAY);
    assert.equal(d.count, 1);
    assert.equal(d.offers[0].badges.drop, 43);
  });

  test('listing: dedupe collapses same-identity same-store variants', async () => {
    const twin = { ...lowRow(), id: 'lulu:central:d4d:twin', identity: candidates[0].identity, price: candidates[0].price };
    const ctx2 = stubCtx({ rows, candidates: [candidates[0], twin] });
    const d = await getBrowseOffersDoc(ctx2, { rail: 'lowest-ever' }, TODAY);
    assert.equal(d.count, 1);
  });

  test('route: GET /browse serves the summary with the disclaimer', async () => {
    const resp = await handleRequest(new Request('https://engine.test/browse'), ctx);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(body.note, 'honesty note present');
    assert.ok(Array.isArray(body.departments) && body.departments.length);
  });

  test('route: GET /browse/offers validates the store id', async () => {
    const resp = await handleRequest(
      new Request('https://engine.test/browse/offers?store=nostore'),
      ctx,
    );
    assert.equal(resp.status, 404);
  });

  test('route: /browse degrades to 503 without a browse store (dev harness)', async () => {
    const resp = await handleRequest(new Request('https://engine.test/browse'), { registry: {} });
    assert.equal(resp.status, 503);
  });
})();

/* --- fresh->frozen refinement + brand facets, end to end -------------------------- */

await (async () => {
  const rows = [
    row({ category: 'fresh-chicken-poultry', name: 'Tanmiah Fresh Chicken 1000g', name_ar: 'دجاج طازج' }),
    row({ category: 'fresh-chicken-poultry', name: 'Doux French Griller', name_ar: 'دجاج فرنسي مجمد' }),
    row({ category: 'frozen-chicken-poultry', name: 'Sadia Chicken Burger', name_ar: 'برجر دجاج' }),
    row({ category: 'cheese-creame', name: 'Kiri Cream Cheese 200g', name_ar: 'كيري جبنه', brand_slug: 'kiri' }),
    row({ category: 'yogurt-labneh', name: 'Kiri Labneh 400g', name_ar: 'كيري لبنه', brand_slug: 'kiri' }),
    row({ category: 'cheese-creame', name: 'Kiri Squares 108g', name_ar: 'كيري مربعات', brand_slug: 'kiri' }),
  ];
  const ctx = stubCtx({ rows });
  const doc = await getBrowseSummaryDoc(ctx, TODAY);

  test('summary counts: the frozen-marked fresh-category row counts as Frozen', () => {
    const fresh = doc.departments.find((d) => d.id === 'fresh');
    const frozen = doc.departments.find((d) => d.id === 'frozen');
    assert.equal(fresh.aisles.find((a) => a.id === 'chicken-poultry').offers, 1);
    assert.equal(frozen.aisles.find((a) => a.id === 'frozen-poultry').offers, 2);
  });

  test('listing: dept=fresh excludes the frozen-marked row; dept=frozen includes it', async () => {
    const fresh = await getBrowseOffersDoc(ctx, { dept: 'fresh' }, TODAY);
    assert.deepEqual(fresh.offers.map((o) => o.name), ['Tanmiah Fresh Chicken 1000g']);
    const frozen = await getBrowseOffersDoc(ctx, { dept: 'frozen' }, TODAY);
    assert.deepEqual(frozen.offers.map((o) => o.name).sort(),
      ['Doux French Griller', 'Sadia Chicken Burger']);
    // Cards agree with the filter: the moved row presents as frozen-poultry.
    const moved = frozen.offers.find((o) => o.name === 'Doux French Griller');
    assert.equal(moved.aisle, 'frozen-poultry');
    assert.equal(moved.dept, 'frozen');
  });

  test('listing: aisle=frozen-poultry pulls the mis-categorized row too', async () => {
    const d = await getBrowseOffersDoc(ctx, { aisle: 'frozen-poultry' }, TODAY);
    assert.equal(d.offers.length, 2);
  });

  test('brand listing: first page carries identity + product families (aisle fold)', async () => {
    const d = await getBrowseOffersDoc(ctx, { brand: 'kiri' }, TODAY);
    assert.deepEqual(d.brand, { slug: 'kiri', en: 'Kiri', ar: 'كيري' });
    assert.deepEqual(d.families, [
      { id: 'cheese-cream', en: 'Cheese & Cream', ar: 'أجبان وقشطة', dept: 'dairy-eggs', offers: 2 },
      { id: 'yogurt-labneh', en: 'Yogurt & Labneh', ar: 'زبادي ولبنة', dept: 'dairy-eggs', offers: 1 },
    ]);
  });

  test('brand listing: later pages skip the facet work', async () => {
    const d = await getBrowseOffersDoc(ctx, { brand: 'kiri', offset: 24 }, TODAY);
    assert.ok(!d.families && !d.brand);
  });

  test('brand + aisle narrows the grid but keeps brand-wide families', async () => {
    const d = await getBrowseOffersDoc(ctx, { brand: 'kiri', aisle: 'yogurt-labneh' }, TODAY);
    assert.equal(d.offers.length, 1);
    assert.equal(d.families.length, 2);
  });
})();

console.log(`browse.test: ${passed} tests passed${process.exitCode ? ' (WITH FAILURES)' : ''}`);
