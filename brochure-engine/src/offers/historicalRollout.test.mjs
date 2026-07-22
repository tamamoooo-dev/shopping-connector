import {
  HISTORICAL_ROLLOUT_MAX_COHORT,
  rollbackHistoricalCandidateRollout,
  stageHistoricalCandidateRollout,
} from './historicalRollout.js';

let failures = 0;
const check = (label, condition) => {
  if (condition) console.log(`  ok  ${label}`);
  else { failures += 1; console.error(`FAIL  ${label}`); }
};

const rows = new Map([
  ['safe', {
    id: 'safe', name: 'Sadia Fresh Chicken Breast', name_ar: null,
    brand: 'Sadia', size: '900 g', confidence: 0.9,
    identity_candidate: null, identity_candidate_version: null,
    mint_verdict: 'too_few_tokens', has_sighting: 0,
  }],
  ['trusted', {
    id: 'trusted', name: 'Nadec Milk Full Fat', name_ar: null,
    brand: 'Nadec', size: '1 l', confidence: 0.9,
    identity_candidate: null, identity_candidate_version: null,
    mint_verdict: 'minted', has_sighting: 1,
  }],
]);
const store = {
  async historicalCandidateRows(ids) { return ids.map((id) => rows.get(id)).filter(Boolean).map((r) => ({ ...r })); },
  async stageHistoricalCandidates(staged) {
    for (const item of staged) Object.assign(rows.get(item.id), {
      identity_candidate: JSON.stringify(item.identity_candidate),
      identity_candidate_version: item.identity_candidate_version,
    });
    return { staged: staged.length };
  },
  async activateHistoricalCandidates(ids) {
    for (const id of ids) rows.get(id).mint_verdict = null;
    return { activated: ids.length };
  },
  async rollbackHistoricalCandidates(snapshot) {
    for (const prior of snapshot) Object.assign(rows.get(prior.id), prior);
    return { restored: snapshot.length };
  },
};

console.log('historical rollout:');
const report = await stageHistoricalCandidateRollout(
  { enrichStore: store },
  { offerIds: ['safe', 'trusted'], activate: true },
);
check('explicit cohort is staged', report.staged === 2);
check('trusted Product ID row is protected from activation',
  report.protectedOfferIds.includes('trusted') && rows.get('trusted').mint_verdict === 'minted');
check('only unsighted row is activated', report.activated === 1 && rows.get('safe').mint_verdict === null);
check('candidate comes only from stored structured observation',
  JSON.parse(rows.get('safe').identity_candidate).family === 'Chicken');
await rollbackHistoricalCandidateRollout({ enrichStore: store }, report.rollbackSnapshot);
check('rollback restores candidate and verdict snapshot',
  rows.get('safe').identity_candidate === null && rows.get('safe').mint_verdict === 'too_few_tokens');

let refused = false;
try { await stageHistoricalCandidateRollout({ enrichStore: store }, { offerIds: [] }); } catch { refused = true; }
check('catalog-wide implicit rollout is refused', refused);
check('cohort limit is bounded', HISTORICAL_ROLLOUT_MAX_COHORT === 200);

if (failures) process.exit(1);
console.log('\nAll historical rollout tests passed.');
