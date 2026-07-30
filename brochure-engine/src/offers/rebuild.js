// offers/rebuild.js — recompute the DERIVED fields of stored enrichments.
//
// WHY THIS EXISTS. Two of the three layers downstream of extraction are pure
// functions of the stored observation, but their OUTPUT is persisted at enrich
// time:
//
//   · identity_candidate            (offers/identityBuilder.js)
//   · extraction_json._arabic_builder.built_arabic  (lexicon/arabicBuilder.js)
//
// So improving a lexicon changes nothing for rows already in the table. The
// 2026-07-30 passes are exactly that shape — measured on production samples:
//
//   · lexicon-backed families: two-dimension (mintable) candidates 6.9% -> 33.0%
//   · Arabic brand pass:       brand survives in the built name 71.8% -> 97.6%
//
// Neither reaches the ~13k existing rows without this.
//
// THE PROPERTY THAT MAKES IT SAFE: no model is called. Every input is already
// in the row (name, name_ar, brand, size, the preserved observation), and every
// layer is pure. A rebuild costs D1 reads and CPU — no Mistral quota, no spend,
// no network. That is the whole reason it can be run freely while the extraction
// model is deliberately pinned to Budget Mode.
//
// WHAT IT DELIBERATELY DOES NOT DO. Rewriting a candidate does not re-resolve
// it: `mint_verdict` is left exactly as it is, so no product is created, merged
// or re-attached by this operation. Re-resolution is a SEPARATE, explicitly
// opted-in step (`reresolve`), because clearing the verdict hands the rows back
// to the registry drain and that DOES mint products. Dry run reports both.

import { buildIdentityCandidate } from './identityBuilder.js';
import { productKnowledge } from './enrich.js';
import { IDENTITY_CANDIDATE_STORAGE_VERSION } from '../registry/candidate.js';
import {
  ARABIC_SHADOW_KEY,
  withArabicBuilderShadow,
  readArabicBuilderShadow,
} from '../lexicon/arabicRollout.js';

// The stored observation, with the builder's own shadow removed so it is not
// fed back into itself on a second rebuild (idempotence).
export function observationOf(extractionJson) {
  if (!extractionJson) return null;
  let parsed = extractionJson;
  if (typeof extractionJson === 'string') {
    try {
      parsed = JSON.parse(extractionJson);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { [ARABIC_SHADOW_KEY]: _shadow, ...rest } = parsed;
  return Object.keys(rest).length ? rest : null;
}

// Recompute one row's derived fields. PURE — returns what WOULD be written and
// what changed; the caller decides whether to persist.
export function rebuildRow(row, { identityNormalizationMode = 'strict' } = {}) {
  const extracted = {
    productName: row.name ?? null,
    arabicName: row.name_ar ?? null,
    brand: row.brand ?? null,
    size: row.size ?? null,
  };
  const observation = observationOf(row.extraction_json);
  const knowledge = productKnowledge(extracted, observation, {
    price: row.price ?? null,
    currency: row.currency ?? null,
  });
  const identity = buildIdentityCandidate(
    { ...extracted, confidence: row.confidence ?? null },
    { mode: identityNormalizationMode },
  );

  const beforeShadow = readArabicBuilderShadow(row.extraction_json);
  const afterShadow = knowledge.arabicBuilder ?? null;
  const beforeCandidate = typeof row.identity_candidate === 'string'
    ? row.identity_candidate
    : JSON.stringify(row.identity_candidate ?? null);
  const nextCandidate = JSON.stringify(identity.identityCandidate ?? null);

  const DIMS = ['family', 'cut', 'processing', 'variety'];
  const dimsOf = (c) => (c ? DIMS.filter((f) => c[f] != null).length : 0);
  let parsedBefore = null;
  try {
    parsedBefore = beforeCandidate ? JSON.parse(beforeCandidate) : null;
  } catch { /* a malformed stored candidate simply scores 0 */ }

  return {
    id: row.id,
    extraction_json: JSON.stringify(withArabicBuilderShadow(observation, afterShadow)),
    identity_candidate: nextCandidate,
    identity_candidate_version: IDENTITY_CANDIDATE_STORAGE_VERSION,
    changed: {
      candidate: beforeCandidate !== nextCandidate,
      // BOTH Arabic fields, not just the built one. Comparing `built_arabic`
      // alone silently skipped every row whose composed name was unchanged —
      // including all NO_CATEGORY rows, where it is null before and after — so
      // when `display_arabic` (the SERVED name) was introduced those rows were
      // scanned, reported, and never written. Found by checking the served
      // value in D1 after a full pass reported success.
      arabic: (beforeShadow?.built_arabic ?? null) !== (afterShadow?.built_arabic ?? null)
        || (beforeShadow?.display_arabic ?? null) !== (afterShadow?.display_arabic ?? null),
    },
    // Reported so a dry run can state the EFFECT, not just the diff count.
    dimensionsBefore: dimsOf(parsedBefore),
    dimensionsAfter: dimsOf(identity.identityCandidate),
    builtArabicBefore: beforeShadow?.built_arabic ?? null,
    builtArabicAfter: afterShadow?.built_arabic ?? null,
    mintableBefore: dimsOf(parsedBefore) >= 2,
    mintableAfter: dimsOf(identity.identityCandidate) >= 2,
  };
}

// Summarize a batch into the shape both dry run and live run report.
export function summarize(results) {
  const report = {
    scanned: results.length,
    candidateChanged: 0,
    arabicChanged: 0,
    becameMintable: 0,
    lostMintable: 0,
    gainedArabicBrand: 0,
    lostArabic: 0,
  };
  for (const r of results) {
    if (r.changed.candidate) report.candidateChanged += 1;
    if (r.changed.arabic) report.arabicChanged += 1;
    if (!r.mintableBefore && r.mintableAfter) report.becameMintable += 1;
    if (r.mintableBefore && !r.mintableAfter) report.lostMintable += 1;
    if (!r.builtArabicBefore && r.builtArabicAfter) report.gainedArabicBrand += 1;
    if (r.builtArabicBefore && !r.builtArabicAfter) report.lostArabic += 1;
  }
  return report;
}
