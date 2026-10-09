// offers/servingFloor.js — the corroboration a stored enrichment row must
// clear before any read path may serve its names. A leaf module (no imports)
// so the verification store can share the one value without importing
// enrich.js, which imports the store. enrich.js re-exports it unchanged.
export const CORROBORATION_FLOOR = 0.3;
