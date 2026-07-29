import assert from 'node:assert/strict';
import {
  EXTRACTION_PROVENANCE,
  applyHumanReview,
  isSelfEvidencingProvenance,
  mergeValidatedExtractions,
} from './smartExtraction.js';
import { validatedExtractionCorroboration } from './enrich.js';

let tests = 0;
const test = (name, fn) => {
  fn();
  tests += 1;
  console.log(`  ok  ${name}`);
};

console.log('Human provenance (R1, C-7):');

const field = (status, value) => ({ status, value, candidate: value, reasons: [] });

const visionValidation = {
  confidence: 0.9,
  fields: {
    name_en: field('Accepted', 'Almarai Milk 1 L'),
    name_ar: field('Accepted', 'حليب المراعي'),
    brand: field('Accepted', 'Almarai'),
    size: field('Accepted', '1 L'),
    pack_count: field('Missing', null),
  },
  acceptedFields: ['name_en', 'name_ar', 'brand', 'size'],
};
const emptyOcr = {
  confidence: null,
  fields: {
    name_en: field('NotInvoked', null),
    name_ar: field('NotInvoked', null),
    brand: field('NotInvoked', null),
    size: field('NotInvoked', null),
    pack_count: field('NotInvoked', null),
  },
  acceptedFields: [],
};

// The downstream contract re-keys provenance from validation field names to
// output field names, exactly as `finalizeValidatedExtraction` does.
const resultFor = (merge) => ({
  extraction: {
    productName: merge.final.name_en,
    arabicName: merge.final.name_ar,
  },
  provenance: {
    brand: merge.provenance.brand,
    productName: merge.provenance.name_en,
    arabicName: merge.provenance.name_ar,
    size: merge.provenance.size,
    packCount: merge.provenance.pack_count,
  },
  diagnostics: {
    visionRequests: 1,
    acceptedVisionFieldsOverwritten: merge.acceptedVisionFieldsOverwritten,
    validationResult: visionValidation,
    ocrValidationResult: emptyOcr,
  },
});

test('Human is a declared provenance, and the only self-evidencing one', () => {
  assert.equal(EXTRACTION_PROVENANCE.HUMAN, 'Human');
  assert.equal(isSelfEvidencingProvenance('Human'), true);
  assert.equal(isSelfEvidencingProvenance('Vision'), false);
  assert.equal(isSelfEvidencingProvenance('OCR'), false);
  assert.equal(isSelfEvidencingProvenance('Null'), false);
});

test('THE BUG R1 DESCRIBES: without it a reviewed row is non-servable', () => {
  // Reconstructs the pre-fix behaviour exactly: a Human-provenance name checked
  // against a validator accepted-set that has no Human key.
  const accepted = { Vision: new Set(['name_en']), OCR: new Set() };
  const source = 'Human';
  assert.equal(accepted[source]?.has('name_en'), undefined);
  assert.ok(!accepted[source]?.has('name_en'), 'which is falsy, so the gate returned null');
});

test('a human-edited name IS servable', () => {
  const merge = applyHumanReview(
    mergeValidatedExtractions(visionValidation, emptyOcr),
    { fields: { name_en: 'Almarai Fresh Milk 1 L' }, actor: 'dev@example', at: '2026-07-26T00:00:00Z' },
  );
  assert.equal(merge.provenance.name_en, EXTRACTION_PROVENANCE.HUMAN);
  assert.equal(validatedExtractionCorroboration(resultFor(merge)), 1);
});

test('a human may override an ACCEPTED Vision field (C-7)', () => {
  // The defect class this exists to fix: a confident, well-formed misread.
  const base = mergeValidatedExtractions(visionValidation, emptyOcr);
  assert.equal(base.provenance.size, EXTRACTION_PROVENANCE.VISION);
  const merge = applyHumanReview(base, { fields: { size: '5 kg' }, actor: 'dev@example' });
  assert.equal(merge.final.size, '5 kg');
  assert.equal(merge.provenance.size, EXTRACTION_PROVENANCE.HUMAN);
  assert.equal(validatedExtractionCorroboration(resultFor(merge)), 1, 'and stays servable');
});

test('the override is RECORDED, never silent (P15)', () => {
  const merge = applyHumanReview(
    mergeValidatedExtractions(visionValidation, emptyOcr),
    { fields: { size: '5 kg' }, actor: 'dev@example', at: '2026-07-26T00:00:00Z' },
  );
  assert.deepEqual([...merge.humanOverrides], [{
    field: 'size',
    value: '5 kg',
    previousValue: '1 L',
    previousProvenance: EXTRACTION_PROVENANCE.VISION,
  }]);
  assert.equal(merge.humanReview.actor, 'dev@example');
  assert.equal(merge.humanReview.at, '2026-07-26T00:00:00Z');
  assert.deepEqual([...merge.humanReview.fields], ['size']);
});

test('the review layer is ADDITIVE — the machine merge is untouched (P2)', () => {
  const base = mergeValidatedExtractions(visionValidation, emptyOcr);
  const snapshot = JSON.parse(JSON.stringify(base));
  applyHumanReview(base, { fields: { size: '5 kg', name_en: 'Something Else' } });
  assert.deepEqual(JSON.parse(JSON.stringify(base)), snapshot, 'no mutation of the input');
});

test('an absent key is not an edit — one field reviewed cannot blank the rest', () => {
  const merge = applyHumanReview(
    mergeValidatedExtractions(visionValidation, emptyOcr),
    { fields: { size: '5 kg' } },
  );
  assert.equal(merge.final.name_en, 'Almarai Milk 1 L');
  assert.equal(merge.final.name_ar, 'حليب المراعي');
  assert.equal(merge.provenance.brand, EXTRACTION_PROVENANCE.VISION);
  assert.equal(merge.humanOverrides.length, 1);
});

test('an explicit null clears a field and records what it cleared', () => {
  const merge = applyHumanReview(
    mergeValidatedExtractions(visionValidation, emptyOcr),
    { fields: { brand: null } },
  );
  assert.equal(merge.final.brand, null);
  assert.equal(merge.provenance.brand, EXTRACTION_PROVENANCE.NULL);
  assert.equal(merge.humanOverrides[0].previousValue, 'Almarai');
});

test('MACHINE immutability is unchanged by C-7', () => {
  // OCR still may not overwrite an accepted Vision field: the merge throws on
  // violation, and that path is untouched.
  const conflictingOcr = {
    ...emptyOcr,
    fields: { ...emptyOcr.fields, name_en: field('Accepted', 'Something Different') },
    acceptedFields: ['name_en'],
  };
  const merge = mergeValidatedExtractions(visionValidation, conflictingOcr);
  assert.equal(merge.final.name_en, 'Almarai Milk 1 L', 'Vision wins');
  assert.equal(merge.provenance.name_en, EXTRACTION_PROVENANCE.VISION);
  assert.deepEqual(merge.ignoredOcrConflicts, [
    { field: 'name_en', visionValue: 'Almarai Milk 1 L', ignoredOcrValue: 'Something Different' },
  ]);
});

test('a machine provenance still requires validator agreement', () => {
  const merge = mergeValidatedExtractions(visionValidation, emptyOcr);
  const tampered = resultFor(merge);
  tampered.diagnostics.validationResult = { ...visionValidation, acceptedFields: ['brand'] };
  assert.equal(
    validatedExtractionCorroboration(tampered), null,
    'an unvalidated Vision name must never be servable',
  );
});

test('re-applying the same human edit is idempotent', () => {
  const once = applyHumanReview(
    mergeValidatedExtractions(visionValidation, emptyOcr), { fields: { size: '5 kg' } },
  );
  const twice = applyHumanReview(once, { fields: { size: '5 kg' } });
  assert.equal(twice.final.size, '5 kg');
  assert.deepEqual([...twice.humanOverrides], [], 'no second override recorded');
});

console.log(`Human provenance: ${tests} tests passed`);
