// storage/local.js — zero-dependency local implementations of the storage
// interfaces, used ONLY by dev.mjs to run the full pipeline end-to-end without
// provisioning any cloud resources. They implement the exact same interfaces as
// the R2/D1 backends, so the engine, pipeline and collectors run unchanged.
//
// Not part of the deployed Worker.

import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { queryTokens, offerRelevance, relevanceScore, rowToOffer } from '../offers/contract.js';
import { expandToken } from '../matching.js';

// --- ObjectStore: files under a data directory --------------------------------
export function createFsObjectStore(rootDir) {
  const metaExt = '.ct'; // side-car storing the content-type
  return {
    async put(key, bytes, { contentType } = {}) {
      const path = join(rootDir, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(bytes));
      await writeFile(path + metaExt, contentType || 'application/octet-stream');
    },
    async get(key) {
      const path = join(rootDir, key);
      if (!existsSync(path)) return null;
      const bytes = new Uint8Array(await readFile(path));
      let contentType = 'application/octet-stream';
      if (existsSync(path + metaExt)) contentType = (await readFile(path + metaExt, 'utf8')).trim();
      return { bytes, contentType };
    },
    async delete(key) {
      const path = join(rootDir, key);
      await rm(path, { force: true });
      await rm(path + metaExt, { force: true });
    },
  };
}

// --- MetadataStore: an in-memory table with the same semantics as D1 ----------
export function createMemoryMetadataStore() {
  const rows = new Map(); // id -> row
  return {
    async existsByChecksum(checksum) {
      for (const r of rows.values()) if (r.checksum === checksum) return true;
      return false;
    },
    async upsert(row) {
      // Same semantics as D1: insert-or-refresh one row as current; superseding
      // prior rows is the ingest run's job via setCurrent() (a store may hold
      // several concurrent current flyers).
      rows.set(row.id, { ...row, is_current: 1 });
    },
    async setCurrent(store, region, checksums, { supersedeOthers = true } = {}) {
      if (!checksums || !checksums.length) return;
      const keep = new Set(checksums);
      for (const r of rows.values()) {
        if (r.store !== store || r.region !== region) continue;
        if (keep.has(r.checksum)) r.is_current = 1;
        else if (supersedeOthers) r.is_current = 0;
      }
    },
    async getById(id) {
      if (!id) return null;
      return rows.get(id) || null;
    },
    async getBySourceUrl(store, region, sourceUrl) {
      if (!sourceUrl) return null;
      const hits = [...rows.values()]
        .filter((r) => r.store === store && r.region === region && r.source_url === sourceUrl)
        .sort((a, b) => (b.detected_at || '').localeCompare(a.detected_at || ''));
      return hits[0] || null;
    },
    async getCurrent(store, region) {
      return [...rows.values()].filter((r) => r.store === store && r.region === region && r.is_current);
    },
    async listCurrent() {
      return [...rows.values()]
        .filter((r) => r.is_current)
        .sort((a, b) => (a.store + a.region).localeCompare(b.store + b.region));
    },
    async getHistory(store, region) {
      return [...rows.values()]
        .filter((r) => r.store === store && r.region === region)
        .sort((a, b) => b.edition.localeCompare(a.edition));
    },
    async listPrunable(cutoffISO, limit = 12) {
      return [...rows.values()]
        .filter((r) => !r.is_current && !r.pruned_at && r.valid_to && r.valid_to < cutoffISO)
        .sort((a, b) => (a.valid_to || '').localeCompare(b.valid_to || ''))
        .slice(0, limit);
    },
    async markPruned(id) {
      const r = rows.get(id);
      if (r) r.pruned_at = new Date().toISOString();
    },
  };
}

// --- OfferStore: an in-memory table with the same semantics as the D1 impl ----
export function createMemoryOfferStore() {
  const rows = new Map(); // id -> row (snake_case, like D1)
  return {
    async upsertMany(newRows) {
      for (const r of newRows) {
        const prior = rows.get(r.id);
        // Same COALESCE semantics as D1: a link to a held edition, once made,
        // is never overwritten by a later null.
        rows.set(r.id, { ...r, edition: r.edition ?? prior?.edition ?? null });
      }
      return { stored: newRows.length };
    },
    async search({ q = '', store = '', region = '', currentOn = null, limit = 60 } = {}) {
      const tokens = queryTokens(q);
      return [...rows.values()]
        .filter(
          (r) =>
            (!currentOn || (r.valid_to && r.valid_to >= currentOn)) &&
            (!store || r.store === store) &&
            (!region || r.region === region) &&
            (!tokens.length || relevanceScore(offerRelevance(rowToOffer(r), tokens, r.search_text || '')) > 0),
        )
        .sort((a, b) => a.price - b.price)
        .slice(0, Math.max(1, Math.min(Number(limit) || 60, 300)));
    },
    async byFlyer(store, region, flyerRef) {
      return [...rows.values()]
        .filter((r) => r.store === store && r.region === region && String(r.flyer_ref) === String(flyerRef))
        .slice(0, 2000);
    },
    async listAll({ store = '' } = {}) {
      return [...rows.values()].filter((r) => !store || r.store === store);
    },
    async counts(currentOn) {
      const all = [...rows.values()];
      const current = all.filter((r) => r.valid_to && r.valid_to >= currentOn);
      return { total: all.length, current: current.length, stores: new Set(current.map((r) => r.store)).size };
    },
    async countsByStore(currentOn) {
      const out = {};
      for (const r of rows.values()) {
        if (r.valid_to && r.valid_to >= currentOn) out[r.store] = (out[r.store] || 0) + 1;
      }
      return out;
    },
    async pruneExpiredBefore(cutoffISO) {
      let n = 0;
      for (const [id, r] of rows) {
        if (r.valid_to && r.valid_to < cutoffISO) {
          rows.delete(id);
          n += 1;
        }
      }
      return n;
    },
  };
}

// --- WatchStore: an in-memory table with the same semantics as the D1 impl ----
export function createMemoryWatchStore() {
  const watches = new Map(); // id -> watch (doc shape, like rowToWatch output)
  const alerts = new Map(); // id -> alert (doc shape)
  return {
    async create(watch) {
      watches.set(watch.id, { ...watch });
      return watch;
    },
    async list({ activeOnly = false, profileId = null } = {}) {
      return [...watches.values()]
        .filter((w) => !activeOnly || w.active)
        .filter((w) => !profileId || w.profileId === profileId)
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    },
    async get(id) {
      const w = watches.get(id);
      return w ? { ...w } : null;
    },
    async remove(id, profileId = null) {
      const w = watches.get(id);
      if (!w || (profileId && w.profileId !== profileId)) return false;
      for (const [aid, a] of alerts) if (a.watchId === id) alerts.delete(aid);
      return watches.delete(id);
    },
    async count(profileId = null) {
      return [...watches.values()]
        .filter((w) => w.active && (!profileId || w.profileId === profileId)).length;
    },
    async countActiveTotal() {
      return [...watches.values()].filter((w) => w.active).length;
    },
    async adoptOrphans(profileId) {
      let n = 0;
      for (const w of watches.values()) {
        if (w.profileId == null) {
          w.profileId = profileId;
          n += 1;
        }
      }
      return n;
    },
    async updateState(id, fields) {
      const w = watches.get(id);
      if (!w) return;
      for (const key of ['isBelow', 'checkedAt', 'lastPrice', 'lastStore', 'lastSource', 'lastName', 'lastLink']) {
        if (key in fields) w[key] = key === 'isBelow' ? !!fields[key] : fields[key] ?? null;
      }
    },
    async insertAlert(alert) {
      alerts.set(alert.id, { ...alert, seen: false });
    },
    // Alerts scope through their watch, exactly like the D1 impl.
    async listAlerts({ limit = 50, unseenOnly = false, profileId = null } = {}) {
      const owned = (a) => !profileId || watches.get(a.watchId)?.profileId === profileId;
      return [...alerts.values()]
        .filter((a) => (!unseenOnly || !a.seen) && owned(a))
        .sort((a, b) => (b.observedAt || '').localeCompare(a.observedAt || ''))
        .slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
    },
    async markAlertsSeen(profileId = null) {
      let n = 0;
      for (const a of alerts.values()) {
        if (!a.seen && (!profileId || watches.get(a.watchId)?.profileId === profileId)) {
          a.seen = true;
          n += 1;
        }
      }
      return n;
    },
    async countUnseen(profileId = null) {
      return [...alerts.values()]
        .filter((a) => !a.seen && (!profileId || watches.get(a.watchId)?.profileId === profileId)).length;
    },
  };
}

// --- OpsStore: an in-memory audit table with the same semantics as the D1 impl
export function createMemoryOpsStore() {
  const runs = []; // insertion order = id order
  let nextId = 1;
  return {
    async record(run) {
      runs.push({
        id: nextId++,
        ts: run.ts || new Date().toISOString(),
        action: run.action,
        origin: run.origin || 'ops',
        store: run.store ?? null,
        stores: run.stores ?? null,
        ok: run.ok ? 1 : 0,
        detected: run.detected ?? null,
        new: run.new ?? null,
        deduped: run.deduped ?? null,
        failed: run.failed ?? null,
        offers: run.offers ?? null,
        coverage: run.coverage ?? null,
        elapsed_ms: run.elapsed_ms ?? null,
        error: run.error ?? null,
        detail: run.detail != null ? JSON.stringify(run.detail) : null,
      });
    },
    async list({ limit = 50, store = '', origin = '', failedOnly = false } = {}) {
      return runs
        .filter(
          (r) =>
            (!store || r.store === store) &&
            (!origin || r.origin === origin) &&
            (!failedOnly || !r.ok),
        )
        .sort((a, b) => b.id - a.id)
        .slice(0, Math.max(1, Math.min(Number(limit) || 50, 400)));
    },
  };
}

// --- HistoryStore: in-memory tables with the same semantics as the D1 impl ----
export function createMemoryHistoryStore() {
  const identities = new Map(); // id -> identity row (snake_case, like D1)
  const points = new Map(); // `${identity} ${week}` -> point row
  return {
    async getByIds(ids) {
      return ids.map((id) => identities.get(id)).filter(Boolean);
    },
    async upsertIdentities(rows) {
      for (const r of rows) {
        const prior = identities.get(r.id);
        // Same semantics as the D1 upsert: first_seen survives a refresh.
        identities.set(r.id, { ...r, first_seen: prior ? prior.first_seen : r.first_seen });
      }
      return { stored: rows.length };
    },
    async insertPoints(newPoints) {
      for (const p of newPoints) points.set(`${p.identity} ${p.week}`, { ...p });
      return { stored: newPoints.length };
    },
    async searchIdentities({ q = '', limit = 250 } = {}) {
      const tokens = queryTokens(q);
      if (!tokens.length) return [];
      // The D1 impl is a broad LIKE prefilter; a substring test is the same
      // spirit locally (final word-boundary relevance runs in priceHistory.js).
      const expanded = tokens.map((t) => expandToken(t));
      return [...identities.values()]
        .filter((r) => expanded.every((vs) => vs.some((v) => r.match_text.includes(v))))
        .sort((a, b) => a.last_price - b.last_price)
        .slice(0, Math.max(1, Math.min(Number(limit) || 250, 400)));
    },
    async pointsForIdentities(ids) {
      const keep = new Set(ids);
      return [...points.values()].filter((p) => keep.has(p.identity));
    },
    async counts() {
      return { identities: identities.size, points: points.size };
    },
    async pruneStale(cutoffISO, { maxRows = 400 } = {}) {
      const stale = [...identities.values()]
        .filter((r) => r.last_seen < cutoffISO)
        .slice(0, maxRows);
      let removedPoints = 0;
      for (const r of stale) {
        identities.delete(r.id);
        for (const [key, p] of points) {
          if (p.identity === r.id) {
            points.delete(key);
            removedPoints += 1;
          }
        }
      }
      return { identities: stale.length, points: removedPoints };
    },
  };
}
