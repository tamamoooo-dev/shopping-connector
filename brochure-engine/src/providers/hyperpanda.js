// providers/hyperpanda.js — Hyper Panda brochure provider (aggregator-covered).
//
// PURE CONFIG (project rule 2). Panda/HyperPanda (Panda Retail Co.) have an
// e-commerce/app backend but no clean official web PDF brochure (Discovery
// §10.C), so the aggregator is the reliable source (§7.2), now D4D.
//
// NOTE on Panda vs HyperPanda: D4D lists a single "hyper-panda" store for the
// group, and Discovery §10.B records that the two share/parallel the same promo.
// They are therefore modelled as ONE provider here (also required by the engine's
// global ux_checksum dedupe: two providers ingesting identical bytes could not
// both be stored). Panda is covered THROUGH Hyper Panda.
//
// Best-first: D4D current flyer (images) -> else Panda's official offers page.

import { createAggregatorCollector } from '../collectors/aggregator.js';
import { d4dAdapter } from '../collectors/adapters/d4d.js';
import { createOfficialLinkCollector } from '../collectors/officialLink.js';

const d4d = createAggregatorCollector({ name: 'd4d', adapter: d4dAdapter });
const official = createOfficialLinkCollector();

export const hyperpandaProvider = {
  id: 'hyperpanda',
  label: 'Hyper Panda (Panda Retail Co.)',
  regions: {
    central: {
      store: 'hyper-panda-70',
      city: 'riyadh',
      officialUrl: 'https://www.panda.com.sa/',
    },
  },
  strategies: [d4d, official],
};
