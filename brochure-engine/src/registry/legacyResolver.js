// Offline-only previous-input adapter for regression comparison. Production
// modules never import this file. It lets the historical calibration corpus
// quantify the Identity Candidate integration against the former raw
// offer/enrichment behavior without keeping that behavior callable in the
// production resolver.

import { readFromOffer } from './read.js';
import { resolveRead } from './resolver.js';

export async function resolveLegacyOffer(offer, enrichment, store, opts = {}) {
  const result = readFromOffer(offer, enrichment);
  if (!result.ok) return { outcome: 'defer', verdict: result.verdict };
  return resolveRead(
    result.read,
    {
      offerId: offer.id,
      store: offer.store,
      region: offer.region,
      textKey: offer.search_text || '',
    },
    store,
    opts,
  );
}
