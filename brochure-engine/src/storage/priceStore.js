// storage/priceStore.js — the Price History store behind a narrow interface,
// backed by D1 (the SAME database as the brochure MetadataStore — Price History
// is a feature of the Brochure Engine, not a separate service).
//
// Interface (deliberately tiny — a personal tool, kept simple):
//   record(point)        -> Promise<{ status: 'new' | 'deduped' }>
//   getHistory(product)  -> Promise<row[]>   (all points, newest edition first)
//   getLowest(product)   -> Promise<row|null>(lowest price; ties keep the earliest)
//   listProducts()       -> Promise<string[]>(distinct tracked products held)
//
// A point is anchored to a brochure edition, so the ux_price_point unique index
// (product, store, edition) makes weekly capture idempotent: a re-fire in the
// same brochure week inserts nothing.

export function createD1PriceStore(db) {
  return {
    async record(point) {
      // INSERT OR IGNORE: any unique-constraint hit (same product+store+edition)
      // is a no-op, so meta.changes tells us new (1) vs deduped (0).
      const res = await db
        .prepare(
          `INSERT OR IGNORE INTO price_points
             (id, product, store, region, edition, price, currency, name, link, observed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          point.id, point.product, point.store, point.region, point.edition,
          point.price, point.currency, point.name, point.link, point.observedAt,
        )
        .run();
      const changed = res?.meta?.changes ?? 0;
      return { status: changed > 0 ? 'new' : 'deduped' };
    },

    async getHistory(product) {
      const { results } = await db
        .prepare('SELECT * FROM price_points WHERE product = ? ORDER BY edition DESC, store ASC')
        .bind(product)
        .all();
      return results || [];
    },

    async getLowest(product) {
      // Lowest price ever seen; on ties keep the EARLIEST occurrence (the first
      // time/edition it hit that low) — that is the "when it occurred".
      return (
        (await db
          .prepare(
            'SELECT * FROM price_points WHERE product = ? ORDER BY price ASC, observed_at ASC LIMIT 1',
          )
          .bind(product)
          .first()) || null
      );
    },

    async listProducts() {
      const { results } = await db
        .prepare('SELECT DISTINCT product FROM price_points ORDER BY product')
        .all();
      return (results || []).map((r) => r.product);
    },
  };
}
