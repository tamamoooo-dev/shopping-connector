// providers/lulu.js — LuLu Hypermarket brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). LuLu's official in-store promotions page is
// bot-protected (Discovery §10.B, Akinon 403), so its reliable brochure source
// is the aggregator (§7.2), now D4D. All store knowledge lives here; the Core,
// collector, adapter and storage never learn the name "lulu".
//
// Best-first strategies:
//   1. d4d          — the current Riyadh flyer as page images (served in-app).
//   2. officialLink — if D4D is expired/unavailable, expose LuLu's official
//                     offers page as the fallback destination (NO other
//                     aggregator, per the Brochure Source Migration rule).

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { d4dAdapter } from '../collectors/adapters/d4d.js';
import { createOfficialLinkCollector } from '../collectors/officialLink.js';

const d4d = createAggregatorCollector({ name: 'd4d', adapter: d4dAdapter });
const official = createOfficialLinkCollector();

export const luluProvider = {
  id: 'lulu',
  label: 'LuLu Hypermarket',
  regions: {
    central: {
      store: 'lulu-hypermarket-63',
      city: 'riyadh',
      officialUrl: 'https://www.luluhypermarket.com/en-sa',
    },
  },
  strategies: [d4d, official],
};
