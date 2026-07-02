// storage/offerStore.js — the structured-offers store behind a narrow
// interface, backed by D1 (the SAME database as the brochure MetadataStore —
// offers are a feature of the Brochure Engine, not a separate service).
//
// Interface:
//   upsertMany(rows)                  -> Promise<{ stored }>   (idempotent)
//   search({ q?, store?, region?, currentOn?, limit? }) -> Promise<row[]>
//   counts(currentOn)                 -> Promise<{ total, current, stores }>
//   pruneExpiredBefore(cutoffISO)     -> Promise<number>  (retention)
//
// Rows keep the offers HISTORY (a price-per-week substrate, like brochure
// editions); "current" is derived from valid_to at read time, never stored.

import { queryTokens } from '../offers/contract.js';

export function createD1OfferStore(db) {
  const upsertStmt = `
    INSERT INTO offers
      (id, store, region, source, offer_id, flyer_ref, page_ref, edition,
       name, name_ar, price, old_price, currency, category_id, category,
       image_url, source_url, valid_from, valid_to, detected_at, search_text)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      flyer_ref=excluded.flyer_ref, page_ref=excluded.page_ref,
      edition=COALESCE(excluded.edition, offers.edition),
      name=excluded.name, name_ar=excluded.name_ar,
      price=excluded.price, old_price=excluded.old_price,
      currency=excluded.currency, category_id=excluded.category_id,
      category=excluded.category, image_url=excluded.image_url,
      source_url=excluded.source_url, valid_from=excluded.valid_from,
      valid_to=excluded.valid_to, search_text=excluded.search_text`;

  const bindRow = (r) =>
    db.prepare(upsertStmt).bind(
      r.id, r.store, r.region, r.source, r.offer_id, r.flyer_ref, r.page_ref,
      r.edition, r.name, r.name_ar, r.price, r.old_price, r.currency,
      r.category_id, r.category, r.image_url, r.source_url, r.valid_from,
      r.valid_to, r.detected_at, r.search_text,
    );

  return {
    async upsertMany(rows) {
      // D1 batch in chunks — one bound statement per row keeps us far under the
      // per-statement parameter limit; a chunk is one network round-trip.
      // Upsert semantics make re-ingest idempotent (same id -> refresh, no dup).
      for (let i = 0; i < rows.length; i += 40) {
        await db.batch(rows.slice(i, i + 40).map(bindRow));
      }
      return { stored: rows.length };
    },

    async search({ q = '', store = '', region = '', currentOn = null, limit = 60 } = {}) {
      const tokens = queryTokens(q);
      const where = [];
      const binds = [];
      if (currentOn) {
        where.push('valid_to >= ?');
        binds.push(currentOn);
      }
      if (store) {
        where.push('store = ?');
        binds.push(store);
      }
      if (region) {
        where.push('region = ?');
        binds.push(region);
      }
      for (const tok of tokens) {
        where.push("(search_text LIKE ? ESCAPE '\\')");
        binds.push(`%${tok.replace(/[%_\\]/g, (c) => '\\' + c)}%`);
      }
      const sql = `SELECT * FROM offers
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY price ASC LIMIT ?`;
      binds.push(Math.max(1, Math.min(Number(limit) || 60, 300)));
      const { results } = await db.prepare(sql).bind(...binds).all();
      return results || [];
    },

    async counts(currentOn) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN valid_to >= ? THEN 1 ELSE 0 END) AS current,
                  COUNT(DISTINCT CASE WHEN valid_to >= ? THEN store END) AS stores
             FROM offers`,
        )
        .bind(currentOn, currentOn)
        .first();
      return {
        total: row?.total || 0,
        current: row?.current || 0,
        stores: row?.stores || 0,
      };
    },

    // Retention: drop offer rows whose validity ended before the cutoff. The
    // useful history horizon is bounded (offers feed comparison + recent
    // history, not an archive); pruning keeps the D1 table lean.
    async pruneExpiredBefore(cutoffISO) {
      const res = await db
        .prepare('DELETE FROM offers WHERE valid_to IS NOT NULL AND valid_to < ?')
        .bind(cutoffISO)
        .run();
      return res?.meta?.changes || 0;
    },
  };
}
