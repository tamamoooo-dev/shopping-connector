// collectors/officialLink.js — the "official offers page" fallback collector
// (Brochure Source Migration).
//
// Pattern: when the primary aggregator (D4D) has NO current brochure for a store
// — because its flyer is expired or unavailable — the engine must NOT silently
// fall back to another aggregator. Instead it exposes the store's OWN official
// offers page as the destination. This collector produces exactly that: a
// "link" brochure whose sourceUrl is the store's official offers page and which
// carries no downloaded pages.
//
// It is a FACTORY mirroring PdfIndexCollector / AggregatorCollector: given config
// it returns a strategy { name, collect(ctx) -> Promise<Candidate[]> }. It is
// COMPLETELY store-agnostic — the official URL is provider config
// (regionConfig.officialUrl), so adding/adjusting a store is a config change,
// never a collector change (project rule 2).
//
//   Candidate = { doc: PartialBrochureDoc, link: true }
//
// The pipeline recognises a `link` candidate (a doc with sourceType "link" and
// no bytes/pages), dedupes it by its sourceUrl, and indexes the row WITHOUT
// storing any object bytes. Because this strategy sits AFTER the aggregator in a
// provider's best-first `strategies`, it only runs when the aggregator yielded
// nothing — i.e. exactly the "expired or unavailable" case.
//
// Frontend note: the frontend stays source-agnostic. It never learns "D4D" vs
// "official"; it only sees a brochure that is either viewable inline (images) or
// an external link (sourceType "link" -> open sourceUrl). That inline-vs-link
// distinction is a content property of the doc, not a provider identity.

import { buildBrochureDoc } from '../contract.js';

export function createOfficialLinkCollector(config = {}) {
  const { name = 'officialLink' } = config;

  return {
    name,
    async collect({ store, region, regionConfig }) {
      const officialUrl = regionConfig && regionConfig.officialUrl;
      // No official page configured -> nothing to fall back to (best-first ends,
      // and the store simply has no current brochure, as before).
      if (!officialUrl) return [];

      const doc = buildBrochureDoc({
        store,
        region,
        title: regionConfig.officialTitle || null,
        // A link brochure has no validity window of its own — it is an
        // evergreen pointer to wherever the store publishes its live offers.
        validFrom: null,
        validTo: null,
        sourceType: 'link',
        sourceUrl: officialUrl,
        pdfUrl: null,
        collector: name,
      });

      return [{ doc, link: true }];
    },
  };
}
