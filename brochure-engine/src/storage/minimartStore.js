// storage/minimartStore.js — the Mini marts tables (minimarts.js) behind a
// narrow interface, backed by D1 (migrate-2026-11-04-minimarts.sql).
//
// Interface (used by runMinimartTick and the /minimarts routes):
//   listShops() / addShop(username, nowIso) / removeShop(username)
//   dueShops(nowIso, limit) / recordCheck(username, patch)
//   setPictureKind(username, kind, pictureUrl) -> the tile's logo-or-name call
//   addSnaps(username, snaps, seenAt) -> number added (a snap id is queued once)
//   pendingSnaps(limit) / finishSnap(snapId, patch) / noteUsage(snapId, usage)
//   findReadSnapByHash(username, hash, exceptSnapId) -> { snapId, offerIds } | null
//   framesSince(iso) -> frames cut since then (the monthly allowance)
//   recentOffers(username, sinceIso) / insertOffers(rows)
//   repostOffer(id, { postedAt, expiresAt }) / retireOffer(id, nowIso)
//   liveOffers(nowIso) -> offers on show, newest posting first

function offerOut(r) {
  return {
    id: r.id,
    username: r.username,
    snapId: r.snap_id,
    name: r.name,
    // The name's words printed in the picture ('' = none: a guess, never
    // shown); null = read before the check (2026-11-05).
    shownName: r.shown_name ?? null,
    brand: r.brand,
    size: r.size,
    sizePrinted: r.size_printed ?? null,
    count: Number(r.count) || 1,
    unit: r.unit,
    price: Number(r.price),
    wasPrice: r.was_price == null ? null : Number(r.was_price),
    imageKey: r.image_key,
    postedAt: r.posted_at,
    lastPostedAt: r.last_posted_at || r.posted_at,
    reposts: Number(r.reposts) || 0,
    expiresAt: r.expires_at,
    votes: Number(r.votes) || 0,
    createdAt: r.created_at,
  };
}

function shopOut(r) {
  return {
    username: r.username,
    title: r.title,
    address: r.address,
    picture: r.picture,
    // The picture, only when it was found to be the shop's own logo (and is
    // still the picture that was looked at).
    logo: r.picture_kind === 'logo' && r.picture_kind_of === r.picture ? r.picture : null,
    pictureKind: r.picture_kind ?? null,
    addedAt: r.added_at,
    lastCheckedAt: r.last_checked_at,
    nextCheckAt: r.next_check_at,
    status: r.last_status,
    error: r.last_error,
    lastPostAt: r.last_post_at,
  };
}

function parseIds(text) {
  try {
    const ids = JSON.parse(text || '[]');
    return Array.isArray(ids) ? ids.map(String) : [];
  } catch {
    return [];
  }
}

export function createMinimartStore(db) {
  return {
    async listShops() {
      const { results } = await db
        .prepare('SELECT * FROM minimart_shops WHERE active = 1 ORDER BY added_at')
        .all();
      return (results || []).map(shopOut);
    },

    async countShops() {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM minimart_shops WHERE active = 1').first();
      return Number(row?.n) || 0;
    },

    // A shop removed earlier comes back with its history; it is checked at once.
    async addShop(username, nowIso) {
      await db
        .prepare(
          `INSERT INTO minimart_shops (username, active, added_at, next_check_at)
           VALUES (?1, 1, ?2, ?2)
           ON CONFLICT(username) DO UPDATE SET active = 1, next_check_at = ?2`,
        )
        .bind(username, nowIso)
        .run();
      const row = await db.prepare('SELECT * FROM minimart_shops WHERE username = ?').bind(username).first();
      return row ? shopOut(row) : null;
    },

    // Stops checking; its offers leave the page (they stay in D1 as history).
    async removeShop(username) {
      const res = await db
        .prepare('UPDATE minimart_shops SET active = 0 WHERE username = ? AND active = 1')
        .bind(username)
        .run();
      return Number(res?.meta?.changes) > 0;
    },

    async dueShops(nowIso, limit) {
      const { results } = await db
        .prepare(
          `SELECT username, picture_kind_of FROM minimart_shops
           WHERE active = 1 AND (next_check_at IS NULL OR next_check_at <= ?)
           ORDER BY next_check_at LIMIT ?`,
        )
        .bind(nowIso, limit)
        .all();
      return (results || []).map((r) => ({ username: r.username, pictureKindOf: r.picture_kind_of }));
    },

    async setPictureKind(username, kind, pictureUrl) {
      await db
        .prepare('UPDATE minimart_shops SET picture_kind = ?2, picture_kind_of = ?3 WHERE username = ?1')
        .bind(username, kind, pictureUrl)
        .run();
    },

    async recordCheck(username, { status, error, profile, lastPostAt, checkedAt, nextCheckAt }) {
      await db
        .prepare(
          `UPDATE minimart_shops SET
             last_status = ?2, last_error = ?3, last_checked_at = ?4, next_check_at = ?5,
             title = COALESCE(?6, title), address = COALESCE(?7, address), picture = COALESCE(?8, picture),
             last_post_at = CASE WHEN ?9 IS NOT NULL AND (last_post_at IS NULL OR last_post_at < ?9) THEN ?9 ELSE last_post_at END
           WHERE username = ?1`,
        )
        .bind(username, status, error, checkedAt, nextCheckAt,
          profile?.title ?? null, profile?.address ?? null, profile?.picture ?? null, lastPostAt ?? null)
        .run();
    },

    async addSnaps(username, snaps, seenAt) {
      if (!snaps.length) return 0;
      const statements = snaps.map((s) => db
        .prepare(
          `INSERT OR IGNORE INTO minimart_snaps
             (snap_id, username, posted_at, media_type, media_url, preview_url, status, seen_at)
           VALUES (?, ?, ?, ?, ?, ?, 'new', ?)`,
        )
        .bind(s.id, username, s.postedAt, s.mediaType, s.mediaUrl, s.previewUrl ?? null, seenAt));
      const results = await db.batch(statements);
      return results.reduce((sum, r) => sum + (Number(r?.meta?.changes) || 0), 0);
    },

    // Oldest posting first, so a shop's offers land in the order it posted.
    async pendingSnaps(limit) {
      const { results } = await db
        .prepare(
          `SELECT s.*, m.title AS shop_title FROM minimart_snaps s
           JOIN minimart_shops m ON m.username = s.username AND m.active = 1
           WHERE s.status = 'new'
           ORDER BY COALESCE(s.posted_at, s.seen_at) LIMIT ?`,
        )
        .bind(limit)
        .all();
      return (results || []).map((r) => ({
        snapId: r.snap_id,
        username: r.username,
        postedAt: r.posted_at,
        mediaType: r.media_type,
        mediaUrl: r.media_url,
        previewUrl: r.preview_url,
        shopTitle: r.shop_title ?? null,
        attempts: Number(r.attempts) || 0,
      }));
    },

    // frames/readings ADD to what earlier attempts spent.
    async finishSnap(snapId, { status, attempts, frames = 0, readings = 0, offers = 0, offerIds = null, mediaHash = null, repeatOf = null, error = null, readAt = null }) {
      await db
        .prepare(
          `UPDATE minimart_snaps SET
             status = ?2, attempts = ?3, frames = frames + ?4, readings = readings + ?5,
             offers = ?6, offer_ids = ?7, media_hash = COALESCE(?8, media_hash),
             repeat_of = ?9, error = ?10, read_at = ?11
           WHERE snap_id = ?1`,
        )
        .bind(snapId, status, attempts, frames, readings, offers,
          offerIds ? JSON.stringify(offerIds) : null, mediaHash, repeatOf, error, readAt)
        .run();
    },

    async noteUsage(snapId, { frames = 0, readings = 0 }) {
      await db
        .prepare('UPDATE minimart_snaps SET frames = frames + ?2, readings = readings + ?3 WHERE snap_id = ?1')
        .bind(snapId, frames, readings)
        .run();
    },

    async findReadSnapByHash(username, hash, exceptSnapId) {
      const row = await db
        .prepare(
          `SELECT snap_id, offer_ids FROM minimart_snaps
           WHERE username = ? AND media_hash = ? AND status = 'read' AND snap_id <> ?
           ORDER BY read_at LIMIT 1`,
        )
        .bind(username, hash, exceptSnapId)
        .first();
      return row ? { snapId: row.snap_id, offerIds: parseIds(row.offer_ids) } : null;
    },

    async framesSince(iso) {
      const row = await db
        .prepare('SELECT COALESCE(SUM(frames), 0) AS n FROM minimart_snaps WHERE COALESCE(read_at, seen_at) >= ?')
        .bind(iso)
        .first();
      return Number(row?.n) || 0;
    },

    async recentOffers(username, sinceIso) {
      const { results } = await db
        .prepare(
          `SELECT * FROM minimart_offers
           WHERE username = ? AND COALESCE(last_posted_at, posted_at, created_at) >= ?
           ORDER BY COALESCE(last_posted_at, posted_at) DESC`,
        )
        .bind(username, sinceIso)
        .all();
      return (results || []).map(offerOut);
    },

    async insertOffers(rows) {
      if (!rows.length) return;
      await db.batch(rows.map((o) => db
        .prepare(
          `INSERT OR IGNORE INTO minimart_offers
             (id, username, snap_id, name, brand, size, count, unit, price, was_price, image_key,
              posted_at, last_posted_at, reposts, expires_at, votes, created_at, shown_name, size_printed)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .bind(o.id, o.username, o.snapId, o.name, o.brand, o.size, o.count || 1, o.unit, o.price, o.wasPrice,
          o.imageKey, o.postedAt, o.lastPostedAt || o.postedAt, o.expiresAt, o.votes || 0, o.createdAt,
          o.shownName ?? null, o.sizePrinted ?? null)));
    },

    // The shop posted this deal again: one more posting, shown longer. The
    // first-seen time (created_at) is left alone.
    async repostOffer(id, { postedAt, expiresAt }) {
      await db
        .prepare(
          `UPDATE minimart_offers SET
             reposts = reposts + 1,
             last_posted_at = CASE WHEN COALESCE(last_posted_at, posted_at, '') < ?2 THEN ?2 ELSE last_posted_at END,
             expires_at = CASE WHEN expires_at < ?3 THEN ?3 ELSE expires_at END
           WHERE id = ?1`,
        )
        .bind(id, postedAt, expiresAt)
        .run();
    },

    async retireOffer(id, nowIso) {
      await db
        .prepare('UPDATE minimart_offers SET expires_at = ?2 WHERE id = ?1 AND expires_at > ?2')
        .bind(id, nowIso)
        .run();
    },

    async liveOffers(nowIso) {
      const { results } = await db
        .prepare(
          `SELECT o.* FROM minimart_offers o
           JOIN minimart_shops m ON m.username = o.username AND m.active = 1
           WHERE o.expires_at > ?
           ORDER BY COALESCE(o.last_posted_at, o.posted_at) DESC, o.id`,
        )
        .bind(nowIso)
        .all();
      return (results || []).map(offerOut);
    },

    async stats(sinceIso) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS snaps,
                  SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS pending,
                  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                  COALESCE(SUM(frames), 0) AS frames, COALESCE(SUM(readings), 0) AS readings
           FROM minimart_snaps WHERE seen_at >= ?`,
        )
        .bind(sinceIso)
        .first();
      return {
        snaps: Number(row?.snaps) || 0,
        pending: Number(row?.pending) || 0,
        failed: Number(row?.failed) || 0,
        frames: Number(row?.frames) || 0,
        readings: Number(row?.readings) || 0,
      };
    },
  };
}
