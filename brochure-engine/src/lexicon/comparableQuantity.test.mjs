import assert from 'node:assert/strict';
import { buildStructuredProduct } from './structuredProduct.js';
import {
  COMPARABLE_QUANTITY_EVIDENCE,
  COMPARABLE_QUANTITY_STATUS,
  COMPARABLE_QUANTITY_VERSION,
  SELLING_MODE,
  comparableQuantityFromStructured,
  projectComparableQuantity,
  resolveComparableQuantity,
  unitPriceFromReference,
} from './comparableQuantity.js';

let tests = 0;
const test = (name, fn) => {
  fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Comparable Quantity:');

test('a printed measure resolves on the measure basis and supports arithmetic', () => {
  const cq = resolveComparableQuantity({ size: '330 ml', name: 'Arwa Bottled Water 330 ml' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.RESOLVED);
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.MEASURE);
  assert.equal(cq.quantity, 330);
  assert.equal(cq.unit, 'ml');
  assert.equal(cq.pack, 1);
  assert.equal(cq.unitPriceComparable, true);
});

test('a multipack keeps the ONE-unit magnitude and reports the pack separately', () => {
  const cq = resolveComparableQuantity({ size: '6 x 250 ml', name: 'Nadec Milk' });
  assert.equal(cq.quantity, 250, 'quantity is the magnitude of one unit, never the total');
  assert.equal(cq.pack, 6);
  assert.equal(cq.unitPriceComparable, true);
});

test('a printed count resolves on the count basis and ADMITS the product', () => {
  const cq = resolveComparableQuantity({ size: "40's", name: 'Fine Tissue' });
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.COUNT);
  assert.equal(cq.quantity, 40);
  assert.equal(cq.unit, 'piece');
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.RESOLVED);
});

test('v4 · an apostrophe count admits the product but is NOT a denominator', () => {
  // CHANGED IN v4, deliberately. `parsePackageSize` surfaces "40's" as a printed
  // count while `parseSize` marks the same string 'count-weak', so v3 reported
  // `unitPriceComparable: true` on a product the pricing function then refused —
  // two layers, two answers, one product. The reference projection reads ONE
  // source, so the flag can no longer lie: the gate still admits the pack (it is
  // a real, groupable product) and no per-piece price is advertised on it.
  const cq = resolveComparableQuantity({ size: "40's", name: 'Fine Tissue' });
  assert.equal(cq.reference, null);
  assert.equal(cq.unitPriceComparable, false);
  // An UNAMBIGUOUS count word is a denominator, exactly as before.
  const strong = resolveComparableQuantity({ name: 'White Eggs 30 pcs' });
  assert.deepEqual(strong.reference, { quantity: 30, unit: 'piece' });
  assert.equal(strong.unitPriceComparable, true);
});

test('a container admits the product but refuses arithmetic', () => {
  const cq = resolveComparableQuantity({ name: 'Fresh Tomato', packageType: 'bag' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.RESOLVED, 'a carton is a real product');
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.CONTAINER);
  assert.equal(cq.quantity, null);
  assert.equal(cq.unit, 'bag');
  assert.equal(cq.source, 'package_type');
  assert.equal(
    cq.unitPriceComparable, false,
    'nothing may ever compute a price per "1 bag"',
  );
});

test('no size and no package type is ABSENT, never an invented quantity', () => {
  const cq = resolveComparableQuantity({ name: 'Fresh Tomato' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.ABSENT);
  assert.equal(cq.evidence, null);
  assert.equal(cq.quantity, null);
  assert.equal(cq.pack, 1);
  assert.equal(cq.unitPriceComparable, false);
});

test('first hit wins — a printed measure is never demoted to its container word', () => {
  const cq = resolveComparableQuantity({
    size: '1.5 L', name: 'Water', packageType: 'bottle',
  });
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.MEASURE);
  assert.equal(cq.unit, 'l');
});

test('an unknown package type resolves to nothing rather than a guess', () => {
  const cq = resolveComparableQuantity({ name: 'Mystery Item', packageType: 'blister' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.ABSENT);
});

test('the weak-count guard is INHERITED, not re-implemented', () => {
  // parseSize marks a bare "…26S" model-number suffix 'count-weak', and
  // parsePackageSize refuses to surface it. The projection must not resurrect
  // it from some other field.
  const cq = resolveComparableQuantity({ name: 'Hisense Fridge NRF110N26S' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.ABSENT);
});

test('the projection re-parses nothing when a Structured Product exists', () => {
  const structured = buildStructuredProduct({
    name_en: 'Almarai Fresh Laban 1.5 L', brand: 'Almarai', size: '1.5 L',
  });
  const fromStructured = comparableQuantityFromStructured(structured);
  const fromRaw = resolveComparableQuantity({ size: '1.5 L', name: 'Almarai Fresh Laban 1.5 L' });
  assert.deepEqual(fromStructured, fromRaw, 'both paths must agree exactly');
});

test('output is frozen and version-stamped', () => {
  const cq = resolveComparableQuantity({ size: '330 ml' });
  assert.equal(cq.version, COMPARABLE_QUANTITY_VERSION);
  assert.ok(Object.isFrozen(cq));
});

test('the same input always yields the same output', () => {
  const once = resolveComparableQuantity({ size: '6 x 250 ml', name: 'Nadec Milk' });
  const twice = resolveComparableQuantity({ size: '6 x 250 ml', name: 'Nadec Milk' });
  assert.deepEqual(once, twice);
});

test('a null or empty observation is safe and ABSENT', () => {
  assert.equal(resolveComparableQuantity().status, COMPARABLE_QUANTITY_STATUS.ABSENT);
  assert.equal(projectComparableQuantity(null, null).status, COMPARABLE_QUANTITY_STATUS.ABSENT);
  assert.equal(comparableQuantityFromStructured(null).status, COMPARABLE_QUANTITY_STATUS.ABSENT);
});

test('KNOWN LIMIT (C-5): resolved is not correct — HONOR 5G projects as 5 g', () => {
  // Pinned deliberately. parseSize reads the model designator "5G" as a
  // measure, so M2 passes on a confidently wrong size. If someone later fixes
  // the parser this test SHOULD fail and be updated — it documents a measured
  // ceiling, not a desired behaviour.
  const cq = resolveComparableQuantity({ name: 'HONOR 5G' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.RESOLVED);
  assert.equal(cq.quantity, 5);
  assert.equal(cq.unit, 'g');
});

// --- v3 · the PRICE BASIS ------------------------------------------------------

test('v3 · a per-kilo price resolves, and its pricing is per_unit not per_pack', () => {
  // The case that started this work: production row nesto:central:d4d:93210819,
  // "Apple Royal Gala Brazil" with `size: "Per Kg"`. v2 returned ABSENT, which
  // rejected the offer outright at the Business Acceptance Gate.
  const cq = resolveComparableQuantity({ size: 'Per Kg', name: 'Apple Royal Gala Brazil' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.RESOLVED);
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS);
  assert.equal(cq.unit, 'kg');
  assert.equal(cq.quantity, 1);
  assert.equal(cq.unitPriceComparable, true, 'a stated denominator IS arithmetic-ready');
  assert.equal(cq.source, 'price_basis:size_field', 'provenance survives the projection');
});

test('v3 · a measure basis outranks a package magnitude read from the SAME field', () => {
  // "320" is a cashew kernel grade, not 320 kg. One expression cannot be both.
  const cq = resolveComparableQuantity({ name: 'CASHEW NUT SALTED W 320 /KG', size: '320 /KG' });
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS);
  assert.equal(cq.unit, 'kg');
  assert.equal(cq.quantity, 1);
});

test('v3/v4 · a measure basis does NOT override a magnitude from a DIFFERENT field', () => {
  // Deli counter: labelled by the kilo, sold in a 500 g tub. Two fields, two
  // independent facts. v3 let the package win outright; v4 refuses instead,
  // because measurement showed the package is right about two thirds of the
  // time and wrong the rest — see the CONTRADICTED tests below. What has NOT
  // changed is that the basis never simply overrides a different field.
  const cq = resolveComparableQuantity({ name: 'Lemon Pickle/Kg', size: '500 gm' });
  assert.notEqual(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS);
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.CONTRADICTED);
  assert.equal(cq.quantity, 500, 'the printed size still shows on the card');
  assert.equal(cq.reference, null, 'but no unit price is claimed');
});

test('v3 · a PIECE basis fills a gap but never displaces a real magnitude', () => {
  // Below measure: an 800 g chicken with `unit: "Each"` is more useful as SAR/kg.
  const withMeasure = resolveComparableQuantity({
    unit: 'Each', size: '800 GM', name: 'ENTAJ FRESH WHOLE CHICKEN CUT UP 800 GM',
  });
  assert.equal(withMeasure.evidence, COMPARABLE_QUANTITY_EVIDENCE.MEASURE);
  // With nothing to displace, it resolves and admits the product.
  const alone = resolveComparableQuantity({ name: 'Iceberg Lettuce/pc' });
  assert.equal(alone.evidence, COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS);
  assert.equal(alone.unit, 'piece');
  assert.equal(alone.unitPriceComparable, true);
});

test('v3 · a PIECE basis on non-grocery defers to the v2 UNIT basis', () => {
  // "Samsung 65 inch TV Each" resolves a real per-piece basis, and acting on it
  // would advertise a unit price identical to the price. The UNIT basis already
  // says "one indivisible item" AND refuses the arithmetic, which is the honest
  // answer; this also keeps every as-is non-grocery verdict attributable to the
  // rule that admitted it.
  const cq = resolveComparableQuantity({ name: 'Samsung 65 inch TV Each', nonGrocery: true });
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.UNIT);
  assert.equal(cq.unitPriceComparable, false);
  // A MEASURE basis is not excluded: a 7 kg washing machine priced per kilo
  // would still be nonsense, but a per-kilo price on an uncategorised bulk item
  // is not, and the class is the retailer's, not ours to second-guess twice.
  assert.equal(
    resolveComparableQuantity({ name: 'Loose Nuts', size: 'Per Kg', nonGrocery: true }).evidence,
    COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS,
  );
});

test('v3 · a basis beats a container word, which carries no magnitude at all', () => {
  const cq = resolveComparableQuantity({ size: 'Per Kg', name: 'Dates', packageType: 'bag' });
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS);
});

test('v3 · the Arabic OCR channel reaches the projection through `text`', () => {
  const cq = resolveComparableQuantity({
    name: 'Apple Royal Gala Brazil',
    text: 'تفاح رويال جالا برازيلي للكيلو apple royal gala brazil per kg',
  });
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS);
  assert.equal(cq.source, 'price_basis:text');
});

test('v3 · a caller supplying no `unit`/`text` gets exactly v2 quantity behaviour', () => {
  // The rollout guarantee: every existing call site is unchanged until it opts
  // in, except where the name or size field alone already proved a basis.
  for (const observation of [
    { size: '1.5 L', name: 'Water', packageType: 'bottle' },
    { name: 'Hisense Fridge NRF110N26S' },
    { name: 'HONOR 5G' },
    { size: '6 x 250 ml', name: 'Nadec Milk' },
  ]) {
    const cq = resolveComparableQuantity(observation);
    assert.notEqual(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS, JSON.stringify(observation));
  }
});

test('v3 · the structured path reads the basis from the OBSERVED size, not the parsed one', () => {
  // `structured.size` is parsePackageSize output and by construction holds no
  // basis — "Per Kg" produced no magnitude, which is the entire bug. If this
  // regresses, fresh produce silently returns to ABSENT.
  const structured = buildStructuredProduct({
    name_en: 'Apple Royal Gala Brazil', package_size: 'Per Kg',
  });
  const cq = comparableQuantityFromStructured(structured);
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS);
  assert.equal(cq.unit, 'kg');
});

test('v3 · both adapters agree exactly, as they did in v2', () => {
  const observation = { name_en: 'Almond Salted', package_size: null };
  const fromStructured = comparableQuantityFromStructured(
    buildStructuredProduct(observation), { unit: 'Per Kg' },
  );
  const fromRaw = resolveComparableQuantity({ name: 'Almond Salted', unit: 'Per Kg' });
  assert.deepEqual(fromStructured, fromRaw);
});

test('v3 · a currency or device spec in `unit` can never resolve a quantity', () => {
  for (const unit of ['SAR', 'AED', 'watts', 'mah', 'oz', 'sqft']) {
    assert.equal(
      resolveComparableQuantity({ name: 'Mystery Item', unit }).status,
      COMPARABLE_QUANTITY_STATUS.ABSENT,
      unit,
    );
  }
});


// --- v4 · REFERENCE QUANTITY / SELLING MODE / EVIDENCE -------------------------
// Three orthogonal facts. The tests below are written to fail if any of them
// starts encoding another.

test('v4 · the reference is the denominator, in the unit a shopper compares in', () => {
  const cases = [
    [{ size: '330 ml', name: 'Water 330 ml' },      { quantity: 0.33, unit: 'l' }],
    [{ size: '6 x 250 ml', name: 'Milk' },          { quantity: 1.5,  unit: 'l' }],
    [{ name: 'Potato Bag 1.7 kg' },                 { quantity: 1.7,  unit: 'kg' }],
    [{ name: 'Almarai Halloumi 200 g' },            { quantity: 0.2,  unit: 'kg' }],
    [{ name: 'White Eggs 30 pcs' },                 { quantity: 30,   unit: 'piece' }],
    [{ size: 'Per Kg', name: 'Potato Local' },      { quantity: 1,    unit: 'kg' }],
    [{ unit: 'per 500 gm', name: 'Olives' },        { quantity: 0.5,  unit: 'kg' }],
    [{ name: 'Iceberg Lettuce/pc' },                { quantity: 1,    unit: 'piece' }],
  ];
  for (const [observation, expected] of cases) {
    assert.deepEqual(
      resolveComparableQuantity(observation).reference, expected, JSON.stringify(observation),
    );
  }
});

test('v4 · the comparison goal, end to end: same family, correct ranking', () => {
  const up = (observation, price) =>
    unitPriceFromReference(price, resolveComparableQuantity(observation).reference);

  const eggs30 = up({ name: 'White Eggs 30 pcs' }, 15);
  const eggs12 = up({ name: 'White Eggs 12 pcs' }, 7);
  assert.equal(eggs30.unit, eggs12.unit, 'both egg packs must compare in ONE unit');
  assert.equal(eggs30.value, 0.5);
  assert.ok(Math.abs(eggs12.value - 0.5833) < 0.001);
  assert.ok(eggs30.value < eggs12.value, 'the 30-pack is the better value');

  const loose = up({ size: 'Per Kg', name: 'Potato Local' }, 4);
  const bag = up({ name: 'Potato Bag 1.7 kg' }, 7);
  assert.equal(loose.unit, bag.unit, 'loose and packaged potatoes must compare in ONE unit');
  assert.equal(loose.value, 4);
  assert.ok(Math.abs(bag.value - 4.1176) < 0.001);
  assert.ok(loose.value < bag.value, 'loose is the better value');
});

test('v4 · a reference exists exactly when arithmetic is honest', () => {
  const none = [
    { name: 'Fresh Tomato', packageType: 'bag' },        // container, no magnitude
    { name: 'Samsung 65 inch TV', nonGrocery: true },    // one indivisible item
    { name: 'Fresh Tomato' },                            // nothing at all
    { size: "6's", name: 'Indomie Noodles' },            // weak count
  ];
  for (const observation of none) {
    const cq = resolveComparableQuantity(observation);
    assert.equal(cq.reference, null, JSON.stringify(observation));
    assert.equal(cq.unitPriceComparable, false, JSON.stringify(observation));
    assert.equal(unitPriceFromReference(10, cq.reference), null, JSON.stringify(observation));
  }
});

test('v4 · `unitPriceComparable` is DERIVED and can no longer contradict itself', () => {
  // The v3 defect this replaces: the flag and the pricing function disagreed
  // about a "40's" pack — one said arithmetic was possible, the other refused.
  for (const observation of [
    { size: '330 ml' }, { size: "40's" }, { name: 'Potato Local', size: 'Per Kg' },
    { name: 'Fresh Tomato', packageType: 'bag' }, { name: 'Nothing' },
  ]) {
    const cq = resolveComparableQuantity(observation);
    assert.equal(cq.unitPriceComparable, cq.reference != null, JSON.stringify(observation));
  }
});

test('v4 · sellingMode is orthogonal to the reference unit', () => {
  // The reason the enum is two values and not four: 'weight'/'volume' would be
  // `reference.unit` restated. Each mode must be reachable with more than one
  // unit, or it is not an independent axis.
  const seen = new Map();
  for (const observation of [
    { name: 'White Eggs 30 pcs' },
    { name: 'Potato Bag 1.7 kg' },
    { size: '1 L', name: 'Almarai Milk' },
    { size: 'Per Kg', name: 'Potato Local' },
    { name: 'Olive Oil Per Litre' },
    { name: 'Iceberg Lettuce/pc' },
  ]) {
    const cq = resolveComparableQuantity(observation);
    const units = seen.get(cq.sellingMode) || new Set();
    units.add(cq.reference?.unit ?? null);
    seen.set(cq.sellingMode, units);
  }
  assert.ok(seen.get(SELLING_MODE.DISCRETE).size >= 3, 'discrete spans several units');
  assert.ok(seen.get(SELLING_MODE.CONTINUOUS).size >= 2, 'continuous spans several units');
});

test('v4 · only a mass/volume price basis is CONTINUOUS', () => {
  // You cannot buy "one 1 kg" as an object; you can buy one lettuce. A per-piece
  // basis is therefore discrete, and so is anything with a printed package.
  assert.equal(resolveComparableQuantity({ size: 'Per Kg', name: 'Potato' }).sellingMode, SELLING_MODE.CONTINUOUS);
  assert.equal(resolveComparableQuantity({ name: 'Iceberg Lettuce/pc' }).sellingMode, SELLING_MODE.DISCRETE);
  assert.equal(resolveComparableQuantity({ size: '330 ml', name: 'Water' }).sellingMode, SELLING_MODE.DISCRETE);
  // "Garlic Bag Small /Pc" — a live offer that is a BAG priced PER PIECE. The
  // mode says discrete; what it is packed IN stays package_type's question, and
  // a mode value of 'piece' would have mis-stated it.
  const bag = resolveComparableQuantity({ name: 'Garlic Bag Small /Pc', packageType: 'bag' });
  assert.equal(bag.sellingMode, SELLING_MODE.DISCRETE);
  assert.deepEqual(bag.reference, { quantity: 1, unit: 'piece' });
});

test('v4 · a reference is never a purchased quantity', () => {
  // Loose potatoes at 4 SAR/kg have a 1 kg reference; a 1.7 kg bag has a 1.7 kg
  // reference. Neither says how much the shopper buys, and the bag'''s reference
  // equalling its contents is a coincidence of packaging, not an identity.
  const loose = resolveComparableQuantity({ size: 'Per Kg', name: 'Potato Local' });
  const bag = resolveComparableQuantity({ name: 'Potato Bag 1.7 kg' });
  assert.deepEqual(loose.reference, { quantity: 1, unit: 'kg' });
  assert.deepEqual(bag.reference, { quantity: 1.7, unit: 'kg' });
  assert.equal(loose.sellingMode, SELLING_MODE.CONTINUOUS);
  assert.equal(bag.sellingMode, SELLING_MODE.DISCRETE);
  // Same reference unit, opposite selling modes: the two axes do not track.
  assert.equal(loose.reference.unit, bag.reference.unit);
});

test('v4 · MEASURED: a magnitude-bearing basis never contradicts its size field', () => {
  // All 44 live "per N unit" rows carry a size field stating the SAME magnitude
  // ("per 500 gm" beside "500 gm"), so the same-field precedence rule and the
  // basis agree and no contradiction has to be adjudicated. Pinned because the
  // obvious hypothetical — "per 100 g sold in a 400 g tub" — does NOT occur, and
  // inventing a rule for it would be tuning against imagination.
  const cq = resolveComparableQuantity({
    unit: 'per 500 gm', size: '500 gm', name: 'Mixed Nuts Plain & Roasted Per 500 gm',
  });
  assert.deepEqual(cq.reference, { quantity: 0.5, unit: 'kg' });
  // With no size field beside it, the basis carries the magnitude alone.
  const alone = resolveComparableQuantity({ unit: 'per 500 gm', name: 'Mixed Nuts' });
  assert.deepEqual(alone.reference, { quantity: 0.5, unit: 'kg' });
});

test('v4 · the shared division refuses every non-reference unit', () => {
  assert.equal(unitPriceFromReference(10, { quantity: 1, unit: 'item' }), null);
  assert.equal(unitPriceFromReference(10, { quantity: 1, unit: 'bag' }), null);
  assert.equal(unitPriceFromReference(10, { quantity: 0, unit: 'kg' }), null);
  assert.equal(unitPriceFromReference(0, { quantity: 1, unit: 'kg' }), null);
  assert.equal(unitPriceFromReference(10, null), null);
});


// --- v4 · CONTRADICTED: refuse rather than guess -------------------------------

test('v4 · a genuine disagreement withholds the denominator, not the product', () => {
  // "Pears Rosemary Per KG" with `size: "10 KG"` — the size field is a PURCHASE
  // LIMIT, not a package. Preferring the package gives 1.00 SAR/kg; preferring
  // the basis gives 10.00. Measured over the 57 live disagreements, every rule
  // that picks a winner is wrong on about a third, in one direction or the
  // other — so the product is admitted and no unit price is offered.
  const cq = resolveComparableQuantity({ name: 'Pears Rosemary Per KG', size: '10 KG' });
  assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.RESOLVED, 'still a real, groupable product');
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.CONTRADICTED);
  assert.equal(cq.reference, null, 'no fabricated denominator');
  assert.equal(cq.unitPriceComparable, false);
  assert.equal(unitPriceFromReference(10, cq.reference), null);
  // The two facts disagree about the selling mode too — unknown, not guessed.
  assert.equal(cq.sellingMode, null);
  // The printed magnitude still shows on the card; only the arithmetic is held.
  assert.equal(cq.quantity, 10);
});

test('v4 · AGREEMENT is not contradiction — 204 of 261 live pairs simply agree', () => {
  // "BLACK CHANA /KG" with `size: "1 kg"` is ONE fact stated twice: both
  // readings give 5.99 SAR/kg. Refusing these would withdraw 204 unit prices
  // that were never in doubt, which is not caution, just loss.
  const cq = resolveComparableQuantity({ name: 'BLACK CHANA /KG', size: '1 kg' });
  assert.notEqual(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.CONTRADICTED);
  assert.deepEqual(cq.reference, { quantity: 1, unit: 'kg' });
  assert.equal(unitPriceFromReference(5.99, cq.reference).value, 5.99);
  // Same for a magnitude-bearing basis that restates its own size field.
  const perN = resolveComparableQuantity({
    name: 'GOLDEN CHICKEN FRESH CHICKEN BREAST FILLET', size: '900g', unit: 'per 900g',
  });
  assert.notEqual(perN.evidence, COMPARABLE_QUANTITY_EVIDENCE.CONTRADICTED);
  assert.deepEqual(perN.reference, { quantity: 0.9, unit: 'kg' });
});

test('v4 · agreement uses the SAME 3% tolerance as sizeContradicts, not a new one', () => {
  // Just inside: a 1.02 kg pack beside a per-kilo price is the same claim.
  const near = resolveComparableQuantity({ name: 'Dal /KG', size: '1.02 kg' });
  assert.notEqual(near.evidence, COMPARABLE_QUANTITY_EVIDENCE.CONTRADICTED);
  // Just outside: 1.5 kg beside a per-kilo price is a real disagreement.
  const far = resolveComparableQuantity({ name: 'Dal /KG', size: '1.5 kg' });
  assert.equal(far.evidence, COMPARABLE_QUANTITY_EVIDENCE.CONTRADICTED);
});

test('v4 · the same-field rule still wins before contradiction is considered', () => {
  // "320" is a cashew grade inside the very expression that says "/KG"; one
  // expression cannot be two facts, so there is nothing to contradict.
  const cq = resolveComparableQuantity({ name: 'CASHEW NUT SALTED W 320 /KG', size: '320 /KG' });
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.PRICE_BASIS);
  assert.deepEqual(cq.reference, { quantity: 1, unit: 'kg' });
});

test('v4 · a PIECE basis is never a contradiction — it carries no magnitude', () => {
  // An 800 g chicken priced "Each": both facts are true and only one is a
  // denominator worth having. Measure wins, as before, with no refusal.
  const cq = resolveComparableQuantity({
    unit: 'Each', size: '800 GM', name: 'ENTAJ FRESH WHOLE CHICKEN CUT UP 800 GM',
  });
  assert.equal(cq.evidence, COMPARABLE_QUANTITY_EVIDENCE.MEASURE);
  assert.deepEqual(cq.reference, { quantity: 0.8, unit: 'kg' });
});

test('v4 · contradiction NEVER changes admission — measured at 0 status changes', () => {
  // The gate and the ranker answer different questions. Withholding a
  // denominator must not un-admit a product that has a price and a name.
  for (const observation of [
    { name: 'Pears Rosemary Per KG', size: '10 KG' },
    { name: 'Tomato Per KG', size: '2 KG Per Customer' },
    { name: 'Sea Bream 200-300 /Kg', size: '300 كيلو' },
  ]) {
    const cq = resolveComparableQuantity(observation);
    assert.equal(cq.status, COMPARABLE_QUANTITY_STATUS.RESOLVED, JSON.stringify(observation));
    assert.equal(cq.reference, null, JSON.stringify(observation));
  }
});

console.log(`Comparable Quantity: ${tests} tests passed`);
