// commerceScore.js — deterministic commercial usefulness of an extracted offer.
//
// This is deliberately separate from Arabic Builder quality. It measures the
// fields that make an offer useful for identity, comparison, history, watches,
// and search. It never reads model confidence, corroboration, or probabilities.

import { PRODUCT_SOURCES } from '../lexicon/structuredProduct.js';

export const COMMERCE_SCORE_VERSION = 'commerce-score-v1';

// User-approved business weighting. Production evidence does not currently
// support changing it, so these values intentionally match the requested
// priority order exactly.
export const COMMERCE_SCORE_WEIGHTS = Object.freeze({
  price: 35,
  package_size: 25,
  brand: 20,
  english_identity: 10,
  category: 5,
  descriptors_flavor: 5,
});

function validCurrency(value) {
  return typeof value === 'string' && /^[A-Z]{3}$/u.test(value.trim().toUpperCase());
}

export function hasUsableCommercePrice({ price = null, currency = null } = {}) {
  const numericPrice = Number(price);
  return Number.isFinite(numericPrice) && numericPrice > 0 && validCurrency(currency);
}

function component(max, resolved, detail = {}) {
  return Object.freeze({
    points: resolved ? max : 0,
    max,
    resolved,
    ...detail,
  });
}

export function calculateCommerceScore(structured, commerce = {}) {
  const descriptors = structured?.descriptors || [];
  const flavorCount = descriptors.filter((descriptor) => descriptor.role === 'flavor').length;
  const priceResolved = hasUsableCommercePrice(commerce);
  const sizeResolved = Boolean(
    structured?.size?.present
    && structured.size.canonical?.unit
    && Number.isFinite(Number(structured.size.canonical?.total))
    && Number(structured.size.canonical.total) > 0,
  );
  const brandResolved = Boolean(structured?.brand?.brand_id);
  const englishIdentityUsable = structured?.source === PRODUCT_SOURCES.ENGLISH;
  const categoryResolved = Boolean(structured?.category);
  const descriptorsResolved = descriptors.length > 0;

  const breakdown = Object.freeze({
    price: component(COMMERCE_SCORE_WEIGHTS.price, priceResolved, {
      source: 'authoritative_offer',
    }),
    package_size: component(COMMERCE_SCORE_WEIGHTS.package_size, sizeResolved),
    brand: component(COMMERCE_SCORE_WEIGHTS.brand, brandResolved),
    english_identity: component(
      COMMERCE_SCORE_WEIGHTS.english_identity,
      englishIdentityUsable,
    ),
    category: component(COMMERCE_SCORE_WEIGHTS.category, categoryResolved),
    descriptors_flavor: component(
      COMMERCE_SCORE_WEIGHTS.descriptors_flavor,
      descriptorsResolved,
      {
        descriptor_count: descriptors.length,
        flavor_count: flavorCount,
      },
    ),
  });
  const score = Object.values(breakdown)
    .reduce((sum, value) => sum + value.points, 0);

  return Object.freeze({
    version: COMMERCE_SCORE_VERSION,
    score,
    breakdown,
  });
}
