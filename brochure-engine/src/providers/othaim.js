// providers/othaim.js — the Othaim brochure provider (ARCHITECTURE.md §5.3, §7.1).
//
// PURE CONFIG. It declares its region map and wires the generic
// PdfIndexCollector with an Othaim-specific `resolve`. All store knowledge lives
// here (project rule 2: store-specific logic only in a provider file); the Core,
// collector, pipeline and storage never learn the name "othaim".
//
// Othaim's offers index (othaimmarkets.com/offers) is a Next.js App-Router page.
// The region -> current brochure mapping is delivered in the RSC "flight"
// payload embedded in the page, and the weekly PDF lives at
//   /api/pdfOffers/<brochureId>-<version>.pdf
// The <brochureId> and <version> BOTH rotate as new weeks are published, so we
// never hardcode a PDF URL (§10.F "weekly PDF URL churn"). Instead we resolve,
// every run, from the stable index:
//   1. decode the flight payload,
//   2. find the region entry by its stable human slug (regionConfig.slug),
//   3. read that entry's current brochure id,
//   4. locate the full weekly PDF filename for that id on the page.
//
// A different PDF-index store (e.g. Farm) reuses the SAME collector with its own
// provider file + its own `resolve` — no collector code changes (§10.D.1).

import { createPdfIndexCollector } from '../collectors/pdfIndex.js';

const INDEX_URL = 'https://othaimmarkets.com/offers';

// Reassemble the Next.js RSC flight text from the page's self.__next_f pushes.
// Each push carries a JSON string literal; concatenating the decoded literals
// yields the flight document that contains the region/brochure data.
function decodeFlight(html) {
  let flight = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      flight += JSON.parse(m[1]);
    } catch {
      /* skip malformed chunk */
    }
  }
  return flight;
}

// Othaim-specific resolver passed to the generic collector.
function resolveOthaim({ indexHtml, region, regionConfig }) {
  const slug = regionConfig?.slug;
  if (!slug) throw new Error(`othaim: region '${region}' has no slug configured`);

  const flight = decodeFlight(indexHtml);

  // Region entry -> current brochure id. The slug is stable; the id rotates.
  const entry = new RegExp(
    `"slug":"${slug}"[^}]*?"brochure":\\{"sys":\\{"id":"([^"]+)"`,
  ).exec(flight);
  if (!entry) throw new Error(`othaim: region slug '${slug}' not found on index`);
  const brochureId = entry[1];

  // Resolve the full weekly PDF filename for that id (id + rotating version).
  const pdf = new RegExp(`api/pdfOffers/${brochureId}[A-Za-z0-9_\\-]*\\.pdf`).exec(indexHtml);
  if (!pdf) throw new Error(`othaim: no PDF for brochure '${brochureId}' on index`);

  // A human title, if the flight exposes one for this region entry.
  const titleMatch = new RegExp(`"title":"([^"]*)","slug":"${slug}"`).exec(flight);

  return {
    pdfUrl: `/${pdf[0]}`, // collector absolutizes against INDEX_URL
    title: titleMatch ? titleMatch[1] : null,
  };
}

const collector = createPdfIndexCollector({
  name: 'pdfIndex',
  indexUrl: INDEX_URL,
  resolve: resolveOthaim,
});

export const othaimProvider = {
  id: 'othaim',
  label: 'Othaim Markets',
  // Canonical region key -> Othaim addressing (§5.3). Central == Riyadh here.
  // The BROCHURE stays the official PDF (best source); structured OFFERS come
  // from D4D's per-product records for Othaim's Riyadh flyer (company 72) —
  // the `offers` config is read only by the offers ingest, never by collectors.
  regions: {
    central: {
      slug: 'central-region-offers-corner',
      offers: { company: 72, city: 'riyadh', storePageSlug: 'othaim-markets-72' },
    },
  },
  strategies: [collector], // best-first; M1 = official PDF only
};
