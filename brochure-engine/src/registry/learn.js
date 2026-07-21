// registry/learn.js — Registry LEARNING: the pure §5 update rules
// (REGISTRY-DESIGN.md §5.1–§5.3) that turn "an auto-band sighting happened"
// into an updated product row. Pure functions over row objects — no storage,
// no source knowledge; the applier (apply.js) persists what these compute.
//
// Band discipline (§3): only the AUTO band reaches these functions. The
// review band attaches a sighting but teaches nothing — a wrong attachment
// must not poison future matching — and `created` rows are born complete
// (model.js newProductRow). The applier enforces this; learn.js assumes it.

import {
  decodeProfile, encodeProfile, PROFILE_TOKEN_CAP, REGISTRY_ALGO_VERSION,
} from './model.js';
import { detectBrand } from '../browse/brands.js';

// Learning priors — same calibration discipline as resolver TUNING: defaults
// grounded in the design, overridable by the caller, never asserted as final.
export const LEARN_TUNING = Object.freeze({
  profileCap: PROFILE_TOKEN_CAP, // §5.2 (~24)
  // §5.3 "highest-corroboration RECENT read wins": a display pick older than
  // this many weeks is stale — presentation freshness beats a high but old
  // corroboration. Aligned with the §5.1 dormancy horizon.
  displayFreshWeeks: 6,
});

const WEEK_MS = 7 * 24 * 3600 * 1000;
function weeksBetween(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 0;
  return Math.abs(tb - ta) / WEEK_MS;
}

// §5.2 token-profile update (auto band only): increment seen tokens, add new
// ones stamped with this week, cap by dropping lowest-count-oldest — the
// profile stays a consensus of what this product is usually called, and an
// unbounded profile that would drift toward matching everything is impossible
// by construction.
export function updatedProfile(profileText, tokens, week, tuning = LEARN_TUNING) {
  const profile = decodeProfile(profileText);
  for (const t of tokens) {
    if (profile[t]) {
      profile[t] = { count: profile[t].count + 1, week };
    } else {
      profile[t] = { count: 1, week };
    }
  }
  return capProfile(profile, tuning.profileCap);
}

// The §5.2 cap, shared by every profile writer (sighting learning here, the
// §5.4 merge union in lifecycle.js). Drop order: lowest count first, then
// oldest week, then token — fully deterministic so replays reproduce
// identical profiles.
export function capProfile(profile, cap) {
  const entries = Object.entries(profile);
  if (entries.length > cap) {
    entries.sort(([ta, a], [tb, b]) =>
      (a.count - b.count) || String(a.week).localeCompare(String(b.week)) || ta.localeCompare(tb));
    entries.splice(0, entries.length - cap);
  }
  return Object.fromEntries(entries);
}

// §5.3 display adoption: the highest-corroboration recent read wins. Adopt
// when the product has no display, the new read corroborates at least as well
// as the current pick, or the current pick has gone stale (freshness matters —
// packaging and phrasing legitimately change). Returns the field delta or
// null (keep the current display).
export function adoptDisplay(product, { name, nameAr, corroboration, week }, tuning = LEARN_TUNING) {
  if (name == null && nameAr == null) return null;
  const hasDisplay = product.display_name != null || product.display_name_ar != null;
  const adopt =
    !hasDisplay ||
    Number(corroboration) >= Number(product.display_corroboration || 0) ||
    weeksBetween(product.display_week || product.first_seen, week) > tuning.displayFreshWeeks;
  if (!adopt) return null;
  return {
    display_name: name ?? null,
    display_name_ar: nameAr ?? null,
    display_corroboration: Number(corroboration) || 0,
    display_week: week,
  };
}

// §5.3 size adoption: a sized read FILLS a nosize product; a conflicting sized
// read (both read, different) never overwrites — it flags review (a variant
// split may be hiding inside one product). The resolver's size veto makes the
// conflict arm unreachable on today's attach path; it stays implemented
// because §5.3 mandates the flag and future paths may attach differently.
export function adoptSize(product, readSize, { sizeTolerance = 0.03 } = {}) {
  if (!readSize) return null;
  if (product.size_unit == null || product.size_total == null) {
    return {
      fill: { size_unit: readSize.unit, size_total: readSize.each, size_pack: readSize.pack || 1 },
    };
  }
  const pt = product.size_total * (product.size_pack || 1);
  const rt = readSize.each * (readSize.pack || 1);
  const hi = Math.max(pt, rt);
  const conflicting =
    product.size_unit !== readSize.unit ||
    (hi > 0 && (hi - Math.min(pt, rt)) / hi > sizeTolerance);
  return conflicting ? { flag: 'size-conflict' } : null;
}

// §5.3 brand_slug: re-run detectBrand over the product's (post-adoption)
// display names — only ever set/upgraded; a conflicting detection never
// overwrites, it flags review. `source`/`category` feed detectBrand's
// department guards exactly as on live offers.
export function adoptBrandSlug(product, { name, nameAr, source, category }) {
  const slug = detectBrand({ name, nameAr, source, category });
  if (!slug) return null;
  if (product.brand_slug == null) return { fill: { brand_slug: slug } };
  if (product.brand_slug !== slug) return { flag: 'brand-conflict' };
  return null;
}

// The §5 composite: everything an auto-band sighting teaches its product.
// `product` is the current row; `read` the resolver's normalized read;
// `observation` the presentation/context fields the read's source supplies:
//   { name, nameAr, source, category, store, week }
// Returns { fields, tokens }: the row delta to persist and the profile's
// token list for the §1.2 index rewrite.
export function learnFromSighting(product, read, observation, tuning = LEARN_TUNING) {
  const fields = {};

  // §5.2 — the profile IS the identity evidence.
  const profile = updatedProfile(product.token_profile, read.tokens, observation.week, tuning);
  fields.token_profile = encodeProfile(profile);

  // Evidence summary (§1.1): counters live on the row so §4.3 confidence is a
  // row read, not a sightings scan.
  fields.sightings = (product.sightings || 0) + 1;
  const stores = new Set(JSON.parse(product.stores_seen || '[]'));
  if (observation.store) stores.add(observation.store);
  fields.stores_seen = JSON.stringify([...stores].sort());
  if (!product.first_seen || observation.week < product.first_seen) {
    fields.first_seen = observation.week;
  }
  if (!product.last_seen || observation.week > product.last_seen) {
    fields.last_seen = observation.week;
  }
  // §5.1: dormant ⇄ active — being seen again reactivates.
  if (product.status === 'dormant') fields.status = 'active';

  // §5.3 — presentation and metadata, never matching consequences.
  const display = adoptDisplay(
    product,
    { name: observation.name, nameAr: observation.nameAr, corroboration: read.corroboration, week: observation.week },
    tuning,
  );
  if (display) {
    Object.assign(fields, display);
    // brand_text follows the same best-evidence provenance as the display.
    if (read.brandText) fields.brand_text = read.brandText;
  }

  const size = adoptSize(product, read.size);
  if (size?.fill) Object.assign(fields, size.fill);

  const brand = adoptBrandSlug(
    { ...product, ...fields },
    {
      name: display ? observation.name : product.display_name,
      nameAr: display ? observation.nameAr : product.display_name_ar,
      source: observation.source,
      category: observation.category,
    },
  );
  if (brand?.fill) Object.assign(fields, brand.fill);

  // Flags accumulate the FIRST suspicion (§6: review queue reads the reason);
  // an already-flagged product keeps its original reason until a human clears.
  const flag = size?.flag || brand?.flag || null;
  if (flag && !product.review_flag) fields.review_flag = flag;

  fields.algo_version = REGISTRY_ALGO_VERSION; // §1.1: version that last touched it
  return { fields, tokens: Object.keys(profile) };
}
