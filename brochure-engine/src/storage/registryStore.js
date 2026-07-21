// storage/registryStore.js — the Product Registry store behind a narrow
// interface, backed by D1 (same database as the offers the sightings
// describe — REGISTRY-DESIGN.md §1, tables in schema.sql /
// migrate-2026-07-registry.sql).
//
// Phase 2 interface (candidate retrieval — everything the resolver reads):
//   productCount()                    -> Promise<number>
//   tokenFrequencies(tokens)          -> Promise<Map<token, product count>>
//   candidateIds(tokens)              -> Promise<product_id[]>   (blocking, §4.1)
//   getProducts(ids)                  -> Promise<row[]>
//   findIncumbentProductId({store, region, searchText, excludeOfferId})
//                                     -> Promise<product_id | null>  (§3 sticky)
//   getSighting(offerId)              -> Promise<row | null>  (idempotency, §1.3)
//
// Phase 3 interface (writes — called ONLY by registry/apply.js):
//   insertSighting(row)               -> Promise<{inserted}>  (if-absent; PK gate)
//   createProduct(row, tokens)        -> Promise<void>        (row + §1.2 index)
//   updateProduct(id, fields, tokens) -> Promise<void>        (learned delta +
//                                                              index rewrite)
//
// Lifecycle interface (§5.1/§5.4 — called ONLY by registry/lifecycle.js):
//   sweepDormancy(cutoff)             -> Promise<number>
//   consolidationPairs({commonCeiling, minShared, limit}) -> Promise<pair[]>
//   tombstoneProduct(loserId, survivorId) -> Promise<void>  (single-hop kept)
//   listDanglingSightings(limit) / deleteSightings(ids)     (crash healing)
//
// Consumer interface (§7) + review surfaces (§5.4 split path):
//   sightingsForProducts(ids)         -> Promise<row[]>  (offers LEFT-joined)
//   bestCurrentForProduct(id, today)  -> Promise<best | null>  (product watches)
//   listFlagged(limit) / listReviewSightings(limit)
//   reassignSighting(offerId, toProductId) / clearFlag(productId)
//
// The in-memory twin with identical semantics lives in registry/memstore.js —
// every method added here is added there, in the same shape.

const PRODUCT_INSERT_COLS = [
  'id', 'status', 'merged_into', 'kind', 'display_name', 'display_name_ar',
  'display_corroboration', 'display_week', 'brand_slug', 'brand_text',
  'size_unit', 'size_total', 'size_pack', 'family', 'category',
  'token_profile', 'sightings', 'stores_seen', 'first_seen', 'last_seen',
  'review_flag', 'algo_version',
];

const SIGHTING_INSERT_COLS = [
  'offer_id', 'product_id', 'match_band', 'match_score', 'corroboration',
  'store', 'region', 'week', 'price', 'old_price', 'algo_version', 'resolved_at',
];

// Columns the learner may write (allow-list: a typo in a field name must fail
// loudly here, never silently produce SQL).
const PRODUCT_UPDATE_COLS = new Set(PRODUCT_INSERT_COLS.filter((c) => c !== 'id'));

export function createD1RegistryStore(db) {
  return {
    async productCount() {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM products WHERE status != 'merged'`)
        .first();
      return row?.n || 0;
    },

    // How many products carry each token (the §4.1 commonness input). Only
    // the read's own tokens are asked about — never a full-index scan.
    async tokenFrequencies(tokens) {
      const map = new Map();
      for (let i = 0; i < tokens.length; i += 60) {
        const chunk = tokens.slice(i, i + 60);
        const { results } = await db
          .prepare(
            `SELECT token, COUNT(*) AS n FROM product_tokens
              WHERE token IN (${chunk.map(() => '?').join(',')})
              GROUP BY token`,
          )
          .bind(...chunk)
          .all();
        for (const r of results || []) map.set(r.token, r.n);
      }
      return map;
    },

    // Blocking (§4.1): every product sharing at least one of the (already
    // distinctiveness-filtered) tokens.
    async candidateIds(tokens) {
      const ids = new Set();
      for (let i = 0; i < tokens.length; i += 60) {
        const chunk = tokens.slice(i, i + 60);
        const { results } = await db
          .prepare(
            `SELECT DISTINCT product_id FROM product_tokens
              WHERE token IN (${chunk.map(() => '?').join(',')})`,
          )
          .bind(...chunk)
          .all();
        for (const r of results || []) ids.add(r.product_id);
      }
      return [...ids];
    },

    async getProducts(ids) {
      const rows = [];
      for (let i = 0; i < ids.length; i += 60) {
        const chunk = ids.slice(i, i + 60);
        const { results } = await db
          .prepare(`SELECT * FROM products WHERE id IN (${chunk.map(() => '?').join(',')})`)
          .bind(...chunk)
          .all();
        rows.push(...(results || []));
      }
      return rows;
    },

    // Sticky incumbency (§3): the product of a PRIOR offer from the same
    // store+region whose OCR text is identical (exact normalized search_text).
    // TEMPORARY FAST-PATH, NOT AN ARCHITECTURAL DEPENDENCY: exact equality is
    // the cheap approximation of "near-identical" — as extraction improves and
    // text legitimately drifts, this simply returns null more often and the
    // resolver falls back to pure profile matching (only tie-break hysteresis
    // is lost). A better similarity lookup swaps in HERE, behind the same
    // method, with zero resolver changes.
    async findIncumbentProductId({ store, region, searchText, excludeOfferId }) {
      if (!searchText) return null;
      const row = await db
        .prepare(
          `SELECT s.product_id FROM offers o
             JOIN product_sightings s ON s.offer_id = o.id
            WHERE o.store = ? AND o.region = ? AND o.search_text = ? AND o.id != ?
            ORDER BY s.resolved_at DESC LIMIT 1`,
        )
        .bind(store, region, searchText, excludeOfferId || '')
        .first();
      return row?.product_id || null;
    },

    // §1.3: offer_id is the PK — one sighting per offer, ever. The drain
    // checks this before resolving (a resolved offer is a no-op re-run).
    async getSighting(offerId) {
      return (
        (await db
          .prepare('SELECT * FROM product_sightings WHERE offer_id = ?')
          .bind(offerId)
          .first()) || null
      );
    },

    // Batch fetch for the /offers vision-mode annotation: offer id ->
    // { product_id, match_band }, keyed for O(1) join per served row.
    async getSightingsForIds(ids) {
      const map = new Map();
      for (let i = 0; i < ids.length; i += 60) {
        const chunk = ids.slice(i, i + 60);
        const { results } = await db
          .prepare(
            `SELECT offer_id, product_id, match_band FROM product_sightings
              WHERE offer_id IN (${chunk.map(() => '?').join(',')})`,
          )
          .bind(...chunk)
          .all();
        for (const r of results || []) map.set(r.offer_id, r);
      }
      return map;
    },

    // Canonical sibling expansion (/offers, 2026-07-21): every sighting of the
    // given products — so a query that lexically matched ONE retailer's offer
    // can surface the SAME canonical product at every other retailer, even
    // when a sibling's extracted name is generic ("Milk" on a tile whose brand
    // only appears in the artwork).
    async sightingsForProducts(productIds) {
      const out = [];
      const ids = [...new Set(productIds)].filter(Boolean);
      for (let i = 0; i < ids.length; i += 60) {
        const chunk = ids.slice(i, i + 60);
        const { results } = await db
          .prepare(
            `SELECT offer_id, product_id, match_band FROM product_sightings
              WHERE product_id IN (${chunk.map(() => '?').join(',')})`,
          )
          .bind(...chunk)
          .all();
        out.push(...(results || []));
      }
      return out;
    },

    // §8 standing metrics, one D1 round-trip each: registry size and health,
    // match-band distribution, review pressure, weekly new-product series
    // (must DECAY toward the true new-product rate as coverage builds — a
    // flat rate means blocking is missing matches).
    async stats() {
      const [products, bands, weekly] = await Promise.all([
        db
          .prepare(
            `SELECT
               SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
               SUM(CASE WHEN status = 'dormant' THEN 1 ELSE 0 END) AS dormant,
               SUM(CASE WHEN status = 'merged' THEN 1 ELSE 0 END) AS merged,
               SUM(CASE WHEN review_flag IS NOT NULL THEN 1 ELSE 0 END) AS flagged,
               SUM(CASE WHEN kind = 'assortment' THEN 1 ELSE 0 END) AS assortments
             FROM products`,
          )
          .first(),
        db
          .prepare(
            `SELECT match_band AS band, COUNT(*) AS n FROM product_sightings GROUP BY match_band`,
          )
          .all(),
        db
          .prepare(
            `SELECT week, SUM(CASE WHEN match_band = 'created' THEN 1 ELSE 0 END) AS created,
                    COUNT(*) AS sightings
               FROM product_sightings GROUP BY week ORDER BY week DESC LIMIT 12`,
          )
          .all(),
      ]);
      return {
        products: {
          active: products?.active || 0,
          dormant: products?.dormant || 0,
          merged: products?.merged || 0,
          flagged: products?.flagged || 0,
          assortments: products?.assortments || 0,
        },
        bands: Object.fromEntries((bands?.results || []).map((r) => [r.band, r.n])),
        weekly: weekly?.results || [],
      };
    },

    // Ops Registry Inspector: total resolved sightings (the §8 evidence
    // volume), one round-trip. Distinct from the band breakdown in stats().
    async sightingsCount() {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM product_sightings').first();
      return row?.n || 0;
    },

    // Ops Registry Inspector search: non-merged products whose id, display
    // name (either language), or brand (slug/raw) contains `q`. Read-only,
    // most-recently-seen first. No barcode lens — the registry has no barcode
    // column (Ops plan §3).
    async searchProducts({ q = '', limit = 30 } = {}) {
      const term = String(q || '').trim();
      if (!term) return [];
      const esc = (v) => v.replace(/[%_\\]/g, (c) => '\\' + c);
      const like = `%${esc(term)}%`;
      const { results } = await db
        .prepare(
          `SELECT * FROM products
            WHERE status != 'merged'
              AND (id LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\'
                   OR display_name_ar LIKE ? ESCAPE '\\' OR brand_text LIKE ? ESCAPE '\\'
                   OR brand_slug LIKE ? ESCAPE '\\')
            ORDER BY last_seen DESC LIMIT ?`,
        )
        .bind(like, like, like, like, like, Math.max(1, Math.min(Number(limit) || 30, 100)))
        .all();
      return results || [];
    },

    // Insert-if-absent: the §1.3/§6 idempotency gate. `inserted: false` tells
    // the applier this offer was already resolved — skip every other write.
    async insertSighting(row) {
      const res = await db
        .prepare(
          `INSERT INTO product_sightings (${SIGHTING_INSERT_COLS.join(',')})
           VALUES (${SIGHTING_INSERT_COLS.map(() => '?').join(',')})
           ON CONFLICT(offer_id) DO NOTHING`,
        )
        .bind(...SIGHTING_INSERT_COLS.map((c) => row[c] ?? null))
        .run();
      return { inserted: (res?.meta?.changes || 0) > 0 };
    },

    // Found a product (§3 create): the row plus its §1.2 index rows, one batch.
    async createProduct(row, tokens) {
      const stmts = [
        db
          .prepare(
            `INSERT INTO products (${PRODUCT_INSERT_COLS.join(',')})
             VALUES (${PRODUCT_INSERT_COLS.map(() => '?').join(',')})`,
          )
          .bind(...PRODUCT_INSERT_COLS.map((c) => row[c] ?? null)),
        ...tokens.map((t) =>
          db
            .prepare('INSERT OR IGNORE INTO product_tokens (token, product_id) VALUES (?,?)')
            .bind(t, row.id),
        ),
      ];
      await db.batch(stmts);
    },

    // Persist a learned delta (§5) and rewrite the product's index rows to
    // mirror its (possibly capped) profile, one batch.
    async updateProduct(id, fields, tokens) {
      const cols = Object.keys(fields).filter((c) => PRODUCT_UPDATE_COLS.has(c));
      const unknown = Object.keys(fields).filter((c) => !PRODUCT_UPDATE_COLS.has(c));
      if (unknown.length) throw new Error(`updateProduct: unknown column(s) ${unknown.join(',')}`);
      if (!cols.length) return;
      const stmts = [
        db
          .prepare(`UPDATE products SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`)
          .bind(...cols.map((c) => fields[c] ?? null), id),
      ];
      if (tokens) {
        stmts.push(db.prepare('DELETE FROM product_tokens WHERE product_id = ?').bind(id));
        for (const t of tokens) {
          stmts.push(
            db
              .prepare('INSERT OR IGNORE INTO product_tokens (token, product_id) VALUES (?,?)')
              .bind(t, id),
          );
        }
      }
      await db.batch(stmts);
    },

    // --- §5.1 dormancy ---------------------------------------------------------
    async sweepDormancy(cutoff) {
      const res = await db
        .prepare(`UPDATE products SET status = 'dormant' WHERE status = 'active' AND last_seen < ?`)
        .bind(cutoff)
        .run();
      return res?.meta?.changes || 0;
    },

    // --- §5.4 consolidation pair retrieval ------------------------------------
    // Non-merged product pairs sharing >= minShared DISTINCTIVE tokens (the
    // same §4.1 commonness idea: a token in half the catalog pairs nothing).
    // Merged products hold no index rows, so they never pair by construction.
    async consolidationPairs({ commonCeiling, minShared = 2, limit = 200 } = {}) {
      const { results } = await db
        .prepare(
          `WITH rare AS (
             SELECT token FROM product_tokens GROUP BY token HAVING COUNT(*) <= ?1
           )
           SELECT a.product_id AS a_id, b.product_id AS b_id, COUNT(*) AS shared
             FROM product_tokens a
             JOIN product_tokens b ON b.token = a.token AND b.product_id > a.product_id
            WHERE a.token IN (SELECT token FROM rare)
            GROUP BY a.product_id, b.product_id
            HAVING COUNT(*) >= ?2
            ORDER BY shared DESC LIMIT ?3`,
        )
        .bind(commonCeiling, minShared, limit)
        .all();
      return (results || []).map((r) => ({ aId: r.a_id, bId: r.b_id, shared: r.shared }));
    },

    // Tombstone the merge loser (§5.1/§5.4): merged status + pointer, index
    // rows dropped, old tombstones re-pointed so chains stay single-hop. One
    // batch; the survivor's learned delta goes through updateProduct.
    async tombstoneProduct(loserId, survivorId) {
      await db.batch([
        db
          .prepare(`UPDATE products SET status = 'merged', merged_into = ? WHERE id = ?`)
          .bind(survivorId, loserId),
        db.prepare('DELETE FROM product_tokens WHERE product_id = ?').bind(loserId),
        db
          .prepare(`UPDATE products SET merged_into = ? WHERE status = 'merged' AND merged_into = ?`)
          .bind(survivorId, loserId),
      ]);
    },

    // --- crash containment (apply.js contract) --------------------------------
    async listDanglingSightings(limit = 200) {
      const { results } = await db
        .prepare(
          `SELECT s.offer_id FROM product_sightings s
             LEFT JOIN products p ON p.id = s.product_id
            WHERE p.id IS NULL LIMIT ?`,
        )
        .bind(limit)
        .all();
      return (results || []).map((r) => r.offer_id);
    },
    async deleteSightings(offerIds) {
      let n = 0;
      for (let i = 0; i < offerIds.length; i += 60) {
        const chunk = offerIds.slice(i, i + 60);
        const res = await db
          .prepare(
            `DELETE FROM product_sightings WHERE offer_id IN (${chunk.map(() => '?').join(',')})`,
          )
          .bind(...chunk)
          .run();
        n += res?.meta?.changes || 0;
      }
      return n;
    },

    // --- consumer reads (§7) ---------------------------------------------------
    // Sightings of a product set with their offer rows LEFT-joined: link and
    // validity ride along while the offer lives; pruned offers leave them
    // null — history keeps the point either way (§1.3: sightings outlive
    // their offer rows).
    async sightingsForProducts(ids) {
      const rows = [];
      for (let i = 0; i < ids.length; i += 60) {
        const chunk = ids.slice(i, i + 60);
        const { results } = await db
          .prepare(
            `SELECT s.*, o.source_url AS o_source_url, o.image_url AS o_image_url,
                    o.valid_to AS o_valid_to, o.currency AS o_currency
               FROM product_sightings s LEFT JOIN offers o ON o.id = s.offer_id
              WHERE s.product_id IN (${chunk.map(() => '?').join(',')})`,
          )
          .bind(...chunk)
          .all();
        rows.push(...(results || []));
      }
      return rows;
    },

    // The tombstones pointing at these survivors (§5.1 single-hop): loserId ->
    // survivorId. History reads fold the losers' sightings into the survivor
    // (sightings keep their original product_id — reversibility, §5.4).
    async mergedLoserIds(survivorIds) {
      const map = new Map();
      for (let i = 0; i < survivorIds.length; i += 60) {
        const chunk = survivorIds.slice(i, i + 60);
        const { results } = await db
          .prepare(
            `SELECT id, merged_into FROM products
              WHERE status = 'merged' AND merged_into IN (${chunk.map(() => '?').join(',')})`,
          )
          .bind(...chunk)
          .all();
        for (const r of results || []) map.set(r.id, r.merged_into);
      }
      return map;
    },

    // Best CURRENT price for one product (§7 product watches): the cheapest
    // sighting whose offer is still valid, including sightings that belong to
    // products merged INTO this one (their rows keep their original id —
    // reversibility — so the read follows the tombstones instead).
    async bestCurrentForProduct(productId, today) {
      const row = await db
        .prepare(
          `SELECT o.price, o.currency, s.store, o.source_url AS link, s.offer_id, s.week
             FROM product_sightings s JOIN offers o ON o.id = s.offer_id
            WHERE (s.product_id = ?1 OR s.product_id IN
                    (SELECT id FROM products WHERE status = 'merged' AND merged_into = ?1))
              AND o.valid_to >= ?2
            ORDER BY o.price ASC LIMIT 1`,
        )
        .bind(productId, today)
        .first();
      return row
        ? {
            price: row.price,
            currency: row.currency || 'SAR',
            store: row.store,
            link: row.link || null,
            offerId: row.offer_id,
            week: row.week,
          }
        : null;
    },

    // --- review surfaces (§5.4 split path, §6) --------------------------------
    async listFlagged(limit = 50) {
      const { results } = await db
        .prepare(
          'SELECT * FROM products WHERE review_flag IS NOT NULL ORDER BY last_seen DESC LIMIT ?',
        )
        .bind(limit)
        .all();
      return results || [];
    },
    async listReviewSightings(limit = 50) {
      const { results } = await db
        .prepare(
          `SELECT s.*, o.image_url AS o_image_url, o.source_url AS o_source_url,
                  o.search_text AS o_search_text,
                  p.display_name AS p_display_name, p.display_name_ar AS p_display_name_ar
             FROM product_sightings s
             LEFT JOIN offers o ON o.id = s.offer_id
             LEFT JOIN products p ON p.id = s.product_id
            WHERE s.match_band = 'review'
            ORDER BY s.resolved_at DESC LIMIT ?`,
        )
        .bind(limit)
        .all();
      return results || [];
    },
    // Human reassignment attaches without teaching, exactly like the resolver's
    // review band (§3) — the sighting moves, the target profile learns nothing.
    async reassignSighting(offerId, toProductId) {
      const target = await db
        .prepare('SELECT id FROM products WHERE id = ?')
        .bind(toProductId)
        .first();
      if (!target) return false;
      const res = await db
        .prepare(
          `UPDATE product_sightings SET product_id = ?, match_band = 'review' WHERE offer_id = ?`,
        )
        .bind(toProductId, offerId)
        .run();
      return (res?.meta?.changes || 0) > 0;
    },
    async clearFlag(productId) {
      const res = await db
        .prepare('UPDATE products SET review_flag = NULL WHERE id = ?')
        .bind(productId)
        .run();
      return (res?.meta?.changes || 0) > 0;
    },
  };
}
