// providers/tamimi.js — Tamimi Markets brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). Tamimi has an official ZopSmart backend (used by
// the search connector) but no clean official web PDF brochure yet (Discovery
// §10.B: "aggregator now; later Tamimi session"), so M2 uses the aggregator
// (§7.2). Tamimi leaflets are national, so Central/Riyadh uses the default
// (other-region-excluded) selection.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { offersInMeAdapter } from '../collectors/adapters/offersinme.js';

const collector = createAggregatorCollector({ name: 'aggregator', adapter: offersInMeAdapter });

export const tamimiProvider = {
  id: 'tamimi',
  label: 'Tamimi Markets',
  regions: {
    central: { store: 'tamimi-markets-offers' },
  },
  strategies: [collector],
};
