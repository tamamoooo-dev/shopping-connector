// registry/memstore.js — the in-memory TWIN of storage/registryStore.js:
// identical interface and semantics, zero D1. One twin, three consumers — the
// offline test suites (learn/pipeline/lifecycle), the dev harness, and the §8
// calibration/replay harness (calibrate-registry.mjs), which replays the real
// resolver over real reads against exactly this store. Semantics parity with
// the D1 store is the contract: when a method is added there, it is added
// here, in the same shape.
//
// Construction: createMemRegistryStore({ offers }) — `offers` is the twin of
// the offers TABLE (snake_case rows), consulted by the incumbency fast-path
// and by the joins (sightings -> offer link/validity) exactly like the D1
// LEFT JOINs. Escape hatches for assertions: `_products`, `_sightings`.

export function createMemRegistryStore({ offers = [] } = {}) {
  const products = new Map(); // id -> row
  const sightings = new Map(); // offer_id -> row
  const index = new Map(); // token -> Set(product_id)
  const offerById = new Map(offers.map((o) => [o.id, o]));

  const addTokens = (id, tokens) => {
    for (const t of tokens) {
      if (!index.has(t)) index.set(t, new Set());
      index.get(t).add(id);
    }
  };
  const dropTokens = (id) => {
    for (const s of index.values()) s.delete(id);
  };
  const live = () => [...products.values()].filter((p) => p.status !== 'merged');

  return {
    _products: products,
    _sightings: sightings,
    _offers: offerById,

    // --- Phase 2 reads (blocking + candidates) --------------------------------
    async productCount() {
      return live().length;
    },
    async tokenFrequencies(tokens) {
      const m = new Map();
      for (const t of tokens) {
        const s = index.get(t);
        if (s?.size) m.set(t, s.size);
      }
      return m;
    },
    async candidateIds(tokens) {
      const ids = new Set();
      for (const t of tokens) for (const id of index.get(t) || []) ids.add(id);
      return [...ids];
    },
    async getProducts(ids) {
      return ids.map((id) => products.get(id)).filter(Boolean).map((p) => ({ ...p }));
    },
    async findIncumbentProductId({ store, region, searchText, excludeOfferId }) {
      for (const o of offerById.values()) {
        if (o.store !== store || o.region !== region) continue;
        if (o.search_text !== searchText || o.id === excludeOfferId) continue;
        const s = sightings.get(o.id);
        if (s) return s.product_id;
      }
      return null;
    },
    async getSighting(offerId) {
      return sightings.get(offerId) || null;
    },
    async getSightingsForIds(ids) {
      const m = new Map();
      for (const id of ids) {
        const s = sightings.get(id);
        if (s) m.set(id, { offer_id: id, product_id: s.product_id, match_band: s.match_band });
      }
      return m;
    },

    // --- §8 aggregates --------------------------------------------------------
    async stats() {
      const all = [...products.values()];
      const bands = {};
      const byWeek = new Map();
      for (const s of sightings.values()) {
        bands[s.match_band] = (bands[s.match_band] || 0) + 1;
        const w = byWeek.get(s.week) || { week: s.week, created: 0, sightings: 0 };
        w.sightings += 1;
        if (s.match_band === 'created') w.created += 1;
        byWeek.set(s.week, w);
      }
      return {
        products: {
          active: all.filter((p) => p.status === 'active').length,
          dormant: all.filter((p) => p.status === 'dormant').length,
          merged: all.filter((p) => p.status === 'merged').length,
          flagged: all.filter((p) => p.review_flag != null).length,
          assortments: all.filter((p) => p.kind === 'assortment').length,
        },
        bands,
        weekly: [...byWeek.values()].sort((a, z) => z.week.localeCompare(a.week)).slice(0, 12),
      };
    },

    // Ops Registry Inspector twins (parity with registryStore.js).
    async sightingsCount() {
      return sightings.size;
    },
    async searchProducts({ q = '', limit = 30 } = {}) {
      const term = String(q || '').trim().toLowerCase();
      if (!term) return [];
      const has = (v) => String(v || '').toLowerCase().includes(term);
      return live()
        .filter(
          (p) =>
            has(p.id) || has(p.display_name) || has(p.display_name_ar) ||
            has(p.brand_text) || has(p.brand_slug),
        )
        .sort((a, z) => String(z.last_seen).localeCompare(String(a.last_seen)))
        .slice(0, limit)
        .map((p) => ({ ...p }));
    },

    // --- Phase 3 writes -------------------------------------------------------
    async insertSighting(row) {
      if (sightings.has(row.offer_id)) return { inserted: false };
      sightings.set(row.offer_id, { ...row });
      return { inserted: true };
    },
    async createProduct(row, tokens) {
      products.set(row.id, { ...row });
      addTokens(row.id, tokens);
    },
    async updateProduct(id, fields, tokens) {
      const p = products.get(id);
      if (!p) return;
      Object.assign(p, fields);
      if (tokens) {
        dropTokens(id);
        addTokens(id, tokens);
      }
    },

    // --- §5.1 dormancy --------------------------------------------------------
    async sweepDormancy(cutoff) {
      let n = 0;
      for (const p of products.values()) {
        if (p.status === 'active' && p.last_seen < cutoff) {
          p.status = 'dormant';
          n += 1;
        }
      }
      return n;
    },

    // --- §5.4 consolidation ---------------------------------------------------
    // Product pairs sharing >= minShared tokens whose commonness is under the
    // ceiling (same distinctiveness idea as §4.1 blocking), both non-merged.
    async consolidationPairs({ commonCeiling, minShared = 2, limit = 200 } = {}) {
      const shared = new Map(); // "a|b" -> count (a < b)
      for (const [token, ids] of index.entries()) {
        if (ids.size > commonCeiling) continue;
        const arr = [...ids].filter((id) => {
          const p = products.get(id);
          return p && p.status !== 'merged';
        });
        for (let i = 0; i < arr.length; i += 1) {
          for (let j = i + 1; j < arr.length; j += 1) {
            const [a, b] = arr[i] < arr[j] ? [arr[i], arr[j]] : [arr[j], arr[i]];
            const key = `${a}|${b}`;
            shared.set(key, (shared.get(key) || 0) + 1);
          }
        }
      }
      return [...shared.entries()]
        .filter(([, n]) => n >= minShared)
        .sort((x, y) => y[1] - x[1])
        .slice(0, limit)
        .map(([key, n]) => {
          const [aId, bId] = key.split('|');
          return { aId, bId, shared: n };
        });
    },

    // Tombstone the loser (§5.1 merged; §5.4): status + merged_into, index rows
    // dropped, and every OLD tombstone pointing at the loser re-pointed to the
    // survivor so chains stay single-hop. The survivor's own learned delta goes
    // through updateProduct (separate call — same as D1).
    async tombstoneProduct(loserId, survivorId) {
      const loser = products.get(loserId);
      if (!loser) return;
      loser.status = 'merged';
      loser.merged_into = survivorId;
      dropTokens(loserId);
      for (const p of products.values()) {
        if (p.status === 'merged' && p.merged_into === loserId) p.merged_into = survivorId;
      }
    },

    // --- crash containment (apply.js: sighting insert then product create) ----
    async listDanglingSightings(limit = 100) {
      const out = [];
      for (const s of sightings.values()) {
        if (!products.has(s.product_id)) out.push(s.offer_id);
        if (out.length >= limit) break;
      }
      return out;
    },
    async deleteSightings(offerIds) {
      let n = 0;
      for (const id of offerIds) if (sightings.delete(id)) n += 1;
      return n;
    },

    // --- consumer reads (§7) --------------------------------------------------
    // Sightings of a product set, joined to their offer rows (link/validity)
    // where the offer still exists — pruned offers leave those fields null,
    // exactly like the D1 LEFT JOIN.
    async sightingsForProducts(ids) {
      const want = new Set(ids);
      const out = [];
      for (const s of sightings.values()) {
        if (!want.has(s.product_id)) continue;
        const o = offerById.get(s.offer_id) || null;
        out.push({
          ...s,
          o_source_url: o?.source_url ?? null,
          o_image_url: o?.image_url ?? null,
          o_valid_to: o?.valid_to ?? null,
          o_currency: o?.currency ?? null,
        });
      }
      return out;
    },

    // The tombstones pointing at these survivors: loserId -> survivorId.
    async mergedLoserIds(survivorIds) {
      const want = new Set(survivorIds);
      const map = new Map();
      for (const p of products.values()) {
        if (p.status === 'merged' && want.has(p.merged_into)) map.set(p.id, p.merged_into);
      }
      return map;
    },

    // Best CURRENT price for one product (§7 product watches): cheapest
    // sighting whose offer is still valid today, including sightings that
    // belong to products merged INTO this one.
    async bestCurrentForProduct(productId, today) {
      const family = new Set([productId]);
      for (const p of products.values()) {
        if (p.status === 'merged' && p.merged_into === productId) family.add(p.id);
      }
      let best = null;
      for (const s of sightings.values()) {
        if (!family.has(s.product_id)) continue;
        const o = offerById.get(s.offer_id);
        if (!o || !o.valid_to || o.valid_to < today) continue;
        if (!best || o.price < best.price) {
          best = {
            price: o.price,
            currency: o.currency || 'SAR',
            store: s.store,
            link: o.source_url || null,
            offerId: s.offer_id,
            week: s.week,
          };
        }
      }
      return best;
    },

    // --- review surfaces (§5.4 split path, §6) --------------------------------
    async listFlagged(limit = 50) {
      return [...products.values()]
        .filter((p) => p.review_flag != null)
        .slice(0, limit)
        .map((p) => ({ ...p }));
    },
    async listReviewSightings(limit = 50) {
      const out = [];
      for (const s of sightings.values()) {
        if (s.match_band !== 'review') continue;
        const o = offerById.get(s.offer_id) || null;
        const p = products.get(s.product_id) || null;
        out.push({
          ...s,
          o_image_url: o?.image_url ?? null,
          o_source_url: o?.source_url ?? null,
          o_search_text: o?.search_text ?? null,
          p_display_name: p?.display_name ?? null,
          p_display_name_ar: p?.display_name_ar ?? null,
        });
        if (out.length >= limit) break;
      }
      return out;
    },
    async reassignSighting(offerId, toProductId) {
      const s = sightings.get(offerId);
      if (!s || !products.has(toProductId)) return false;
      s.product_id = toProductId;
      s.match_band = 'review'; // human-assigned: attached, never teaching (§3)
      return true;
    },
    async clearFlag(productId) {
      const p = products.get(productId);
      if (!p) return false;
      p.review_flag = null;
      return true;
    },
  };
}
