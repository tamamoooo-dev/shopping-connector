// providers/nesto.js — Nesto Hypermarket brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). Nesto has an official site but heavy aggregator
// coverage (Discovery §10.B), so it uses the aggregator (§7.2), now D4D. D4D
// scopes offers by the city in the URL, so the Riyadh store page already yields
// only Central/Riyadh flyers — no per-region slug matcher is needed (unlike the
// retired OffersInMe adapter, which mixed in Dammam/Eastern leaflets).
//
// Best-first: D4D current flyer (images) -> else Nesto's official site.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { d4dAdapter } from '../collectors/adapters/d4d.js';
import { createOfficialLinkCollector } from '../collectors/officialLink.js';

const d4d = createAggregatorCollector({ name: 'd4d', adapter: d4dAdapter });
const official = createOfficialLinkCollector();

export const nestoProvider = {
  id: 'nesto',
  label: 'Nesto Hypermarket',
  regions: {
    central: {
      store: 'nesto-73',
      city: 'riyadh',
      officialUrl: 'https://nesto.sa/',
    },
  },
  strategies: [d4d, official],
};
