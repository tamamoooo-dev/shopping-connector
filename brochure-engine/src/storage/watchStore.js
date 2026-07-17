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
// PROFILE SCOPING (Local Profile milestone): every watch belongs to one
// browser's local profile (profile_id). User-facing reads/writes pass a
// profileId and see ONLY that profile's watches and alerts (alerts scope via
// their watch — no duplicated column). The cron's check path omits profileId
// and operates across all profiles. Watches created before profiles existed
// (profile_id NULL) are claimed by the first profile to list — adoptOrphans.
//
// Interface:
//   create(watch)                    -> watch (doc shape; carries profileId)
//   list({ activeOnly, profileId }) -> watch docs, newest first
//   get(id)                          -> watch doc | null
//   remove(id, profileId?)           -> boolean   (also deletes its alerts;
//                                       with profileId, only an owned watch)
//   count(profileId?)                -> active watches (the per-profile cap gate)
//   countActiveTotal()               -> active watches across ALL profiles
//   adoptOrphans(profileId)          -> number of NULL-profile watches claimed
//   updateState(id, fields)          -> void      (checked_at / last_* / is_below)
//   insertAlert(alert)               -> void
//   listAlerts({ limit, unseenOnly, profileId }) -> alert docs, newest first
//   markAlertsSeen(profileId?)       -> number marked
//   countUnseen(profileId?)          -> number

export function watchToRow(w) {
  return {
    id: w.id,
    profile_id: w.profileId ?? null,
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
    profileId: r.profile_id ?? null,
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
             (id, profile_id, kind, label, query, provider, product_id, link, image,
              target_price, currency, size_unit, size_total, active, is_below,
              created_at, checked_at, last_price, last_store, last_source,
              last_name, last_link)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          r.id, r.profile_id, r.kind, r.label, r.query, r.provider, r.product_id, r.link,
          r.image, r.target_price, r.currency, r.size_unit, r.size_total,
          r.active, r.is_below, r.created_at, r.checked_at, r.last_price,
          r.last_store, r.last_source, r.last_name, r.last_link,
        )
        .run();
      return watch;
    },

    async list({ activeOnly = false, profileId = null } = {}) {
      const where = [];
      const binds = [];
      if (activeOnly) where.push('active = 1');
      if (profileId) {
        where.push('profile_id = ?');
        binds.push(profileId);
      }
      const sql = `SELECT * FROM watches ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`;
      const { results } = await db.prepare(sql).bind(...binds).all();
      return (results || []).map(rowToWatch);
    },

    async get(id) {
      return rowToWatch(await db.prepare('SELECT * FROM watches WHERE id = ?').bind(id).first());
    },

    async remove(id, profileId = null) {
      // Ownership guard first: with a profileId, only that profile's watch
      // dies. Watch first, then its alerts (no FK; order keeps the guard).
      const res = profileId
        ? await db.prepare('DELETE FROM watches WHERE id = ? AND profile_id = ?').bind(id, profileId).run()
        : await db.prepare('DELETE FROM watches WHERE id = ?').bind(id).run();
      if ((res?.meta?.changes || 0) === 0) return false;
      await db.prepare('DELETE FROM alerts WHERE watch_id = ?').bind(id).run();
      return true;
    },

    async count(profileId = null) {
      const row = profileId
        ? await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE active = 1 AND profile_id = ?').bind(profileId).first()
        : await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE active = 1').first();
      return row?.n || 0;
    },

    async countActiveTotal() {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE active = 1').first();
      return row?.n || 0;
    },

    async adoptOrphans(profileId) {
      const res = await db
        .prepare('UPDATE watches SET profile_id = ? WHERE profile_id IS NULL')
        .bind(profileId)
        .run();
      return res?.meta?.changes || 0;
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

    // Alerts scope through their watch (watch_id -> watches.profile_id) — one
    // ownership column, no denormalized copies to drift.
    async listAlerts({ limit = 50, unseenOnly = false, profileId = null } = {}) {
      const where = [];
      const binds = [];
      if (unseenOnly) where.push('seen = 0');
      if (profileId) {
        where.push('watch_id IN (SELECT id FROM watches WHERE profile_id = ?)');
        binds.push(profileId);
      }
      const sql = `SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY observed_at DESC LIMIT ?`;
      const { results } = await db
        .prepare(sql)
        .bind(...binds, Math.max(1, Math.min(Number(limit) || 50, 200)))
        .all();
      return (results || []).map(rowToAlert);
    },

    async markAlertsSeen(profileId = null) {
      const res = profileId
        ? await db
            .prepare('UPDATE alerts SET seen = 1 WHERE seen = 0 AND watch_id IN (SELECT id FROM watches WHERE profile_id = ?)')
            .bind(profileId)
            .run()
        : await db.prepare('UPDATE alerts SET seen = 1 WHERE seen = 0').run();
      return res?.meta?.changes || 0;
    },

    async countUnseen(profileId = null) {
      const row = profileId
        ? await db
            .prepare('SELECT COUNT(*) AS n FROM alerts WHERE seen = 0 AND watch_id IN (SELECT id FROM watches WHERE profile_id = ?)')
            .bind(profileId)
            .first()
        : await db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE seen = 0').first();
      return row?.n || 0;
    },
  };
}
