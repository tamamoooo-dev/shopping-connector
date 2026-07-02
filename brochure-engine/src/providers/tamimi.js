// providers/tamimi.js — Tamimi Markets brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). Tamimi has an official ZopSmart backend (used by
// the search connector) but no clean official web PDF brochure yet (Discovery
// §10.B: "aggregator now; later Tamimi session"), so it uses the aggregator
// (§7.2), now D4D. D4D scopes offers by city, so Central/Riyadh is the URL city.
//
// Best-first: D4D current flyer (images) -> else Tamimi's official shop.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { d4dAdapter } from '../collectors/adapters/d4d.js';
import { createOfficialLinkCollector } from '../collectors/officialLink.js';

const d4d = createAggregatorCollector({ name: 'd4d', adapter: d4dAdapter });
const official = createOfficialLinkCollector();

export const tamimiProvider = {
  id: 'tamimi',
  label: 'Tamimi Markets',
  regions: {
    central: {
      store: 'tamimi-market-68',
      city: 'riyadh',
      officialUrl: 'https://shop.tamimimarkets.com/',
    },
  },
  strategies: [d4d, official],
};
