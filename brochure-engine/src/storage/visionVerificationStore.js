// storage/visionVerificationStore.js — compact D1 state for stage-two Vision verification.
//
// Full attempt evidence lives in R2. D1 retains only an ordered list of
// SHA-256 identity hashes, which is enough to approve A → B → A atomically.

import { normalizeText, parseSize } from '../matching.js';
import { CORROBORATION_FLOOR } from '../offers/servingFloor.js';

const DEFAULT_LEASE_MS = 180000;

// RE-READ ONLY WHAT NEEDS IT (user directive 2026-10-09: "avoid reprocessing
// products that have already been successfully validated; re-verify only when
// flagged for review, when a change is detected, or when the previous
// validation failed"). Measured before, on current offers: Stage 2 re-read 112
// offers every 20 minutes (~336 Mistral reads an hour), and 3,079 of its queued
// rows were already published while failed reads looped without a cap (up to
// 97 reads of one crop). A queue row is DUE when either
//   • nothing is published for the offer (a failed read, or a flagged one,
//     whose quarantine clears corroboration), or
//   • the published read was taken from a different crop than the offer
//     now carries (a detected change),
// and it has had fewer than STAGE_TWO_MAX_ATTEMPTS reads in total, Stage 1
// included. Rows that are not due stay in the queue untouched, so a flag
// (reverifyStatements) makes them due again. `q`, `o`, `e` are the queue, the
// offer and its enrichment row (LEFT JOIN).
export const STAGE_TWO_MAX_ATTEMPTS = 3;
// Strictly boolean: a quarantined row has corroboration NULL, and NOT(NULL)
// would silently exclude it instead of making it due.
const PUBLISHED_SQL = `(e.id IS NOT NULL AND (e.name IS NOT NULL OR e.name_ar IS NOT NULL)
  AND COALESCE(e.corroboration, 0) >= ${CORROBORATION_FLOOR})`;
// Unsettled: not served, or served from a crop the offer no longer shows.
const STAGE_TWO_UNSETTLED_SQL = `(NOT ${PUBLISHED_SQL} OR (e.crop_url IS NOT NULL AND e.crop_url <> o.image_url))`;
export const STAGE_TWO_DUE_SQL = `(q.attempts < ${STAGE_TWO_MAX_ATTEMPTS}
  AND ${STAGE_TWO_UNSETTLED_SQL})`;

function normalizedIdentityPart(value) {
  const text = normalizeText(String(value == null ? '' : value)).trim();
  return text || null;
}

function verificationCount(row) {
  const size = row?.structured_product?.size ?? row?.structuredProduct?.size ?? null;
  const count = Number(size?.count);
  const canonicalPack = Number(size?.canonical?.pack);
  if (size?.canonical?.unit === 'pcs'
      && Number.isFinite(canonicalPack) && canonicalPack > 0) return canonicalPack;
  if (Number.isFinite(count) && count > 0) return count;
  if (Number.isFinite(canonicalPack) && canonicalPack > 0) return canonicalPack;
  const pack = Number(size?.pack);
  if (Number.isFinite(pack) && pack > 0) return pack;
  const legacySize = parseSize(row?.name || '', row?.size || '');
  const legacyPack = Number(legacySize?.pack);
  if (Number.isFinite(legacyPack) && legacyPack > 0) return legacyPack;
  return null;
}

// Equality is English product name + brand + visible item/pack count. Arabic
// remains extracted for display but is intentionally absent here. Raw package
// size is already part of the literal English title and must not add a second,
// unstable veto. Null remains significant for brand/count.
//
// An Arabic-only read (business-acceptance-v5) has no English name, so its
// Arabic name stands in. The English shape is unchanged, so every stored hash
// keeps its meaning; before v5 an Arabic-only read had no fingerprint at all
// and two of them could never match.
export function visionVerificationFingerprint(row) {
  if (row?.name) {
    return JSON.stringify({
      name: normalizedIdentityPart(row.name),
      brand: normalizedIdentityPart(row.brand),
      count: verificationCount(row),
    });
  }
  const nameAr = normalizedIdentityPart(row?.name_ar);
  if (!nameAr) return null;
  return JSON.stringify({
    name: null,
    name_ar: nameAr,
    brand: normalizedIdentityPart(row.brand),
    count: verificationCount(row),
  });
}

// RE-CHECK identity (user directive 2026-09-24: "in the recheck stage we get
// what we missed"). For an item already PUBLISHED by one reading, a re-read is
// the same product when the English names agree; brand and pack count only
// need to be compatible — equal, or missing on either side — so a re-read that
// finds a brand or count the first read missed confirms it instead of
// counting as a mismatch.
export function compatibleVisionIdentity(published, candidate) {
  // Two Arabic-only reads compare their Arabic names (v5); an English name on
  // either side keeps the English comparison.
  const arabicOnly = !published?.name && !candidate?.name;
  const a = normalizedIdentityPart(arabicOnly ? published?.name_ar : published?.name);
  const b = normalizedIdentityPart(arabicOnly ? candidate?.name_ar : candidate?.name);
  if (!a || !b || a !== b) return false;
  const brandA = normalizedIdentityPart(published?.brand);
  const brandB = normalizedIdentityPart(candidate?.brand);
  if (brandA && brandB && brandA !== brandB) return false;
  const countA = verificationCount(published);
  const countB = verificationCount(candidate);
  if (countA != null && countB != null && countA !== countB) return false;
  return true;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function visionVerificationFingerprintHash(fingerprintOrRow) {
  const fingerprint = typeof fingerprintOrRow === 'string'
    ? fingerprintOrRow
    : visionVerificationFingerprint(fingerprintOrRow);
  if (!fingerprint) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint));
  return base64Url(new Uint8Array(digest));
}

export function parseVisionVerificationFingerprintHashes(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => typeof entry === 'string' && entry.length > 0);
  } catch {
    return [];
  }
}

function pendingItem(row) {
  return {
    offerId: row.offer_id,
    status: row.status,
    attempts: Number(row.attempts || 0),
    // Set by flagForReverification: the stored read is the suspect, so it is
    // never re-judged, only read again.
    flagged: /^flagged/.test(String(row.last_error || '')),
    initialOutcome: row.initial_outcome,
    fingerprintHashes: parseVisionVerificationFingerprintHashes(row.matched_fingerprint),
    matchCount: Number(row.match_count || 0),
    imageUrl: row.image_url,
    price: row.price,
    currency: row.currency,
    category: row.category,
    name: row.name,
    nameAr: row.name_ar,
    searchText: row.search_text,
    validTo: row.valid_to,
    initialCandidate: row.initial_outcome === 'accepted' && row.initial_name
      ? { name: row.initial_name, brand: row.initial_brand, size: row.initial_size }
      : null,
  };
}

export function enqueueVisionVerificationStatements(db, {
  attempt,
  fingerprintHash = null,
}) {
  const at = attempt.attemptedAt;
  const hashes = fingerprintHash ? [fingerprintHash] : [];
  return [
    db.prepare(
      `INSERT INTO offer_vision_verification_queue
         (offer_id, status, attempts, claimed_by, claim_until, claim_token,
          last_error, initial_outcome, matched_fingerprint, match_count,
          created_at, updated_at, verified_at)
       VALUES (?, 'queued', 1, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(offer_id) DO UPDATE SET
         status='queued', attempts=1, claimed_by=NULL, claim_until=NULL,
         claim_token=NULL, last_error=NULL,
         initial_outcome=excluded.initial_outcome,
         matched_fingerprint=excluded.matched_fingerprint,
         match_count=excluded.match_count,
         updated_at=excluded.updated_at, verified_at=NULL`,
    ).bind(
      attempt.offerId,
      attempt.accepted ? 'accepted' : 'rejected',
      JSON.stringify(hashes),
      hashes.length,
      at,
      at,
    ),
    // A deliberately re-read offer is quarantined until the new generation
    // also reaches two matching observations.
    db.prepare(
      `UPDATE offer_enrichments
          SET corroboration=NULL, mint_verdict=NULL
        WHERE id=?`,
    ).bind(attempt.offerId),
  ];
}

export function visionVerificationFenceStatements(db, { offerId, token, at }) {
  return [
    db.prepare(
      `UPDATE offer_vision_verification_queue
          SET status=CASE WHEN claim_token IS NOT NULL AND claim_token=?
                          THEN status ELSE '!stale-claim' END
        WHERE offer_id=?`,
    ).bind(token, offerId),
    db.prepare(
      `INSERT INTO offer_vision_verification_queue
         (offer_id, status, attempts, initial_outcome, matched_fingerprint,
          match_count, created_at, updated_at)
       SELECT ?, '!missing-claim', 0, 'rejected', '[]', 0, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM offer_vision_verification_queue WHERE offer_id=?
        )`,
    ).bind(offerId, at, at, offerId),
  ];
}

export function completeVisionVerificationStatement(db, {
  offerId,
  attempts,
  fingerprintHashes,
  matchCount,
  at,
}) {
  return db.prepare(
    `UPDATE offer_vision_verification_queue
        SET status='verified', attempts=?, claimed_by=NULL, claim_until=NULL,
            claim_token=NULL, last_error=NULL, matched_fingerprint=?,
            match_count=?, updated_at=?, verified_at=?
      WHERE offer_id=?`,
  ).bind(attempts, JSON.stringify(fingerprintHashes), matchCount, at, at, offerId);
}

export function continueVisionVerificationStatement(db, {
  offerId,
  attempts,
  fingerprintHashes,
  bestCount,
  at,
}) {
  // A flag outlives a failed re-read: until a read publishes, the stored
  // (suspect) read must never be re-judged back into service.
  return db.prepare(
    `UPDATE offer_vision_verification_queue
        SET status='queued', attempts=?, claimed_by=NULL, claim_until=NULL,
            claim_token=NULL,
            last_error=CASE WHEN last_error LIKE 'flagged%' THEN last_error ELSE NULL END,
            matched_fingerprint=?, match_count=?, updated_at=?
      WHERE offer_id=?`,
  ).bind(attempts, JSON.stringify(fingerprintHashes), bestCount, at, offerId);
}

export function createD1VisionVerificationStore(db) {
  let readyState = null;

  const ready = async () => {
    if (readyState !== null) return readyState;
    try {
      const row = await db.prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table' AND name='offer_vision_verification_queue'`,
      ).first();
      readyState = !!row;
    } catch {
      readyState = false;
    }
    return readyState;
  };

  // A deployed compact-state Worker must not consume the old queue before the
  // one-time R2 archive migration has converted its fingerprints.
  const legacyHistoryPending = async () => {
    const table = await db.prepare(
      `SELECT name FROM sqlite_master
        WHERE type='table' AND name='offer_vision_verification_attempts'`,
    ).first().catch(() => null);
    if (!table) return false;
    const row = await db.prepare(
      'SELECT 1 AS present FROM offer_vision_verification_attempts LIMIT 1',
    ).first().catch(() => ({ present: 1 }));
    return !!row;
  };

  const store = {
    ready,
    legacyHistoryPending,

    async countPending(currentOn) {
      if (!(await ready()) || await legacyHistoryPending()) return 0;
      const now = new Date().toISOString();
      const row = await db.prepare(
        `SELECT COUNT(*) AS n
           FROM offer_vision_verification_queue q INDEXED BY ix_vision_verification_ready
           CROSS JOIN offers o ON o.id=q.offer_id
           LEFT JOIN offer_enrichments e ON e.id=q.offer_id
          WHERE (q.status='queued' OR
                 (q.status='claimed' AND (q.claim_until IS NULL OR q.claim_until<=?)))
            AND o.valid_to>=? AND o.image_url IS NOT NULL
            AND ${STAGE_TWO_DUE_SQL}`,
      ).bind(now, currentOn).first();
      return Number(row?.n || 0);
    },

    async listPending({ currentOn, limit = 15 } = {}) {
      if (!(await ready()) || await legacyHistoryPending()) return [];
      const now = new Date().toISOString();
      const { results } = await db.prepare(
        `SELECT q.offer_id, q.status, q.attempts, q.initial_outcome, q.last_error,
                q.matched_fingerprint, q.match_count, q.updated_at,
                o.image_url, o.price, o.currency, o.category,
                o.name, o.name_ar, o.search_text, o.valid_to,
                e.name AS initial_name, e.brand AS initial_brand,
                e.size AS initial_size
           FROM offer_vision_verification_queue q INDEXED BY ix_vision_verification_ready
           CROSS JOIN offers o ON o.id=q.offer_id
           LEFT JOIN offer_enrichments e ON e.id=q.offer_id
          WHERE (q.status='queued' OR
                 (q.status='claimed' AND (q.claim_until IS NULL OR q.claim_until<=?)))
            AND o.valid_to>=? AND o.image_url IS NOT NULL
            AND ${STAGE_TWO_DUE_SQL}
          ORDER BY q.updated_at, q.offer_id
          LIMIT ?`,
      // 200, not 50: a cron fire asks for its full 4 x 28 = 112 child capacity.
      ).bind(now, currentOn, Math.max(1, Math.min(Number(limit) || 15, 200))).all();
      return (results || []).map(pendingItem);
    },

    // Re-judge candidates (2026-10-09): every UNSETTLED row, whatever its read
    // count. The attempts cap stops paid re-reads; re-judging stored evidence
    // costs nothing, and 1,344 current rows were past the cap — many of them
    // Arabic-only reads rejected only by the old English-name rule. Paged by
    // offer id (`after`), because a row that still fails stays unsettled and
    // would otherwise be listed again.
    async listRejudgeCandidates({ currentOn, limit = 50, after = '' } = {}) {
      if (!(await ready()) || await legacyHistoryPending()) return [];
      const now = new Date().toISOString();
      const { results } = await db.prepare(
        `SELECT q.offer_id, q.status, q.attempts, q.initial_outcome, q.last_error,
                q.matched_fingerprint, q.match_count, q.updated_at,
                o.image_url, o.price, o.currency, o.category,
                o.name, o.name_ar, o.search_text, o.valid_to,
                e.name AS initial_name, e.brand AS initial_brand,
                e.size AS initial_size
           FROM offer_vision_verification_queue q
           JOIN offers o ON o.id=q.offer_id
           LEFT JOIN offer_enrichments e ON e.id=q.offer_id
          WHERE q.offer_id > ?
            AND (q.status='queued' OR
                 (q.status='claimed' AND (q.claim_until IS NULL OR q.claim_until<=?)))
            AND o.valid_to>=? AND o.image_url IS NOT NULL
            AND ${STAGE_TWO_UNSETTLED_SQL}
          ORDER BY q.offer_id
          LIMIT ?`,
      ).bind(String(after || ''), now, currentOn, Math.max(1, Math.min(Number(limit) || 50, 200))).all();
      return (results || []).map(pendingItem);
    },

    // Scheduler counterpart to listPending(): the coordinator scans the
    // ordered queue once, then each isolated child reloads only its assigned
    // ids through the queue/offers primary keys while retaining every normal
    // readiness, lease, expiry and crop guard.
    async listPendingByIds({ ids, currentOn } = {}) {
      if (!(await ready()) || await legacyHistoryPending()) return [];
      const selected = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, 50);
      if (!selected.length) return [];
      const now = new Date().toISOString();
      const placeholders = selected.map(() => '?').join(',');
      const { results } = await db.prepare(
        `SELECT q.offer_id, q.status, q.attempts, q.initial_outcome, q.last_error,
                q.matched_fingerprint, q.match_count, q.updated_at,
                o.image_url, o.price, o.currency, o.category,
                o.name, o.name_ar, o.search_text, o.valid_to,
                e.name AS initial_name, e.brand AS initial_brand,
                e.size AS initial_size
           FROM offer_vision_verification_queue q
           JOIN offers o ON o.id=q.offer_id
           LEFT JOIN offer_enrichments e ON e.id=q.offer_id
          WHERE q.offer_id IN (${placeholders})
            AND (q.status='queued' OR
                 (q.status='claimed' AND (q.claim_until IS NULL OR q.claim_until<=?)))
            AND o.valid_to>=? AND o.image_url IS NOT NULL
            AND ${STAGE_TWO_DUE_SQL}
          ORDER BY q.updated_at, q.offer_id`,
      ).bind(...selected, now, currentOn).all();
      return (results || []).map(pendingItem);
    },

    async claim({ offerId, leaseMs = DEFAULT_LEASE_MS, now = new Date() }) {
      if (!(await ready()) || await legacyHistoryPending()) return null;
      const at = now.toISOString();
      const until = new Date(now.getTime() + leaseMs).toISOString();
      const token = crypto.randomUUID();
      const result = await db.prepare(
        `UPDATE offer_vision_verification_queue
            SET status='claimed', claimed_by='vision-verification',
                claim_until=?, claim_token=?, updated_at=?
          WHERE offer_id=?
            AND status IN ('queued','claimed')
            AND (claim_until IS NULL OR claim_until<=?)`,
      ).bind(until, token, at, offerId, at).run();
      return Number(result?.meta?.changes || 0) > 0 ? token : null;
    },

    // FLAGGED FOR REVIEW (2026-10-09): give offers a fresh Stage 2 cycle. The
    // published read is quarantined, as for any deliberate re-read, so a
    // suspect name stops serving until a passing read replaces it, and the
    // read count restarts so the flag buys a full STAGE_TWO_MAX_ATTEMPTS.
    // Offers without a current crop are skipped. Returns the ids flagged.
    async flagForReverification(offerIds = [], { now = new Date(), reason = 'flagged for review' } = {}) {
      if (!(await ready())) return [];
      const ids = [...new Set((offerIds || []).map(String).filter(Boolean))].slice(0, 50);
      if (!ids.length) return [];
      const placeholders = ids.map(() => '?').join(',');
      const { results } = await db.prepare(
        `SELECT id FROM offers WHERE id IN (${placeholders}) AND image_url IS NOT NULL`,
      ).bind(...ids).all();
      const found = (results || []).map((row) => row.id);
      if (!found.length) return [];
      const at = now.toISOString();
      await db.batch(found.flatMap((offerId) => [
        db.prepare(
          `INSERT INTO offer_vision_verification_queue
             (offer_id, status, attempts, initial_outcome, matched_fingerprint,
              match_count, last_error, created_at, updated_at)
           VALUES (?, 'queued', 0, 'rejected', '[]', 0, ?, ?, ?)
           ON CONFLICT(offer_id) DO UPDATE SET
             status='queued', attempts=0, claimed_by=NULL, claim_until=NULL,
             claim_token=NULL, last_error=excluded.last_error,
             matched_fingerprint='[]', match_count=0,
             updated_at=excluded.updated_at, verified_at=NULL`,
        ).bind(offerId, String(reason).slice(0, 200), at, at),
        db.prepare(
          'UPDATE offer_enrichments SET corroboration=NULL, mint_verdict=NULL WHERE id=?',
        ).bind(offerId),
      ]));
      return found;
    },

    async release(offerId, { token, error = null, now = new Date() } = {}) {
      if (!(await ready())) return false;
      const result = await db.prepare(
        `UPDATE offer_vision_verification_queue
            SET status='queued', claimed_by=NULL, claim_until=NULL, claim_token=NULL,
                last_error=CASE WHEN last_error LIKE 'flagged%' THEN last_error ELSE ? END,
                updated_at=?
          WHERE offer_id=? AND claim_token=?`,
      ).bind(
        error == null ? null : String(error).slice(0, 500),
        now.toISOString(),
        offerId,
        token,
      ).run();
      return Number(result?.meta?.changes || 0) > 0;
    },

    async snapshot({ currentOn } = {}) {
      if (!(await ready())) {
        return { available: false, reason: 'migration_missing' };
      }
      const { results } = await db.prepare(
        `SELECT q.status, COUNT(*) AS n, AVG(q.attempts) AS average_attempts,
                MAX(q.attempts) AS max_attempts
           FROM offer_vision_verification_queue q
           JOIN offers o ON o.id=q.offer_id
          WHERE o.valid_to>=?
          GROUP BY q.status`,
      ).bind(currentOn).all();
      const byStatus = {};
      let averageAttempts = 0;
      let maxAttempts = 0;
      let active = 0;
      for (const row of results || []) {
        byStatus[row.status] = Number(row.n || 0);
        if (row.status === 'queued' || row.status === 'claimed') {
          active += Number(row.n || 0);
          averageAttempts += Number(row.average_attempts || 0) * Number(row.n || 0);
          maxAttempts = Math.max(maxAttempts, Number(row.max_attempts || 0));
        }
      }
      return {
        available: true,
        historyBackend: 'r2',
        migrationPending: await legacyHistoryPending(),
        byStatus,
        // `pending` counts open queue rows; `due` is the part Stage 2 will
        // actually read (STAGE_TWO_DUE_SQL). The rest are settled reads that
        // a flag or a crop change can make due again.
        due: await store.countPending(currentOn),
        maxAttemptsPerOffer: STAGE_TWO_MAX_ATTEMPTS,
        pending: active,
        verified: Number(byStatus.verified || 0),
        averageAttempts: active ? Math.round((averageAttempts / active) * 100) / 100 : 0,
        maxAttempts,
      };
    },
  };
  return store;
}
