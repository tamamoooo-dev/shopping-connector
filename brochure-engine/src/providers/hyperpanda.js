// providers/hyperpanda.js — Hyper Panda brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). Panda/HyperPanda (Panda Retail Co.) have an
// e-commerce/app backend but no clean official web PDF brochure (Discovery
// §10.C), so the aggregator is the reliable source (§7.2).
//
// NOTE on Panda vs HyperPanda: OffersInMe merges Panda into a single
// "hyper-panda-offers" listing (a plain "panda-offers" page redirects away),
// and Discovery §10.B records that the two share/parallel the same promo. They
// are therefore modelled as ONE provider here (also required by the engine's
// global ux_checksum dedupe: two providers ingesting identical bytes could not
// both be stored). Hyper Panda's leaflets are national, so Central/Riyadh is
// the default (other-region-excluded) selection — no `include` needed.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { offersInMeAdapter } from '../collectors/adapters/offersinme.js';

const collector = createAggregatorCollector({ name: 'aggregator', adapter: offersInMeAdapter });

export const hyperpandaProvider = {
  id: 'hyperpanda',
  label: 'Hyper Panda (Panda Retail Co.)',
  regions: {
    central: { store: 'hyper-panda-offers' },
  },
  strategies: [collector],
};
