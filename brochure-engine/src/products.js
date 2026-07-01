// products.js — the Price History watchlist. PURE CONFIG (project rule 2): the
// only place a store name appears for Price History. The Core, priceHistory
// logic, pipeline and storage never learn a store name.
//
// A tracked product maps to store entries. Each entry needs BOTH:
//   • brochureStore + region — the brochure provider whose current edition
//     ANCHORS the price point (the "when" / "where"); and
//   • searchProvider — the search-connector provider that supplies the current
//     price NUMBER.
// So only stores present in BOTH engines can contribute a point. Today that is
// LuLu, Tamimi, Danube (same id both sides) and Panda (brochure id "hyperpanda"
// ≡ search id "panda", per HANDOFF §12.D.4). Adding a product = one entry here.
//
// Keep this small — it is a personal tool, not a catalogue. Queries should be
// specific enough that the connector's best-ranked result is the right product.

export const products = [
  {
    id: 'milk',
    label: 'Fresh milk',
    query: 'milk',
    stores: [
      { brochureStore: 'lulu', region: 'central', searchProvider: 'lulu' },
      { brochureStore: 'tamimi', region: 'central', searchProvider: 'tamimi' },
      { brochureStore: 'danube', region: 'central', searchProvider: 'danube' },
      { brochureStore: 'hyperpanda', region: 'central', searchProvider: 'panda' },
    ],
  },
  {
    id: 'eggs',
    label: 'Eggs',
    query: 'eggs',
    stores: [
      { brochureStore: 'lulu', region: 'central', searchProvider: 'lulu' },
      { brochureStore: 'tamimi', region: 'central', searchProvider: 'tamimi' },
      { brochureStore: 'danube', region: 'central', searchProvider: 'danube' },
      { brochureStore: 'hyperpanda', region: 'central', searchProvider: 'panda' },
    ],
  },
];
