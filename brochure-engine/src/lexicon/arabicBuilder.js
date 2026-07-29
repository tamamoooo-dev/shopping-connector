// lexicon/arabicBuilder.js — the ARABIC BUILDER: a consistent Arabic product
// name GENERATED from the structured English record.
//
// Final layer of Phase 2 (HISTORY §47). Input is a Structured Product; output
// is presentation.
//
// THE POINT. This is not translation. The Arabic name is COMPOSED from
// vocabulary the project curated, in a fixed order, so every product of the
// same kind reads the same way — "آيس كريم" is always آيس كريم, whether the
// crop's Arabic OCR said "ايس كريم", "آيسكريم" or nothing at all. That
// consistency is the deliverable; a translation of whatever the flyer printed
// is not.
//
// A PRESENTATION LAYER, BY DIRECTIVE (user, 2026-07-26). The structured English
// record stays authoritative for identity, search and matching. This module may
// therefore be LOSSY on purpose: anything the lexicon has no Arabic term for is
// DROPPED rather than transliterated, guessed, or left in Latin script. What is
// dropped is reported in `dropped` so the loss is measurable, never silent.
//
// WHY IT CAN REFUSE. A name with no category resolves to `status: 'no_category'`
// and NO built name: without a head noun the composition would be "أروى 330 مل",
// which names nothing. Callers fall back to the observed Arabic OCR name — the
// fallback the brief specifies, and the reason nothing here needs a coverage
// threshold.
//
// KNOWN LIMITATION (accepted for this phase, deliberately not hidden): Arabic
// adjective agreement in gender/number is not modelled. Descriptor terms are
// stored in the masculine singular, so "مياه معبأة" (a lexicon phrase, correct)
// reads better than a composed "مياه مجمد" would. Composed adjectives are
// therefore kept few and factual; full agreement needs a morphology layer and a
// gender field per category, which is not this phase.

import { descriptorRoleRank, DESCRIPTOR_ROLES } from './shopping.js';
import { PRODUCT_SOURCES } from './structuredProduct.js';

export const ARABIC_BUILDER_VERSION = 'arabic-builder-v1';

export const ARABIC_BUILD_STATUS = Object.freeze({
  BUILT: 'built',                 // a name was composed
  NO_CATEGORY: 'no_category',     // English understood, but no head noun in the lexicon
  NOT_ENGLISH: 'not_english',     // no usable English name to build from
});

const AL = 'ال';

// "بـ" + the definite article, the way a shelf label joins a second flavour:
// فانيليا + شوكولاتة -> "فانيليا بالشوكولاتة". A term that already carries the
// article takes the bare بـ.
function withBaa(term) {
  return term.startsWith(AL) ? `ب${term}` : `ب${AL}${term}`;
}

function withWaw(term) {
  return term.startsWith(AL) ? `و${term}` : `و${AL}${term}`;
}

// One flavour reads bare; two join with بـ (the phrasing the brief specifies);
// three or more join with و, because "فانيليا بالشوكولاتة بالفراولة" is not
// something anyone writes.
export function joinFlavors(terms) {
  const list = terms.filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} ${withBaa(list[1])}`;
  return [list[0], ...list.slice(1).map(withWaw)].join(' ');
}

// --- the entry point -----------------------------------------------------------
// Composition order is FIXED and is the whole point of the module:
//
//   category → non-flavour descriptors (by role) → flavour phrase → brand → size
//
// so "Arwa Bottled Water 330 ml" and "Nova Bottled Water 200ml" produce names
// with identical shape, and a shopper comparing them reads the same words in
// the same places.
export function buildArabicName(structured) {
  const dropped = [];
  if (!structured || structured.source !== PRODUCT_SOURCES.ENGLISH) {
    return {
      status: ARABIC_BUILD_STATUS.NOT_ENGLISH,
      name: null,
      lines: null,
      parts: null,
      dropped: [],
      version: ARABIC_BUILDER_VERSION,
    };
  }

  // Everything the English name said that this layer cannot express in Arabic.
  // Reported, not hidden — this list is the measurement of how lossy the
  // presentation layer currently is.
  dropped.push(...(structured.residual_en || []).map((token) => ({ token, reason: 'no_lexicon_term' })));
  if (structured.brand?.observed_brand && !structured.brand.display_ar) {
    dropped.push({ token: structured.brand.observed_brand, reason: 'brand_has_no_arabic_name' });
  }

  if (!structured.category) {
    return {
      status: ARABIC_BUILD_STATUS.NO_CATEGORY,
      name: null,
      lines: null,
      parts: null,
      dropped,
      version: ARABIC_BUILDER_VERSION,
    };
  }

  const descriptors = [...(structured.descriptors || [])].filter((descriptor) => descriptor.ar);
  const flavors = descriptors.filter((descriptor) => descriptor.role === DESCRIPTOR_ROLES.FLAVOR);
  const modifiers = descriptors
    .filter((descriptor) => descriptor.role !== DESCRIPTOR_ROLES.FLAVOR)
    .sort((a, b) => descriptorRoleRank(a.role) - descriptorRoleRank(b.role));

  const parts = {
    category: structured.category.ar,
    modifiers: modifiers.map((descriptor) => descriptor.ar),
    flavor: joinFlavors(flavors.map((descriptor) => descriptor.ar)),
    brand: structured.brand?.display_ar ?? null,
    size: structured.size?.display_ar ?? null,
  };

  const name = [
    parts.category,
    ...parts.modifiers,
    parts.flavor,
    parts.brand,
    parts.size,
  ].filter(Boolean).join(' ');

  // The same content, grouped the way a product card stacks it: the shopper
  // reads WHAT it is, then WHICH ONE, then WHO makes it, then HOW MUCH.
  const lines = {
    category: parts.category,
    descriptors: [...parts.modifiers, parts.flavor].filter(Boolean).join(' ') || null,
    brand: parts.brand,
    size: parts.size,
  };

  return {
    status: ARABIC_BUILD_STATUS.BUILT,
    name,
    lines,
    parts,
    dropped,
    version: ARABIC_BUILDER_VERSION,
  };
}
