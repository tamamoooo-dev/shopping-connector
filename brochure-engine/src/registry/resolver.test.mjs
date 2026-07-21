// registry/resolver.test.mjs — offline, dependency-free tests for Registry
// Resolution (Phase 2: REGISTRY-DESIGN.md §3–§4 — decide only, no writes).
// Run with:
//   node brochure-engine/src/registry/resolver.test.mjs   (repo root)
//
// Guards the milestone's promises:
//  • the mint gates defer with the right verdict (IDENTITY-V2 §3.1) and an
//    uncorroborated read can neither attach nor mint (P5),
//  • the read is EN-preferred, size-stripped, banner-stripped, diacritic-folded
//    and brand-repaired (cross-script: المراعي ≡ Almarai),
//  • assortment tiles produce degraded assortment reads that never mix with
//    specific products (kind gate, both directions),
//  • scoring: containment is the workhorse; size conflict vetoes; nosize is
//    compatible with sized (but one-sided size caps the band at review);
//    brand conflict vetoes (P2 revised 2026-07-21 — the Nadec/Al Safi
//    cross-brand pollution); missing brand stays neutral;
//    corroboration scales the whole score down,
//  • the four outcomes fall out of the two thresholds (attach / review /
//    create / defer), biased to create-on-doubt (P1),
//  • blocking: common tokens block nothing; the sticky incumbent joins the
//    candidate set and wins ties; merged tombstones redirect single-hop.

import { readFromOffer, evidenceTokens, readSize, READ_VERDICT } from './read.js';
import {
  resolveOffer, scoreCandidate, distinctiveTokens, sizeConflicts, brandRelation,
  TUNING,
} from './resolver.js';

const { tAttach: T_ATTACH, tReview: T_REVIEW } = TUNING;

let failures = 0;
function check(label, cond) {
  if (cond) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

// --- fixtures -------------------------------------------------------------------

function product(id, tokens, over = {}) {
  return {
    id, status: 'active', merged_into: null, kind: 'product',
    display_name: null, display_name_ar: null, brand_slug: null, brand_text: null,
    size_unit: null, size_total: null, size_pack: null, family: null, category: null,
    token_profile: JSON.stringify(
      Object.fromEntries(tokens.map((t) => [t, { count: 2, week: '2026-W28' }])),
    ),
    sightings: 3, stores_seen: '["othaim"]', first_seen: '2026-07-01',
    last_seen: '2026-07-15', review_flag: null, algo_version: 1, ...over,
  };
}

const offer = (over = {}) => ({
  id: 'othaim:riyadh:d4d:1', store: 'othaim', region: 'riyadh',
  category: null, search_text: 'some ocr text', ...over,
});

const enr = (over = {}) => ({
  name: null, name_ar: null, brand: null, size: null, corroboration: 0.9, ...over,
});

// In-memory twin of storage/registryStore.js (same semantics; the SQL store is
// exercised by the Phase 4 shadow runs).
function twinStore({ products = [], sightings = [], offers = [] } = {}) {
  const tokensOf = (p) => Object.keys(JSON.parse(p.token_profile || '{}'));
  const live = () => products.filter((p) => p.status !== 'merged');
  return {
    async productCount() { return live().length; },
    async tokenFrequencies(tokens) {
      const m = new Map();
      for (const t of tokens) {
        const n = live().filter((p) => tokensOf(p).includes(t)).length;
        if (n) m.set(t, n);
      }
      return m;
    },
    // No merged filter here: like the real store this reads the token index,
    // which may briefly hold rows for a just-merged product (§6).
    async candidateIds(tokens) {
      const ids = new Set();
      for (const p of products) {
        if (tokensOf(p).some((t) => tokens.includes(t))) ids.add(p.id);
      }
      return [...ids];
    },
    async getProducts(ids) { return products.filter((p) => ids.includes(p.id)); },
    async findIncumbentProductId({ store, region, searchText, excludeOfferId }) {
      for (const o of offers) {
        if (o.store !== store || o.region !== region) continue;
        if (o.search_text !== searchText || o.id === excludeOfferId) continue;
        const s = sightings.find((x) => x.offer_id === o.id);
        if (s) return s.product_id;
      }
      return null;
    },
    async getSighting(id) { return sightings.find((s) => s.offer_id === id) || null; },
  };
}

// --- mint gates (defer verdicts) ------------------------------------------------
console.log('mint gates:');
{
  const empty = twinStore();
  const d1 = await resolveOffer(offer(), null, empty);
  check('no enrichment -> defer/no_enrichment', d1.outcome === 'defer' && d1.verdict === READ_VERDICT.NO_ENRICHMENT);
  const d2 = await resolveOffer(offer(), enr(), empty);
  check('declined (null names) -> defer/declined', d2.outcome === 'defer' && d2.verdict === READ_VERDICT.DECLINED);
  const d3 = await resolveOffer(offer(), enr({ name: 'Halah Sunflower Oil', corroboration: 0.1 }), empty);
  check('uncorroborated -> defer/low_corroboration (P5)', d3.outcome === 'defer' && d3.verdict === READ_VERDICT.LOW_CORROBORATION);
  const d4 = await resolveOffer(offer(), enr({ name: 'Milk' }), empty);
  check('single token -> defer/too_few_tokens', d4.outcome === 'defer' && d4.verdict === READ_VERDICT.TOO_FEW_TOKENS);
}

// --- bare OR-deal gate (IDENTITY-V2 §3 gate 2b) ---------------------------------
console.log('OR-deal gate:');
{
  const empty = twinStore();
  const d = await resolveOffer(
    offer(), enr({ name: 'Tide Detergent 3kg or Persil Powder 3kg' }), empty,
  );
  check('two substantial sides (EN) -> defer/or_deal', d.outcome === 'defer' && d.verdict === READ_VERDICT.OR_DEAL);
  const ar = await resolveOffer(
    offer(), enr({ name_ar: 'مسحوق تايد للغسيل او مسحوق برسيل للغسيل' }), empty,
  );
  check('two substantial sides (AR او) -> defer/or_deal', ar.outcome === 'defer' && ar.verdict === READ_VERDICT.OR_DEAL);
  const attr = await resolveOffer(
    offer(), enr({ name: 'Fresh or Frozen Chicken Whole' }), empty,
  );
  check('attribute-choice "fresh or frozen" never fires (one thin side)', attr.outcome !== 'defer');
  const substr = await resolveOffer(
    offer(), enr({ name: 'Oreo Original Cookies' }), empty,
  );
  check('"or" as substring never fires (word boundary)', substr.outcome !== 'defer');
  const arNoise = await resolveOffer(
    offer({ search_text: 'تايد او برسيل مسحوق الغسيل عرض' }),
    enr({ name: 'Tide Detergent Powder' }),
    empty,
  );
  check('OCR-text marker alone never fires (vision names only)', arNoise.outcome !== 'defer');
}

// --- read normalization ---------------------------------------------------------
console.log('read normalization:');
{
  const r = readFromOffer(
    offer(),
    enr({ name: 'Almarai Fresh Milk Full Fat', name_ar: 'حليب المراعي', brand: 'Almarai', size: '2L' }),
  );
  check('EN name preferred, tokens repaired + deduped',
    r.ok && r.read.tokens.join(',') === 'almarai,fresh,milk,full,fat');
  check('size from the structured field', r.ok && r.read.size && r.read.size.unit === 'ml' && r.read.size.each === 2000 && r.read.size.pack === 1);
  check('brandText folded', r.ok && r.read.brandText === 'almarai');
  check('family classified (milk)', r.ok && r.read.family === 'milk');
  check('kind product, corroboration carried', r.ok && r.read.kind === 'product' && r.read.corroboration === 0.9);

  const ar = readFromOffer(offer(), enr({ name_ar: 'حليب المراعي كامل الدسم' }));
  check('AR-only read still tokenizes (cross-script repair: المراعي -> almarai)',
    ar.ok && ar.read.tokens.includes('almarai') && ar.read.tokens.includes('حليب'));

  check('size expressions never become tokens',
    evidenceTokens('Halah Pure Oil 1.5L x 2').join(',') === 'halah,pure,oil');
  check('banner + digit + single-char tokens dropped',
    evidenceTokens('Amazing Offer Tide 3 X').join(',') === 'tide');
  check('Latin diacritics folded then brand-repaired (Président -> president)',
    evidenceTokens('Président Cheese').join(',') === 'president,cheese');

  check('range size -> nosize (7 to 9 kg)', readSize('7 to 9 kg', 'Tanzanian Mutton') === null);
  check('dual-size alternation -> nosize (12 * 1LTR / 4 * 1LTR)',
    readSize('12 * 1LTR / 4 * 1LTR', 'ALSAFI UHT MILK') === null);
  check('dual-size alternation -> nosize (12 x 1L / 4 x 1L)',
    readSize('12 x 1L / 4 x 1L', null) === null);
  const dual = readSize(null, 'NADEC UHT Milk 1L x 12');
  check('single size still parses beside slash-free text',
    dual && dual.unit === 'ml' && dual.each === 1000 && dual.pack === 12);
  const packed = readSize('1.5L x 2', null);
  check('pack grammar: 1.5L x 2 -> ml/1500/2', packed && packed.unit === 'ml' && packed.each === 1500 && packed.pack === 2);
}

// --- assortment reads -----------------------------------------------------------
console.log('assortment reads:');
{
  const a = readFromOffer(
    offer({ search_text: 'mobi dishwash 1l assorted' }),
    enr({ name: 'MOBI Dishwash Lemon 1L Assorted', brand: 'MOBI' }),
  );
  check('marker -> kind assortment', a.ok && a.read.kind === 'assortment');
  check('degraded core: brand + assorted, flavor dropped',
    a.ok && a.read.tokens.includes('mobi') && a.read.tokens.includes('assorted') && !a.read.tokens.includes('lemon'));
  const generic = readFromOffer(offer(), enr({ name: 'Chips Selected Flavours' }));
  check('brandless assortment keeps its product-type core (chips + assorted)',
    generic.ok && generic.read.kind === 'assortment' && generic.read.tokens.sort().join(',') === 'assorted,chips');
  const bare = readFromOffer(offer(), enr({ name: 'Selected Flavours' }));
  check('assortment with no brand/type core -> defer/too_few_tokens',
    !bare.ok && bare.verdict === READ_VERDICT.TOO_FEW_TOKENS);
}

// --- scoring --------------------------------------------------------------------
console.log('scoring:');
{
  const read = {
    tokens: ['almarai', 'fresh', 'milk', 'full', 'fat'], size: { unit: 'ml', each: 2000, pack: 1 },
    brandText: 'almarai', family: 'milk', category: 'milk-laban', kind: 'product', corroboration: 0.9,
  };
  const full = product('pr_a', ['almarai', 'fresh', 'milk', 'full', 'fat'], {
    brand_text: 'almarai', size_unit: 'ml', size_total: 2000, size_pack: 1,
    family: 'milk', category: 'milk-laban',
  });
  const s1 = scoreCandidate(read, full);
  check('perfect agreement -> score 1', !s1.vetoed && Math.abs(s1.score - 1) < 1e-9);

  const s2 = scoreCandidate(read, product('pr_b', ['almarai', 'fresh', 'milk', 'full', 'fat'], {
    size_unit: 'ml', size_total: 500, size_pack: 1,
  }));
  check('size conflict -> veto (P3)', s2.vetoed);

  const s3 = scoreCandidate({ ...read, size: null }, full);
  check('nosize read vs sized product -> compatible, not penalized', !s3.vetoed && s3.score > 0.9);

  const s4 = scoreCandidate(read, product('pr_c', ['almarai', 'fresh', 'milk', 'full', 'fat'], {
    brand_text: 'nadec',
  }));
  check('brand conflict -> veto (P2 revised 2026-07-21)', s4.vetoed);
  const s4b = scoreCandidate({ ...read, brandText: null }, product('pr_c2', ['almarai', 'fresh', 'milk', 'full', 'fat'], {
    brand_text: 'nadec',
  }));
  check('missing read brand stays neutral, never vetoes', !s4b.vetoed && s4b.score > 0.5);
  check('brand granularity is compatible ("sebamed" vs "sebamed baby")', brandRelation('sebamed', 'sebamed baby') === 1);

  const s5 = scoreCandidate({ ...read, corroboration: 0.3 }, full);
  check('corroboration near floor halves the score', Math.abs(s5.score - 0.5) < 1e-9);

  const s6 = scoreCandidate({ ...read, kind: 'assortment' }, full);
  check('kind mismatch -> veto (assortments match only assortments)', s6.vetoed);

  check('sizeConflicts: same grand total across pack forms is compatible',
    !sizeConflicts({ unit: 'ml', each: 1500, pack: 2 }, { unit: 'ml', each: 1500, pack: 2 }));
  check('sizeConflicts: unit family mismatch conflicts',
    sizeConflicts({ unit: 'ml', each: 500, pack: 1 }, { unit: 'g', each: 500, pack: 1 }));
}

// --- blocking -------------------------------------------------------------------
console.log('blocking:');
{
  const freqs = new Map([['fresh', 50], ['almarai', 5]]);
  const kept = distinctiveTokens(['fresh', 'almarai', 'milk'], freqs, 1000);
  check('common token (>2%) blocks nothing; rare + unseen tokens block',
    kept.join(',') === 'almarai,milk');
  const keptSmall = distinctiveTokens(['fresh', 'almarai'], freqs, 100);
  check('small registry: floor keeps sub-floor tokens blocking', keptSmall.join(',') === 'almarai');
}

// --- outcomes end-to-end --------------------------------------------------------
console.log('outcomes:');
{
  const e = enr({ name: 'Almarai Fresh Milk Full Fat', brand: 'Almarai', size: '2L' });

  const create = await resolveOffer(offer(), e, twinStore());
  check('empty registry -> create', create.outcome === 'create' && create.band === 'created' && create.verdict === 'minted');

  const full = product('pr_full', ['almarai', 'fresh', 'milk', 'full', 'fat'], {
    brand_text: 'almarai', size_unit: 'ml', size_total: 2000, size_pack: 1,
    family: 'milk', category: 'milk-laban',
  });
  const attach = await resolveOffer(offer({ category: 'milk-laban' }), e, twinStore({ products: [full] }));
  check('strong match -> attach (band auto)', attach.outcome === 'attach' && attach.band === 'auto' && attach.productId === 'pr_full');
  check('attach score >= T_ATTACH', attach.score >= T_ATTACH);

  // Partial containment with no corroborating fields -> review band.
  const partial = product('pr_part', ['nadec', 'juice', 'orange', 'pulp']);
  const review = await resolveOffer(offer(), enr({ name: 'Nadec Apple Juice' }), twinStore({ products: [partial] }));
  check('middling match -> review (attaches to best, band review)',
    review.outcome === 'review' && review.band === 'review' && review.productId === 'pr_part');
  check('review score in [T_REVIEW, T_ATTACH)', review.score >= T_REVIEW && review.score < T_ATTACH);

  // Cross-brand read over the same generic tokens -> create, never attach or
  // review (the production Nadec-onto-AlSafi pollution, P2 revised).
  const crossBrand = await resolveOffer(
    offer({ category: 'milk-laban' }),
    enr({ name: 'Nadec UHT Milk Full Fat', brand: 'Nadec', size: '12 x 1L' }),
    twinStore({
      products: [product('pr_safi', ['alsafi', 'milk', 'uht', 'full', 'fat'], {
        brand_text: 'al safi', size_unit: 'ml', size_total: 1000, size_pack: 12,
        family: 'milk', category: 'milk-laban',
      })],
    }),
  );
  check('cross-brand read -> create (brand conflict vetoes attachment)',
    crossBrand.outcome === 'create');

  // One-sided size (read nosize, product sized) -> attach demoted to review.
  const sizedProduct = product('pr_sz', ['almarai', 'fresh', 'milk', 'full', 'fat'], {
    brand_text: 'almarai', size_unit: 'ml', size_total: 2000, size_pack: 1,
    family: 'milk', category: 'milk-laban',
  });
  const oneSided = await resolveOffer(
    offer({ category: 'milk-laban' }),
    enr({ name: 'Almarai Fresh Milk Full Fat', brand: 'Almarai' }), // no size
    twinStore({ products: [sizedProduct] }),
  );
  check('size-unknown attach demoted to review band',
    oneSided.outcome === 'review' && oneSided.band === 'review' && oneSided.productId === 'pr_sz');

  // Same registry, unrelated read -> create (create-on-doubt, P1).
  const unrelated = await resolveOffer(offer(), enr({ name: 'Tide Detergent Powder' }), twinStore({ products: [partial] }));
  check('unrelated read -> create', unrelated.outcome === 'create');

  // A weak read attaches cautiously: same evidence, floor corroboration.
  const shaky = await resolveOffer(
    offer({ category: 'milk-laban' }),
    { ...e, corroboration: 0.3 },
    twinStore({ products: [full] }),
  );
  check('floor-corroboration read never auto-attaches', shaky.outcome === 'review');

  // Sticky incumbency: identical twins, the prior-week counterpart wins.
  const twinA = product('pr_ta', ['berain', 'water', 'bottle']);
  const twinB = product('pr_tb', ['berain', 'water', 'bottle']);
  const sticky = await resolveOffer(
    offer({ id: 'othaim:riyadh:d4d:new', search_text: 'berain water ocr' }),
    enr({ name: 'Berain Water Bottles' }), // bottles -> containment 2/3
    twinStore({
      products: [twinA, twinB],
      offers: [{ id: 'othaim:riyadh:d4d:old', store: 'othaim', region: 'riyadh', search_text: 'berain water ocr' }],
      sightings: [{ offer_id: 'othaim:riyadh:d4d:old', product_id: 'pr_ta' }],
    }),
  );
  check('sticky incumbent wins the tie', sticky.productId === 'pr_ta');

  // Merged tombstone: candidate redirects single-hop to the survivor.
  const dead = product('pr_dead', ['berain', 'water', 'bottle'], { status: 'merged', merged_into: 'pr_live' });
  const live = product('pr_live', ['berain', 'water', 'bottles', 'small'], {});
  const redirected = await resolveOffer(
    offer(),
    enr({ name: 'Berain Water Bottles', corroboration: 1 }),
    twinStore({ products: [dead, live] }),
  );
  check('merged candidate redirects to survivor', redirected.productId === 'pr_live' && redirected.outcome !== 'create');
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll resolver tests passed.');
