// providers/lulu.js — LuLu Hypermarket brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). LuLu's official in-store promotions page is
// bot-protected (Discovery §10.B, Akinon 403), so its only reliable brochure
// source is the aggregator (§7.2). All store knowledge lives here; the Core,
// collector, adapter and storage never learn the name "lulu".
//
// LuLu publishes explicitly province-tagged leaflets on OffersInMe
// ("central-province-…", "eastern-province-…"), so Central/Riyadh is selected
// with an `include` matcher — the §5.3 region map in practice.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { offersInMeAdapter } from '../collectors/adapters/offersinme.js';

const collector = createAggregatorCollector({ name: 'aggregator', adapter: offersInMeAdapter });

export const luluProvider = {
  id: 'lulu',
  label: 'LuLu Hypermarket',
  regions: {
    central: { store: 'lulu-hypermarket-offers', include: /central-province/i },
  },
  strategies: [collector], // best-first; aggregator is LuLu's only reliable source
};
