import { AISLES } from '../browse/taxonomy.js';
import { saleObservationSql } from '../offers/saleObservation.js';
import { priceSizeContextSql } from '../offers/priceSizeAssociation.js';
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
import { corroboratedPackCountSql } from '../offers/observedPackCount.js';
import {
  ENRICH_JOIN, CANON_NAME_SQL, SERVABLE_SQL, canonicalNameArSql,
} from './enrichStore.js';

// Slim projection: everything a Browse card needs, nothing more (search_text
// stays out — it is matching payload, ~600 chars/row of dead weight here).
// Names are the CANONICAL identity (vision-canonical, 2026-07-21): the
// servable vision reading via the one shared gate (enrichStore.js
// SERVABLE_SQL), OCR as extraction fallback — same names Search serves.
const HISTORY_JOIN = `
  ${ENRICH_JOIN}
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
// Classify over the CANONICAL names (vision when servable, OCR fallback) so
// fresh/frozen bucketing agrees with the names the cards actually show.
const SORTS = {
  discount: `(CASE WHEN o.old_price > o.price
               THEN (o.old_price - o.price) * 1.0 / o.old_price ELSE 0 END) DESC,
             o.price ASC`,
  price: 'o.price ASC',
  newest: 'o.detected_at DESC, o.price ASC',
  ending: 'o.valid_to ASC, o.price ASC',
};

// The outer half of a brand-listing CTE cannot refer to the original `o`
// alias. Keep the ordering byte-for-byte equivalent to SORTS so SQL-level
// pagination does not change the order users already see.
const OUTER_SORTS = {
  discount: `(CASE WHEN old_price > price
               THEN (old_price - price) * 1.0 / old_price ELSE 0 END) DESC,
             price ASC`,
  price: 'price ASC',
  newest: 'detected_at DESC, price ASC',
  ending: 'valid_to ASC, price ASC',
};

export function createD1BrowseStore(db, { builtArabicNamesEnabled = false } = {}) {
  const canonicalNameAr = canonicalNameArSql(builtArabicNamesEnabled);
  // The saved classification drives tile counts, filters and card placement
  // together. Legacy rows retain their provider mapping until reprocessed.
  const titleVersion="json_extract(e.extraction_json, '$._arabic_builder.product_title.version')";
  const classRoot='$._arabic_builder.product_title.classification';
  const savedAisle=`json_extract(e.extraction_json, '${classRoot}.aisle')`;
  const classified=`(${SERVABLE_SQL} AND json_valid(e.extraction_json) AND ${titleVersion}='dictionary-title-v1'
    AND json_extract(e.extraction_json, '${classRoot}.version')='archive-classification-v1'
    AND json_extract(e.extraction_json, '${classRoot}.status')='classified'
    AND ${savedAisle} IN (${AISLES.filter(a=>a.id!=='other').map(a=>"'"+a.id+"'").join(',')}))`;
  const sourceSql=`(CASE WHEN ${classified} THEN 'knowledge' ELSE o.source END)`;
  const categorySql=`(CASE WHEN ${classified} THEN ${savedAisle} ELSE o.category END)`;
  const canonicalBrandSql=`(CASE WHEN ${SERVABLE_SQL} AND json_valid(e.extraction_json) AND ${titleVersion}='dictionary-title-v1'
    THEN json_extract(e.extraction_json, '$._arabic_builder.product_title.brand.id') ELSE o.brand_slug END)`;

  const cardColumns = `
    o.id, o.store, o.region, o.source, o.offer_id, o.flyer_ref, o.page_ref,
    o.brochure_id, o.page_index, o.navigation_provenance, o.edition,
    ${CANON_NAME_SQL} AS name, ${canonicalNameAr} AS name_ar,
    o.price, o.old_price, o.currency, o.category,
    o.image_url, o.source_url, o.valid_from, o.valid_to, o.detected_at,
    o.identity, ${canonicalBrandSql} AS brand_slug, pi.weeks_seen, pi.first_seen,
    h.min_price, h.max_price, h.points,
    -- The three enrichment fields the PER-ITEM price needs (browse/api.js
    -- cardDoc). Deliberately NOT o.search_text, which the /offers path also
    -- feeds to the projection: measured on all 74,173 priced offers, omitting it
    -- changes the each-price on ZERO of them -- it can only ever contribute a
    -- PRICE BASIS, which carries pack 1 and is refused by gate 4 regardless.
    -- It changes 1,488 UNIT prices, which is why Browse serves no unit price
    -- rather than a second, quieter one. The candidates() query scans up to
    -- 10,000 rows and search_text is the full OCR haystack; these three are
    -- small. NOTE: no backticks in this comment -- it lives inside a JS
    -- template literal, where one would end the string.
    ${SERVABLE_SQL} AS servable, e.model AS e_model, e.size AS e_size,
    json_extract(e.extraction_json, '$.unit') AS e_unit,
    ${corroboratedPackCountSql()} AS e_pack_count,
    ${saleObservationSql()} AS e_sale,
    ${priceSizeContextSql()} AS e_price_context,
    json_extract(e.extraction_json, '$._arabic_builder.product_title') AS e_product_title,
    json_extract(e.extraction_json, '$.package_type') AS e_package_type`;
  const markNames = `(ifnull(${CANON_NAME_SQL},'') || ' ' || ifnull(${canonicalNameAr},''))`;
  const likeAny = (terms) => terms.map((t) => `${markNames} LIKE '%${t}%'`).join(' OR ');
  const frozenMarkSql = `((${likeAny(FROZEN_MARK_TERMS)})
    OR ((${likeAny(PROCESSED_MARK_TERMS)}) AND NOT (${likeAny(FRESH_GUARD_TERMS)})))`;
  // SQL twin of browse/api.js dedupeRows. Brand counts, family counts and
  // paged brand cards must describe the same real-world deals. The identity is
  // strongest; identity-less OCR rows use the canonical displayed name/image.
  const dealKeySql = `(CASE WHEN o.identity IS NOT NULL THEN
      'i:' || ifnull(o.store,'') || ':' || o.identity || ':' || printf('%.15g', o.price)
    ELSE 'f:' || ifnull(o.store,'') || ':' || printf('%.15g', o.price) || ':' ||
      coalesce(nullif(${CANON_NAME_SQL},''), nullif(${canonicalNameAr},''),
               nullif(o.image_url,''), o.id)
    END)`;

  return {
    // Live-offer counts per (source, provider category) — the market floor's
    // department/aisle tiles fold these through the canonical mapping in JS
    // (read-time canonicalization: mapping fixes apply retroactively).
    // The extra frozen_marked split lets the read-time fresh->frozen
    // refinement (mapping.FRESH_TO_FROZEN) fold counts onto the right aisle.
    async categoryCounts(currentOn) {
      const { results } = await db
        .prepare(
          `SELECT ${sourceSql} AS source, ${categorySql} AS category,
                  (CASE WHEN ${frozenMarkSql} THEN 1 ELSE 0 END) AS frozen_marked,
                  COUNT(*) AS n
             FROM offers o ${ENRICH_JOIN}
            WHERE o.valid_to >= ?
              AND o.brochure_id IS NOT NULL AND o.page_index IS NOT NULL
            GROUP BY ${sourceSql}, ${categorySql}, frozen_marked`,
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
          `SELECT ${canonicalBrandSql} AS brand_slug, COUNT(DISTINCT ${dealKeySql}) AS n,
                  COUNT(DISTINCT o.store) AS stores
             FROM offers o ${ENRICH_JOIN}
            WHERE o.valid_to >= ? AND ${canonicalBrandSql} IS NOT NULL
              AND o.brochure_id IS NOT NULL AND o.page_index IS NOT NULL
            GROUP BY ${canonicalBrandSql} ORDER BY n DESC`,
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
          `WITH ranked AS (
             SELECT ${sourceSql} AS source, ${categorySql} AS category,
                    (CASE WHEN ${frozenMarkSql} THEN 1 ELSE 0 END) AS frozen_marked,
                    ROW_NUMBER() OVER (
                      PARTITION BY ${dealKeySql}
                      ORDER BY o.valid_to DESC, o.id ASC
                    ) AS deal_rank
               FROM offers o ${ENRICH_JOIN}
              WHERE o.valid_to >= ? AND ${canonicalBrandSql} = ?
                AND o.brochure_id IS NOT NULL AND o.page_index IS NOT NULL
           )
           SELECT source, category, frozen_marked, COUNT(*) AS n
             FROM ranked WHERE deal_rank = 1
            GROUP BY source, category, frozen_marked`,
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
      const where = [
        'o.valid_to >= ?',
        'o.brochure_id IS NOT NULL',
        'o.page_index IS NOT NULL',
      ];
      const binds = [currentOn];
      if (include) {
        if (!include.length) return []; // no source feeds these aisles
        // A group's optional `frozen` mode ('exclude' | 'only') applies the
        // fresh->frozen name refinement inside SQL, so pagination and counts
        // stay exact (browse/api.js categoryFilter builds the groups).
        const parts = include.map(({ source, categories, frozen }) => {
          binds.push(source, ...categories);
          let p = `(${sourceSql} = ? AND ${categorySql} IN (${categories.map(() => '?').join(',')})`;
          if (frozen === 'exclude') p += ` AND NOT ${frozenMarkSql}`;
          else if (frozen === 'only') p += ` AND ${frozenMarkSql}`;
          return `${p})`;
        });
        where.push(`(${parts.join(' OR ')})`);
      }
      if (excludeMapped) {
        for (const { source, categories } of excludeMapped) {
          binds.push(source, ...categories);
          where.push(
            `(${sourceSql} != ? OR ${categorySql} IS NULL OR ${categorySql} NOT IN (${categories.map(() => '?').join(',')}))`,
          );
        }
      }
      if (store) {
        where.push('o.store = ?');
        binds.push(store);
      }
      if (brand) {
        where.push(`${canonicalBrandSql} = ?`);
        binds.push(brand);
      }
      if (hasDrop) where.push('o.old_price IS NOT NULL AND o.old_price > o.price');
      if (maxValidTo) {
        where.push('o.valid_to <= ?');
        binds.push(maxValidTo);
      }
      // Brand listings dedupe BEFORE LIMIT/OFFSET. The previous API-level
      // dedupe ran after pagination, so a page requesting 24 cards could
      // return 22 and the next offset skipped real products. Other Browse
      // routes keep their established query plan; this fixes the brand surface
      // without widening the change.
      const sql = brand
        ? `WITH ranked AS (
             SELECT ${cardColumns},
                    ROW_NUMBER() OVER (
                      PARTITION BY ${dealKeySql}
                      ORDER BY o.valid_to DESC, ${SORTS[sort] || SORTS.discount}, o.id ASC
                    ) AS deal_rank
               FROM offers o ${HISTORY_JOIN}
              WHERE ${where.join(' AND ')}
           )
           SELECT * FROM ranked WHERE deal_rank = 1
            ORDER BY ${OUTER_SORTS[sort] || OUTER_SORTS.discount}
            LIMIT ? OFFSET ?`
        : `SELECT ${cardColumns} FROM offers o ${HISTORY_JOIN}
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
      const sql = `SELECT ${cardColumns} FROM offers o
        ${ENRICH_JOIN}
        JOIN price_identities pi ON pi.id = o.identity
        LEFT JOIN (SELECT identity, MIN(price) AS min_price, MAX(price) AS max_price,
                          COUNT(*) AS points
                     FROM price_history GROUP BY identity) h ON h.identity = o.identity
        WHERE o.valid_to >= ? AND o.identity IS NOT NULL
          AND o.brochure_id IS NOT NULL AND o.page_index IS NOT NULL
        LIMIT 10000`;
      const { results } = await db.prepare(sql).bind(currentOn).all();
      return results || [];
    },
  };
}
