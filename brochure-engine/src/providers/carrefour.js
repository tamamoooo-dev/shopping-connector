// providers/carrefour.js — Carrefour (MAF) brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). Carrefour's official digital leaflet is a
// bot-protected web-app (Discovery §10.B, Akamai) — we build no bypass (§10.F),
// so the aggregator is the source (§7.2), now D4D. D4D scopes offers by city, so
// Central/Riyadh is selected by the city in the URL.
//
// Best-first: D4D current flyer (images) -> else Carrefour KSA's official site.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { d4dAdapter } from '../collectors/adapters/d4d.js';
import { createOfficialLinkCollector } from '../collectors/officialLink.js';

const d4d = createAggregatorCollector({ name: 'd4d', adapter: d4dAdapter });
const official = createOfficialLinkCollector();

export const carrefourProvider = {
  id: 'carrefour',
  label: 'Carrefour',
  regions: {
    central: {
      store: 'carrefour-62',
      city: 'riyadh',
      officialUrl: 'https://www.carrefourksa.com/mafsau/en/',
    },
  },
  strategies: [d4d, official],
};
