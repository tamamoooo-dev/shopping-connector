// Full Vision Verification attempt evidence lives in R2. D1 keeps only the
// compact hashes required to make the matching decision atomically.

const enc = new TextEncoder();

function safeSegment(value) {
  return encodeURIComponent(String(value == null ? '' : value));
}

function compactTimestamp(value) {
  return String(value || new Date().toISOString()).replace(/[^0-9A-Za-z]/g, '');
}

export function visionVerificationAttemptKey({ offerId, attemptNo, attemptedAt, token = null }) {
  const suffix = token ? `-${safeSegment(token)}` : '';
  return `vision-verification/attempts/${safeSegment(offerId)}/${compactTimestamp(attemptedAt)}`
    + `-${String(Math.max(1, Number(attemptNo) || 1)).padStart(8, '0')}${suffix}.json`;
}

export function createR2VisionVerificationHistoryStore(bucket) {
  return {
    available: !!bucket && typeof bucket.put === 'function',

    async recordAttempt({
      offerId,
      initialOutcome,
      attemptNo,
      fingerprint = null,
      fingerprintHash = null,
      candidateRow = null,
      attempt,
      token = null,
    }) {
      if (!bucket || typeof bucket.put !== 'function') {
        throw new Error('Vision Verification R2 history binding is unavailable');
      }
      const key = visionVerificationAttemptKey({
        offerId,
        attemptNo,
        attemptedAt: attempt?.attemptedAt,
        token: token || crypto.randomUUID(),
      });
      const body = JSON.stringify({
        version: 1,
        offer_id: offerId,
        initial_outcome: initialOutcome,
        attempt_no: Math.max(1, Number(attemptNo) || 1),
        fingerprint,
        fingerprint_hash: fingerprintHash,
        candidate: candidateRow,
        observation: attempt?.output ?? null,
        validation: attempt?.validation ?? {},
        confidence: attempt?.confidence ?? null,
        model: attempt?.model ?? null,
        crop_url: attempt?.cropUrl ?? null,
        accepted: !!attempt?.accepted,
        attempted_at: attempt?.attemptedAt ?? new Date().toISOString(),
      });
      const bytes = enc.encode(body);
      const stored = await bucket.put(key, bytes, {
        httpMetadata: { contentType: 'application/json; charset=utf-8' },
        customMetadata: {
          recordType: 'vision-verification-attempt',
          attemptNo: String(Math.max(1, Number(attemptNo) || 1)),
        },
      });
      if (!stored) throw new Error('Vision Verification R2 attempt write was refused');
      return { key, size: bytes.byteLength };
    },
  };
}
