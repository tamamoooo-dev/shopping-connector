// historicalRollout.js — allowlist-only Identity Candidate rollout support.
//
// This module never scans the catalog, calls Vision/OCR, deletes enrichment,
// or changes a Product ID. It stages candidates from persisted structured
// observations, preserves the prior row as an operator-held rollback snapshot,
// and activates only rows that have no Registry sighting.

import {
  buildIdentityCandidate, DEFAULT_IDENTITY_NORMALIZATION_MODE,
} from './identityBuilder.js';
import { IDENTITY_CANDIDATE_STORAGE_VERSION } from '../registry/candidate.js';

const MAX_COHORT = 200;

function explicitIds(offerIds) {
  const ids = [...new Set((offerIds || []).map(String).map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) throw new Error('Historical rollout requires an explicit offer-ID allowlist');
  if (ids.length > MAX_COHORT) throw new Error(`Historical rollout cohort exceeds ${MAX_COHORT} offers`);
  return ids;
}

export async function stageHistoricalCandidateRollout(
  { enrichStore },
  { offerIds, activate = false, identityNormalizationMode = DEFAULT_IDENTITY_NORMALIZATION_MODE } = {},
) {
  if (!enrichStore?.historicalCandidateRows || !enrichStore?.stageHistoricalCandidates) {
    throw new Error('Historical rollout storage is unavailable');
  }
  const ids = explicitIds(offerIds);
  const rows = await enrichStore.historicalCandidateRows(ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const missing = ids.filter((id) => !byId.has(id));
  const rollbackSnapshot = rows.map((row) => ({
    id: row.id,
    identity_candidate: row.identity_candidate ?? null,
    identity_candidate_version: row.identity_candidate_version ?? null,
    mint_verdict: row.mint_verdict ?? null,
  }));
  const staged = rows.map((row) => ({
    id: row.id,
    identity_candidate: buildIdentityCandidate({
      brand: row.brand ?? null,
      productName: row.name ?? null,
      arabicName: row.name_ar ?? null,
      size: row.size ?? null,
      confidence: row.confidence ?? null,
    }, { mode: identityNormalizationMode }).identityCandidate,
    identity_candidate_version: IDENTITY_CANDIDATE_STORAGE_VERSION,
  }));
  await enrichStore.stageHistoricalCandidates(staged);

  const protectedIds = rows.filter((row) => Number(row.has_sighting) === 1).map((row) => row.id);
  const eligibleIds = rows.filter((row) => Number(row.has_sighting) !== 1).map((row) => row.id);
  const activation = activate
    ? await enrichStore.activateHistoricalCandidates(eligibleIds)
    : { activated: 0 };
  return {
    selected: ids.length,
    found: rows.length,
    staged: staged.length,
    activated: activation.activated || 0,
    protectedProductIds: protectedIds.length,
    protectedOfferIds: protectedIds,
    missingOfferIds: missing,
    rollbackSnapshot,
  };
}

export async function rollbackHistoricalCandidateRollout({ enrichStore }, snapshot) {
  if (!Array.isArray(snapshot) || !snapshot.length) {
    throw new Error('Rollback requires the snapshot returned by the staging operation');
  }
  return enrichStore.rollbackHistoricalCandidates(snapshot);
}

export const HISTORICAL_ROLLOUT_MAX_COHORT = MAX_COHORT;
