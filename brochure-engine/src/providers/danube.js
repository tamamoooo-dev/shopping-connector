// providers/danube.js — Danube brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). Danube has an official Spree backend (used by
// the search connector) but no clean official web PDF brochure yet (Discovery
// §10.B: "aggregator now; later Danube session"), so it uses the aggregator
// (§7.2), now D4D — which carries a CURRENT Danube Riyadh flyer (a marked
// improvement over the stale Danube data on the retired OffersInMe).
//
// Best-first: D4D current flyer (images) -> else Danube's official site.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { d4dAdapter } from '../collectors/adapters/d4d.js';
import { createOfficialLinkCollector } from '../collectors/officialLink.js';

const d4d = createAggregatorCollector({ name: 'd4d', adapter: d4dAdapter });
const official = createOfficialLinkCollector();

export const danubeProvider = {
  id: 'danube',
  label: 'Danube',
  regions: {
    central: {
      store: 'danube-74',
      city: 'riyadh',
      officialUrl: 'https://www.danube.sa/',
    },
  },
  strategies: [d4d, official],
};
