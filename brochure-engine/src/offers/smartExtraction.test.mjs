// Offline contract tests for the production Smart Vision extraction pipeline.

import {
  EXTRACTION_STRATEGIES,
  normalizeExtractionStrategy,
  parseVisiblePackCount,
  validateVisionOutput,
  validateOcrOutput,
  mergeValidatedExtractions,
  runSmartExtraction,
} from './smartExtraction.js';
import { validatedExtractionCorroboration } from './enrich.js';

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}`);
  }
}

const completeVision = {
  name_en: 'Sadia Tender Chicken Breasts',
  name_ar: 'ساديا صدور دجاج طرية',
  brand: 'Sadia',
  size: '900 g',
  confidence: 0.01,
};

console.log('strategy configuration:');
check('Vision First is the default', normalizeExtractionStrategy() === EXTRACTION_STRATEGIES.VISION_FIRST);
check('human-readable OCR First is accepted', normalizeExtractionStrategy('OCR First') === EXTRACTION_STRATEGIES.OCR_FIRST);
check('invalid configuration safely falls back', normalizeExtractionStrategy('surprise-me') === EXTRACTION_STRATEGIES.VISION_FIRST);

console.log('Vision validation:');
const complete = validateVisionOutput(completeVision);
check('complete valid observation skips OCR despite low confidence', !complete.ocrRequired && complete.acceptedFields.length === 4);
const optionalSize = validateVisionOutput({ ...completeVision, size: null });
check('absent optional size without visible evidence skips OCR', !optionalSize.ocrRequired);
const missingEnglish = validateVisionOutput({ ...completeVision, name_en: null });
check('missing English observation triggers OCR recovery', missingEnglish.triggerReasons.includes('english_product_name_missing_or_invalid'));
const visibleSize = validateVisionOutput({ ...completeVision, name_en: 'Sadia Chicken 900 g', size: null });
check('missing separately-visible size triggers OCR', visibleSize.triggerReasons.includes('size_missing_with_direct_vision_text_evidence'));
const missingBrand = validateVisionOutput({ ...completeVision, brand: null });
check('missing brand triggers OCR', missingBrand.triggerReasons.includes('brand_missing_or_invalid'));
const malformed = validateVisionOutput(null, { usable: false, error: 'bad JSON' });
check('malformed Vision triggers deterministic fallback', malformed.triggerReasons.includes('malformed_or_unusable_vision'));
const invalid = validateVisionOutput({ ...completeVision, name_en: 'SAR 19.99', size: 'enormous' });
check('invalid fields are rejected without repair', invalid.rejectedFields.includes('name_en') && invalid.rejectedFields.includes('size'));
const specificationSize = validateVisionOutput({ ...completeVision, size: '800 Watts' });
check('unsupported optional specification does not trigger OCR by itself', specificationSize.rejectedFields.includes('size') && !specificationSize.ocrRequired);
const impossible = validateVisionOutput({ ...completeVision, name_en: 'Sadia ساديا', name_ar: 'Sadia ساديا' });
check('impossible bilingual duplication is rejected', impossible.rejectedFields.includes('name_en') && impossible.rejectedFields.includes('name_ar'));

// Expanded JSON schema (FROZEN production baseline, 2026-07-25): the same
// validation rules, reached through the renamed observation fields.
const expanded = validateVisionOutput({
  name_en: 'Sadia Tender Chicken Breasts', name_ar: 'ساديا صدور دجاج طرية',
  brand: 'Sadia', package_size: '900 g', quantity: '10+2',
  unit: 'g', package_type: 'pack', attributes: ['frozen'], confidence: 0.01,
});
check('package_size validates as size', expanded.fields.size.value === '900 g');
check('quantity validates as pack_count, expression preserved',
  expanded.fields.pack_count.value === '10+2' && expanded.packCountEvidence.count === 12);
check('Expanded JSON needs no OCR escalation', !expanded.ocrRequired);
check('unmapped Expanded JSON fields are not extraction candidates',
  !('unit' in expanded.fields) && !('package_type' in expanded.fields) && !('attributes' in expanded.fields));
const legacyStillWins = validateVisionOutput({ ...completeVision, size: '900 g', package_size: '2 L' });
check('a legacy size key still takes priority over its alias', legacyStillWins.fields.size.value === '900 g');

console.log('visible package-count extraction:');
check('6×200 ml multiplier is extracted', parseVisiblePackCount('6×200 ml')?.count === 6);
check('10+2 bonus count is additive', parseVisiblePackCount('10+2')?.count === 12);
check('3 Pack expression is extracted', parseVisiblePackCount('3 Pack')?.count === 3);
check('Buy 2 Get 1 expression is additive', parseVisiblePackCount('Buy 2 Get 1')?.count === 3);
check("100's count expression is extracted", parseVisiblePackCount("Tea Bags 100's")?.count === 100);
check('30s compact count expression is extracted', parseVisiblePackCount('Plastic Tray 30s')?.count === 30);
check('usage duration is not a package count', parseVisiblePackCount('30 NIGHTS') === null);
check('reverse 200 ml x 6 multiplier is extracted', parseVisiblePackCount('200 ml x 6')?.count === 6);
const derivedPack = validateVisionOutput({ ...completeVision, size: '12 x 23g' });
check('pack count is recovered deterministically from accepted Vision size', derivedPack.fields.pack_count.value === '12 x' && derivedPack.fields.pack_count.count === 12);
const conflictingPack = validateVisionOutput({ ...completeVision, size: '5X145g', pack_count: '1 PC' });
check('embedded package evidence wins over a conflicting model field', conflictingPack.fields.pack_count.value === '5X' && conflictingPack.fields.pack_count.count === 5);
const countSize = validateVisionOutput({ ...completeVision, size: null, pack_count: '18 Pcs' });
check('visible piece count also populates count-based size', countSize.fields.size.value === '18 Pcs' && countSize.fields.pack_count.value === '18 Pcs');
const misplacedSize = validateVisionOutput({ ...completeVision, size: null, pack_count: '80g Each' });
check('misplaced visible measurement repairs only the missing size field', misplacedSize.fields.size.value === '80g Each' && misplacedSize.fields.pack_count.status === 'Rejected' && !misplacedSize.ocrRequired);
const contextualBareCount = validateVisionOutput({ ...completeVision, size: '140g', pack_count: '5' });
check('bare pack count is accepted only beside a measured unit', contextualBareCount.fields.pack_count.value === '5' && contextualBareCount.fields.pack_count.count === 5);
const uncontextualBareCount = validateVisionOutput({ ...completeVision, size: null, pack_count: '12' });
check('bare count without measured context remains rejected', uncontextualBareCount.fields.pack_count.status === 'Rejected');

console.log('OCR admission and immutable merge:');
const ocr = validateOcrOutput([
  '# Different Brand Product',
  '# منتج علامة مختلف',
  '1 kg',
].join('\n'));
check('OCR confidence is derived from validated OCR coverage', ocr.confidence === 0.9
  && ocr.confidenceMethod === 'validated-visible-field-coverage-v1');
const merged = mergeValidatedExtractions(complete, ocr);
check('accepted Vision product name is immutable', merged.final.name_en === completeVision.name_en && merged.provenance.name_en === 'Vision');
check('accepted Vision size is immutable', merged.final.size === completeVision.size && merged.provenance.size === 'Vision');
check('OCR conflicts are diagnostic only', merged.acceptedVisionFieldsOverwritten === 0 && merged.ignoredOcrConflicts.length > 0);
const brandRecovery = mergeValidatedExtractions(missingBrand, validateOcrOutput('# Sadia Chicken\n# دجاج ساديا'));
check('OCR fills only a missing Vision field', brandRecovery.final.brand === 'Sadia' && brandRecovery.provenance.brand === 'OCR');
const ocrPack = validateOcrOutput('# Water 200 ml x 6\n# مياه ٢٠٠ مل × ٦');
check('OCR fallback extracts visible package count', ocrPack.fields.pack_count.status === 'Accepted'
  && parseVisiblePackCount(ocrPack.fields.pack_count.value, { allowStandaloneMultiplier: true })?.count === 6);

console.log('pipeline orchestration:');
{
  let ocrCalls = 0;
  const result = await runSmartExtraction({
    runVision: async () => ({ parsedObject: completeVision, rawReply: JSON.stringify(completeVision) }),
    runOcr: async () => { ocrCalls += 1; return { rawOutput: '# should not run' }; },
  });
  check('Vision First accepts complete output without OCR', ocrCalls === 0 && !result.diagnostics.ocrTriggered);
  check('request counters are exact', result.diagnostics.visionRequests === 1 && result.diagnostics.ocrRequests === 0);
  check('all output fields carry provenance', Object.values(result.provenance).every((source) => source === 'Vision' || source === 'Null'));
}
{
  const packedVision = { ...completeVision, size: '6×200 ml', pack_count: '6×' };
  const result = await runSmartExtraction({
    runVision: async () => ({ parsedObject: packedVision, rawReply: JSON.stringify(packedVision) }),
    runOcr: async () => ({ rawOutput: '# should not run' }),
  });
  check('structured extraction exposes pack expression and numeric count', result.extraction.packCount === '6×' && result.extraction.count === 6);
  check('pack expression provenance remains Vision', result.provenance.packCount === 'Vision' && result.provenance.count === 'Vision');
}
{
  const result = await runSmartExtraction({
    strategy: 'vision-first',
    runVision: async () => ({ parsedObject: { ...completeVision, brand: null }, rawReply: '{}' }),
    runOcr: async () => ({ rawOutput: '# Sadia Chicken\n# دجاج ساديا' }),
  });
  check('validation invokes OCR for incomplete Vision', result.diagnostics.ocrTriggered && result.diagnostics.triggerReason.includes('brand_missing_or_invalid'));
  check('fallback provenance identifies the recovered field', result.extraction.brand === 'Sadia' && result.provenance.brand === 'OCR');
  check('Vision-confirmed fields remain Vision-owned', result.extraction.productName === completeVision.name_en && result.provenance.productName === 'Vision');
}
{
  const { confidence: _omitted, ...visionWithoutConfidence } = completeVision;
  const result = await runSmartExtraction({
    strategy: 'vision-first',
    runVision: async () => ({ parsedObject: { ...visionWithoutConfidence, brand: null }, rawReply: '{}' }),
    runOcr: async () => ({ rawOutput: '# Sadia Chicken\n# دجاج ساديا\n900 g' }),
  });
  check('Vision First confidence behavior remains Vision-derived', result.confidence === null
    && result.provenance.confidence === 'Null' && result.diagnostics.ocrValidationResult.confidence > 0);
}
{
  const counts = { vision: 0, ocr: 0 };
  const run = (strategy) => runSmartExtraction({
    strategy,
    runVision: async () => { counts.vision += 1; return { parsedObject: completeVision, rawReply: '{}' }; },
    runOcr: async () => { counts.ocr += 1; return { rawOutput: '# Sadia Chicken\n# دجاج ساديا\n900 g' }; },
  });
  await run('vision-only');
  check('Vision Only never invokes OCR', counts.vision === 1 && counts.ocr === 0);
  counts.vision = 0; counts.ocr = 0;
  const ocrOnly = await run('ocr-only');
  check('OCR Only never invokes Vision', counts.vision === 0 && counts.ocr === 1 && ocrOnly.diagnostics.strategy === 'ocr-only');
  counts.vision = 0; counts.ocr = 0;
  const ocrFirst = await run('ocr-first');
  check('OCR First invokes OCR without invoking Vision', counts.vision === 0 && counts.ocr === 1);
  check('OCR First output and confidence are entirely OCR-derived', ocrFirst.provenance.productName === 'OCR'
    && ocrFirst.provenance.confidence === 'OCR' && ocrFirst.confidence === ocrFirst.diagnostics.ocrValidationResult.confidence);
  check('OCR First passes the source-neutral canonical serving gate', validatedExtractionCorroboration(ocrFirst) === 1);
}
{
  let visionCalls = 0;
  const result = await runSmartExtraction({
    strategy: 'ocr-first',
    runOcr: async () => ({ rawOutput: '# OCR Product\n# منتج أو سي آر\n900 g' }),
    runVision: async () => { visionCalls += 1; throw new Error('complete Vision outage'); },
  });
  check('OCR First succeeds during a complete Vision outage', visionCalls === 0
    && result.extraction.productName === 'OCR Product' && result.diagnostics.visionRequests === 0);
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll Smart Vision extraction tests passed.');
