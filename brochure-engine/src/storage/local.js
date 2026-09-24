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
import { hasUsableCommercePrice } from '../offers/commerceScore.js';
import { readExtractionPackageType, readExtractionUnit, visionMatchText } from './enrichStore.js';
import {
  BUILDER_SCORE_VERSION,
  buildArabicShadow,
  readArabicBuilderShadow,
  selectArabicName,
  withArabicBuilderShadow,
} from '../lexicon/arabicRollout.js';
import { COMMERCE_SCORE_VERSION } from '../offers/commerceScore.js';

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
  // S1 Extraction Admission (R4). The D1 twin spells this out as
  // enrichStore.USABLE_PRICE_SQL; here the shared JS predicate is called
  // directly, which is the point — one definition, two bindings, and the
  // differential test proves the SQL matches this.
  const visionEligible = (o, scope) =>
    o.image_url && isDebris(o, scope) && hasUsableCommercePrice(o);
  return {
    _rows: rows, // test/dev seam
    async listDebris({ currentOn, limit = 15, scope = 'all' } = {}) {
      return (await listOffers())
        .filter((o) => !rows.has(o.id) && (!currentOn || (o.valid_to && o.valid_to >= currentOn)) && visionEligible(o, scope))
        // Expiry-first, arrival-order tiebreak — the twin of the D1 ORDER BY.
        .sort((a, b) => String(a.valid_to).localeCompare(String(b.valid_to))
          || String(a.detected_at).localeCompare(String(b.detected_at)))
        .slice(0, Math.max(1, Math.min(Number(limit) || 15, 50)))
        .map((o) => ({
          id: o.id,
          image_url: o.image_url,
          search_text: o.search_text,
          price: o.price,
          currency: o.currency,
        }));
    },
    async listSelected({ ids, currentOn } = {}) {
      const selected = new Set((ids || []).map(String));
      return (await listOffers())
        .filter((o) => selected.has(o.id) && o.image_url &&
          (!currentOn || (o.valid_to && o.valid_to >= currentOn)))
        .slice(0, 50)
        .map((o) => ({
          id: o.id,
          image_url: o.image_url,
          price: o.price,
          currency: o.currency,
        }));
    },
    async listDebrisByIds({ ids, currentOn, scope = 'all' } = {}) {
      const selected = new Set((ids || []).map(String));
      return (await this.listDebris({ currentOn, limit: 50, scope }))
        .filter((offer) => selected.has(offer.id));
    },
    async countDebris(currentOn, scope = 'all') {
      return (await this.listDebris({ currentOn, limit: 50, scope })).length;
    },
    async coverage(currentOn) {
      // Denominator tracks S1 admission, exactly as the D1 twin does (R4).
      const withCropRows = (await listOffers())
        .filter((o) => (!currentOn || (o.valid_to && o.valid_to >= currentOn)) && visionEligible(o, 'all'));
      const attempted = withCropRows.filter((o) => rows.has(o.id));
      const enriched = attempted.filter((o) => {
        const e = rows.get(o.id);
        return e.name != null;
      });
      const servableN = enriched.filter((o) => servable(rows.get(o.id))).length;
      const withCrop = withCropRows.length;
      return {
        withCrop,
        attempted: attempted.length,
        enriched: enriched.length,
        verified: servableN,
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
          extraction_json: r.extraction_json == null
            ? null
            : JSON.stringify(r.extraction_json),
          identity_candidate: r.identity_candidate == null
            ? null
            : JSON.stringify(r.identity_candidate),
          identity_candidate_version: r.identity_candidate_version
            ?? (r.identity_candidate == null ? null : 'identity-candidate-v1'),
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
    async backfillArabicBuilderShadows(limit = 200) {
      let updated = 0;
      const offersById = new Map((await listOffers()).map((offer) => [offer.id, offer]));
      for (const row of rows.values()) {
        if (updated >= Math.max(1, Math.min(Number(limit) || 200, 500))) break;
        const existingShadow = readArabicBuilderShadow(row.extraction_json);
        if (existingShadow?.builder_score_version === BUILDER_SCORE_VERSION
            && existingShadow?.commerce_score_version === COMMERCE_SCORE_VERSION) continue;
        let observation = {};
        try {
          observation = row.extraction_json ? JSON.parse(row.extraction_json) : {};
        } catch {
          continue;
        }
        const { arabicBuilder } = buildArabicShadow({
          ...observation,
          name_en: row.name,
          name_ar: row.name_ar,
          brand: row.brand,
          size: row.size,
          price: offersById.get(row.id)?.price ?? null,
          currency: offersById.get(row.id)?.currency ?? null,
        });
        row.extraction_json = JSON.stringify(withArabicBuilderShadow(observation, arabicBuilder));
        updated += 1;
      }
      return updated;
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
    async listPendingReviews(limit = 50) {
      const byId = new Map((await listOffers()).map((o) => [o.id, o]));
      const out = [];
      for (const e of rows.values()) {
        if (e.mint_verdict !== 'review') continue;
        const o = byId.get(e.id);
        if (!o) continue;
        out.push({
          offer_id: o.id, product_id: null, match_band: 'review',
          match_score: null, corroboration: null,
          store: o.store, region: o.region,
          week: o.valid_from || String(o.detected_at || '').slice(0, 10),
          price: o.price, old_price: o.old_price ?? null,
          resolved_at: e.enriched_at,
          o_image_url: o.image_url ?? null, o_source_url: o.source_url ?? null,
          o_search_text: o.search_text ?? null,
          p_display_name: null, p_display_name_ar: null,
          identity_candidate: e.identity_candidate,
          identity_candidate_version: e.identity_candidate_version,
          review_state: 'pending', trusted: 0,
        });
        if (out.length >= limit) break;
      }
      return out;
    },
    async getPendingReview(offerId) {
      const e = rows.get(offerId);
      if (!e || e.mint_verdict !== 'review') return null;
      const o = (await listOffers()).find((row) => row.id === offerId);
      if (!o) return null;
      return {
        offer_id: o.id, store: o.store, region: o.region, source: o.source,
        price: o.price, old_price: o.old_price ?? null,
        week: o.valid_from || String(o.detected_at || '').slice(0, 10),
        identity_candidate: e.identity_candidate,
        identity_candidate_version: e.identity_candidate_version,
      };
    },
    async historicalCandidateRows(ids) {
      const selected = new Set((ids || []).map(String));
      return [...rows.values()].filter((row) => selected.has(row.id)).map((row) => ({
        ...row,
        has_sighting: 0,
      }));
    },
    async stageHistoricalCandidates(staged) {
      for (const row of staged) {
        const current = rows.get(row.id);
        if (!current) continue;
        current.identity_candidate = JSON.stringify(row.identity_candidate);
        current.identity_candidate_version = row.identity_candidate_version || 'identity-candidate-v1';
      }
      return { staged: staged.length };
    },
    async activateHistoricalCandidates(ids) {
      let activated = 0;
      for (const id of ids || []) {
        const row = rows.get(id);
        if (!row || row.identity_candidate == null) continue;
        row.mint_verdict = null;
        activated += 1;
      }
      return { activated };
    },
    async rollbackHistoricalCandidates(snapshot) {
      let restored = 0;
      for (const prior of snapshot || []) {
        const row = rows.get(prior.id);
        if (!row) continue;
        row.identity_candidate = prior.identity_candidate ?? null;
        row.identity_candidate_version = prior.identity_candidate_version ?? null;
        row.mint_verdict = prior.mint_verdict ?? null;
        restored += 1;
      }
      return { restored };
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
export function createMemoryOfferStore({
  enrichStore = null,
  builtArabicNamesEnabled = false,
} = {}) {
  const rows = new Map(); // id -> row (snake_case, like D1)
  const pending = new Map(); // id -> price_pending row (snake_case, like D1)

  // The ENRICH_ROW_COLS twin, in ONE place. search() and byFlyer() both project
  // it, because the production bug this mirrors was precisely one read path
  // (the flyer viewer) silently not carrying these columns.
  const decorateWithEnrichment = async (scoped) => {
    const enr = enrichStore
      ? await enrichStore.getForIds(scoped.map((r) => r.id))
      : new Map();
    return scoped.map((r) => {
      const e = enr.get(r.id);
      const selectedArabic = selectArabicName({
        observedArabic: e?.name_ar ?? null,
        shadow: readArabicBuilderShadow(e?.extraction_json),
        enabled: builtArabicNamesEnabled,
      });
      return {
        ...r,
        e_name: e?.name ?? null,
        e_name_ar: selectedArabic.nameAr,
        // The D1 search projects the enrichment's brand and size too, and
        // consumers read them (monitor.js offerAsListing turns a flyer row
        // into a listing for the shared extractor). Omitting them here made
        // the twin quietly weaker than production.
        e_brand: e?.brand ?? null,
        e_size: e?.size ?? null,
        // The D1 twin extracts this with json_extract; here the parsed object
        // is already to hand. Feeds the price basis (applyUnitPrice).
        e_unit: readExtractionUnit(e?.extraction_json),
        e_package_type: readExtractionPackageType(e?.extraction_json),
        e_match_text: e?.match_text ?? null,
        e_corroboration: e?.corroboration ?? null,
        e_model: e?.model ?? null,
      };
    });
  };

  return {
    async upsertMany(newRows) {
      for (const r of newRows) {
        const hasNavigationShape =
          Object.hasOwn(r, 'brochure_id') ||
          Object.hasOwn(r, 'page_index') ||
          Object.hasOwn(r, 'navigation_provenance');
        rows.set(
          r.id,
          hasNavigationShape
            ? {
                ...r,
                brochure_id: r.brochure_id ?? null,
                page_index: r.page_index ?? null,
                navigation_provenance: r.navigation_provenance ?? null,
                edition: r.edition ?? null,
              }
            : { ...r },
        );
      }
      return { stored: newRows.length };
    },
    async updateNavigation(updates) {
      for (const update of updates) {
        const row = rows.get(update.id);
        if (!row) continue;
        row.brochure_id = update.brochureId ?? null;
        row.page_index = Number.isInteger(update.pageIndex) ? update.pageIndex : null;
        row.navigation_provenance = update.navigationProvenance ?? null;
        row.edition = update.edition ?? null;
      }
      return { updated: updates.length };
    },
    async search({ q = '', store = '', region = '', currentOn = null, limit = 60 } = {}) {
      const tokens = queryTokens(q);
      const scoped = [...rows.values()].filter(
        (r) =>
          (!currentOn || (r.valid_to && r.valid_to >= currentOn)) &&
          (!store || r.store === store) &&
          (!region || r.region === region) &&
          (!Object.hasOwn(r, 'brochure_id') && !Object.hasOwn(r, 'page_index') ||
            r.brochure_id != null && Number.isInteger(r.page_index)),
      );
      // Decorate with the aliased enrichment columns (ENRICH_ROW_COLS twin),
      // then match relevance over the canonical haystack applyEnrichment
      // returns — same gate, same substrate as the D1 query.
      return (await decorateWithEnrichment(scoped))
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
      return decorateWithEnrichment(
        [...rows.values()]
          .filter((r) => r.store === store && r.region === region && String(r.flyer_ref) === String(flyerRef))
          .slice(0, 2000),
      );
    },
    // price_pending twin (vision price fallback queue).
    async upsertPricePending(newRows) {
      for (const r of newRows) {
        const prev = pending.get(r.id);
        pending.set(r.id, prev
          ? { ...prev, flyer_ref: r.flyer_ref ?? null, image_url: r.image_url, valid_to: r.valid_to ?? null, raw_json: r.raw_json }
          : { status: 'pending', attempts: 0, reason: null, price: null, old_price: null, audit_json: null, resolved_at: null, ...r });
      }
      return { stored: newRows.length };
    },
    async pricePendingByIds(ids) {
      return ids.map((id) => pending.get(id)).filter(Boolean);
    },
    async pricePendingByFlyer(store, region, flyerRef) {
      return [...pending.values()]
        .filter((p) => p.store === store && p.region === region && String(p.flyer_ref) === String(flyerRef))
        .slice(0, 2000);
    },
    async listPricePending({ currentOn, limit = 10 } = {}) {
      return [...pending.values()]
        .filter((p) => p.status === 'pending' && p.valid_to >= currentOn &&
          !(rows.has(p.id) && rows.get(p.id).price_source == null))
        .sort((a, b) => String(a.valid_to).localeCompare(String(b.valid_to)) ||
          String(a.detected_at).localeCompare(String(b.detected_at)))
        .slice(0, Math.max(1, Math.min(Number(limit) || 10, 50)));
    },
    async resolvePricePending(id, { status, price = null, oldPrice = null, reason = null, audit = null, at }) {
      const p = pending.get(id);
      if (p) Object.assign(p, { status, price, old_price: oldPrice, reason, audit_json: audit ? JSON.stringify(audit) : null, resolved_at: at });
    },
    async markPricePendingAttempt(id, { reason, reject = false, at }) {
      const p = pending.get(id);
      if (!p) return;
      p.attempts += 1;
      p.reason = reason;
      if (reject) Object.assign(p, { status: 'rejected', resolved_at: at });
    },
    async prunePricePendingBefore(cutoffISO) {
      let n = 0;
      for (const [id, p] of pending) {
        if (p.valid_to && p.valid_to < cutoffISO) { pending.delete(id); n += 1; }
      }
      return n;
    },
    async requiredFlyerRefs(store, region, currentOn) {
      return [...new Set(
        [...rows.values()]
          .filter(
            (r) =>
              r.store === store &&
              r.region === region &&
              r.valid_to >= currentOn &&
              r.flyer_ref != null &&
              String(r.flyer_ref) !== '',
          )
          .map((r) => String(r.flyer_ref)),
      )];
    },
    async listAll({ store = '' } = {}) {
      return [...rows.values()].filter((r) => !store || r.store === store);
    },
    async navigationMetrics(currentOn) {
      const current = [...rows.values()].filter((r) => r.valid_to && r.valid_to >= currentOn);
      return {
        current: current.length,
        unlinked: current.filter((r) => r.brochure_id == null || !Number.isInteger(r.page_index)).length,
        dual: current.filter((r) => r.navigation_provenance === 'dual').length,
        hotspotUnique: current.filter((r) => r.navigation_provenance === 'hotspot_unique').length,
        missingProvenance: current.filter(
          (r) =>
            r.brochure_id != null &&
            Number.isInteger(r.page_index) &&
            r.navigation_provenance == null,
        ).length,
      };
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
  const anchored = (w) => (
    ['anchored_registry', 'anchored_source', 'anchored_spec'].includes(w.anchorState) ||
    (!w.anchorState && Boolean(w.registryProductId || w.spec))
  );
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
    // MONITORED = active AND anchored. Same boundary as the D1 impl: the cap
    // this feeds bounds the daily cron's work, and an unanchored watch does no
    // work, so it must not occupy a slot.
    async count(profileId = null) {
      return [...watches.values()].filter(
        (w) => w.active && anchored(w) && (!profileId || w.profileId === profileId),
      ).length;
    },
    async countRows(profileId = null) {
      return [...watches.values()].filter((w) => !profileId || w.profileId === profileId).length;
    },
    async countUnanchored(profileId = null) {
      return [...watches.values()].filter(
        (w) => w.active && !anchored(w) && (!profileId || w.profileId === profileId),
      ).length;
    },
    async countActiveTotal() {
      return [...watches.values()].filter((w) => w.active && anchored(w)).length;
    },
    async identityStats(profileId = null) {
      const states = {};
      const provenance = {};
      let zeroCandidateConfirmations = 0;
      for (const w of watches.values()) {
        if (!w.active || (profileId && w.profileId !== profileId)) continue;
        const state = w.anchorState || 'legacy';
        states[state] = (states[state] || 0) + 1;
        try {
          const kind = JSON.parse(w.anchorProvenance || '{}').kind;
          if (kind) provenance[kind] = (provenance[kind] || 0) + 1;
        } catch { /* diagnostic only */ }
        if (state === 'confirmation_required') {
          try {
            const candidates = JSON.parse(w.candidateSnapshot || '{}').candidates;
            if (!Array.isArray(candidates) || candidates.length === 0) {
              zeroCandidateConfirmations += 1;
            }
          } catch {
            zeroCandidateConfirmations += 1;
          }
        }
      }
      return {
        states,
        provenance,
        confirmationRequired: states.confirmation_required || 0,
        zeroCandidateConfirmations,
      };
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
      for (const key of [
        'isBelow', 'isClose', 'checkedAt', 'lastPrice', 'lastPurchasePrice',
        'lastUnitLabel', 'lastStore', 'lastSource', 'lastName', 'lastLink',
        'lastResolution', 'lastResolutionReason', 'resolvedAt',
        'monitoringHealth', 'monitoringHealthReason',
      ]) {
        if (key in fields) {
          w[key] = key === 'isBelow' || key === 'isClose' ? !!fields[key] : fields[key] ?? null;
        }
      }
    },
    // The anchor moved because the REGISTRY merged it — same boundary as D1.
    async rebindProduct(id, registryProductId) {
      const w = watches.get(id);
      if (!w || !registryProductId) return false;
      w.registryProductId = registryProductId;
      return true;
    },
    async rebindSource(id, {
      provider, productId, snapshot, provenance, confidence, margin,
    } = {}) {
      const w = watches.get(id);
      if (!w || w.anchorState !== 'anchored_source' || !provider || !productId || !snapshot) {
        return false;
      }
      w.provider = provider;
      w.productId = productId;
      w.sourceSnapshot = JSON.stringify(snapshot);
      w.anchorProvenance = JSON.stringify({
        kind: provenance || 'verified-source-rebind', provider, productId,
      });
      w.anchorConfidence = confidence ?? null;
      w.anchorMargin = margin ?? null;
      return true;
    },
    // Set the ANCHOR and the state explaining it — same boundary as D1.
    async setAnchor(id, anchor = {}) {
      const w = watches.get(id);
      if (!w) return false;
      for (const key of [
        'registryProductId', 'spec', 'provider', 'productId', 'anchorState',
        'sourceSnapshot', 'anchorProvenance', 'anchorConfidence', 'anchorMargin',
        'anchorPolicyVersion', 'candidateSnapshot', 'resolutionAttempts',
        'lastResolutionAttemptAt', 'identityResolutionReason', 'monitoringHealth',
        'monitoringHealthReason', 'lastResolution', 'lastResolutionReason',
      ]) {
        w[key] = anchor[key] ?? null;
      }
      return true;
    },
    async updateSettings(id, profileId, fields) {
      const w = watches.get(id);
      if (!w || w.profileId !== profileId) return false;
      for (const key of [
        'matchBrand', 'matchSize', 'matchVariant', 'closeThreshold',
        'targetUnitPrice', 'unitLabel', 'customSearchQuery',
      ]) {
        if (key in fields) w[key] = fields[key] ?? null;
      }
      w.isBelow = false;
      w.isClose = false;
      return true;
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
