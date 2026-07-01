// collectors/adapters/offersinme.js — the OffersInMe adapter for the generic
// AggregatorCollector (ARCHITECTURE.md §7.2).
//
// ONE adapter per aggregator. This is aggregator-generic, NOT store-specific:
// it knows OffersInMe's URL scheme and page markup, nothing about any store.
// The store-specific bits (which OffersInMe slug a store maps to, and how to
// pick this store's Central/Riyadh leaflets) arrive as `regionConfig` from the
// provider (project rule 2 / §5.3), so a new aggregator store is a provider
// config addition, not an adapter change.
//
// Why OffersInMe (not the Discovery's ClicFlyer pick): ClicFlyer's web frontend
// hard-blocks datacenter egress (HTTP 503 on every request) — unusable from a
// Cloudflare Worker — whereas OffersInMe server-renders clean, fetchable pages.
// The AggregatorCollector is adapter-driven precisely so this choice is a
// one-line swap (§10.F risk #1: "don't hard-depend on one aggregator").
//
// OffersInMe shape (verified against the live KSA site):
//   store page:  https://ksa.offersinme.com/hypermarkets/<slug>-offers
//                -> links to /leaflet/<leaflet-slug>-<leafletId>
//   leaflet page: https://ksa.offersinme.com/leaflet/<leaflet-slug>-<leafletId>
//                -> "Valid from :DD Month YYYY" / "Valid to : DD Month YYYY"
//                -> page images at
//                   https://offersin.me/leaflet/Y/M/D/<leafletId>/<leafletId>-<n>-<slug>.<ext>
//                   (<ext> is webp or jpeg/jpg/png; <n> is the 0-based page index)
//
// Interface (the brochure analogue of a search adapter):
//   name
//   listBrochures(storeKey, ctx) -> Promise<Brochure[]>
//     ctx = { region, regionConfig, fetchText, maxCandidates }
//     Brochure = { id, slug, title, validFrom, validTo, pages:[imageUrl…], sourceUrl }
// The collector downloads the page-image BYTES (the heavy part) for only the
// chosen brochure; this adapter fetches only HTML.

const HOST = 'https://ksa.offersinme.com';
const STORE_BASE = `${HOST}/hypermarkets/`;

// OffersInMe's other-KSA-region geo tokens. Default `exclude` so a store that
// publishes per-region leaflets (or a national store whose listing also carries
// other cities) never leaks an Eastern/Western/Jeddah/Dammam flyer into a
// Central/Riyadh request. Providers override via regionConfig.include/exclude.
const OTHER_REGIONS =
  /eastern-province|western-province|northern-province|southern-province|\bdammam\b|\bjeddah\b|\bmakkah\b|\bmecca\b|al-?madinah?|\bmadinah?\b|\bqass?e?im\b|buray?dah|\bkhobar\b|\bjubail\b|\bhail\b|\btabuk\b|\babha\b|\bkhamis\b|\byanbu\b/i;

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
};

// "03 June 2026" -> "2026-06-03" (null if unparseable).
function parseDate(text) {
  if (!text) return null;
  const m = /([0-9]{1,2})\s+([A-Za-z]+)\s+([0-9]{4})/.exec(text);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${mo}-${m[1].padStart(2, '0')}`;
}

// Collect unique leaflet links from a store page: /leaflet/<slug>-<id>. The
// trailing number is the leaflet id; slugs themselves contain numbers (e.g.
// "sr-5-10-20-offers-44175"), so match greedily and anchor the id at the URL
// boundary to always capture the *final* numeric group.
function extractLeaflets(html) {
  const seen = new Map(); // id -> { id, slug, url }
  for (const m of html.matchAll(/\/leaflet\/([a-z0-9-]+)-(\d+)(?=["'\/?#]|$)/gi)) {
    const id = Number(m[2]);
    if (!seen.has(id)) {
      seen.set(id, { id, slug: m[1].toLowerCase(), url: `${HOST}/leaflet/${m[1]}-${m[2]}` });
    }
  }
  return [...seen.values()];
}

// Parse one leaflet page into a Brochure (title, validity, ordered page images).
function parseLeaflet(html, leaflet) {
  const ogTitle = /property="og:title"\s+content="([^"]*)"/i.exec(html) || /<title>([^<]*)<\/title>/i.exec(html);
  const title = ogTitle ? ogTitle[1].replace(/\s*\|.*$/, '').trim() || null : null;

  const validFrom = parseDate((/Valid\s*from\s*:\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i.exec(html) || [])[1]);
  const validTo = parseDate((/Valid\s*to\s*:\s*([0-9]{1,2}\s+[A-Za-z]+\s+[0-9]{4})/i.exec(html) || [])[1]);

  // Page images live under this leaflet id; index (<n>) is the page order.
  const re = new RegExp(
    `https?://offersin\\.me/leaflet/[0-9]+/[0-9]+/[0-9]+/${leaflet.id}/${leaflet.id}-(\\d+)-[^"'\\s>)]+?\\.(?:webp|jpe?g|png)`,
    'gi',
  );
  const byIndex = new Map();
  for (const m of html.matchAll(re)) {
    const idx = Number(m[1]);
    if (!byIndex.has(idx)) byIndex.set(idx, m[0]);
  }
  const pages = [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);

  return { id: leaflet.id, slug: leaflet.slug, title, validFrom, validTo, pages, sourceUrl: leaflet.url };
}

export const offersInMeAdapter = {
  name: 'offersinme',

  async listBrochures(storeKey, { region, regionConfig = {}, fetchText, maxCandidates = 4 } = {}) {
    if (!storeKey) throw new Error(`offersinme: region '${region}' has no store slug configured`);
    if (typeof fetchText !== 'function') throw new Error('offersinme: fetchText is required');

    const html = await fetchText(STORE_BASE + storeKey);

    // Region selection (§5.3): a leaflet qualifies if it matches the provider's
    // `include` (when given) and does NOT match `exclude` (defaults to the
    // other-KSA-region blocklist). This is where Lulu's "central-province",
    // Manuel's "riyadh", and the national stores diverge — all via config.
    const include = regionConfig.include;
    const exclude = regionConfig.exclude || OTHER_REGIONS;
    let leaflets = extractLeaflets(html).filter(
      (l) => (!include || include.test(l.slug)) && !(exclude && exclude.test(l.slug)),
    );

    // Newest first (higher id == more recently published), then cap the number
    // of leaflet pages we fetch — gentle on the aggregator (§10.F legal posture).
    leaflets.sort((a, b) => b.id - a.id);
    leaflets = leaflets.slice(0, maxCandidates);

    const out = [];
    for (const leaflet of leaflets) {
      try {
        const parsed = parseLeaflet(await fetchText(leaflet.url), leaflet);
        if (parsed.pages.length) out.push(parsed);
      } catch {
        /* skip a leaflet that fails to fetch/parse; others still count */
      }
    }
    return out;
  },
};
