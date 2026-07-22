import {
  CANDIDATE_VERDICT, IDENTITY_CANDIDATE_STORAGE_VERSION,
  readFromIdentityCandidate, validateIdentityCandidate,
} from './candidate.js';
import { resolveIdentityCandidate, resolveOffer } from './resolver.js';
import { applyDecision } from './apply.js';
import { observationFromIdentityCandidate } from './candidate.js';
import { createMemRegistryStore } from './memstore.js';
import { handleRegistryCandidateDebug, REGISTRY_DEBUG_PATH } from './debug.js';

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  ${label}`);
  else { failures += 1; console.error(`FAIL  ${label}`); }
}

const chickenBreast = {
  brand: 'Sadia', family: 'Chicken', cut: 'Breast', processing: 'Fresh',
  variety: null, package: null, size: { value: 900, unit: 'g' }, count: 1,
};
const context = (offerId, week = '2026-07-08') => ({
  offerId, store: 'othaim', region: 'riyadh', source: 'd4d', week,
  price: 20, oldPrice: 25,
});

console.log('candidate contract:');
{
  const validation = validateIdentityCandidate(chickenBreast);
  check('exact Identity Builder shape validates', validation.valid);
  const read = readFromIdentityCandidate(chickenBreast);
  check('candidate projects to existing resolver contract',
    read.ok && read.read.tokens.includes('chicken') && read.read.tokens.includes('breast'));
  const packed = readFromIdentityCandidate({
    ...chickenBreast, size: { value: 1.5, unit: 'kg' }, count: 2,
  });
  check('canonical candidate units compare in Registry base units',
    packed.read.size.unit === 'g' && packed.read.size.each === 1500 && packed.read.size.pack === 2);
  const malformed = readFromIdentityCandidate('{bad', { version: IDENTITY_CANDIDATE_STORAGE_VERSION });
  check('malformed persisted JSON is Review evidence, never guessed',
    !malformed.ok && malformed.verdict === CANDIDATE_VERDICT.MALFORMED);
  const old = readFromIdentityCandidate(JSON.stringify(chickenBreast), { version: 'unknown-v9' });
  check('unknown contract versions do not fall back to raw fields',
    !old.ok && old.verdict === CANDIDATE_VERDICT.UNSUPPORTED_VERSION);
  const thin = readFromIdentityCandidate({ ...chickenBreast, cut: null, processing: null });
  check('brand + family + size alone is insufficient for automatic identity',
    !thin.ok && thin.verdict === CANDIDATE_VERDICT.INSUFFICIENT);
}

console.log('Registry decisions:');
{
  const store = createMemRegistryStore();
  const firstContext = context('candidate:1');
  const created = await resolveIdentityCandidate(chickenBreast, firstContext, store);
  check('no match -> New Product', created.registryOutcome === 'New Product' && created.outcome === 'create');
  const viaPreservedApi = await resolveOffer(
    { id: 'candidate:api', store: 'othaim', region: 'riyadh' }, chickenBreast, store,
  );
  check('existing resolveOffer API now accepts only the Identity Candidate contract',
    viaPreservedApi.registryOutcome === 'New Product' && viaPreservedApi.candidate.brand === 'Sadia');
  const applied = await applyDecision(
    created, observationFromIdentityCandidate(firstContext, created.candidate), store,
  );
  check('only Registry apply mints and assigns Product ID',
    applied.productId?.startsWith('pr_') && store._sightings.get('candidate:1')?.product_id === applied.productId);

  const nextContext = context('candidate:2', '2026-07-15');
  const known = await resolveIdentityCandidate(chickenBreast, nextContext, store, { includeDiagnostics: true });
  check('complete matching candidate -> Known Product',
    known.registryOutcome === 'Known Product' && known.productId === applied.productId);
  check('diagnostics carry match score and reason',
    known.matchCandidates?.some((item) => item.productId === applied.productId && item.score >= 0.7)
      && !!known.decisionReason);

  const wrongCut = { ...chickenBreast, cut: 'Thigh' };
  const separate = await resolveIdentityCandidate(wrongCut, context('candidate:3'), store);
  check('same brand and size with conflicting cut never merges', separate.registryOutcome === 'New Product');

  const thin = { ...chickenBreast, cut: null, processing: null };
  const review = await resolveIdentityCandidate(thin, context('candidate:4'), store);
  const reviewed = await applyDecision(
    review, observationFromIdentityCandidate(context('candidate:4'), review.candidate), store,
  );
  check('insufficient candidate -> Review with no trusted Product ID',
    review.registryOutcome === 'Review' && reviewed.inserted === false
      && !store._sightings.has('candidate:4'));
}

console.log('development diagnostics:');
{
  const store = createMemRegistryStore();
  const hidden = await handleRegistryCandidateDebug(
    new Request(`https://x${REGISTRY_DEBUG_PATH}`),
    { isDevelopment: false, registryStore: store },
  );
  check('debug panel is absent outside development', hidden === null);
  const response = await handleRegistryCandidateDebug(
    new Request(`https://x${REGISTRY_DEBUG_PATH}/evaluate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identityCandidate: chickenBreast }),
    }),
    { isDevelopment: true, registryStore: store },
  );
  const diagnostics = await response.json();
  check('dev diagnostics expose required decision fields without writes',
    response.status === 200 && diagnostics.outcome === 'New Product'
      && Array.isArray(diagnostics.registryMatchCandidates)
      && diagnostics.assignedProductId === null
      && Number.isFinite(diagnostics.processingTimeMs)
      && store._products.size === 0);
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('\nAll Registry candidate integration tests passed.');
