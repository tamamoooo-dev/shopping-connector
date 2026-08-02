import assert from 'node:assert/strict';
import {
  PRICE_BASIS_STATUS,
  PRICE_BASIS_VERSION,
  resolvePriceBasis,
} from './priceBasis.js';
import { unitPriceFromReference } from './comparableQuantity.js';

let tests = 0;
const test = (name, fn) => {
  fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Price Basis:');

// --- the nine production pattern classes ---------------------------------------
// Every example below is a verbatim string from production D1 (2026-08-01).

test('A · the size field holding nothing but a basis expression', () => {
  // 383 production rows. `offer_enrichments.size = "Per Kg"` on a fresh apple.
  const b = resolvePriceBasis({ size: 'Per Kg', name: 'Apple Royal Gala Brazil' });
  assert.equal(b.status, PRICE_BASIS_STATUS.RESOLVED);
  assert.equal(b.unit, 'kg');
  assert.equal(b.quantity, 1);
  assert.equal(b.source, 'size_field');
});

test('A · the extractor unit field holding the basis alone', () => {
  // 736 rows carry the basis ONLY here.
  assert.equal(resolvePriceBasis({ unit: 'KG', name: 'BARHY RUTAB' }).unit, 'kg');
  assert.equal(resolvePriceBasis({ unit: 'Per Kg', name: 'ALMOND SALTED' }).unit, 'kg');
  assert.equal(resolvePriceBasis({ unit: 'KILO', name: 'FRESH VEAL - BONE IN' }).unit, 'kg');
});

test('A · parenthetical, slash and per-word markers in the name', () => {
  assert.equal(resolvePriceBasis({ name: 'GALA APPLES (KG)' }).unit, 'kg');
  assert.equal(resolvePriceBasis({ name: 'Ajwa Dates Box /Kg' }).unit, 'kg');
  assert.equal(resolvePriceBasis({ name: 'Ringa (Herring) Per kg' }).unit, 'kg');
  assert.equal(resolvePriceBasis({ name: 'Chicken Shawarma, Assorted Items KILO' }).unit, 'kg');
});

test('A · a bare trailing KG resolves only when no package magnitude exists', () => {
  assert.equal(resolvePriceBasis({ name: 'SALMON FILLET KG' }).unit, 'kg');
  // "AL OSRA SUGAR ASSORTED 10KG" is a ten-kilo bag, not a per-kilo price. The
  // caller reports that parsePackageSize resolved a magnitude, and the bare
  // rule stands down. This single flag is what keeps class A from eating the
  // entire grocery catalogue.
  assert.equal(
    resolvePriceBasis({ name: 'AL OSRA SUGAR ASSORTED 10KG', size: '10KG', sizeResolved: true }).status,
    PRICE_BASIS_STATUS.ABSENT,
  );
});

test('B · per-piece basis in every observed spelling', () => {
  assert.equal(resolvePriceBasis({ name: 'Iceberg Lettuce/pc' }).unit, 'piece');
  assert.equal(resolvePriceBasis({ name: 'Marble Donuts (Pc)' }).unit, 'piece');
  assert.equal(resolvePriceBasis({ name: 'Pineapple Per Pcs' }).unit, 'piece');
  assert.equal(resolvePriceBasis({ name: 'PINEAPPLE (KENYA)/PC' }).unit, 'piece');
});

test('C · a per-N-unit basis keeps its magnitude, normalised to kilograms', () => {
  // "Per 500 gm" is NOT a 500 g pack and NOT a per-kilo price. 16 production
  // rows; getting this wrong is a 2x error in either direction.
  const b = resolvePriceBasis({ unit: 'per 500 gm', name: 'Kalamata Olives' });
  assert.equal(b.unit, 'kg');
  assert.equal(b.quantity, 0.5);
  assert.equal(resolvePriceBasis({ unit: 'per 100g' }).quantity, 0.1);
  assert.equal(resolvePriceBasis({ unit: 'per 400gm' }).quantity, 0.4);
});

test('D · a grade number beside the marker never becomes a magnitude', () => {
  // The 144-offer wrong-unit-price class. "200-300" is a fish grade (pieces per
  // kilo) and "W320" a cashew grade; parseSize read both as a package size and
  // produced unit prices wrong by 300x. The basis is read from the "/Kg" alone.
  for (const name of [
    'Sea Bream 200-300 /Kg',
    'Cashew Nut Normal/ Roasted W320/Kg',
    'FRESH SHRIMPS 40 / 60 (KG)',
    'ALMOND 27-30 /KG',
  ]) {
    const b = resolvePriceBasis({ name, sizeResolved: true });
    assert.equal(b.unit, 'kg', name);
    assert.equal(b.quantity, 1, name);
  }
});

test('E · a basis and a genuine pack are both true; the basis is still the basis', () => {
  // Deli counter: sold by the kilo, packed in 500 g tubs. Note sizeResolved is
  // true — the explicit "/Kg" rule fires anyway, because an explicit per-form is
  // never ambiguous with a package size.
  const b = resolvePriceBasis({ name: 'Lemon Pickle/Kg', size: '500 gm', sizeResolved: true });
  assert.equal(b.unit, 'kg');
  assert.equal(b.quantity, 1);
});

test('F · the Arabic OCR channel, explicit markers only', () => {
  // 650 per-kg and 249 per-piece production rows state the basis nowhere else.
  const kg = resolvePriceBasis({
    name: 'Apple Royal Gala Brazil',
    text: 'تفاح رويال جالا برازيلي للكيلو apple royal gala brazil per kg',
  });
  assert.equal(kg.unit, 'kg');
  assert.equal(kg.source, 'text');
  assert.equal(resolvePriceBasis({ text: 'موز اصغر للحبة' }).unit, 'piece');
  // A bare unit word in free text is NOT enough — retailer copy is full of them.
  assert.equal(resolvePriceBasis({ text: 'nesto fresh fruits kg' }).status, PRICE_BASIS_STATUS.ABSENT);
});

test('G · other per-forms that are not a supported basis stay ABSENT', () => {
  // "per box", "per tray", "per dozen", "per meter" are real basis expressions
  // with no comparable denominator in this project (matching.js has no metre and
  // no dozen). Refused, not approximated.
  for (const name of ['Sweet Potato Per Box', 'Cable Per Meter', 'Eggs Per Dozen']) {
    assert.equal(resolvePriceBasis({ name }).status, PRICE_BASIS_STATUS.ABSENT, name);
  }
});

test('H · currencies and device specifications can never become a basis', () => {
  // The reason the classifier is an allow-list. Every value below appears in the
  // production `unit` field; a permissive reader emits "SAR/SAR", "SAR/watt".
  for (const unit of ['SAR', 'AED', 'sfr', 'watts', 'w', 'mah', 'btu', 'sqft', 'meter', 'oz', 'ton', 'k', 'mi']) {
    assert.equal(resolvePriceBasis({ unit }).status, PRICE_BASIS_STATUS.ABSENT, unit);
  }
});

test('H · bare size units are size units, never a per-gram price', () => {
  // `unit: "g"` (793 rows), "ml" (652), "gm" (486), "L" (270) mean "the unit of
  // the package size". No flyer in the corpus prices by the gram or millilitre.
  for (const unit of ['g', 'gm', 'gr', 'ml', 'l', 'ltr', 'gram', 'grams']) {
    assert.equal(resolvePriceBasis({ unit }).status, PRICE_BASIS_STATUS.ABSENT, unit);
  }
});

test('I · Arabic-Indic digits and Farsi letter forms fold before reading', () => {
  assert.equal(resolvePriceBasis({ unit: 'per ٥٠٠ جرام' }).quantity, 0.5);
  assert.equal(resolvePriceBasis({ name: 'Sea Bream ٣٠٠-٤٠٠ /كيلو' }).unit, 'kg');
});

// --- discipline ----------------------------------------------------------------

test('nothing at all is ABSENT, never a guess', () => {
  assert.equal(resolvePriceBasis().status, PRICE_BASIS_STATUS.ABSENT);
  assert.equal(resolvePriceBasis({ name: 'Fresh Tomato' }).status, PRICE_BASIS_STATUS.ABSENT);
  assert.equal(resolvePriceBasis({ name: 'Arwa Water 330 ml' }).status, PRICE_BASIS_STATUS.ABSENT);
});

test('an EXPLICIT marker outranks a bare unit word in an earlier field', () => {
  // Evidence quality beats field precedence: "/pc" can only be a basis, while a
  // bare `unit: "KG"` is just as likely to be naming the unit of a magnitude.
  const b = resolvePriceBasis({ unit: 'KG', name: 'Iceberg Lettuce/pc' });
  assert.equal(b.source, 'name');
  assert.equal(b.unit, 'piece');
  // Field precedence still decides between two equally explicit readings.
  assert.equal(resolvePriceBasis({ unit: 'per kg', name: 'Donuts (Pc)' }).source, 'unit_field');
});

test('a bare unit word stands down as soon as a package magnitude exists', () => {
  // MEASURED 2026-08-01: without this, 19 live offers — "AL OSRA SUGAR 10KG"
  // with `unit: "KG"`, "Anchor Milk Powder 2.25 Kg" with `unit: "Kg"` — flipped
  // to a per-kilo price they do not have. The `unit` field there is naming the
  // unit OF the magnitude, which is its commonest meaning in the corpus.
  const asPack = resolvePriceBasis({
    unit: 'KG', size: '10KG', name: 'AL OSRA SUGAR ASSORTED 10KG', sizeResolved: true,
  });
  assert.equal(asPack.status, PRICE_BASIS_STATUS.ABSENT);
  // The same fields with no magnitude anywhere DO yield a basis.
  assert.equal(resolvePriceBasis({ unit: 'KG', name: 'BARHY RUTAB' }).unit, 'kg');
});

test('output is frozen, version-stamped and deterministic', () => {
  const once = resolvePriceBasis({ size: 'Per Kg' });
  const twice = resolvePriceBasis({ size: 'Per Kg' });
  assert.deepEqual(once, twice);
  assert.equal(once.version, PRICE_BASIS_VERSION);
  assert.ok(Object.isFrozen(once));
});

// --- a basis IS a reference quantity -------------------------------------------
// v4 deleted this module's own `unitPriceFromBasis()`. A stated denominator is
// not a second kind of unit price with a second formula — it is a reference
// quantity like any other, and ONE division turns any of them into a price.

test('a per-unit price IS the unit price — the shared division, no special case', () => {
  const b = resolvePriceBasis({ size: 'Per Kg' });
  assert.deepEqual(
    unitPriceFromReference(7.99, { quantity: b.quantity, unit: b.unit }),
    { value: 7.99, unit: 'kg', label: 'SAR/kg' },
  );
});

test('a per-N basis divides by the amount the price buys', () => {
  const b = resolvePriceBasis({ unit: 'per 500 gm' });
  assert.equal(b.quantity, 0.5);
  assert.equal(unitPriceFromReference(9.95, { quantity: b.quantity, unit: b.unit }).value, 19.9);
});

test('a per-piece basis prices the piece', () => {
  const b = resolvePriceBasis({ name: 'Iceberg Lettuce/pc' });
  assert.deepEqual(
    unitPriceFromReference(4.5, { quantity: b.quantity, unit: b.unit }),
    { value: 4.5, unit: 'piece', label: 'SAR/Piece' },
  );
});

test('the reader emits units the shared division already understands', () => {
  // No translation layer between this module and the arithmetic: if these ever
  // diverge, every basis-priced offer silently loses its unit price.
  for (const [obs, unit] of [
    [{ size: 'Per Kg' }, 'kg'],
    [{ name: 'Oil Per Litre' }, 'l'],
    [{ name: 'Lettuce /Pc' }, 'piece'],
  ]) {
    const b = resolvePriceBasis(obs);
    assert.equal(b.unit, unit);
    assert.ok(unitPriceFromReference(10, { quantity: b.quantity, unit: b.unit }), unit);
  }
});

console.log(`Price Basis: ${tests} tests passed`);
