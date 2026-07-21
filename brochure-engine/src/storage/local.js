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
import { applyEnrichment, servable } from '../offers/enrich.js';
import { visionMatchText } from './enrichStore.js';

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

// --- EnrichStore: an in-memory side-car with the same semantics as the D1 impl
// Local twin of storage/enrichStore.js so the vision-canonical read path runs
// end-to-end in dev/tests. `listOffers` (optional async () => offer rows) backs
// the offer-joined reads (listDebris/coverage/pruneOrphans/listUnresolved).
export function createMemoryEnrichStore({ listOffers = async () => [] } = {}) {
  const rows = new Map(); // id -> enrichment row (snake_case, like D1)
  const isDebris = (o, scope) =>
    scope === 'debris' ? o.name == null && o.name_ar == null : true;
  return {
    _rows: rows, // test/dev seam
    async listDebris({ currentOn, limit = 15, scope = 'all' } = {}) {
      return (await listOffers())
        .filter((o) => !rows.has(o.id) && o.image_url && (!currentOn || (o.valid_to && o.valid_to >= currentOn)) && isDebris(o, scope))
        .sort((a, b) => String(b.detected_at).localeCompare(String(a.detected_at)))
        .slice(0, Math.max(1, Math.min(Number(limit) || 15, 50)))
        .map((o) => ({ id: o.id, image_url: o.image_url, search_text: o.search_text }));
    },
    async countDebris(currentOn, scope = 'all') {
      return (await this.listDebris({ currentOn, limit: 50, scope })).length;
    },
    async coverage(currentOn) {
      const withCropRows = (await listOffers())
        .filter((o) => o.image_url && (!currentOn || (o.valid_to && o.valid_to >= currentOn)));
      const attempted = withCropRows.filter((o) => rows.has(o.id));
      const enriched = attempted.filter((o) => {
        const e = rows.get(o.id);
        return e.name != null || e.name_ar != null;
      });
      const servableN = enriched.filter((o) => servable(rows.get(o.id))).length;
      const withCrop = withCropRows.length;
      return {
        withCrop,
        attempted: attempted.length,
        enriched: enriched.length,
        servable: servableN,
        declined: attempted.length - enriched.length,
        remaining: withCrop - attempted.length,
        coverage: withCrop > 0 ? Math.round((attempted.length / withCrop) * 1000) / 10 : null,
      };
    },
    async upsertMany(newRows) {
      for (const r of newRows) {
        rows.set(r.id, {
          id: r.id, name: r.name ?? null, name_ar: r.name_ar ?? null,
          brand: r.brand ?? null, size: r.size ?? null,
          confidence: r.confidence ?? null, corroboration: r.corroboration ?? null,
          model: r.model ?? null, crop_url: r.crop_url ?? null,
          enriched_at: r.enriched_at, match_text: visionMatchText(r),
          mint_verdict: null, // a re-enrichment is re-resolved, like D1
        });
      }
      return { stored: newRows.length };
    },
    async getForIds(ids) {
      const map = new Map();
      for (const id of ids) if (rows.has(id)) map.set(id, rows.get(id));
      return map;
    },
    async pruneOrphans() {
      const live = new Set((await listOffers()).map((o) => o.id));
      let n = 0;
      for (const id of [...rows.keys()]) {
        if (!live.has(id)) {
          rows.delete(id);
          n += 1;
        }
      }
      return n;
    },
    async listUnresolved({ currentOn, limit = 50 } = {}) {
      const byId = new Map((await listOffers()).map((o) => [o.id, o]));
      const out = [];
      for (const e of rows.values()) {
        const o = byId.get(e.id);
        if (!o || e.mint_verdict != null) continue;
        if (currentOn && !(o.valid_to && o.valid_to >= currentOn)) continue;
        out.push({
          id: o.id, store: o.store, region: o.region, source: o.source,
          category: o.category, search_text: o.search_text, price: o.price,
          old_price: o.old_price, valid_from: o.valid_from, detected_at: o.detected_at,
          e_name: e.name, e_name_ar: e.name_ar, e_brand: e.brand,
          e_size: e.size, e_corroboration: e.corroboration,
        });
      }
      return out
        .sort((a, b) => String(b.detected_at).localeCompare(String(a.detected_at)))
        .slice(0, Math.max(1, Math.min(Number(limit) || 50, 500)));
    },
    async setVerdicts(pairs) {
      for (const { id, verdict } of pairs) {
        const e = rows.get(id);
        if (e) e.mint_verdict = verdict;
      }
    },
    async resetVerdicts(ids) {
      for (const id of ids) {
        const e = rows.get(id);
        if (e) e.mint_verdict = null;
      }
    },
    async verdictCounts() {
      const out = {};
      for (const e of rows.values()) {
        const k = e.mint_verdict ?? 'unresolved';
        out[k] = (out[k] || 0) + 1;
      }
      return out;
    },
    async reindexMatchText(limit = 400) {
      let n = 0;
      for (const e of rows.values()) {
        if (n >= limit) break;
        if (e.match_text == null && (e.name != null || e.name_ar != null)) {
          e.match_text = visionMatchText(e);
          n += 1;
        }
      }
      return n;
    },
  };
}

// --- OfferStore: an in-memory table with the same semantics as the D1 impl ----
// `enrichStore` (optional, a createMemoryEnrichStore) makes search() the local
// twin of the D1 vision-canonical query: rows carry the aliased e_* columns and
// match on the canonical haystack via the ONE gate (offers/enrich.js).
export function createMemoryOfferStore({ enrichStore = null } = {}) {
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
      const scoped = [...rows.values()].filter(
        (r) =>
          (!currentOn || (r.valid_to && r.valid_to >= currentOn)) &&
          (!store || r.store === store) &&
          (!region || r.region === region),
      );
      // Decorate with the aliased enrichment columns (ENRICH_ROW_COLS twin),
      // then match relevance over the canonical haystack applyEnrichment
      // returns — same gate, same substrate as the D1 query.
      const enr = enrichStore
        ? await enrichStore.getForIds(scoped.map((r) => r.id))
        : new Map();
      return scoped
        .map((r) => {
          const e = enr.get(r.id);
          return {
            ...r,
            e_name: e?.name ?? null,
            e_name_ar: e?.name_ar ?? null,
            e_match_text: e?.match_text ?? null,
            e_corroboration: e?.corroboration ?? null,
          };
        })
        .filter((r) => {
          if (!tokens.length) return true;
          const offer = rowToOffer(r);
          const hay = applyEnrichment(offer, r);
          return relevanceScore(offerRelevance(offer, tokens, hay)) > 0;
        })
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
    // Ops Vision Inspector parity (D1 offerStore.getById/inspectorFeed/
    // oldestUnenrichedAge). Local dev has no vision/registry substrate, so the
    // enrichment + sighting columns come back null — exactly what the D1 LEFT
    // JOINs yield for an un-enriched offer.
    async getById(id) {
      return rows.get(id) || null;
    },
    async inspectorFeed({ q = '', filter = 'all', currentOn = null, limit = 40 } = {}) {
      const ql = q.trim().toLowerCase();
      // Enrichment/sighting filters have no substrate locally -> empty, honestly.
      if (['unresolved', 'deferred', 'reviewed', 'low-confidence', 'ocr-fallback', 'vision-enriched'].includes(filter)) return [];
      return [...rows.values()]
        .filter((r) => r.image_url && (!currentOn || (r.valid_to && r.valid_to >= currentOn)))
        .filter((r) => !ql || [r.search_text, r.name, r.name_ar].some((v) => String(v || '').toLowerCase().includes(ql)))
        .sort((a, b) => String(b.detected_at).localeCompare(String(a.detected_at)))
        .slice(0, Math.max(1, Math.min(Number(limit) || 40, 200)))
        .map((r) => ({
          id: r.id, store: r.store, region: r.region, category: r.category, price: r.price,
          old_price: r.old_price, currency: r.currency, image_url: r.image_url, source_url: r.source_url,
          search_text: r.search_text, valid_to: r.valid_to, detected_at: r.detected_at,
          o_name: r.name, o_name_ar: r.name_ar, e_name: null, e_name_ar: null, e_brand: null,
          e_size: null, e_confidence: null, e_corroboration: null, e_mint_verdict: null,
          e_crop_url: null, e_enriched_at: null, e_servable: 0, s_product_id: null,
          s_match_band: null, s_match_score: null, s_resolved_at: null,
        }));
    },
    async oldestUnenrichedAge(currentOn) {
      const c = [...rows.values()].filter((r) => r.image_url && (!currentOn || (r.valid_to && r.valid_to >= currentOn)));
      return c.length ? c.reduce((m, r) => (r.detected_at < m ? r.detected_at : m), c[0].detected_at) : null;
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
