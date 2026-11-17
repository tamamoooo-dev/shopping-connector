// storage/offerArchive.js — the permanent flyer price archive (2026-11-17).
//
// One row per flyer offer the engine ever held: store, validity dates, price,
// was-price, the product's name and size, and links to its crop and its flyer
// page. It answers "what did this product cost, where, and when — since the
// beginning", which nothing else can:
//   • `offers` rows are deleted 14 days after expiry (retention.js);
//   • `price_history` keeps only the first sighting and price CHANGES, under
//     identities that split whenever the flyer text differs;
//   • brochure page images are deleted once their products are saved here.
//
// The table is APPEND-ONLY: a row is written once and never updated or
// deleted. Two writers:
//   • the daily retention copies every expired offer here in the SAME D1
//     batch that deletes it (enrichStore.pruneExpiredOffers), so an offer can
//     never leave D1 without being archived;
//   • POST /prices/archive/import loads offers recovered from older copies
//     (weekly backups, the August archives, Vision evidence) — the one-time
//     backfill of everything before this table existed.
// GET /prices/archive?q= reads it.
//
// Names follow the one servable gate: the Vision reading when servable, the
// flyer's own text otherwise. match_text is the normalized bilingual haystack
// (Vision names + size + the flyer's OCR text), searched like price_identities:
// FTS5 trigram candidates, then exact LIKE rechecks.

import { canonicalMatchText, parseSize, querySize, queryTokens, expandToken } from '../matching.js';

export const OFFER_ARCHIVE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS offer_archive (
  id           TEXT PRIMARY KEY,  -- offers.id (store:region:source:offer_id)
  store        TEXT NOT NULL,
  region       TEXT NOT NULL,
  flyer_ref    TEXT,              -- the flyer the offer was printed in
  brochure_id  TEXT,              -- brochures.id when known
  valid_from   TEXT,              -- the flyer's validity (the offer's date)
  valid_to     TEXT,
  price        REAL NOT NULL,
  old_price    REAL,
  currency     TEXT NOT NULL DEFAULT 'SAR',
  name         TEXT,              -- display name (EN), servable Vision else flyer text
  name_ar      TEXT,              -- display name (AR), same rule
  size         TEXT,              -- package size as read, when Vision read it
  category     TEXT,
  image_url    TEXT,              -- the product's flyer crop
  source_url   TEXT,              -- the flyer page (human verification)
  price_source TEXT,              -- NULL = the flyer's price; 'vision' = read from the crop
  origin       TEXT NOT NULL,     -- 'retention' or 'backfill:<source>'
  match_text   TEXT NOT NULL,     -- normalized bilingual search haystack
  archived_at  TEXT NOT NULL
)`;

const SHORT_TERM_SQL = (alias) => `WITH RECURSIVE split(rest, word) AS (
    SELECT trim(${alias}.match_text) || ' ', ''
    UNION ALL
    SELECT substr(rest, instr(rest, ' ') + 1),
           substr(rest, 1, instr(rest, ' ') - 1)
    FROM split WHERE rest <> ''
  ), canon(term) AS (
    SELECT DISTINCT CASE
      WHEN word LIKE 'وال%' AND length(substr(word, 4)) >= 2 THEN substr(word, 4)
      WHEN word LIKE 'ال%' AND length(substr(word, 3)) >= 2 THEN substr(word, 3)
      ELSE word
    END FROM split WHERE word <> ''
  )`;

// Same contentless trigram index and short-word sentinels as
// price_identities_fts (schema.sql). Rows are never updated or deleted, so
// only the insert trigger exists.
export const OFFER_ARCHIVE_DDL = [
  OFFER_ARCHIVE_TABLE_SQL,
  'CREATE INDEX IF NOT EXISTS ix_offer_archive_store_date ON offer_archive(store, valid_from)',
  'CREATE INDEX IF NOT EXISTS ix_offer_archive_flyer ON offer_archive(store, flyer_ref)',
  `CREATE VIRTUAL TABLE IF NOT EXISTS offer_archive_fts USING fts5(
  match_text,
  content='',
  tokenize='trigram',
  detail=none,
  columnsize=0
)`,
  `CREATE TRIGGER IF NOT EXISTS offer_archive_fts_ai
AFTER INSERT ON offer_archive BEGIN
  INSERT INTO offer_archive_fts(rowid, match_text)
  ${SHORT_TERM_SQL('new')}
  SELECT new.rowid,
         new.match_text || COALESCE(' ' || group_concat('qx' || term || 'xq', ' '), '')
  FROM canon WHERE length(term) < 3;
END`,
];

const ensured = new WeakMap();

// Creates the table, indexes, FTS index and trigger when missing. Idempotent;
// runs once per database handle per isolate.
export function ensureOfferArchive(db) {
  if (!ensured.has(db)) {
    const run = (async () => {
      for (const sql of OFFER_ARCHIVE_DDL) await db.prepare(sql).run();
      return true;
    })();
    run.catch(() => ensured.delete(db));
    ensured.set(db, run);
  }
  return ensured.get(db);
}

const text = (value, max = 400) => {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
};
const isoDate = (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value || '')) ? String(value).slice(0, 10) : null);
const ID_RE = /^[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+:[A-Za-z0-9_-]+$/;

// One import row -> the bound values, or null when the row is not a priced,
// dated offer. match_text is computed here, never trusted from the caller.
export function archiveImportValues(row, archivedAt) {
  if (!row || typeof row !== 'object') return null;
  const id = text(row.id, 160);
  const price = Number(row.price);
  const validFrom = isoDate(row.validFrom);
  if (!id || !ID_RE.test(id) || !(price > 0) || price > 1e6 || !validFrom) return null;
  const [store, region] = id.split(':');
  const oldPrice = Number(row.oldPrice);
  const name = text(row.name);
  const nameAr = text(row.nameAr);
  const size = text(row.size, 80);
  const haystack = canonicalMatchText([
    name, nameAr, size, text(row.brand, 80), text(row.flyerText, 400), text(row.category, 60),
  ].filter(Boolean).join(' '));
  if (!haystack) return null;
  const origin = `backfill:${String(row.origin || 'import').replace(/[^a-z0-9:-]/gi, '').slice(0, 40)}`;
  return [
    id, store, region, text(row.flyerRef, 40), text(row.brochureId, 120), validFrom, isoDate(row.validTo),
    price, oldPrice > price ? oldPrice : null, text(row.currency, 8) || 'SAR', name, nameAr, size,
    text(row.category, 60), text(row.imageUrl, 400), text(row.sourceUrl, 400),
    row.priceSource === 'vision' ? 'vision' : null, origin, haystack.slice(0, 1200), archivedAt,
  ];
}

const INSERT_SQL = `INSERT OR IGNORE INTO offer_archive
  (id, store, region, flyer_ref, brochure_id, valid_from, valid_to, price, old_price, currency,
   name, name_ar, size, category, image_url, source_url, price_source, origin, match_text, archived_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const escapeLike = (value) => value.replace(/[%_\\]/g, (char) => `\\${char}`);
const ftsPhrase = (value) => `"${value.replace(/"/g, '""')}"`;
const ftsVariant = (term) => {
  const chars = [...([...term].length < 3 ? `qx${term}xq` : term)];
  const grams = [...new Set(Array.from({ length: chars.length - 2 }, (_, i) => chars.slice(i, i + 3).join('')))];
  return `(${grams.map(ftsPhrase).join(' AND ')})`;
};

// Every query word must appear (any of its bilingual variants); a size named
// in the query ("185g", "١٨٥ جم") must appear as a whole number in the text.
export function buildArchiveSearchQuery(q, limit = 500) {
  const groups = queryTokens(q).map((token) => expandToken(token));
  if (!groups.length) return null;
  const size = querySize(q);
  const ctes = [];
  const binds = [];
  const where = [];
  const whereBinds = [];
  groups.forEach((variants, index) => {
    ctes.push(`g${index}(rowid) AS (SELECT rowid FROM offer_archive_fts WHERE offer_archive_fts MATCH ?)`);
    binds.push(variants.map(ftsVariant).join(' OR '));
    where.push(`(${variants.map(() => "a.match_text LIKE ? ESCAPE '\\'").join(' OR ')})`);
    whereBinds.push(...variants.map((variant) => `%${escapeLike(variant)}%`));
  });
  ctes.push(`candidates(rowid) AS (${groups.map((_, i) => `SELECT rowid FROM g${i}`).join(' INTERSECT ')})`);
  const bounded = Math.max(1, Math.min(Number(limit) || 500, 2000));
  return {
    sql: `WITH ${ctes.join(', ')}
      SELECT a.id, a.store, a.region, a.flyer_ref, a.valid_from, a.valid_to, a.price, a.old_price,
             a.currency, a.name, a.name_ar, a.size, a.category, a.image_url, a.source_url,
             a.price_source, a.match_text
      FROM candidates c CROSS JOIN offer_archive a ON a.rowid = c.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY a.valid_from DESC, a.store, a.price
      LIMIT ?`,
    binds: [...binds, ...whereBinds, bounded],
    size,
    limit: bounded,
  };
}

const within = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.max(a, b) > 0
  && Math.abs(a - b) / Math.max(a, b) <= 0.03;
const LARGE_UNIT = { ml: '(?:l|lt|ltr|liter|litre|liters|litres|لتر|ل)', g: '(?:kg|kilo|كجم|كغ|كغم|كيلو|كيلوجرام|ك)' };

// A size named in the query needs positive evidence on the row: the engine's
// own size reading of its name and size field (same unit, per-item or total
// within 3%), or the number printed in its text — a whole number, so 185
// matches "185g" and "185 - 195 grams" but never "1850"; litres and kilos are
// also matched as printed ("1L" for 1000 ml), only next to their unit.
export function sizeMatches(row, size) {
  if (!size || !size.unit) return true;
  const parsed = parseSize(row.name || '', row.size || '');
  if (parsed && parsed.unit === size.unit
      && (within(parsed.each, size.each) || within(parsed.total, size.total))) return true;
  const hay = ` ${String(row.match_text || '').replace(/(\d)(?=[^\d.\s])/g, '$1 ')} `;
  const printed = (value, unit) => {
    const number = String(Math.round(value * 1000) / 1000).replace('.', '\\.');
    return new RegExp(`(^|[^\\d.])${number}(?![\\d.])${unit ? `\\s*${unit}(?![a-z\\u0600-\\u06ff])` : ''}`).test(hay);
  };
  for (const value of new Set([size.each, size.total])) {
    if (!(Number.isFinite(value) && value > 0)) continue;
    if (value >= 10 && printed(value, null)) return true;
    if (LARGE_UNIT[size.unit] && value >= 100 && printed(value / 1000, LARGE_UNIT[size.unit])) return true;
  }
  return false;
}

export function createOfferArchive(db) {
  return {
    ensure: () => ensureOfferArchive(db),

    // Bulk backfill. Invalid rows are skipped and counted; existing ids are
    // left untouched (append-only), so re-sending a chunk is harmless.
    async importRows(rows, { now = new Date() } = {}) {
      await ensureOfferArchive(db);
      const archivedAt = now.toISOString();
      const values = [];
      let invalid = 0;
      for (const row of rows || []) {
        const bound = archiveImportValues(row, archivedAt);
        if (bound) values.push(bound); else invalid += 1;
      }
      let inserted = 0;
      for (let i = 0; i < values.length; i += 50) {
        const results = await db.batch(values.slice(i, i + 50).map((v) => db.prepare(INSERT_SQL).bind(...v)));
        inserted += results.reduce((sum, r) => sum + Number(r?.meta?.changes || 0), 0);
      }
      return { received: (rows || []).length, valid: values.length, invalid, inserted };
    },

    // Which of these D4D offer ids (one brochure's hotspot products) already
    // have a priced row here. Retention deletes a brochure's page images only
    // when every product is accounted for.
    async archivedOfferIds(store, region, offerIds) {
      const found = new Set();
      const ids = [...new Set((offerIds || []).map(String))];
      try {
        for (let i = 0; i < ids.length; i += 80) {
          const chunk = ids.slice(i, i + 80).map((id) => `${store}:${region}:d4d:${id}`);
          const { results } = await db.prepare(
            `SELECT id FROM offer_archive WHERE id IN (${chunk.map(() => '?').join(',')}) AND price > 0`,
          ).bind(...chunk).all();
          for (const row of results || []) found.add(row.id.split(':').pop());
        }
      } catch (err) {
        if (/no such table/i.test(String(err?.message))) return new Set();
        throw err;
      }
      return found;
    },

    // Newest first. A named size filters a wider candidate set, so the size
    // cannot be crowded out by newer offers of other sizes. `truncated` says
    // older matches exist beyond the limit.
    async search({ q = '', limit = 500 } = {}) {
      const bounded = Math.max(1, Math.min(Number(limit) || 500, 2000));
      const query = buildArchiveSearchQuery(q, querySize(q) ? 2000 : bounded);
      if (!query) return { rows: [], size: null };
      try {
        const { results } = await db.prepare(query.sql).bind(...query.binds).all();
        const all = results || [];
        const rows = all.filter((row) => sizeMatches(row, query.size));
        const truncated = all.length >= query.limit || rows.length > bounded;
        return { rows: rows.slice(0, bounded), size: query.size, truncated };
      } catch (err) {
        if (/no such table/i.test(String(err?.message))) return { rows: [], size: query.size, missing: true };
        throw err;
      }
    },

    async stats() {
      try {
        const total = await db.prepare(
          `SELECT COUNT(*) AS rows, MIN(valid_from) AS first, MAX(valid_from) AS last,
                  COUNT(DISTINCT store) AS stores FROM offer_archive`,
        ).first();
        const { results } = await db.prepare(
          `SELECT substr(valid_from, 1, 7) AS month, COUNT(*) AS rows FROM offer_archive
            GROUP BY month ORDER BY month`,
        ).all();
        const origins = await db.prepare(
          'SELECT origin, COUNT(*) AS rows FROM offer_archive GROUP BY origin ORDER BY origin',
        ).all();
        return { ...total, months: results || [], origins: origins.results || [] };
      } catch (err) {
        if (/no such table/i.test(String(err?.message))) return { rows: 0, missing: true };
        throw err;
      }
    },
  };
}

// The read shape for GET /prices/archive: newest first, plus a per-store
// summary (how many flyers, lowest and highest price, first and last date).
export function archiveDoc(q, { rows, size, truncated }) {
  const byStore = new Map();
  for (const row of rows) {
    const s = byStore.get(row.store) || { store: row.store, offers: 0, lowest: null, highest: null, first: null, last: null };
    s.offers += 1;
    if (s.lowest == null || row.price < s.lowest) s.lowest = row.price;
    if (s.highest == null || row.price > s.highest) s.highest = row.price;
    if (!s.first || row.valid_from < s.first) s.first = row.valid_from;
    if (!s.last || row.valid_from > s.last) s.last = row.valid_from;
    byStore.set(row.store, s);
  }
  const dates = rows.map((row) => row.valid_from).filter(Boolean).sort();
  return {
    query: q,
    size: size ? { unit: size.unit, each: size.each, total: size.total, pack: size.pack } : null,
    offers: rows.length,
    truncated: !!truncated,
    first: dates[0] || null,
    last: dates[dates.length - 1] || null,
    stores: [...byStore.values()].sort((a, b) => a.lowest - b.lowest),
    history: rows.map((row) => ({
      store: row.store,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      price: row.price,
      oldPrice: row.old_price,
      currency: row.currency,
      name: row.name,
      nameAr: row.name_ar,
      size: row.size,
      category: row.category,
      image: row.image_url,
      link: row.source_url,
      priceSource: row.price_source,
    })),
    note: 'Every flyer price the engine has kept, one line per flyer offer. Prices are machine-extracted from flyer images; the flyer itself prevails on any mismatch.',
  };
}
