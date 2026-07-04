// storage/historyStore.js — the catalog-wide Price History store behind a
// narrow interface, backed by D1 (the SAME database as the offers/metadata
// stores — Price History is a feature of the Brochure Engine).
//
// Two tables (schema.sql): `price_identities` (one row per derived product
// identity, refreshed in place) and `price_history` (the append-only series:
// first sighting + price changes only). All history statistics are derived
// from these rows at read time.
//
// Interface:
//   getByIds(ids)                     -> Promise<row[]>       (identity rows)
//   upsertIdentities(rows)            -> Promise<{ stored }>  (idempotent)
//   insertPoints(points)              -> Promise<{ stored }>  (REPLACE per identity+week)
//   searchIdentities({ q, limit })    -> Promise<row[]>       (banded prefilter)
//   pointsForIdentities(ids)          -> Promise<row[]>
//   counts()                          -> Promise<{ identities, points }>
//   pruneStale(cutoffISO, { maxRows })-> Promise<{ identities, points }>

import { queryTokens } from '../offers/contract.js';
import { expandToken } from '../matching.js';

const CHUNK = 80; // stay under SQLite's bound-parameter ceiling

export function createD1HistoryStore(db) {
  const upsertStmt = `
    INSERT INTO price_identities
      (id, store, region, name, name_ar, match_text, size_unit, size_total,
       size_pack, category, image_url, source_url, currency, first_seen,
       last_seen, weeks_seen, last_price, last_valid_to)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, name_ar=excluded.name_ar,
      match_text=excluded.match_text, size_unit=excluded.size_unit,
      size_total=excluded.size_total, size_pack=excluded.size_pack,
      category=excluded.category, image_url=excluded.image_url,
      source_url=excluded.source_url, currency=excluded.currency,
      last_seen=excluded.last_seen, weeks_seen=excluded.weeks_seen,
      last_price=excluded.last_price, last_valid_to=excluded.last_valid_to`;

  const bindIdentity = (r) =>
    db.prepare(upsertStmt).bind(
      r.id, r.store, r.region, r.name, r.name_ar, r.match_text, r.size_unit,
      r.size_total, r.size_pack, r.category, r.image_url, r.source_url,
      r.currency, r.first_seen, r.last_seen, r.weeks_seen, r.last_price,
      r.last_valid_to,
    );

  const bindPoint = (p) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO price_history (identity, week, price, old_price, observed_at)
         VALUES (?,?,?,?,?)`,
      )
      .bind(p.identity, p.week, p.price, p.old_price, p.observed_at);

  const inChunks = async (ids, run) => {
    const out = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      out.push(...(await run(ids.slice(i, i + CHUNK))));
    }
    return out;
  };

  return {
    async getByIds(ids) {
      if (!ids.length) return [];
      return inChunks(ids, async (chunk) => {
        const marks = chunk.map(() => '?').join(',');
        const { results } = await db
          .prepare(`SELECT * FROM price_identities WHERE id IN (${marks})`)
          .bind(...chunk)
          .all();
        return results || [];
      });
    },

    async upsertIdentities(rows) {
      for (let i = 0; i < rows.length; i += 40) {
        await db.batch(rows.slice(i, i + 40).map(bindIdentity));
      }
      return { stored: rows.length };
    },

    async insertPoints(points) {
      for (let i = 0; i < points.length; i += 40) {
        await db.batch(points.slice(i, i + 40).map(bindPoint));
      }
      return { stored: points.length };
    },

    // Broad SQL prefilter over the normalized bilingual NAME — the same banded
    // fill as offerStore.search (exact word > word-start > substring, bilingual
    // synonym variants per token) so the fetch window is never starved by
    // substring noise; final word-boundary relevance runs in JS (priceHistory).
    async searchIdentities({ q = '', limit = 250 } = {}) {
      const tokens = queryTokens(q);
      if (!tokens.length) return [];
      const esc = (v) => v.replace(/[%_\\]/g, (c) => '\\' + c);
      const where = [];
      const binds = [];
      const boundaryParts = [];
      const boundaryBinds = [];
      for (const tok of tokens) {
        const variants = expandToken(tok);
        where.push(`(${variants.map(() => "match_text LIKE ? ESCAPE '\\'").join(' OR ')})`);
        for (const v of variants) binds.push(`%${esc(v)}%`);
        boundaryParts.push(
          `(CASE WHEN ${variants.map(() => "(' ' || match_text || ' ') LIKE ? ESCAPE '\\'").join(' OR ')} THEN 2 ` +
            `WHEN ${variants.map(() => "(' ' || match_text) LIKE ? ESCAPE '\\'").join(' OR ')} THEN 1 ELSE 0 END)`,
        );
        for (const v of variants) boundaryBinds.push(`% ${esc(v)} %`);
        for (const v of variants) boundaryBinds.push(`% ${esc(v)}%`);
      }
      const sql = `SELECT * FROM price_identities
        WHERE ${where.join(' AND ')}
        ORDER BY (${boundaryParts.join(' + ')}) DESC, last_price ASC LIMIT ?`;
      binds.push(...boundaryBinds);
      binds.push(Math.max(1, Math.min(Number(limit) || 250, 400)));
      const { results } = await db.prepare(sql).bind(...binds).all();
      return results || [];
    },

    async pointsForIdentities(ids) {
      if (!ids.length) return [];
      return inChunks(ids, async (chunk) => {
        const marks = chunk.map(() => '?').join(',');
        const { results } = await db
          .prepare(`SELECT * FROM price_history WHERE identity IN (${marks})`)
          .bind(...chunk)
          .all();
        return results || [];
      });
    },

    async counts() {
      const row = await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM price_identities) AS identities,
                  (SELECT COUNT(*) FROM price_history) AS points`,
        )
        .first();
      return { identities: row?.identities || 0, points: row?.points || 0 };
    },

    // Retention: an identity unseen for a long time (product discontinued or
    // renamed for good) is dead weight — delete it WITH its points, capped per
    // run so a backlog drains across fires. Active products are never touched.
    async pruneStale(cutoffISO, { maxRows = 400 } = {}) {
      const { results } = await db
        .prepare('SELECT id FROM price_identities WHERE last_seen < ? LIMIT ?')
        .bind(cutoffISO, maxRows)
        .all();
      const ids = (results || []).map((r) => r.id);
      if (!ids.length) return { identities: 0, points: 0 };
      let points = 0;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK);
        const marks = chunk.map(() => '?').join(',');
        const res = await db
          .prepare(`DELETE FROM price_history WHERE identity IN (${marks})`)
          .bind(...chunk)
          .run();
        points += res?.meta?.changes || 0;
        await db
          .prepare(`DELETE FROM price_identities WHERE id IN (${marks})`)
          .bind(...chunk)
          .run();
      }
      return { identities: ids.length, points };
    },
  };
}
