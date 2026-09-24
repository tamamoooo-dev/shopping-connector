// storage/visionVerificationStore.js — compact D1 state for stage-two Vision verification.
//
// Full attempt evidence lives in R2. D1 retains only an ordered list of
// SHA-256 identity hashes, which is enough to approve A → B → A atomically.

import { normalizeText, parseSize } from '../matching.js';

const DEFAULT_LEASE_MS = 180000;

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
export function visionVerificationFingerprint(row) {
  if (!row?.name) return null;
  return JSON.stringify({
    name: normalizedIdentityPart(row.name),
    brand: normalizedIdentityPart(row.brand),
    count: verificationCount(row),
  });
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
  return db.prepare(
    `UPDATE offer_vision_verification_queue
        SET status='queued', attempts=?, claimed_by=NULL, claim_until=NULL,
            claim_token=NULL, last_error=NULL, matched_fingerprint=?,
            match_count=?, updated_at=?
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

  return {
    ready,
    legacyHistoryPending,

    async countPending(currentOn) {
      if (!(await ready()) || await legacyHistoryPending()) return 0;
      const now = new Date().toISOString();
      const row = await db.prepare(
        `SELECT COUNT(*) AS n
           FROM offer_vision_verification_queue q INDEXED BY ix_vision_verification_ready
           CROSS JOIN offers o ON o.id=q.offer_id
          WHERE (q.status='queued' OR
                 (q.status='claimed' AND (q.claim_until IS NULL OR q.claim_until<=?)))
            AND o.valid_to>=? AND o.image_url IS NOT NULL`,
      ).bind(now, currentOn).first();
      return Number(row?.n || 0);
    },

    async listPending({ currentOn, limit = 15 } = {}) {
      if (!(await ready()) || await legacyHistoryPending()) return [];
      const now = new Date().toISOString();
      const { results } = await db.prepare(
        `SELECT q.offer_id, q.status, q.attempts, q.initial_outcome,
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
          ORDER BY q.updated_at, q.offer_id
          LIMIT ?`,
      ).bind(now, currentOn, Math.max(1, Math.min(Number(limit) || 15, 50))).all();
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
        `SELECT q.offer_id, q.status, q.attempts, q.initial_outcome,
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

    async release(offerId, { token, error = null, now = new Date() } = {}) {
      if (!(await ready())) return false;
      const result = await db.prepare(
        `UPDATE offer_vision_verification_queue
            SET status='queued', claimed_by=NULL, claim_until=NULL,
                claim_token=NULL, last_error=?, updated_at=?
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
        pending: active,
        verified: Number(byStatus.verified || 0),
        averageAttempts: active ? Math.round((averageAttempts / active) * 100) / 100 : 0,
        maxAttempts,
      };
    },
  };
}
