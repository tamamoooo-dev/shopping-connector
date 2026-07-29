// Read-only production consistency audit for offer -> local brochure -> page.
//
// Usage (from brochure-engine/):
//   node audit-navigation.mjs [YYYY-MM-DD]
//
// The D1 query reads linkage metadata. Page validity is then checked against
// the engine-served local meta.json and hotspots snapshots; D4D is never read.

import { execFileSync, execSync } from 'node:child_process';

const today = process.argv[2] || new Date().toISOString().slice(0, 10);
const engine = 'https://brochure-engine.tamamoooo.workers.dev';

function d1(sql) {
  const opts = { cwd: import.meta.dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  const stdout = process.platform === 'win32'
    ? execSync(
        `npx wrangler d1 execute brochure-engine --remote --json --command="${sql.replace(/\s+/g, ' ').trim()}"`,
        opts,
      )
    : execFileSync(
        'npx',
        ['wrangler', 'd1', 'execute', 'brochure-engine', '--remote', '--json', '--command', sql],
        opts,
      );
  const parsed = JSON.parse(stdout);
  if (!parsed[0]?.success) throw new Error('D1 audit query failed');
  return parsed[0].results || [];
}

const offerColumns = new Set(d1('PRAGMA table_info(offers)').map((r) => r.name));
const exactNavigationSchema =
  offerColumns.has('brochure_id') && offerColumns.has('page_index');
const navigationProjection = exactNavigationSchema
  ? 'o.brochure_id AS stored_brochure_id, o.page_index AS stored_page_index'
  : 'NULL AS stored_brochure_id, NULL AS stored_page_index';
const brochureJoin = exactNavigationSchema
  ? 'b.id=o.brochure_id'
  : 'b.store=o.store AND b.region=o.region AND b.edition=o.edition';
const all = d1(`
  SELECT o.id, o.store, o.region, o.offer_id, o.flyer_ref, o.page_ref, o.edition,
         ${navigationProjection},
         o.name, o.name_ar, o.price, o.source_url,
         b.id AS brochure_id, b.storage_key, b.source_type, b.pruned_at
    FROM offers o
    LEFT JOIN brochures b ON ${brochureJoin}
   WHERE o.valid_to >= '${today.replaceAll("'", "''")}'
`);
const totalAll = d1('SELECT COUNT(*) AS n FROM offers')[0]?.n || 0;

const currentBrochures = d1(`
  SELECT id AS brochure_id, store, region, storage_key, source_type,
         source_url, pruned_at
    FROM brochures
   WHERE is_current=1 AND pruned_at IS NULL
`);
const brochureRows = new Map();
for (const row of currentBrochures) {
  brochureRows.set(row.brochure_id, row);
}

async function localSnapshot(row) {
  if (row.source_type !== 'images' || row.pruned_at || !row.storage_key) {
    return { metaOk: false, pageIds: new Set(), offerIds: new Set(), reason: 'not_local_images' };
  }
  const metaUrl = `${engine}/asset/brochures/${row.storage_key}/meta.json`;
  const hotUrl = `${engine}/brochures/hotspots?id=${encodeURIComponent(row.brochure_id)}`;
  const [metaRes, hotRes] = await Promise.all([fetch(metaUrl), fetch(hotUrl)]);
  const meta = metaRes.ok ? await metaRes.json().catch(() => null) : null;
  const hot = hotRes.ok ? await hotRes.json().catch(() => null) : null;
  return {
    metaOk: !!(
      meta &&
      meta.complete === true &&
      Number.isInteger(meta.advertisedPageCount) &&
      Array.isArray(meta.pages) &&
      meta.pages.length === meta.advertisedPageCount &&
      meta.pages.length
    ),
    pageCount: (meta?.pages || []).length,
    pageIndexes: new Set(
      (meta?.pages || []).map((p) => p.index).filter((index) => Number.isInteger(index)),
    ),
    pageIds: new Set((meta?.pages || []).map((p) => String(p.pageId ?? '')).filter(Boolean)),
    offerIds: new Set(
      (hot?.pages || []).flatMap((p) => (p.spots || []).map((s) => String(s.offerId))),
    ),
    pageById: new Map(
      (meta?.pages || [])
        .filter((p) => p.pageId != null && Number.isInteger(p.index))
        .map((p) => [String(p.pageId), p.index]),
    ),
    pageByOffer: new Map(
      (hot?.pages || []).flatMap((p) =>
        (p.spots || [])
          .filter((spot) => spot.offerId != null && Number.isInteger(p.index))
          .map((spot) => [String(spot.offerId), p.index]),
      ),
    ),
    reason: metaRes.ok ? null : `meta_http_${metaRes.status}`,
  };
}

const snapshots = new Map();
const entries = [...brochureRows.entries()];
for (let i = 0; i < entries.length; i += 8) {
  await Promise.all(
    entries.slice(i, i + 8).map(async ([id, row]) => snapshots.set(id, await localSnapshot(row))),
  );
}

function flyerRefFromUrl(url) {
  return (/\/offers\/[^/]+\/(\d+)(?:\/|$)/.exec(String(url || '')) || [])[1] || null;
}

const brochureByFlyer = new Map();
for (const row of currentBrochures) {
  const flyerRef = flyerRefFromUrl(row.source_url);
  if (flyerRef) brochureByFlyer.set(`${row.store}:${row.region}:${flyerRef}`, row);
}

const hasStoredBrochureLink = (r) =>
  exactNavigationSchema ? !!r.stored_brochure_id : !!r.edition;
const missingBrochureId = all.filter((r) => !hasStoredBrochureLink(r));
const missingPageRef = all.filter((r) => !r.page_ref);
const missingPageIndex = exactNavigationSchema
  ? all.filter((r) => !Number.isInteger(r.stored_page_index))
  : [];
const missingBrochure = all.filter((r) => hasStoredBrochureLink(r) && !r.brochure_id);
const missingLocalAssets = all.filter((r) => {
  if (!r.brochure_id) return false;
  const s = snapshots.get(r.brochure_id);
  return !s?.metaOk;
});
const invalidPage = all.filter((r) => {
  if (!r.brochure_id) return false;
  const s = snapshots.get(r.brochure_id);
  if (!s?.metaOk) return false;
  if (exactNavigationSchema) {
    const byPage = s.pageById.get(String(r.page_ref));
    const byOffer = s.pageByOffer.get(String(r.offer_id));
    return (
      !Number.isInteger(r.stored_page_index) ||
      !s.pageIndexes.has(r.stored_page_index) ||
      byPage !== r.stored_page_index ||
      byOffer !== r.stored_page_index
    );
  }
  if (!r.page_ref) return false;
  return !s.pageIds.has(String(r.page_ref)) && !s.offerIds.has(String(r.offer_id));
});
const invalidPageIds = new Set(invalidPage.map((r) => r.id));
const d4dProvenance = all.filter((r) => /(^|\.)d4donline\.com$/i.test(safeHost(r.source_url)));
const d4dOnly = d4dProvenance.filter(
  (r) =>
    !hasStoredBrochureLink(r) ||
    !r.brochure_id ||
    !snapshots.get(r.brochure_id)?.metaOk ||
    invalidPageIds.has(r.id),
);
const validLocalLanding = all.filter(
  (r) =>
    hasStoredBrochureLink(r) &&
    !!r.brochure_id &&
    !!snapshots.get(r.brochure_id)?.metaOk &&
    !invalidPageIds.has(r.id),
);
const unavailable = all.filter((r) => !hasStoredBrochureLink(r));
const unavailableClassification = unavailable.map((offer) => {
  const brochure = brochureByFlyer.get(`${offer.store}:${offer.region}:${offer.flyer_ref}`);
  if (!brochure) return { offer, reason: 'no_current_local_brochure_for_flyer' };
  const snapshot = snapshots.get(brochure.brochure_id);
  if (!snapshot?.metaOk) return { offer, reason: 'local_brochure_incomplete' };
  const pageById = snapshot.pageById.get(String(offer.page_ref));
  const pageByOffer = snapshot.pageByOffer.get(String(offer.offer_id));
  if (Number.isInteger(pageById) && pageById === pageByOffer) {
    return { offer, reason: 'exact_mapping_available_but_not_linked' };
  }
  return { offer, reason: 'exact_page_or_hotspot_mapping_anomaly' };
});
const unavailableCounts = Object.fromEntries(
  [...new Set(unavailableClassification.map((item) => item.reason))]
    .sort()
    .map((reason) => [
      reason,
      unavailableClassification.filter((item) => item.reason === reason).length,
    ]),
);
const unavailableByStore = {};
for (const item of unavailableClassification) {
  const storeCounts = (unavailableByStore[item.offer.store] ||= {});
  storeCounts[item.reason] = (storeCounts[item.reason] || 0) + 1;
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function sample(rows, n = 12) {
  return rows.slice(0, n).map((r) => ({
    id: r.id,
    store: r.store,
    offerId: r.offer_id,
    flyerRef: r.flyer_ref,
    pageRef: r.page_ref,
    storedPageIndex: r.stored_page_index,
    edition: r.edition,
    storedBrochureId: r.stored_brochure_id,
    resolvedBrochureId: r.brochure_id,
    name: r.name || r.name_ar,
    price: r.price,
  }));
}

const chicken = all.filter(
  (r) =>
    r.store === 'hyperpanda' &&
    /chicken[\s\S]*breast|breast[\s\S]*chicken|صدور?\s+دجاج|دجاج[\s\S]*صدور?/i.test(
      `${r.name || ''} ${r.name_ar || ''}`,
    ),
);

const byStore = {};
for (const row of all) {
  const s = (byStore[row.store] ||= { total: 0, missingBrochureId: 0, invalidPage: 0 });
  s.total += 1;
  if (!hasStoredBrochureLink(row)) s.missingBrochureId += 1;
  if (invalidPage.includes(row)) s.invalidPage += 1;
}

console.log(JSON.stringify({
  asOf: today,
  navigationSchema: exactNavigationSchema ? 'exact' : 'legacy-edition-link',
  totalIndexedAllHistory: totalAll,
  totalIndexedCurrent: all.length,
  productsMissingBrochureId: missingBrochureId.length,
  productsMissingSourcePageRef: missingPageRef.length,
  productsMissingStoredPageIndex:
    exactNavigationSchema ? missingPageIndex.length : 'column-not-deployed',
  productsReferencingNonexistentBrochure: missingBrochure.length,
  productsWhoseBrochureAssetsAreMissing: missingLocalAssets.length,
  productsWhoseBrochureExistsButPageMappingIsInvalid: invalidPage.length,
  productsWithD4dProvenanceUrl: d4dProvenance.length,
  productsWithD4dAsOnlyAvailableTarget: d4dOnly.length,
  productsWithValidLocalLanding: validLocalLanding.length,
  unavailableOfferClassification: unavailableCounts,
  unavailableOfferClassificationByStore: unavailableByStore,
  unavailableOfferSamples: Object.fromEntries(
    Object.keys(unavailableCounts).map((reason) => [
      reason,
      sample(
        unavailableClassification
          .filter((item) => item.reason === reason)
          .map((item) => item.offer),
      ),
    ]),
  ),
  brochuresChecked: snapshots.size,
  byStore,
  hyperPandaChickenBreast: sample(chicken, 20),
  samples: {
    missingBrochureId: sample(missingBrochureId),
    missingBrochure: sample(missingBrochure),
    missingLocalAssets: sample(missingLocalAssets),
    invalidPage: sample(invalidPage),
  },
}, null, 2));
