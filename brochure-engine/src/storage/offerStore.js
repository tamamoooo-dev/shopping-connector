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
import { expandToken } from '../matching.js';

export function createD1OfferStore(db) {
  const upsertStmt = `
    INSERT INTO offers
      (id, store, region, source, offer_id, flyer_ref, page_ref, edition,
       name, name_ar, price, old_price, currency, category_id, category,
       image_url, source_url, valid_from, valid_to, detected_at, search_text,
       identity, brand_slug)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      flyer_ref=excluded.flyer_ref, page_ref=excluded.page_ref,
      edition=COALESCE(excluded.edition, offers.edition),
      name=excluded.name, name_ar=excluded.name_ar,
      price=excluded.price, old_price=excluded.old_price,
      currency=excluded.currency, category_id=excluded.category_id,
      category=excluded.category, image_url=excluded.image_url,
      source_url=excluded.source_url, valid_from=excluded.valid_from,
      valid_to=excluded.valid_to, search_text=excluded.search_text,
      identity=excluded.identity, brand_slug=excluded.brand_slug`;

  const bindRow = (r) =>
    db.prepare(upsertStmt).bind(
      r.id, r.store, r.region, r.source, r.offer_id, r.flyer_ref, r.page_ref,
      r.edition, r.name, r.name_ar, r.price, r.old_price, r.currency,
      r.category_id, r.category, r.image_url, r.source_url, r.valid_from,
      r.valid_to, r.detected_at, r.search_text, r.identity ?? null,
      r.brand_slug ?? null,
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
      // Broad SQL prefilter only — final word-boundary relevance runs in JS
      // (engine.js). Each token ORs across its bilingual synonym variants so an
      // English query can reach Arabic-only OCR rows (and vice versa); rows the
      // prefilter lets through that don't match at word level are dropped by
      // offerRelevance.
      //
      // The fetch window MUST be filled word-boundary-matches-first: a plain
      // "cheapest substring matches" window starves real results, because a
      // substring like "rice" lives inside "price" (2,500+ rows) and "بيض"
      // (eggs) inside "بيضاء"/"ابيض" (white) — the cheapest N noise rows crowd
      // out every genuine match, which the JS filter then rejects, yielding
      // zero results for a query the data can answer. Per token, rows are
      // banded: exact whole-word match (2) > word-start match (1, catches
      // "eggs" via "egg" but also "eggplant") > substring-only (0); the bands
      // sum across tokens and fill the window best-first, price ordering
      // within each band. search_text is space-normalized, so padding it with
      // spaces makes ' tok ' an exact-word test.
      const esc = (v) => v.replace(/[%_\\]/g, (c) => '\\' + c);
      const boundaryParts = [];
      const boundaryBinds = [];
      for (const tok of tokens) {
        const variants = expandToken(tok);
        where.push(`(${variants.map(() => "search_text LIKE ? ESCAPE '\\'").join(' OR ')})`);
        for (const v of variants) binds.push(`%${esc(v)}%`);
        boundaryParts.push(
          `(CASE WHEN ${variants.map(() => "(' ' || search_text || ' ') LIKE ? ESCAPE '\\'").join(' OR ')} THEN 2 ` +
            `WHEN ${variants.map(() => "(' ' || search_text) LIKE ? ESCAPE '\\'").join(' OR ')} THEN 1 ELSE 0 END)`,
        );
        for (const v of variants) boundaryBinds.push(`% ${esc(v)} %`);
        for (const v of variants) boundaryBinds.push(`% ${esc(v)}%`);
      }
      const orderBy = boundaryParts.length
        ? `ORDER BY (${boundaryParts.join(' + ')}) DESC, price ASC`
        : 'ORDER BY price ASC';
      const sql = `SELECT * FROM offers
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ${orderBy} LIMIT ?`;
      binds.push(...boundaryBinds);
      binds.push(Math.max(1, Math.min(Number(limit) || 60, 300)));
      const { results } = await db.prepare(sql).bind(...binds).all();
      return results || [];
    },

    // Every offer of ONE flyer (the hotspots join): tap targets are keyed by
    // offer_id, so the whole flyer's products come back in a single query.
    async byFlyer(store, region, flyerRef) {
      const { results } = await db
        .prepare(
          'SELECT * FROM offers WHERE store = ? AND region = ? AND flyer_ref = ? LIMIT 2000',
        )
        .bind(store, region, String(flyerRef))
        .all();
      return results || [];
    },

    // Every stored offer row of one store (or all) WITHOUT search_text — the
    // price-history backfill's read path (search_text is matching payload the
    // backfill doesn't need; leaving it out keeps the result set small).
    async listAll({ store = '' } = {}) {
      const sql = `SELECT id, store, region, source, offer_id, flyer_ref, page_ref,
          edition, name, name_ar, price, old_price, currency, category_id,
          category, image_url, source_url, valid_from, valid_to, detected_at,
          identity, brand_slug
        FROM offers ${store ? 'WHERE store = ?' : ''} LIMIT 20000`;
      const stmt = store ? db.prepare(sql).bind(store) : db.prepare(sql);
      const { results } = await stmt.all();
      return results || [];
    },

    // Backfill: stamp the ingest-derived columns (identity, brand) onto rows
    // ingested before they existed (engine.js /prices/backfill). Idempotent.
    async updateDerived(rows) {
      for (let i = 0; i < rows.length; i += 80) {
        await db.batch(
          rows
            .slice(i, i + 80)
            .map((r) =>
              db
                .prepare('UPDATE offers SET identity = ?, brand_slug = ? WHERE id = ?')
                .bind(r.identity ?? null, r.brand_slug ?? null, r.id),
            ),
        );
      }
      return { updated: rows.length };
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

    // Current-offer count per store in one query (the Ops Console's coverage
    // table paints every store from this + the metadata index).
    async countsByStore(currentOn) {
      const { results } = await db
        .prepare('SELECT store, COUNT(*) AS n FROM offers WHERE valid_to >= ? GROUP BY store')
        .bind(currentOn)
        .all();
      return Object.fromEntries((results || []).map((r) => [r.store, r.n]));
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
