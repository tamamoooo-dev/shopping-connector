// providers/d4dStores.js — the D4D-covered Riyadh grocery stores added in the
// Coverage Expansion milestone. PURE CONFIG (project rule 2): one entry per
// store, all built by the same tiny factory; the Core, collectors, adapter and
// storage never learn these names.
//
// Every store here was probed live (2026-07-02): each has ≥1 CURRENT Riyadh
// flyer on D4D and structured product offers behind /products/search. The
// engine id is the canonical store key; the D4D key ("<slug>-<companyId>")
// addresses both the flyer pages AND the offers API (the trailing id is the
// offers `company`).
//
// `officialUrl` (the offers-page fallback when D4D has nothing current) is set
// only where a store's official offers destination is actually known — a wrong
// fallback is worse than none (the store then honestly shows "no current
// flyer", exactly like Manuel).
//
// The original 7 aggregator stores keep their own provider files; this module
// is the growth path (adding a store = one line here + one registry line).

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { d4dAdapter } from '../collectors/adapters/d4d.js';
import { createOfficialLinkCollector } from '../collectors/officialLink.js';

const d4d = createAggregatorCollector({ name: 'd4d', adapter: d4dAdapter });
const official = createOfficialLinkCollector();

function makeD4dProvider({ id, label, store, officialUrl = null }) {
  return {
    id,
    label,
    regions: {
      central: { store, city: 'riyadh', ...(officialUrl ? { officialUrl } : {}) },
    },
    strategies: officialUrl ? [d4d, official] : [d4d],
  };
}

export const d4dStoreProviders = [
  { id: 'farm', label: 'Farm Superstores', store: 'farm-101', officialUrl: 'https://www.farm.com.sa/' },
  { id: 'almadina', label: 'Al Madina Hypermarket', store: 'al-madina-hypermarket-212' },
  { id: 'ramez', label: 'Aswaq Ramez', store: 'aswaq-ramez-88' },
  { id: 'cityflower', label: 'City Flower', store: 'city-flower-556' },
  { id: 'marksave', label: 'Mark & Save', store: 'mark-save-3179' },
  { id: 'amarket', label: 'A Market', store: 'a-market-3351' },
  { id: 'grandhyper', label: 'Grand Hyper', store: 'grand-hyper-3181' },
  { id: 'makkah', label: 'Makkah Hypermarket', store: 'makkah-hypermarket-796' },
  { id: 'prime', label: 'Prime Supermarket', store: 'prime-supermarket-471' },
  { id: 'alwafa', label: 'Hyper Al Wafa', store: 'hyper-al-wafa-3041' },
  { id: 'aljazera', label: 'AlJazera Markets', store: 'aljazera-shopping-center-210' },
].map(makeD4dProvider);
