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
//   count(profileId?)                -> MONITORED watches (active AND anchored)
//                                       — the per-profile COMPUTE cap gate
//   countRows(profileId?)            -> every row owned — the STORAGE bound
//   countUnanchored(profileId?)      -> active watches awaiting an anchor
//   countActiveTotal()               -> monitored watches across ALL profiles
//   adoptOrphans(profileId)          -> number of NULL-profile watches claimed
//   updateState(id, fields)          -> void      (checked_at / last_* / is_below)
//   rebindProduct(id, registryProductId) -> boolean  (the ANCHOR only, and only
//                                       when a registry merge relocated it)
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
    // THE ANCHOR: the registry product this watch is about. Resolved once, in
    // the foreground, at creation; only a registry MERGE ever moves it.
    registry_product_id: w.registryProductId ?? null,
    anchor_state: w.anchorState ?? null,
    source_snapshot: w.sourceSnapshot ?? null,
    anchor_provenance: w.anchorProvenance ?? null,
    anchor_confidence: w.anchorConfidence ?? null,
    anchor_margin: w.anchorMargin ?? null,
    anchor_policy_version: w.anchorPolicyVersion ?? null,
    candidate_snapshot: w.candidateSnapshot ?? null,
    resolution_attempts: w.resolutionAttempts ?? 0,
    last_resolution_attempt_at: w.lastResolutionAttemptAt ?? null,
    identity_resolution_reason: w.identityResolutionReason ?? null,
    monitoring_health: w.monitoringHealth ?? null,
    monitoring_health_reason: w.monitoringHealthReason ?? null,
    scope: w.scope ?? null,
    spec: w.spec ?? null,
    link: w.link ?? null,
    image: w.image ?? null,
    target_price: w.targetPrice,
    currency: w.currency || 'SAR',
    size_unit: w.sizeUnit ?? null,
    size_total: w.sizeTotal ?? null,
    size_source: w.sizeSource ?? null,
    match_brand: w.matchBrand === false ? 0 : 1,
    match_size: w.matchSize === false ? 0 : 1,
    match_variant: w.matchVariant === false ? 0 : 1,
    target_unit_price: w.targetUnitPrice ?? null,
    unit_label: w.unitLabel ?? null,
    close_threshold: w.closeThreshold ?? null,
    active: w.active === false ? 0 : 1,
    is_below: w.isBelow ? 1 : 0,
    is_close: w.isClose ? 1 : 0,
    created_at: w.createdAt,
    checked_at: w.checkedAt ?? null,
    last_price: w.lastPrice ?? null,
    last_purchase_price: w.lastPurchasePrice ?? null,
    last_unit_label: w.lastUnitLabel ?? null,
    last_store: w.lastStore ?? null,
    last_source: w.lastSource ?? null,
    last_name: w.lastName ?? null,
    last_link: w.lastLink ?? null,
    last_resolution: w.lastResolution ?? null,
    last_resolution_reason: w.lastResolutionReason ?? null,
    resolved_at: w.resolvedAt ?? null,
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
    registryProductId: r.registry_product_id ?? null,
    anchorState: r.anchor_state ?? null,
    sourceSnapshot: r.source_snapshot ?? null,
    anchorProvenance: r.anchor_provenance ?? null,
    anchorConfidence: r.anchor_confidence ?? null,
    anchorMargin: r.anchor_margin ?? null,
    anchorPolicyVersion: r.anchor_policy_version ?? null,
    candidateSnapshot: r.candidate_snapshot ?? null,
    resolutionAttempts: r.resolution_attempts ?? 0,
    lastResolutionAttemptAt: r.last_resolution_attempt_at ?? null,
    identityResolutionReason: r.identity_resolution_reason ?? null,
    monitoringHealth: r.monitoring_health ?? null,
    monitoringHealthReason: r.monitoring_health_reason ?? null,
    // Legacy rows predate `scope`; their old `kind` says the same thing.
    scope: r.scope ?? (r.kind === 'product' ? 'store' : 'market'),
    link: r.link,
    image: r.image,
    targetPrice: r.target_price,
    currency: r.currency,
    sizeUnit: r.size_unit,
    sizeTotal: r.size_total,
    sizeSource: r.size_source ?? null,
    // The v2 identity columns (identity_query/_family/_type, brand_id,
    // variant_key) are still READ for the one-time legacy backfill, which maps
    // them to a spec (identity/spec.js specFromLegacyWatch). New rows leave
    // them NULL; nothing else consults them.
    identityFamily: r.identity_family ?? null,
    identityType: r.identity_type ?? null,
    brandId: r.brand_id ?? null,
    variantKey: r.variant_key ?? null,
    spec: r.spec ?? null,
    matchBrand: r.match_brand == null ? true : !!r.match_brand,
    matchSize: r.match_size == null ? true : !!r.match_size,
    matchVariant: r.match_variant == null ? true : !!r.match_variant,
    targetUnitPrice: r.target_unit_price ?? null,
    unitLabel: r.unit_label ?? null,
    closeThreshold: r.close_threshold ?? null,
    active: !!r.active,
    isBelow: !!r.is_below,
    isClose: !!r.is_close,
    createdAt: r.created_at,
    checkedAt: r.checked_at,
    lastPrice: r.last_price,
    lastPurchasePrice: r.last_purchase_price ?? null,
    lastUnitLabel: r.last_unit_label ?? null,
    lastStore: r.last_store,
    lastSource: r.last_source,
    lastName: r.last_name,
    lastLink: r.last_link,
    // Why the last check ended the way it did. Always present after a check;
    // NULL only on a watch that has never been checked.
    lastResolution: r.last_resolution ?? null,
    lastResolutionReason: r.last_resolution_reason ?? null,
    resolvedAt: r.resolved_at ?? null,
  };
}

export function rowToAlert(r) {
  if (!r) return null;
  return {
    id: r.id,
    watchId: r.watch_id,
    price: r.price,
    purchasePrice: r.purchase_price ?? r.price,
    targetPrice: r.target_price,
    unitLabel: r.unit_label ?? null,
    alertType: r.alert_type || 'target',
    currency: r.currency,
    store: r.store,
    source: r.source,
    name: r.name,
    link: r.link,
    observedAt: r.observed_at,
    seen: !!r.seen,
  };
}

// Whitelisted state columns updateState may touch. Everything else is fixed at
// creation: a watch's target never changes server-side, and its ANCHOR moves
// only through rebindProduct (a registry merge) or setAnchor (the backfill, or
// the user confirming) — three different writers for three different things.
const STATE_COLS = {
  isBelow: 'is_below',
  isClose: 'is_close',
  checkedAt: 'checked_at',
  lastPrice: 'last_price',
  lastPurchasePrice: 'last_purchase_price',
  lastUnitLabel: 'last_unit_label',
  lastStore: 'last_store',
  lastSource: 'last_source',
  lastName: 'last_name',
  lastLink: 'last_link',
  // The resolution outcome. Written on EVERY check, including the ones that
  // found nothing — a check that resolves nothing must leave a record, or a
  // dead watch is indistinguishable from a healthy one waiting for a discount.
  lastResolution: 'last_resolution',
  lastResolutionReason: 'last_resolution_reason',
  resolvedAt: 'resolved_at',
  monitoringHealth: 'monitoring_health',
  monitoringHealthReason: 'monitoring_health_reason',
};

export function createD1WatchStore(db) {
  return {
    async create(watch) {
      const r = watchToRow(watch);
      await db
        .prepare(
          // Only columns that exist in the LIVE schema. The v2 identity columns
          // (identity_query/_family/_type, brand_id, variant_key) are left NULL
          // on new rows: identity now lives in registry_product_id and the
          // resolver owns it. They are not dropped — additive and reversible.
          `INSERT INTO watches
             (id, profile_id, kind, label, query, provider, product_id,
              registry_product_id, scope, spec, link, image,
              target_price, currency, size_unit, size_total, size_source,
              match_brand, match_size, match_variant, target_unit_price, unit_label,
              close_threshold, active, is_below, is_close, created_at, checked_at,
              last_price, last_purchase_price, last_unit_label, last_store, last_source,
              last_name, last_link, anchor_state, source_snapshot, anchor_provenance,
              anchor_confidence, anchor_margin, anchor_policy_version, candidate_snapshot,
              resolution_attempts, last_resolution_attempt_at, identity_resolution_reason,
              monitoring_health, monitoring_health_reason, last_resolution,
              last_resolution_reason, resolved_at)
           VALUES (${Array(50).fill('?').join(',')})`,
        )
        .bind(
          r.id, r.profile_id, r.kind, r.label, r.query, r.provider, r.product_id,
          r.registry_product_id, r.scope, r.spec, r.link,
          r.image, r.target_price, r.currency, r.size_unit, r.size_total,
          r.size_source, r.match_brand, r.match_size, r.match_variant,
          r.target_unit_price, r.unit_label, r.close_threshold, r.active, r.is_below,
          r.is_close, r.created_at, r.checked_at, r.last_price, r.last_purchase_price,
          r.last_unit_label, r.last_store, r.last_source, r.last_name, r.last_link,
          r.anchor_state, r.source_snapshot, r.anchor_provenance, r.anchor_confidence,
          r.anchor_margin, r.anchor_policy_version, r.candidate_snapshot,
          r.resolution_attempts, r.last_resolution_attempt_at, r.identity_resolution_reason,
          r.monitoring_health, r.monitoring_health_reason, r.last_resolution,
          r.last_resolution_reason, r.resolved_at,
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

    // MONITORED watches — active AND anchored. The cap this feeds is a COMPUTE
    // budget (it bounds the daily cron's fan-out), and an unanchored watch is
    // skipped by the check, so it consumes nothing the cap protects and must
    // not occupy a slot. Storage is bounded separately by countRows.
    async count(profileId = null) {
      const where = `active = 1 AND (
        anchor_state IN ('anchored_registry','anchored_source','anchored_spec')
        OR (anchor_state IS NULL AND (registry_product_id IS NOT NULL OR spec IS NOT NULL))
      )`;
      const row = profileId
        ? await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE ' + where + ' AND profile_id = ?').bind(profileId).first()
        : await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE ' + where).first();
      return row?.n || 0;
    },

    // Every row the profile owns, anchored or not — the STORAGE bound. Without
    // it, watches awaiting confirmation could accumulate without limit.
    async countRows(profileId = null) {
      const row = profileId
        ? await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE profile_id = ?').bind(profileId).first()
        : await db.prepare('SELECT COUNT(*) AS n FROM watches').first();
      return row?.n || 0;
    },

    // Watches awaiting the user's answer — surfaced in the cap error so the
    // pressure arrives with an explanation, not just a refusal.
    async countUnanchored(profileId = null) {
      const where = `active = 1 AND NOT (
        anchor_state IN ('anchored_registry','anchored_source','anchored_spec')
        OR (anchor_state IS NULL AND (registry_product_id IS NOT NULL OR spec IS NOT NULL))
      )`;
      const row = profileId
        ? await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE ' + where + ' AND profile_id = ?').bind(profileId).first()
        : await db.prepare('SELECT COUNT(*) AS n FROM watches WHERE ' + where).first();
      return row?.n || 0;
    },

    // The global cron-budget backstop: monitored watches across all profiles.
    async countActiveTotal() {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM watches WHERE active = 1 AND (
          anchor_state IN ('anchored_registry','anchored_source','anchored_spec')
          OR (anchor_state IS NULL AND (registry_product_id IS NOT NULL OR spec IS NOT NULL))
        )`)
        .first();
      return row?.n || 0;
    },

    async identityStats(profileId = null) {
      const query = profileId
        ? db.prepare(
            `SELECT anchor_state, candidate_snapshot, anchor_provenance
               FROM watches WHERE active = 1 AND profile_id = ?`,
          ).bind(profileId)
        : db.prepare(
            `SELECT anchor_state, candidate_snapshot, anchor_provenance
               FROM watches WHERE active = 1`,
          );
      const { results } = await query.all();
      const states = {};
      const provenance = {};
      let zeroCandidateConfirmations = 0;
      for (const row of results || []) {
        const state = row.anchor_state || 'legacy';
        states[state] = (states[state] || 0) + 1;
        try {
          const kind = JSON.parse(row.anchor_provenance || '{}').kind;
          if (kind) provenance[kind] = (provenance[kind] || 0) + 1;
        } catch { /* diagnostic only */ }
        if (state === 'confirmation_required') {
          try {
            const candidates = JSON.parse(row.candidate_snapshot || '{}').candidates;
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
          binds.push(key === 'isBelow' || key === 'isClose' ? (v ? 1 : 0) : v ?? null);
        }
      }
      if (!sets.length) return;
      binds.push(id);
      await db.prepare(`UPDATE watches SET ${sets.join(', ')} WHERE id = ?`).bind(...binds).run();
    },

    async updateSettings(id, profileId, fields) {
      const cols = {
        matchBrand: 'match_brand',
        matchSize: 'match_size',
        matchVariant: 'match_variant',
        closeThreshold: 'close_threshold',
        targetUnitPrice: 'target_unit_price',
        unitLabel: 'unit_label',
      };
      const sets = [];
      const binds = [];
      for (const [key, col] of Object.entries(cols)) {
        if (!(key in fields)) continue;
        sets.push(`${col} = ?`);
        const value = fields[key];
        binds.push(key.startsWith('match') ? (value ? 1 : 0) : value ?? null);
      }
      if (!sets.length) return false;
      binds.push(id, profileId);
      const res = await db
        .prepare(`UPDATE watches SET ${sets.join(', ')}, is_below = 0, is_close = 0 WHERE id = ? AND profile_id = ?`)
        .bind(...binds)
        .run();
      return (res?.meta?.changes || 0) > 0;
    },

    // Re-point the anchor after the REGISTRY relocated it (a merge makes the
    // loser a tombstone forwarding to the survivor). Deliberately separate from
    // updateState: this is the one column that says WHAT the watch is about,
    // and only the registry — never a price check — may move it.
    async rebindProduct(id, registryProductId) {
      if (!registryProductId) return false;
      const res = await db
        .prepare('UPDATE watches SET registry_product_id = ? WHERE id = ?')
        .bind(registryProductId, id)
        .run();
      return (res?.meta?.changes || 0) > 0;
    },

    async rebindSource(id, {
      provider, productId, snapshot, provenance, confidence, margin,
    } = {}) {
      if (!provider || !productId || !snapshot) return false;
      const res = await db
        .prepare(
          `UPDATE watches
              SET provider = ?, product_id = ?, source_snapshot = ?,
                  anchor_provenance = ?, anchor_confidence = ?, anchor_margin = ?,
                  anchor_state = 'anchored_source'
            WHERE id = ? AND anchor_state = 'anchored_source'`,
        )
        .bind(
          provider, productId, JSON.stringify(snapshot),
          JSON.stringify({
            kind: provenance || 'verified-source-rebind',
            provider,
            productId,
          }),
          confidence ?? null, margin ?? null, id,
        )
        .run();
      return (res?.meta?.changes || 0) > 0;
    },

    // Set (or clear) a watch's ANCHOR and the state that explains it. The only
    // writer of registry_product_id + spec together, used by the one-time
    // legacy backfill and by the user's confirmation. Deliberately separate
    // from updateState: this changes what the watch is ABOUT, not how its last
    // check went.
    async setAnchor(id, anchor = {}) {
      const res = await db
        .prepare(
          `UPDATE watches
              SET registry_product_id = ?, spec = ?, provider = ?, product_id = ?,
                  anchor_state = ?, source_snapshot = ?, anchor_provenance = ?,
                  anchor_confidence = ?, anchor_margin = ?, anchor_policy_version = ?,
                  candidate_snapshot = ?, resolution_attempts = ?,
                  last_resolution_attempt_at = ?, identity_resolution_reason = ?,
                  monitoring_health = ?, monitoring_health_reason = ?,
                  last_resolution = ?, last_resolution_reason = ?
            WHERE id = ?`,
        )
        .bind(
          anchor.registryProductId ?? null, anchor.spec ?? null,
          anchor.provider ?? null, anchor.productId ?? null,
          anchor.anchorState ?? null, anchor.sourceSnapshot ?? null,
          anchor.anchorProvenance ?? null, anchor.anchorConfidence ?? null,
          anchor.anchorMargin ?? null, anchor.anchorPolicyVersion ?? null,
          anchor.candidateSnapshot ?? null, anchor.resolutionAttempts ?? 0,
          anchor.lastResolutionAttemptAt ?? null, anchor.identityResolutionReason ?? null,
          anchor.monitoringHealth ?? null, anchor.monitoringHealthReason ?? null,
          anchor.lastResolution ?? null, anchor.lastResolutionReason ?? null, id,
        )
        .run();
      return (res?.meta?.changes || 0) > 0;
    },

    async insertAlert(alert) {
      await db
        .prepare(
          `INSERT INTO alerts
             (id, watch_id, price, purchase_price, target_price, unit_label, alert_type,
              currency, store, source, name, link, observed_at, seen)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
        )
        .bind(
          alert.id, alert.watchId, alert.price, alert.purchasePrice ?? alert.price,
          alert.targetPrice, alert.unitLabel ?? null, alert.alertType || 'target',
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
