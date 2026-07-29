// registry/candidate.js — Identity Candidate -> Registry read boundary.
//
// This is the only production adapter into Registry resolution. It accepts the
// deterministic Identity Builder contract and never reads Vision observations,
// OCR text, brochure category data, or historical offer names. The Registry
// still owns comparison and Product ID decisions; this module only validates
// the already-structured candidate and projects its canonical fields onto the
// resolver's existing read contract.

import { PRODUCT_KIND } from './model.js';

export const IDENTITY_CANDIDATE_STORAGE_VERSION = 'identity-candidate-v1';

export const CANDIDATE_VERDICT = Object.freeze({
  OK: 'minted',
  NO_CANDIDATE: 'no_identity_candidate',
  UNSUPPORTED_VERSION: 'unsupported_identity_candidate_version',
  MALFORMED: 'malformed_identity_candidate',
  INSUFFICIENT: 'insufficient_identity_candidate',
  REVIEW: 'review',
});

const TEXT_FIELDS = ['brand', 'family', 'cut', 'processing', 'variety'];
const DISCRIMINATING_FIELDS = ['family', 'cut', 'processing', 'variety'];

// Every dimension an Identity Candidate carries. THE single source of truth for
// "what can be said about a product" — consumers that need to enumerate
// dimensions (identity/spec.js, which lets a Flexible Watch pin a subset) read
// this rather than keeping a parallel list that would drift.
export const CANDIDATE_DIMENSIONS = Object.freeze([...TEXT_FIELDS, 'package', 'size', 'count']);
const UNITS = new Set(['g', 'kg', 'ml', 'l']);

function textValue(value, field, errors) {
  if (value == null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 120) {
    errors.push(`${field} must be null or a non-empty string up to 120 characters`);
    return null;
  }
  // Identity Builder already normalized this value. Trimming outer whitespace
  // is schema hygiene, not interpretation of an observation.
  return value.trim();
}

function parseSize(value, errors) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('size must be null or { value, unit }');
    return null;
  }
  const number = value.value;
  const unit = value.unit;
  if (!Number.isFinite(number) || number <= 0 || !UNITS.has(unit)) {
    errors.push('size requires a positive finite value and canonical unit g|kg|ml|l');
    return null;
  }
  return { value: number, unit };
}

function parsePackage(value, errors) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('package must be null or { type, expression }');
    return null;
  }
  const type = textValue(value.type, 'package.type', errors);
  const expression = textValue(value.expression, 'package.expression', errors);
  if (!type && !expression) {
    errors.push('package requires type or expression');
    return null;
  }
  return { type, expression };
}

function parseCount(value, errors) {
  if (value == null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 9999) {
    errors.push('count must be null or an integer from 1 to 9999');
    return null;
  }
  return value;
}

export function validateIdentityCandidate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, candidate: null, errors: ['Identity Candidate must be an object'] };
  }
  const errors = [];
  const candidate = Object.fromEntries(
    TEXT_FIELDS.map((field) => [field, textValue(input[field], field, errors)]),
  );
  candidate.package = parsePackage(input.package, errors);
  candidate.size = parseSize(input.size, errors);
  candidate.count = parseCount(input.count, errors);
  return { valid: errors.length === 0, candidate, errors };
}

export function parseStoredIdentityCandidate(value, version) {
  if (value == null || value === '') {
    return { ok: false, verdict: CANDIDATE_VERDICT.NO_CANDIDATE, errors: [] };
  }
  if (version && version !== IDENTITY_CANDIDATE_STORAGE_VERSION) {
    return {
      ok: false,
      verdict: CANDIDATE_VERDICT.UNSUPPORTED_VERSION,
      errors: [`Unsupported Identity Candidate version: ${version}`],
    };
  }
  let input = value;
  if (typeof value === 'string') {
    try {
      input = JSON.parse(value);
    } catch {
      return { ok: false, verdict: CANDIDATE_VERDICT.MALFORMED, errors: ['Identity Candidate JSON is malformed'] };
    }
  }
  const validation = validateIdentityCandidate(input);
  if (!validation.valid) {
    return { ok: false, verdict: CANDIDATE_VERDICT.MALFORMED, errors: validation.errors };
  }
  return { ok: true, candidate: validation.candidate, errors: [] };
}

function tokensOf(value) {
  if (!value) return [];
  return String(value)
    .split(/\s+/u)
    .map((part) => part.toLocaleLowerCase('en').trim())
    .filter(Boolean);
}

export function candidateTokens(candidate) {
  const values = [
    ...tokensOf(candidate.brand),
    ...tokensOf(candidate.family),
    ...tokensOf(candidate.cut),
    ...tokensOf(candidate.processing),
    ...tokensOf(candidate.variety),
    ...tokensOf(candidate.package?.type),
  ];
  // Namespaced markers preserve Identity Builder's semantic dimensions in the
  // existing token profile. Registry compares these exact values; it never
  // reclassifies token text to reconstruct family/cut/processing/variety.
  const dimensions = [
    ['family', candidate.family],
    ['cut', candidate.cut],
    ['processing', candidate.processing],
    ['variety', candidate.variety],
    ['package', candidate.package?.type],
  ].flatMap(([field, value]) => {
    const normalized = tokensOf(value).join('_');
    return normalized ? [`${field}:${normalized}`] : [];
  });
  return [...new Set([...values, ...dimensions])];
}

function registrySize(size, count) {
  if (!size) return null;
  const mass = size.unit === 'kg';
  const volume = size.unit === 'l';
  return {
    unit: mass ? 'g' : volume ? 'ml' : size.unit,
    each: (mass || volume) ? size.value * 1000 : size.value,
    pack: count || 1,
  };
}

export function candidateDisplayName(candidate) {
  candidate ||= {};
  const fields = [
    candidate.brand, candidate.family, candidate.cut,
    candidate.processing, candidate.variety,
  ].filter(Boolean);
  return fields.length ? [...new Set(fields)].join(' ') : null;
}

export function candidateFingerprint(candidate) {
  return JSON.stringify({
    brand: candidate.brand,
    family: candidate.family,
    cut: candidate.cut,
    processing: candidate.processing,
    variety: candidate.variety,
    package: candidate.package,
    size: candidate.size,
    count: candidate.count,
  });
}

export function readFromIdentityCandidate(input, { version } = {}) {
  const parsed = parseStoredIdentityCandidate(input, version);
  if (!parsed.ok) return parsed;
  const candidate = parsed.candidate;
  const discriminating = DISCRIMINATING_FIELDS.filter((field) => candidate[field] != null);
  // Brand, package, count, and size corroborate an identity but cannot establish
  // one. Requiring two structured semantic dimensions prevents the unsafe
  // brand+size/package merge path while valid partial candidates remain Review.
  if (discriminating.length < 2) {
    return {
      ok: false,
      verdict: CANDIDATE_VERDICT.INSUFFICIENT,
      candidate,
      errors: ['At least two structured identity dimensions are required for automatic Registry evaluation'],
      unresolved: DISCRIMINATING_FIELDS.filter((field) => candidate[field] == null),
    };
  }
  const tokens = candidateTokens(candidate);
  if (tokens.length < 2) {
    return {
      ok: false,
      verdict: CANDIDATE_VERDICT.INSUFFICIENT,
      candidate,
      errors: ['Identity Candidate contains too little canonical evidence'],
    };
  }
  return {
    ok: true,
    candidate,
    read: {
      tokens,
      size: registrySize(candidate.size, candidate.count),
      brandText: candidate.brand || null,
      family: candidate.family || null,
      identityFields: {
        family: candidate.family || null,
        cut: candidate.cut || null,
        processing: candidate.processing || null,
        variety: candidate.variety || null,
        package: candidate.package?.type || null,
      },
      category: null,
      kind: PRODUCT_KIND.PRODUCT,
      corroboration: 1,
    },
  };
}

export function observationFromIdentityCandidate(context, candidate) {
  return {
    offerId: context.offerId,
    store: context.store,
    region: context.region,
    week: context.week,
    price: context.price,
    oldPrice: context.oldPrice ?? null,
    name: candidateDisplayName(candidate),
    nameAr: null,
    source: context.source ?? null,
    category: null,
  };
}
