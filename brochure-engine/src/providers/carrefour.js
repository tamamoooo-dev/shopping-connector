// providers/carrefour.js — Carrefour (MAF) brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). Carrefour's official digital leaflet is a
// bot-protected web-app (Discovery §10.B, Akamai) — we build no bypass (§10.F),
// so the aggregator is the source (§7.2). Carrefour KSA leaflets are national,
// so Central/Riyadh uses the default (other-region-excluded) selection.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { offersInMeAdapter } from '../collectors/adapters/offersinme.js';

const collector = createAggregatorCollector({ name: 'aggregator', adapter: offersInMeAdapter });

export const carrefourProvider = {
  id: 'carrefour',
  label: 'Carrefour',
  regions: {
    central: { store: 'carrefour-offers' },
  },
  strategies: [collector],
};
