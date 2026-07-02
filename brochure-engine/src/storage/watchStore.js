// storage/watchStore.js — Price Monitoring storage behind a narrow interface,
// backed by D1 (the SAME database as the rest of the Brochure Engine — watches
// are a feature of the engine, not a separate service). An in-memory twin with
// identical semantics lives in local.js for dev/selftests.
//
// Two tables:
//   watches — what the user monitors: a target price on either a specific
//             product (kind 'product': provider + stable product id, e.g. an
//             Amazon ASIN) or a grocery query (kind 'grocery': evaluated across
//             ALL sources — live online stores + current flyer offers).
//   alerts  — one row per target-price CROSSING (see monitor.js): the proof of
//             "your price was reached", kept until its watch is deleted.
//
// Interface:
//   create(watch)                    -> watch (doc shape)
//   list({ activeOnly })             -> watch docs, newest first
//   get(id)                          -> watch doc | null
//   remove(id)                       -> boolean   (also deletes its alerts)
//   count()                          -> number of active watches (the cap gate)
//   updateState(id, fields)          -> void      (checked_at / last_* / is_below)
//   insertAlert(alert)               -> void
//   listAlerts({ limit, unseenOnly })-> alert docs, newest first
//   markAlertsSeen()                 -> number marked
//   countUnseen()                    -> number

export function watchToRow(w) {
  return {
    id: w.id,
    kind: w.kind,
    label: w.label ?? null,
    query: w.query,
    provider: w.provider ?? null,
    product_id: w.productId ?? null,
    link: w.link ?? null,
    image: w.image ?? null,
    target_price: w.targetPrice,
    currency: w.currency || 'SAR',
    size_unit: w.sizeUnit ?? null,
    size_total: w.sizeTotal ?? null,
    active: w.active === false ? 0 : 1,
    is_below: w.isBelow ? 1 : 0,
    created_at: w.createdAt,
    checked_at: w.checkedAt ?? null,
    last_price: w.lastPrice ?? null,
    last_store: w.lastStore ?? null,
    last_source: w.lastSource ?? null,
    last_name: w.lastName ?? null,
    last_link: w.lastLink ?? null,
  };
}

export function rowToWatch(r) {
  if (!r) return null;
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    query: r.query,
    provider: r.provider,
    productId: r.product_id,
    link: r.link,
    image: r.image,
    targetPrice: r.target_price,
    currency: r.currency,
    sizeUnit: r.size_unit,
    sizeTotal: r.size_total,
    active: !!r.active,
    isBelow: !!r.is_below,
    createdAt: r.created_at,
    checkedAt: r.checked_at,
    lastPrice: r.last_price,
    lastStore: r.last_store,
    lastSource: r.last_source,
    lastName: r.last_name,
    lastLink: r.last_link,
  };
}

export function rowToAlert(r) {
  if (!r) return null;
  return {
    id: r.id,
    watchId: r.watch_id,
    price: r.price,
    targetPrice: r.target_price,
    currency: r.currency,
    store: r.store,
    source: r.source,
    name: r.name,
    link: r.link,
    observedAt: r.observed_at,
    seen: !!r.seen,
  };
}

// Whitelisted state columns updateState may touch (everything else is fixed at
// creation — a watch's identity/target never changes server-side).
const STATE_COLS = {
  isBelow: 'is_below',
  checkedAt: 'checked_at',
  lastPrice: 'last_price',
  lastStore: 'last_store',
  lastSource: 'last_source',
  lastName: 'last_name',
  lastLink: 'last_link',
};

export function createD1WatchStore(db) {
  return {
    async create(watch) {
      const r = watchToRow(watch);
      await db
        .prepare(
          `INSERT INTO watches
             (id, kind, label, query, provider, product_id, link, image,
              target_price, currency, size_unit, size_total, active, is_below,
              created_at, checked_at, last_price, last_store, last_source,
              last_name, last_link)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          r.id, r.kind, r.label, r.query, r.provider, r.product_id, r.link,
          r.image, r.target_price, r.currency, r.size_unit, r.size_total,
          r.active, r.is_below, r.created_at, r.checked_at, r.last_price,
          r.last_store, r.last_source, r.last_name, r.last_link,
        )
        .run();
      return watch;
    },

    async list({ activeOnly = false } = {}) {
      const sql = `SELECT * FROM watches ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY created_at DESC`;
      const { results } = await db.prepare(sql).all();
      return (results || []).map(rowToWatch);
    },

    async get(id) {
      return rowToWatch(await db.prepare('SELECT * FROM watches WHERE id = ?').bind(id).first());
    },

    async remove(id) {
      await db.prepare('DELETE FROM alerts WHERE watch_id = ?').bind(id).run();
      const res = await db.prepare('DELETE FROM watches WHERE id = ?').bind(id).run();
      return (res?.meta?.changes || 0) > 0;
    },

    async count() {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE active = 1').first();
      return row?.n || 0;
    },

    async updateState(id, fields) {
      const sets = [];
      const binds = [];
      for (const [key, col] of Object.entries(STATE_COLS)) {
        if (key in fields) {
          sets.push(`${col} = ?`);
          const v = fields[key];
          binds.push(key === 'isBelow' ? (v ? 1 : 0) : v ?? null);
        }
      }
      if (!sets.length) return;
      binds.push(id);
      await db.prepare(`UPDATE watches SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
    },

    async insertAlert(alert) {
      await db
        .prepare(
          `INSERT INTO alerts
             (id, watch_id, price, target_price, currency, store, source, name, link, observed_at, seen)
           VALUES (?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .bind(
          alert.id, alert.watchId, alert.price, alert.targetPrice,
          alert.currency ?? null, alert.store ?? null, alert.source ?? null,
          alert.name ?? null, alert.link ?? null, alert.observedAt,
        )
        .run();
    },

    async listAlerts({ limit = 50, unseenOnly = false } = {}) {
      const sql = `SELECT * FROM alerts ${unseenOnly ? 'WHERE seen = 0' : ''}
        ORDER BY observed_at DESC LIMIT ?`;
      const { results } = await db
        .prepare(sql)
        .bind(Math.max(1, Math.min(Number(limit) || 50, 200)))
        .all();
      return (results || []).map(rowToAlert);
    },

    async markAlertsSeen() {
      const res = await db.prepare('UPDATE alerts SET seen = 1 WHERE seen = 0').run();
      return res?.meta?.changes || 0;
    },

    async countUnseen() {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE seen = 0').first();
      return row?.n || 0;
    },
  };
}
