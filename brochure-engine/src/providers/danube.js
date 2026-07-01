// providers/danube.js — Danube brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). Danube has an official Spree backend (used by
// the search connector) but no clean official web PDF brochure yet (Discovery
// §10.B: "aggregator now; later Danube session"), so M2 uses the aggregator
// (§7.2). A future StoreSessionCollector (M3) may reuse the search session.
// Danube leaflets are national, so Central/Riyadh uses the default selection.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { offersInMeAdapter } from '../collectors/adapters/offersinme.js';

const collector = createAggregatorCollector({ name: 'aggregator', adapter: offersInMeAdapter });

export const danubeProvider = {
  id: 'danube',
  label: 'Danube',
  regions: {
    central: { store: 'danube-offers' },
  },
  strategies: [collector],
};
