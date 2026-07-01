// providers/manuel.js — Manuel Market brochure provider (aggregator-only).
//
// PURE CONFIG (project rule 2). Manuel has NO official brochure site (Discovery
// §10.B), so the aggregator is its only channel (§7.2). On OffersInMe, Manuel
// publishes per-city leaflets ("riyadh-…" and "jeddah-…"), so Central/Riyadh is
// selected with an `include` matcher that keeps only the Riyadh leaflets — the
// §5.3 region map, and a good example of why region selection is per-provider.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { offersInMeAdapter } from '../collectors/adapters/offersinme.js';

const collector = createAggregatorCollector({ name: 'aggregator', adapter: offersInMeAdapter });

export const manuelProvider = {
  id: 'manuel',
  label: 'Manuel Market',
  regions: {
    central: { store: 'manuel-market-offers', include: /riyadh/i },
  },
  strategies: [collector],
};
