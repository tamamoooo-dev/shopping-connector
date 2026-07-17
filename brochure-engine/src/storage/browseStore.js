// storage/browseStore.js — the Browse read layer behind a narrow interface,
// backed by D1 (the same database as offers/price history — Browse is a VIEW
// over the existing substrate, it owns no tables of its own).
//
// Interface (all read-only):
//   categoryCounts(currentOn)          -> [{ source, category, n }]
//   list({ include?, excludeMapped?, store?, hasDrop?, maxValidTo?,
//          sort?, limit?, offset?, currentOn }) -> row[]
//   candidates(currentOn)              -> row[]   (history-joined, for scoring)
//
// Every row is an offers row LEFT-JOINed with its price identity and history
// aggregates (weeks_seen, first_seen, min/max price, point count) — the shape
// browse/deals.js scores and badges. The join key is offers.identity, written
// at ingest by the same derivation the price-history harvest uses.

import {
  FROZEN_MARK_TERMS, PROCESSED_MARK_TERMS, FRESH_GUARD_TERMS,
} from '../browse/mapping.js';

// Slim projection: everything a Browse card needs, nothing more (search_text
// stays out — it is matching payload, ~600 chars/row of dead weight here).
const CARD_COLS = `
  o.id, o.store, o.region, o.source, o.offer_id, o.flyer_ref, o.page_ref,
  o.edition, o.name, o.name_ar, o.price, o.old_price, o.currency, o.category,
  o.image_url, o.source_url, o.valid_from, o.valid_to, o.detected_at,
  o.identity, o.brand_slug, pi.weeks_seen, pi.first_seen,
  h.min_price, h.max_price, h.points`;

const HISTORY_JOIN = `
  LEFT JOIN price_identities pi ON pi.id = o.identity
  LEFT JOIN (SELECT identity, MIN(price) AS min_price, MAX(price) AS max_price,
                    COUNT(*) AS points
               FROM price_history GROUP BY identity) h ON h.identity = o.identity`;

// The SQL twin of mapping.isFrozenMarked, GENERATED from the same term lists
// so the two classifiers cannot drift (the JS regex and this expression MUST
// classify identically or tiles and listings diverge). Both test the
// space-joined "name nameAr" pair with NULLs coalesced to '' — a NULL column
// must read as "no mark", never as SQL NULL: `NOT (name LIKE ...)` over a
// NULL name is NULL, and three-valued logic silently dropped every NULL-named
// row from the fresh listings (all produce; production bug found 2026-07-17).
// ASCII LIKE is case-insensitive, matching the JS regex's /i.
const MARK_NAMES = `(ifnull(o.name,'') || ' ' || ifnull(o.name_ar,''))`;
const likeAny = (terms) => terms.map((t) => `${MARK_NAMES} LIKE '%${t}%'`).join(' OR ');
const FROZEN_MARK_SQL = `((${likeAny(FROZEN_MARK_TERMS)})
  OR ((${likeAny(PROCESSED_MARK_TERMS)}) AND NOT (${likeAny(FRESH_GUARD_TERMS)})))`;

const SORTS = {
  discount: `(CASE WHEN o.old_price > o.price
               THEN (o.old_price - o.price) * 1.0 / o.old_price ELSE 0 END) DESC,
             o.price ASC`,
  price: 'o.price ASC',
  newest: 'o.detected_at DESC, o.price ASC',
  ending: 'o.valid_to ASC, o.price ASC',
};

export function createD1BrowseStore(db) {
  return {
    // Live-offer counts per (source, provider category) — the market floor's
    // department/aisle tiles fold these through the canonical mapping in JS
    // (read-time canonicalization: mapping fixes apply retroactively).
    // The extra frozen_marked split lets the read-time fresh->frozen
    // refinement (mapping.FRESH_TO_FROZEN) fold counts onto the right aisle.
    async categoryCounts(currentOn) {
      const { results } = await db
        .prepare(
          `SELECT o.source, o.category,
                  (CASE WHEN ${FROZEN_MARK_SQL} THEN 1 ELSE 0 END) AS frozen_marked,
                  COUNT(*) AS n
             FROM offers o WHERE o.valid_to >= ?
            GROUP BY o.source, o.category, frozen_marked`,
        )
        .bind(currentOn)
        .all();
      return results || [];
    },

    // The universal Browse listing.
    //   include:       [{ source, categories: [...] }] — canonical-aisle
    //                  prefilter (from mapping.providerCategoriesFor)
    //   excludeMapped: [{ source, categories: [...] }] — the `other` aisle
    //                  ("everything this source does NOT map, incl. null")
    //   store, hasDrop, maxValidTo — additional narrows
    // Live-offer counts per canonical brand (the Brands entry point).
    async brandCounts(currentOn) {
      const { results } = await db
        .prepare(
          `SELECT brand_slug, COUNT(*) AS n, COUNT(DISTINCT store) AS stores
             FROM offers WHERE valid_to >= ? AND brand_slug IS NOT NULL
            GROUP BY brand_slug ORDER BY n DESC`,
        )
        .bind(currentOn)
        .all();
      return results || [];
    },

    // One brand's live offers per (source, category, frozen_marked) — the
    // brand page's product-families facet folds these through the canonical
    // mapping exactly like categoryCounts.
    async brandFacets(brandSlug, currentOn) {
      const { results } = await db
        .prepare(
          `SELECT o.source, o.category,
                  (CASE WHEN ${FROZEN_MARK_SQL} THEN 1 ELSE 0 END) AS frozen_marked,
                  COUNT(*) AS n
             FROM offers o WHERE o.valid_to >= ? AND o.brand_slug = ?
            GROUP BY o.source, o.category, frozen_marked`,
        )
        .bind(currentOn, brandSlug)
        .all();
      return results || [];
    },

    async list({
      include = null,
      excludeMapped = null,
      store = '',
      brand = '',
      hasDrop = false,
      maxValidTo = null,
      sort = 'discount',
      limit = 60,
      offset = 0,
      currentOn,
    }) {
      const where = ['o.valid_to >= ?'];
      const binds = [currentOn];
      if (include) {
        if (!include.length) return []; // no source feeds these aisles
        // A group's optional `frozen` mode ('exclude' | 'only') applies the
        // fresh->frozen name refinement inside SQL, so pagination and counts
        // stay exact (browse/api.js categoryFilter builds the groups).
        const parts = include.map(({ source, categories, frozen }) => {
          binds.push(source, ...categories);
          let p = `(o.source = ? AND o.category IN (${categories.map(() => '?').join(',')})`;
          if (frozen === 'exclude') p += ` AND NOT ${FROZEN_MARK_SQL}`;
          else if (frozen === 'only') p += ` AND ${FROZEN_MARK_SQL}`;
          return `${p})`;
        });
        where.push(`(${parts.join(' OR ')})`);
      }
      if (excludeMapped) {
        for (const { source, categories } of excludeMapped) {
          binds.push(source, ...categories);
          where.push(
            `(o.source != ? OR o.category IS NULL OR o.category NOT IN (${categories.map(() => '?').join(',')}))`,
          );
        }
      }
      if (store) {
        where.push('o.store = ?');
        binds.push(store);
      }
      if (brand) {
        where.push('o.brand_slug = ?');
        binds.push(brand);
      }
      if (hasDrop) where.push('o.old_price IS NOT NULL AND o.old_price > o.price');
      if (maxValidTo) {
        where.push('o.valid_to <= ?');
        binds.push(maxValidTo);
      }
      const sql = `SELECT ${CARD_COLS} FROM offers o ${HISTORY_JOIN}
        WHERE ${where.join(' AND ')}
        ORDER BY ${SORTS[sort] || SORTS.discount}
        LIMIT ? OFFSET ?`;
      binds.push(Math.max(1, Math.min(Number(limit) || 60, 120)));
      binds.push(Math.max(0, Math.min(Number(offset) || 0, 5000)));
      const { results } = await db.prepare(sql).bind(...binds).all();
      return results || [];
    },

    // Every current offer WITH a price identity — the Exceptional Deals /
    // history-rail candidate pool (qualification requires history signals, so
    // identity-less offers can never qualify and are prefiltered out here).
    async candidates(currentOn) {
      const sql = `SELECT ${CARD_COLS} FROM offers o
        JOIN price_identities pi ON pi.id = o.identity
        LEFT JOIN (SELECT identity, MIN(price) AS min_price, MAX(price) AS max_price,
                          COUNT(*) AS points
                     FROM price_history GROUP BY identity) h ON h.identity = o.identity
        WHERE o.valid_to >= ? AND o.identity IS NOT NULL
        LIMIT 10000`;
      const { results } = await db.prepare(sql).bind(currentOn).all();
      return results || [];
    },
  };
}
