// providers/nesto.js — Nesto Hypermarket brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). Nesto has an official site but heavy aggregator
// coverage and a KSA footprint that skews Eastern/Western (Discovery §10.B), so
// M2 uses the aggregator (§7.2). Nesto mixes national leaflets with Dammam
// (Eastern) ones; the default `exclude` (other-KSA-region blocklist) drops the
// Dammam/Eastern flyers, leaving the national leaflets valid for Central/Riyadh.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { offersInMeAdapter } from '../collectors/adapters/offersinme.js';

const collector = createAggregatorCollector({ name: 'aggregator', adapter: offersInMeAdapter });

export const nestoProvider = {
  id: 'nesto',
  label: 'Nesto Hypermarket',
  regions: {
    central: { store: 'nesto-hypermarket-offers' },
  },
  strategies: [collector],
};
