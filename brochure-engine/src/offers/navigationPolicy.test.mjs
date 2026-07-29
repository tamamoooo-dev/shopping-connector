import assert from 'node:assert/strict';
import {
  NAVIGATION_PROVENANCE,
  NAVIGATION_STATUS,
  acceptedNavigation,
  addPageEvidence,
  assessNavigation,
  resolveNavigation,
} from './navigationPolicy.js';

const nav = () => ({
  brochureId: 'shop:central:2026-W31',
  edition: '2026-W31',
  byPageRef: new Map(),
  byOfferId: new Map(),
});

{
  const flyer = nav();
  addPageEvidence(flyer.byPageRef, 'page-a', 0);
  addPageEvidence(flyer.byOfferId, 'A', 0);
  addPageEvidence(flyer.byOfferId, 'B', 1);
  const byFlyer = new Map([['111', flyer]]);
  const candidates = [
    { id: 'A', flyerRef: '111', pageRef: 'page-a', offerId: 'A' },
    { id: 'B', flyerRef: '111', pageRef: 'missing', offerId: 'B' },
  ];
  const assessment = assessNavigation(byFlyer, candidates);

  assert.equal(assessment.health.failClosed, false);
  assert.equal(assessment.health.dual, 1);
  assert.equal(assessment.health.hotspotUniqueAccepted, 1);
  assert.deepEqual(
    {
      status: assessment.resolutions.get('A').status,
      provenance: acceptedNavigation(
        assessment.resolutions.get('A'),
        assessment.health,
      ).provenance,
    },
    { status: NAVIGATION_STATUS.DUAL, provenance: NAVIGATION_PROVENANCE.DUAL },
  );
  assert.equal(
    acceptedNavigation(assessment.resolutions.get('B'), assessment.health).provenance,
    NAVIGATION_PROVENANCE.HOTSPOT_UNIQUE,
  );
}

{
  const flyer = nav();
  addPageEvidence(flyer.byOfferId, 'AMB', 0);
  addPageEvidence(flyer.byOfferId, 'AMB', 1);
  addPageEvidence(flyer.byOfferId, 'SAFE', 2);
  const byFlyer = new Map([['111', flyer]]);
  const candidates = [
    { id: 'amb', flyerRef: '111', pageRef: 'missing', offerId: 'AMB' },
    { id: 'safe', flyerRef: '111', pageRef: 'missing', offerId: 'SAFE' },
  ];
  const closed = assessNavigation(byFlyer, candidates);

  assert.equal(closed.resolutions.get('amb').status, NAVIGATION_STATUS.HOTSPOT_AMBIGUOUS);
  assert.equal(acceptedNavigation(closed.resolutions.get('amb'), closed.health), null);
  assert.equal(closed.health.failClosed, true);
  assert.equal(closed.health.hotspotUniqueSuppressed, 1);
  assert.equal(acceptedNavigation(closed.resolutions.get('safe'), closed.health), null);

  // A configured tolerance can keep the target circuit closed, but the
  // ambiguous row itself is still rejected unconditionally.
  const tolerated = assessNavigation(byFlyer, candidates, {
    ambiguityRateThreshold: 1,
    disagreementRateThreshold: 0,
  });
  assert.equal(tolerated.health.failClosed, false);
  assert.equal(acceptedNavigation(tolerated.resolutions.get('amb'), tolerated.health), null);
  assert.equal(
    acceptedNavigation(tolerated.resolutions.get('safe'), tolerated.health).pageIndex,
    2,
  );
}

{
  const flyer = nav();
  addPageEvidence(flyer.byPageRef, 'page-a', 0);
  addPageEvidence(flyer.byOfferId, 'A', 1);
  addPageEvidence(flyer.byOfferId, 'SAFE', 2);
  const byFlyer = new Map([['111', flyer]]);
  const candidates = [
    { id: 'bad', flyerRef: '111', pageRef: 'page-a', offerId: 'A' },
    { id: 'safe', flyerRef: '111', pageRef: 'missing', offerId: 'SAFE' },
  ];
  const assessment = assessNavigation(byFlyer, candidates);

  assert.equal(assessment.resolutions.get('bad').status, NAVIGATION_STATUS.DISAGREEMENT);
  assert.equal(acceptedNavigation(assessment.resolutions.get('bad'), assessment.health), null);
  assert.equal(assessment.health.failClosed, true);
  assert.equal(acceptedNavigation(assessment.resolutions.get('safe'), assessment.health), null);
}

{
  const flyer = nav();
  addPageEvidence(flyer.byPageRef, 'duplicated-page-ref', 0);
  addPageEvidence(flyer.byPageRef, 'duplicated-page-ref', 1);
  addPageEvidence(flyer.byOfferId, 'A', 0);
  const resolution = resolveNavigation(flyer, {
    pageRef: 'duplicated-page-ref',
    offerId: 'A',
  });
  assert.equal(resolution.status, NAVIGATION_STATUS.PAGE_REF_AMBIGUOUS);
}

console.log('navigationPolicy.test: Policy B trust hierarchy and circuit breakers passed');
