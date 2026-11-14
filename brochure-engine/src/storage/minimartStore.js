// storage/minimartStore.js — the Mini marts tables (minimarts.js) behind a
// narrow interface, backed by D1 (migrate-2026-11-04-minimarts.sql).
//
// Interface (used by runMinimartTick and the /minimarts routes):
//   listShops() / addShop(username, nowIso) / removeShop(username)
//   dueShops(nowIso, limit) / recordCheck(username, patch)
//   setPictureKind(username, kind, pictureUrl) -> the tile's logo-or-name call
//   addSnaps(username, snaps, seenAt) -> number added (a snap id is queued once)
//   pendingSnaps(limit, { reread }) / finishSnap(snapId, patch) / noteUsage(snapId, usage)
//   The PC reader (minimarts.js): noteReader(nowIso) / readerSeenSince(iso) /
//   noteReaderRun(nowIso, run) / readerStatus(); prepareSnap(snapId, patch);
//   claimForReader(opts) / heldSnap(snapId, reader) / startSaving / stopSaving;
//   lateSnaps(opts) / claimForMistral(snapId, opts); requeueForReread(snapIds);
//   offersOfSnap(snapId) / rewriteOffer(id, fields)
//   findReadSnapByHash(username, hash, exceptSnapId) -> { snapId, offerIds } | null
//   framesSince(iso) -> frames cut since then (the monthly allowance)
//   videoYield(username, sinceIso) -> { videos, priced }: a shop's read videos, and those with a price
//   logCheck(username, row) / checkProblems(sinceIso) / pruneChecks(beforeIso): the story checks' history
//   noteReaderLimit(nowIso, untilIso, note) / readerLimitedUntil(): every Claude account at its limit
//   unusedPictureKeys(beforeIso, limit) / clearPictures(keys) / picturelessOffers(ids) / setOfferImage(id, key)
//   videoPace(iso) -> { videos: new videos seen since then, firstSeen: the first snap ever seen }
//   recentOffers(username, sinceIso) / insertOffers(rows)
//   repostOffer(id, { postedAt, expiresAt }) / retireOffer(id, nowIso)
//   liveOffers(nowIso) -> offers on show, newest posting first
//   The owner's name for a shop (2026-11-14): setShopNames(username, { ar?, en? }).
//   A presenter shop (2026-11-14, minimartCrop.js): setShopStyle(username, style);
//   cropQueue(nowIso, limit) -> offers whose picture has no crop yet;
//   saveCrop(id, imageKey, cropKey) -> { saved, oldCropKey }; expiredCrops(beforeIso, limit) / clearCrops(ids)

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
    // A presenter shop's card shows the crop made from this very picture.
    cropKey: r.crop_key ?? null,
    cropOf: r.crop_of ?? null,
    shopStyle: r.shop_style ?? null,
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
    // 'presenter': a person presents the offers in videos (minimartCrop.js).
    style: r.style ?? null,
    // The owner's name for the shop, shown instead of `title` (2026-11-14).
    nameAr: r.name_ar ?? null,
    nameEn: r.name_en ?? null,
    addedAt: r.added_at,
    lastCheckedAt: r.last_checked_at,
    nextCheckAt: r.next_check_at,
    status: r.last_status,
    error: r.last_error,
    lastPostAt: r.last_post_at,
  };
}

function snapOut(r) {
  return {
    snapId: r.snap_id,
    username: r.username,
    postedAt: r.posted_at,
    mediaType: r.media_type,
    mediaUrl: r.media_url,
    previewUrl: r.preview_url,
    shopTitle: r.shop_title ?? null,
    shopStyle: r.shop_style ?? null,
    status: r.status,
    attempts: Number(r.attempts) || 0,
    // Prepared for the PC reader: the pictures' refs in R2, who holds it.
    pictures: parseIds(r.pictures),
    preparedAt: r.prepared_at ?? null,
    reader: r.reader ?? null,
    reread: Number(r.reread) === 1,
  };
}

const SNAP_COLUMNS = 's.*, m.title AS shop_title, m.style AS shop_style';
// A time no limit reaches: `limited_until > NEVER` is never true.
const NEVER = '9999-12-31T00:00:00.000Z';
const changed = (res) => Number(res?.meta?.changes) > 0;

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

    // 'presenter' or null (minimartCrop.js shopStyle). -> whether the shop exists.
    // names: { ar?, en? } — a key left out is unchanged, null clears it.
    async setShopNames(username, names) {
      const sets = [];
      const values = [username];
      for (const [lang, column] of [['ar', 'name_ar'], ['en', 'name_en']]) {
        if (!Object.prototype.hasOwnProperty.call(names, lang)) continue;
        values.push(names[lang] ?? null);
        sets.push(`${column} = ?${values.length}`);
      }
      if (!sets.length) return false;
      return changed(await db.prepare(`UPDATE minimart_shops SET ${sets.join(', ')} WHERE username = ?1`).bind(...values).run());
    },

    async setShopStyle(username, style) {
      return changed(await db.prepare('UPDATE minimart_shops SET style = ?2 WHERE username = ?1').bind(username, style).run());
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
          `SELECT username, picture_kind_of, last_post_at, added_at FROM minimart_shops
           WHERE active = 1 AND (next_check_at IS NULL OR next_check_at <= ?)
           ORDER BY next_check_at LIMIT ?`,
        )
        .bind(nowIso, limit)
        .all();
      return (results || []).map((r) => ({ username: r.username, pictureKindOf: r.picture_kind_of, lastPostAt: r.last_post_at ?? null, addedAt: r.added_at ?? null }));
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

    // Every story check, kept: a block that cleared by itself still shows.
    async logCheck(username, { status, error = null, snaps = 0, added = 0, checkedAt }) {
      await db
        .prepare('INSERT INTO minimart_checks (username, checked_at, status, error, snaps, added) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(username, checkedAt, status, error, snaps, added)
        .run();
    },

    // The checks that did not answer "ok" since then, per shop and status.
    async checkProblems(sinceIso) {
      const { results } = await db
        .prepare(
          `SELECT username, status, COUNT(*) AS n, MAX(checked_at) AS last, MAX(error) AS error
           FROM minimart_checks WHERE checked_at >= ? AND status <> 'ok'
           GROUP BY username, status ORDER BY last DESC`,
        )
        .bind(sinceIso)
        .all();
      return (results || []).map((r) => ({ username: r.username, status: r.status, checks: Number(r.n) || 0, last: r.last, error: r.error ?? null }));
    },

    async pruneChecks(beforeIso) {
      await db.prepare('DELETE FROM minimart_checks WHERE checked_at < ?').bind(beforeIso).run();
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
    // A snap queued to be read again by the PC reader (reread) is left out
    // unless asked for: Mistral never reads it.
    async pendingSnaps(limit, { reread = false } = {}) {
      const { results } = await db
        .prepare(
          `SELECT ${SNAP_COLUMNS} FROM minimart_snaps s
           JOIN minimart_shops m ON m.username = s.username AND m.active = 1
           WHERE s.status = 'new' AND (?2 = 1 OR COALESCE(s.reread, 0) = 0)
           ORDER BY COALESCE(s.posted_at, s.seen_at) LIMIT ?1`,
        )
        .bind(limit, reread ? 1 : 0)
        .all();
      return (results || []).map(snapOut);
    },

    // --- the PC reader -------------------------------------------------------
    async noteReader(nowIso) {
      await db
        .prepare(
          `INSERT INTO minimart_reader (name, seen_at) VALUES ('pc', ?1)
           ON CONFLICT(name) DO UPDATE SET seen_at = ?1`,
        )
        .bind(nowIso)
        .run();
    },

    // The reader said every Claude account is at its limit until `untilIso`
    // (a time already past = it reads again). Saying so is asking: it stays
    // on. The snaps it held are let go, for Mistral or its own next round.
    async noteReaderLimit(nowIso, untilIso, note = null) {
      await db.batch([
        db
          .prepare(
            `INSERT INTO minimart_reader (name, seen_at, limited_until, limit_note) VALUES ('pc', ?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET seen_at = ?1, limited_until = ?2, limit_note = ?3`,
          )
          .bind(nowIso, untilIso, note == null ? null : JSON.stringify(note).slice(0, 1000)),
        db.prepare("UPDATE minimart_snaps SET reader = NULL, claimed_at = NULL WHERE status = 'prepared' AND reader = 'haiku'"),
      ]);
    },

    async readerLimitedUntil() {
      const row = await db.prepare("SELECT limited_until FROM minimart_reader WHERE name = 'pc'").first();
      return row?.limited_until ?? null;
    },

    async readerSeenSince(iso) {
      const row = await db.prepare("SELECT 1 AS seen FROM minimart_reader WHERE name = 'pc' AND seen_at >= ?").bind(iso).first();
      return Boolean(row);
    },

    async noteReaderRun(nowIso, run) {
      await db
        .prepare(
          `INSERT INTO minimart_reader (name, seen_at, last_run_at, last_run) VALUES ('pc', ?1, ?1, ?2)
           ON CONFLICT(name) DO UPDATE SET seen_at = ?1, last_run_at = ?1, last_run = ?2`,
        )
        .bind(nowIso, JSON.stringify(run ?? null).slice(0, 4000))
        .run();
    },

    async readerStatus() {
      const row = await db.prepare("SELECT * FROM minimart_reader WHERE name = 'pc'").first();
      if (!row) return null;
      let lastRun = null;
      try {
        lastRun = JSON.parse(row.last_run || 'null');
      } catch {
        /* unreadable: left out */
      }
      let limitNote = null;
      try {
        limitNote = JSON.parse(row.limit_note || 'null');
      } catch {
        /* unreadable: left out */
      }
      return { seenAt: row.seen_at, lastRunAt: row.last_run_at ?? null, lastRun, limitedUntil: row.limited_until ?? null, limitNote };
    },

    // Ready for the PC reader: its pictures are in R2 under these refs.
    async prepareSnap(snapId, { pictures, frames = 0, mediaHash = null, preparedAt }) {
      await db
        .prepare(
          `UPDATE minimart_snaps SET
             status = 'prepared', pictures = ?2, prepared_at = ?3, frames = frames + ?4,
             media_hash = COALESCE(?5, media_hash), reader = NULL, claimed_at = NULL, error = NULL
           WHERE snap_id = ?1`,
        )
        .bind(snapId, JSON.stringify(pictures), preparedAt, frames, mediaHash)
        .run();
    },

    // The oldest prepared snaps the reader may take (unclaimed, or a claim
    // that expired; not yet Mistral's unless queued to be read again), up to
    // maxPictures pictures and always one snap; each claimed atomically.
    // Snaps held through a limit (limited_until after `holdSince`) are still
    // the reader's however long they waited.
    async claimForReader({ nowIso, claimBefore, waitBefore, holdSince = NEVER, maxPictures, reader, limit = 60 }) {
      const { results } = await db
        .prepare(
          `SELECT ${SNAP_COLUMNS} FROM minimart_snaps s
           JOIN minimart_shops m ON m.username = s.username AND m.active = 1
           WHERE s.status = 'prepared'
             AND (s.prepared_at >= ?1 OR COALESCE(s.reread, 0) = 1
                  OR EXISTS (SELECT 1 FROM minimart_reader r WHERE r.name = 'pc' AND r.limited_until > ?4))
             AND (s.reader IS NULL OR s.claimed_at < ?2)
           ORDER BY COALESCE(s.posted_at, s.seen_at) LIMIT ?3`,
        )
        .bind(waitBefore, claimBefore, limit, holdSince)
        .all();
      const chosen = [];
      let pictures = 0;
      for (const snap of (results || []).map(snapOut)) {
        if (chosen.length && pictures + snap.pictures.length > maxPictures) break;
        chosen.push(snap);
        pictures += snap.pictures.length;
      }
      if (!chosen.length) return [];
      const claims = await db.batch(chosen.map((snap) => db
        .prepare(
          `UPDATE minimart_snaps SET reader = ?2, claimed_at = ?3
           WHERE snap_id = ?1 AND status = 'prepared' AND (reader IS NULL OR claimed_at < ?4)`,
        )
        .bind(snap.snapId, reader, nowIso, claimBefore)));
      return chosen.filter((_, i) => changed(claims[i]));
    },

    async heldSnap(snapId, reader) {
      const row = await db
        .prepare(
          `SELECT ${SNAP_COLUMNS} FROM minimart_snaps s
           LEFT JOIN minimart_shops m ON m.username = s.username
           WHERE s.snap_id = ? AND s.status = 'prepared' AND s.reader = ?`,
        )
        .bind(snapId, reader)
        .first();
      return row ? snapOut(row) : null;
    },

    // Saving is one writer's: the reader's answer and Mistral never both land.
    async startSaving(snapId, reader) {
      return changed(await db
        .prepare("UPDATE minimart_snaps SET status = 'saving' WHERE snap_id = ? AND status = 'prepared' AND reader = ?")
        .bind(snapId, reader)
        .run());
    },

    async stopSaving(snapId) {
      await db.prepare("UPDATE minimart_snaps SET status = 'prepared' WHERE snap_id = ? AND status = 'saving'").bind(snapId).run();
    },

    // Prepared snaps that are Mistral's: the reader is off, or every Claude
    // account is at its limit until after `holdOver` (too long to wait), or
    // the snap waited too long. A snap that waited is NOT Mistral's while the
    // reader holds it for a limit that resets soon (limited_until after
    // `holdSince`). Never one claimed by the reader within the claim time,
    // never one queued to be read again.
    async lateSnaps({ onSince, claimBefore, waitBefore, holdOver = NEVER, holdSince = NEVER, limit }) {
      if (limit <= 0) return [];
      const { results } = await db
        .prepare(
          `SELECT ${SNAP_COLUMNS} FROM minimart_snaps s
           JOIN minimart_shops m ON m.username = s.username AND m.active = 1
           WHERE s.status = 'prepared' AND COALESCE(s.reread, 0) = 0
             AND (s.reader IS NULL OR s.reader = 'mistral' OR s.claimed_at < ?2)
             AND (NOT EXISTS (SELECT 1 FROM minimart_reader r WHERE r.name = 'pc' AND r.seen_at >= ?1)
                  OR EXISTS (SELECT 1 FROM minimart_reader r WHERE r.name = 'pc' AND r.limited_until > ?5)
                  OR (s.prepared_at < ?3
                      AND NOT EXISTS (SELECT 1 FROM minimart_reader r WHERE r.name = 'pc' AND r.limited_until > ?6)))
           ORDER BY COALESCE(s.posted_at, s.seen_at) LIMIT ?4`,
        )
        .bind(onSince, claimBefore, waitBefore, limit, holdOver, holdSince)
        .all();
      return (results || []).map(snapOut);
    },

    async claimForMistral(snapId, { nowIso, claimBefore }) {
      return changed(await db
        .prepare(
          `UPDATE minimart_snaps SET reader = 'mistral', claimed_at = ?2
           WHERE snap_id = ?1 AND status = 'prepared' AND (reader IS NULL OR reader = 'mistral' OR claimed_at < ?3)`,
        )
        .bind(snapId, nowIso, claimBefore)
        .run());
    },

    // Read snaps queued to be read again by the PC reader (the owner's
    // one-time Haiku re-read, 2026-11-05). A re-posted file (repeat_of) is
    // left alone: it shows its first posting's offers. -> how many queued.
    async requeueForReread(snapIds) {
      if (!snapIds.length) return 0;
      const results = await db.batch(snapIds.map((id) => db
        .prepare(
          `UPDATE minimart_snaps SET status = 'new', reread = 1, attempts = 0, error = NULL,
             reader = NULL, claimed_at = NULL, pictures = NULL, prepared_at = NULL
           WHERE snap_id = ? AND status = 'read' AND repeat_of IS NULL`,
        )
        .bind(id)));
      return results.filter(changed).length;
    },

    async readSnapIds() {
      const { results } = await db
        .prepare(
          `SELECT s.snap_id FROM minimart_snaps s
           JOIN minimart_shops m ON m.username = s.username AND m.active = 1
           WHERE s.status = 'read' AND s.repeat_of IS NULL ORDER BY COALESCE(s.posted_at, s.seen_at)`,
        )
        .all();
      return (results || []).map((r) => r.snap_id);
    },

    // A re-read that could not be prepared: the snap stays as it was read.
    async endReread(snapId, error) {
      await db
        .prepare("UPDATE minimart_snaps SET status = 'read', reread = 0, error = ? WHERE snap_id = ?")
        .bind(error, snapId)
        .run();
    },

    async readerQueueCounts() {
      const row = await db
        .prepare(
          `SELECT COALESCE(SUM(status = 'new' AND COALESCE(reread, 0) = 0), 0) AS fresh,
                  COALESCE(SUM(status = 'new' AND reread = 1), 0) AS reread,
                  COALESCE(SUM(status = 'prepared' AND reader IS NULL), 0) AS prepared,
                  COALESCE(SUM(status = 'prepared' AND reader = 'haiku'), 0) AS claimed,
                  COALESCE(SUM(status = 'prepared' AND reader = 'mistral'), 0) AS mistral,
                  COALESCE(SUM(status = 'saving'), 0) AS saving
           FROM minimart_snaps`,
        )
        .first();
      return Object.fromEntries(Object.entries(row || {}).map(([k, v]) => [k, Number(v) || 0]));
    },

    async offersOfSnap(snapId) {
      const { results } = await db.prepare('SELECT * FROM minimart_offers WHERE snap_id = ? ORDER BY id').bind(snapId).all();
      return (results || []).map(offerOut);
    },

    // A re-read corrects an offer in place: its id, first-seen time, postings
    // and showing time stay.
    async rewriteOffer(id, o) {
      await db
        .prepare(
          `UPDATE minimart_offers SET
             name = ?2, shown_name = ?3, brand = ?4, size = ?5, size_printed = ?6, count = ?7, unit = ?8,
             price = ?9, was_price = ?10, image_key = COALESCE(?11, image_key), votes = ?12
           WHERE id = ?1`,
        )
        .bind(id, o.name, o.shownName ?? null, o.brand ?? null, o.size ?? null, o.sizePrinted ?? null, o.count || 1,
          o.unit ?? null, o.price, o.wasPrice ?? null, o.imageKey ?? null, o.votes || 2)
        .run();
    },

    // frames/readings ADD to what earlier attempts spent.
    // A read snap is no longer queued to be read again.
    async finishSnap(snapId, { status, attempts, frames = 0, readings = 0, offers = 0, offerIds = null, mediaHash = null, repeatOf = null, error = null, readAt = null, reader = null }) {
      await db
        .prepare(
          `UPDATE minimart_snaps SET
             status = ?2, attempts = ?3, frames = frames + ?4, readings = readings + ?5,
             offers = ?6, offer_ids = ?7, media_hash = COALESCE(?8, media_hash),
             repeat_of = ?9, error = ?10, read_at = ?11, reader = COALESCE(?12, reader),
             reread = CASE WHEN ?2 = 'read' THEN 0 ELSE reread END
           WHERE snap_id = ?1`,
        )
        .bind(snapId, status, attempts, frames, readings, offers,
          offerIds ? JSON.stringify(offerIds) : null, mediaHash, repeatOf, error, readAt, reader)
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

    // How fast videos arrive (to pace the month's frames): repeats are never cut.
    async videoPace(sinceIso) {
      const row = await db
        .prepare(
          `SELECT SUM(CASE WHEN media_type = 'video' AND repeat_of IS NULL AND seen_at >= ?1 THEN 1 ELSE 0 END) AS videos,
                  MIN(seen_at) AS first
           FROM minimart_snaps`,
        )
        .bind(sinceIso)
        .first();
      return { videos: Number(row?.videos) || 0, firstSeen: row?.first || null };
    },

    // A shop's read videos since then, and how many of them showed a price
    // (a new offer or a re-posted one).
    async videoYield(username, sinceIso) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS videos,
                  COALESCE(SUM(CASE WHEN offer_ids IS NOT NULL AND offer_ids <> '[]' THEN 1 ELSE 0 END), 0) AS priced
           FROM minimart_snaps
           WHERE username = ?1 AND media_type = 'video' AND status = 'read' AND repeat_of IS NULL AND seen_at >= ?2`,
        )
        .bind(username, sinceIso)
        .first();
      return { videos: Number(row?.videos) || 0, priced: Number(row?.priced) || 0 };
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

    // Pictures no offer has needed since `beforeIso`: every offer that shows
    // the picture expired before then (several offers can share one picture).
    async unusedPictureKeys(beforeIso, limit) {
      const { results } = await db
        .prepare(
          `SELECT image_key FROM minimart_offers WHERE image_key IS NOT NULL
           GROUP BY image_key HAVING MAX(expires_at) < ?1 LIMIT ?2`,
        )
        .bind(beforeIso, limit)
        .all();
      return (results || []).map((r) => r.image_key);
    },

    // Their pictures left R2: the offers stay (the repeat history) without one.
    async clearPictures(keys) {
      for (let i = 0; i < keys.length; i += 50) {
        const part = keys.slice(i, i + 50);
        await db
          .prepare(`UPDATE minimart_offers SET image_key = NULL WHERE image_key IN (${part.map(() => '?').join(', ')})`)
          .bind(...part)
          .run();
      }
    },

    // Of these offers, the ones whose picture left R2.
    async picturelessOffers(ids) {
      const bare = [];
      for (let i = 0; i < ids.length; i += 50) {
        const part = ids.slice(i, i + 50);
        const { results } = await db
          .prepare(`SELECT id FROM minimart_offers WHERE image_key IS NULL AND id IN (${part.map(() => '?').join(', ')})`)
          .bind(...part)
          .all();
        bare.push(...(results || []).map((r) => r.id));
      }
      return bare;
    },

    // A presenter shop's live offers whose picture has no crop yet (a new
    // picture, or a picture changed since its crop), newest first.
    async cropQueue(nowIso, limit) {
      const { results } = await db
        .prepare(
          `SELECT o.* FROM minimart_offers o
           JOIN minimart_shops m ON m.username = o.username AND m.active = 1 AND m.style = 'presenter'
           WHERE o.expires_at > ?1 AND o.image_key IS NOT NULL
             AND (o.crop_of IS NULL OR o.crop_of != o.image_key)
           ORDER BY o.created_at DESC, o.id LIMIT ?2`,
        )
        .bind(nowIso, limit)
        .all();
      return (results || []).map(offerOut);
    },

    // The crop made from `imageKey` (null: none stood). Kept only while that
    // is still the offer's picture. -> { saved, oldCropKey } (the crop it replaces).
    async saveCrop(id, imageKey, cropKey) {
      const before = await db.prepare('SELECT crop_key FROM minimart_offers WHERE id = ?1 AND image_key = ?2').bind(id, imageKey).first();
      if (!before) return { saved: false, oldCropKey: null };
      const saved = changed(await db
        .prepare('UPDATE minimart_offers SET crop_key = ?3, crop_of = ?2 WHERE id = ?1 AND image_key = ?2')
        .bind(id, imageKey, cropKey)
        .run());
      return { saved, oldCropKey: saved && before.crop_key && before.crop_key !== cropKey ? before.crop_key : null };
    },

    // Crops of offers that expired before `beforeIso` (they leave R2 with their pictures).
    async expiredCrops(beforeIso, limit) {
      const { results } = await db
        .prepare('SELECT id, crop_key FROM minimart_offers WHERE crop_key IS NOT NULL AND expires_at < ?1 LIMIT ?2')
        .bind(beforeIso, limit)
        .all();
      return (results || []).map((r) => ({ id: r.id, cropKey: r.crop_key }));
    },

    async clearCrops(ids) {
      for (let i = 0; i < ids.length; i += 50) {
        const part = ids.slice(i, i + 50);
        await db
          .prepare(`UPDATE minimart_offers SET crop_key = NULL, crop_of = NULL WHERE id IN (${part.map(() => '?').join(', ')})`)
          .bind(...part)
          .run();
      }
    },

    // A deal posted again after its picture left R2 takes the new posting's.
    async setOfferImage(id, imageKey) {
      await db.prepare('UPDATE minimart_offers SET image_key = ?2 WHERE id = ?1 AND image_key IS NULL').bind(id, imageKey).run();
    },

    async liveOffers(nowIso) {
      const { results } = await db
        .prepare(
          `SELECT o.*, m.style AS shop_style FROM minimart_offers o
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
