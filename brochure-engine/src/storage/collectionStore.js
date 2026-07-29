// Durable index of store/region brochure collections that need another batch.
// Detailed page progress stays in the object store; D1 only provides the small
// queryable pending queue used by the resume cron.

export function createD1CollectionStore(db) {
  return {
    async markPending(store, region, detail = {}) {
      await db
        .prepare(
          `INSERT INTO brochure_collection_jobs
             (store, region, status, advertised_flyers, advertised_pages,
              collected_pages, last_error, updated_at, completed_at)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(store, region) DO UPDATE SET
             status='pending',
             advertised_flyers=excluded.advertised_flyers,
             advertised_pages=excluded.advertised_pages,
             collected_pages=excluded.collected_pages,
             last_error=excluded.last_error,
             updated_at=excluded.updated_at,
             completed_at=NULL`,
        )
        .bind(
          store,
          region,
          detail.advertisedFlyers ?? null,
          detail.advertisedPages ?? null,
          detail.collectedPages ?? null,
          detail.error ?? null,
          new Date().toISOString(),
        )
        .run();
    },

    async markComplete(store, region, detail = {}) {
      const now = new Date().toISOString();
      await db
        .prepare(
          `INSERT INTO brochure_collection_jobs
             (store, region, status, advertised_flyers, advertised_pages,
              collected_pages, last_error, updated_at, completed_at)
           VALUES (?, ?, 'complete', ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(store, region) DO UPDATE SET
             status='complete',
             advertised_flyers=excluded.advertised_flyers,
             advertised_pages=excluded.advertised_pages,
             collected_pages=excluded.collected_pages,
             last_error=NULL,
             updated_at=excluded.updated_at,
             completed_at=excluded.completed_at`,
        )
        .bind(
          store,
          region,
          detail.advertisedFlyers ?? null,
          detail.advertisedPages ?? null,
          detail.collectedPages ?? null,
          now,
          now,
        )
        .run();
    },

    async listPending(limit = 20) {
      const { results } = await db
        .prepare(
          `SELECT store, region, advertised_flyers, advertised_pages,
                  collected_pages, last_error, updated_at
             FROM brochure_collection_jobs
            WHERE status = 'pending'
            ORDER BY updated_at ASC
            LIMIT ?`,
        )
        .bind(Math.max(1, Math.min(Number(limit) || 20, 24)))
        .all();
      return results || [];
    },
  };
}
