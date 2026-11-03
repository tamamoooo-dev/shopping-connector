// storage/watchListingStore.js — the Value Watch INDEX (watchIndex.js): one row
// per (watch, store, listing) any store returned for the watch, with the
// identity verdict and the last price seen. D1 in production; an in-memory twin
// with the same semantics for tests and dev.
//
// Interface:
//   list(watchId)                     -> listing docs (every verdict)
//   upsertMany(watchId, docs)         -> void   (insert or update by key)
//   setVerdict(watchId, store, listingId, { verdict, by, reason }) -> boolean
//   forget(watchId, docs)             -> void   (drop stale rejected/undecided rows)
//   removeForWatch(watchId)           -> void

const COLUMNS = [
  'watch_id', 'store', 'listing_id', 'source', 'name', 'name_key', 'brand', 'size_text',
  'link', 'image', 'item_value', 'item_unit', 'pack_count', 'verdict', 'verdict_by',
  'verdict_reason', 'ai_items', 'size_verified', 'query', 'first_seen_at', 'last_seen_at',
  'last_checked_at', 'last_price', 'last_value', 'missing_rounds', 'barcodes', 'in_stock',
];

export function listingToRow(watchId, d) {
  return {
    watch_id: watchId,
    store: String(d.store),
    listing_id: String(d.listingId),
    source: d.source || 'online',
    name: d.name ?? null,
    name_key: d.nameKey ?? null,
    brand: d.brand ?? null,
    size_text: d.sizeText ?? null,
    link: d.link ?? null,
    image: d.image ?? null,
    item_value: d.item?.value ?? null,
    item_unit: d.item?.unit ?? null,
    pack_count: d.pack ?? null,
    verdict: d.verdict,
    verdict_by: d.verdictBy ?? null,
    verdict_reason: d.verdictReason ?? null,
    ai_items: d.aiItems ?? null,
    size_verified: d.sizeVerified ? 1 : 0,
    query: d.query ?? null,
    first_seen_at: d.firstSeenAt,
    last_seen_at: d.lastSeenAt ?? null,
    last_checked_at: d.lastCheckedAt ?? null,
    last_price: d.lastPrice ?? null,
    last_value: d.lastValue ?? null,
    missing_rounds: d.missingRounds ?? 0,
    // Barcode keys (connector gtin.js), comma-joined; stock as the store said it.
    barcodes: Array.isArray(d.barcodes) && d.barcodes.length ? d.barcodes.slice(0, 8).join(',') : null,
    in_stock: d.inStock == null ? null : d.inStock ? 1 : 0,
  };
}

export function rowToListing(r) {
  if (!r) return null;
  return {
    watchId: r.watch_id,
    store: r.store,
    listingId: r.listing_id,
    source: r.source || 'online',
    name: r.name ?? null,
    nameKey: r.name_key ?? null,
    brand: r.brand ?? null,
    sizeText: r.size_text ?? null,
    link: r.link ?? null,
    image: r.image ?? null,
    item: r.item_value != null && r.item_unit ? { value: r.item_value, unit: r.item_unit } : null,
    pack: r.pack_count ?? null,
    verdict: r.verdict,
    verdictBy: r.verdict_by ?? null,
    verdictReason: r.verdict_reason ?? null,
    aiItems: r.ai_items ?? null,
    sizeVerified: Boolean(r.size_verified),
    query: r.query ?? null,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at ?? null,
    lastCheckedAt: r.last_checked_at ?? null,
    lastPrice: r.last_price ?? null,
    lastValue: r.last_value ?? null,
    missingRounds: r.missing_rounds ?? 0,
    barcodes: r.barcodes ? String(r.barcodes).split(',').filter(Boolean) : [],
    inStock: r.in_stock == null ? null : Boolean(r.in_stock),
  };
}

export function createD1WatchListingStore(db) {
  const upsertSql = `INSERT INTO watch_listings (${COLUMNS.join(', ')})
    VALUES (${COLUMNS.map(() => '?').join(', ')})
    ON CONFLICT(watch_id, store, listing_id) DO UPDATE SET
      ${COLUMNS.filter((c) => !['watch_id', 'store', 'listing_id', 'first_seen_at'].includes(c))
        .map((c) => `${c} = excluded.${c}`).join(',\n      ')}`;
  return {
    async list(watchId) {
      const { results } = await db
        .prepare('SELECT * FROM watch_listings WHERE watch_id = ? ORDER BY verdict, last_value')
        .bind(watchId)
        .all();
      return (results || []).map(rowToListing);
    },
    async upsertMany(watchId, docs = []) {
      if (!docs.length) return;
      const statements = docs.map((d) => {
        const r = listingToRow(watchId, d);
        return db.prepare(upsertSql).bind(...COLUMNS.map((c) => r[c]));
      });
      // D1 batches are one round trip and atomic; keep each batch small.
      for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
    },
    async setVerdict(watchId, store, listingId, { verdict, by = 'user', reason = null } = {}) {
      const res = await db
        .prepare(`UPDATE watch_listings SET verdict = ?, verdict_by = ?, verdict_reason = ?
                   WHERE watch_id = ? AND store = ? AND listing_id = ?`)
        .bind(verdict, by, reason, watchId, String(store), String(listingId))
        .run();
      return (res?.meta?.changes || 0) > 0;
    },
    async forget(watchId, docs = []) {
      const statements = docs.map((d) => db
        .prepare('DELETE FROM watch_listings WHERE watch_id = ? AND store = ? AND listing_id = ?')
        .bind(watchId, String(d.store), String(d.listingId)));
      for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
    },
    async removeForWatch(watchId) {
      await db.prepare('DELETE FROM watch_listings WHERE watch_id = ?').bind(watchId).run();
    },
  };
}

export function createMemoryWatchListingStore() {
  const rows = new Map(); // `${watchId}\u0000${store}\u0000${listingId}` -> row
  const key = (w, s, l) => `${w}\u0000${s}\u0000${l}`;
  return {
    async list(watchId) {
      return [...rows.values()].filter((r) => r.watch_id === watchId).map(rowToListing);
    },
    async upsertMany(watchId, docs = []) {
      for (const d of docs) {
        const r = listingToRow(watchId, d);
        const k = key(watchId, r.store, r.listing_id);
        const prev = rows.get(k);
        rows.set(k, prev ? { ...r, first_seen_at: prev.first_seen_at } : r);
      }
    },
    async setVerdict(watchId, store, listingId, { verdict, by = 'user', reason = null } = {}) {
      const r = rows.get(key(watchId, String(store), String(listingId)));
      if (!r) return false;
      Object.assign(r, { verdict, verdict_by: by, verdict_reason: reason });
      return true;
    },
    async forget(watchId, docs = []) {
      for (const d of docs) rows.delete(key(watchId, String(d.store), String(d.listingId)));
    },
    async removeForWatch(watchId) {
      for (const [k, r] of rows) if (r.watch_id === watchId) rows.delete(k);
    },
  };
}
