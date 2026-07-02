// providers/manuel.js — Manuel Market brochure provider (aggregator-only).
//
// PURE CONFIG (project rule 2). Manuel has NO official brochure/offers site
// (Discovery §10.B), so the aggregator is its only channel (§7.2), now D4D. D4D
// carries Manuel's Riyadh store, and scopes offers by the city in the URL.
//
// Because Manuel has no official offers page, it gets NO officialLink fallback:
// if D4D is ever expired/unavailable the store simply has no current brochure
// (the same behaviour as before this migration). We do NOT fall back to another
// aggregator, per the Brochure Source Migration rule.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { d4dAdapter } from '../collectors/adapters/d4d.js';

const d4d = createAggregatorCollector({ name: 'd4d', adapter: d4dAdapter });

export const manuelProvider = {
  id: 'manuel',
  label: 'Manuel Market',
  regions: {
    central: { store: 'manuel-market-223', city: 'riyadh' },
  },
  strategies: [d4d],
};
