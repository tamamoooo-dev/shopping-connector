// debug/hotspot-census.mjs — stage-by-stage hotspot accounting for one D4D
// leaflet, page by page. NOT part of the deployed Worker.
//
// Answers, with MEASUREMENT rather than inference, "where does a page's
// hotspot count change between the raw leaflet HTML and what the pipeline
// persists?" For every source page it reports:
//
//   raw        hotspot records present in the raw HTML (an independent, lax
//              scan of EVERY data-coords-json / data-next-page-coords blob —
//              deliberately NOT the production regexes, so records the parser
//              never sees are still counted)
//   regex      records extracted by parseHotspots' regex stage (the blob that
//              won first-seen-wins; duplicate-blocked blobs reported apart)
//   norm       spots surviving normalization (bbox + id + size filters),
//              with a breakdown of every drop reason
//   dedup      pages surviving the parser's dedup (first-seen-wins happens
//              INSIDE the regex stage in this parser; there is no per-spot
//              dedup — the column shows the post-parse page total)
//   persisted  spots after remapHotspotPages onto stored ordinals and the
//              aggregator's page cap — byte-for-byte the `hotspots` payload
//              the pipeline hands to writeHotspots() (pipeline.js), i.e. what
//              lands in hotspots.json next to the D1-indexed edition row.
//
// Usage:
//   node debug/hotspot-census.mjs --store al-madina-hypermarket-212 [--city riyadh] [--page 6]
//   node debug/hotspot-census.mjs --leaflet <leaflet-url> [--page 6]
//   node debug/hotspot-census.mjs --file <saved-leaflet.html> [--page 6]
//
// --page N (1-based source page) additionally dumps every raw record on that
// page with the exact outcome the parser gave it.

import { readFileSync } from 'node:fs';
import { parseHotspots } from '../src/hotspots.js';
import { extractOffers, parseLeaflet } from '../src/collectors/adapters/d4d.js';

const HOST = 'https://d4donline.com';
const MAX_PAGES = 36; // aggregator.js maxPages/maxTotalPages — the persistence cap

// --- CLI ----------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
};
const store = opt('store');
const city = opt('city', 'riyadh');
const leafletUrl = opt('leaflet');
const file = opt('file');
const detailPage = Number(opt('page', '6')); // 1-based

const UA = { 'User-Agent': 'BrochureEngine/0.1 (+https://github.com/tamamoooo-dev)', Accept: '*/*' };
async function fetchText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.text();
}

// --- stage 1: independent raw-HTML scan ----------------------------------------
// Finds EVERY coords blob with a lax regex (both quote styles, any attribute
// order) and attributes it to a source page index by document position, so a
// blob the production parser misses still shows up in the `raw` column.
function rawScan(html) {
  const pics = []; // { start, end, idx }
  const picRe = /<picture\s[^>]*class="offer-page"[^>]*>/gi;
  let m;
  while ((m = picRe.exec(html))) {
    const idx = /data-index="(\d+)"/.exec(m[0]);
    pics.push({ start: m.index, end: m.index + m[0].length, idx: idx ? Number(idx[1]) : null });
  }

  const blobs = []; // { pageIndex, kind, records, parseError, quote, prodMatch }
  const attrRe = /data-(coords-json|next-page-coords)=(?:'(\[[\s\S]*?\])'|"(\[[\s\S]*?\])")/gi;
  while ((m = attrRe.exec(html))) {
    const kind = m[1] === 'coords-json' ? 'container' : 'next-page';
    const raw = m[2] != null ? m[2] : m[3];
    const quote = m[2] != null ? "'" : '"';
    // Would the PRODUCTION regex have seen this blob? (hotspots.js: the
    // single-quoted picture-attr regex for next-page blobs; the strict
    // figure-prefix regex for container blobs.)
    let prodMatch;
    if (kind === 'next-page') {
      // production sees it only if the enclosing picture's attrs match the
      // single-quoted regex at hotspots.js (pictureRe loop)
      const host = pics.find((p) => p.start <= m.index && m.index < p.end);
      prodMatch = !!(host && /data-next-page-coords='(\[[^']*\])'/.test(html.slice(host.start, host.end)));
    } else {
      // production sees it only with the exact figure prefix AND single quotes
      // (containerRe at hotspots.js); the attr match starts at `data-`
      const figPrefix = '<figure class="image-container flyer-container" ';
      prodMatch = quote === "'" && html.slice(m.index - figPrefix.length, m.index) === figPrefix;
    }
    let records = null;
    let parseError = null;
    try {
      const parsed = JSON.parse(raw.split('\\/').join('/'));
      records = Array.isArray(parsed) ? parsed.length : 0;
    } catch (e) {
      parseError = e.message.slice(0, 60);
      records = (raw.match(/id_product/g) || []).length; // lower-bound estimate
    }
    let pageIndex = null;
    if (kind === 'next-page') {
      const host = pics.find((p) => p.start <= m.index && m.index < p.end);
      if (host && host.idx != null) pageIndex = host.idx + 1; // blob belongs to the NEXT page
    } else {
      const next = pics.find((p) => p.start > m.index); // container wraps the following picture
      if (next && next.idx != null) pageIndex = next.idx;
    }
    blobs.push({ pageIndex, kind, records, parseError, estimated: !!parseError, quote, prodMatch });
  }
  return { pics, blobs };
}

// --- run one leaflet ------------------------------------------------------------
async function censusLeaflet(html, offer) {
  const { pics, blobs } = rawScan(html);
  const trace = [];
  const brochure = parseLeaflet(html, offer, trace); // the REAL adapter path

  // Source pages present in the document.
  const sourceIndexes = [...new Set(pics.map((p) => p.idx).filter((i) => i != null))].sort((a, b) => a - b);
  const allPages = new Set([...sourceIndexes, ...blobs.map((b) => b.pageIndex).filter((i) => i != null)]);

  const byPage = new Map();
  const page = (i) => {
    if (!byPage.has(i)) {
      byPage.set(i, {
        raw: 0, rawBlobs: [], regex: null, regexBlob: null, blocked: [],
        drops: {}, norm: null, dims: undefined, persisted: 0, ordinal: null,
      });
    }
    return byPage.get(i);
  };

  for (const b of blobs) {
    if (b.pageIndex == null) continue;
    const p = page(b.pageIndex);
    // raw = the LARGEST blob any copy of this page carries (copies duplicate
    // the same geometry; summing would double-count the same products).
    p.raw = Math.max(p.raw, b.records || 0);
    p.rawBlobs.push(b);
  }
  for (const e of trace) {
    if (e.stage === 'blob') {
      const p = page(e.index);
      if (e.outcome === 'parsed') { p.regex = e.records; p.regexBlob = e.source; }
      else p.blocked.push(e);
    } else if (e.stage === 'record') {
      const p = page(e.index);
      p.drops[e.outcome] = (p.drops[e.outcome] || 0) + 1;
    } else if (e.stage === 'page') {
      const p = page(e.index);
      p.norm = e.out;
      p.dims = e.dims;
    } else if (e.stage === 'remap') {
      const p = page(e.sourceIndex);
      p.ordinal = e.ordinal;
    }
  }

  // What the pipeline actually persists: the adapter's remapped pages, then the
  // aggregator's cap — hotspotsFor(pageCount) in collectors/aggregator.js —
  // exactly as handed to writeHotspots() in pipeline.js.
  const pageCount = Math.min(brochure.pages.length, MAX_PAGES);
  const persistedPages = (brochure.hotspots || []).filter((pg) => pg.index < pageCount);
  const persistedByOrdinal = new Map(persistedPages.map((pg) => [pg.index, pg.spots.length]));
  for (const [i, p] of byPage) {
    if (p.ordinal != null) p.persisted = persistedByOrdinal.get(p.ordinal) || 0;
    void i;
  }

  // --- report -------------------------------------------------------------------
  console.log(`\n=== ${offer.url}`);
  console.log(`    title="${brochure.title}"  validity=${brochure.validFrom}..${brochure.validTo}`);
  console.log(`    pictures in HTML: ${pics.length} (${sourceIndexes.length} distinct data-index) · stored page images: ${brochure.pages.length} · coords blobs: ${blobs.length}`);
  console.log('');
  console.log('  page(1-based) srcIdx ordinal |   raw  regex   norm  dedup persist | winning-blob  drops / notes');
  console.log('  ------------------------------------------------------------------------------------------------');
  const rows = [...allPages].sort((a, b) => a - b);
  let totals = { raw: 0, regex: 0, norm: 0, persisted: 0 };
  for (const i of rows) {
    const p = byPage.get(i) || page(i);
    const notes = [];
    if (p.blocked.length) notes.push(p.blocked.map((b) => `${b.outcome}(${b.source}${b.records != null ? `:${b.records}` : ''})`).join(','));
    const dropStr = Object.entries(p.drops).filter(([k]) => k !== 'kept').map(([k, v]) => `${k}:${v}`).join(' ');
    if (dropStr) notes.push(dropStr);
    if (p.dims === null) notes.push('DROPPED: no data-width/height resolvable');
    for (const b of p.rawBlobs) {
      if (b.parseError) notes.push(`raw-blob-unparsable(${b.kind}): ${b.parseError}`);
      if (!b.prodMatch) notes.push(`INVISIBLE-TO-PARSER(${b.kind},quote=${b.quote}):${b.records}`);
    }
    const regex = p.regex != null ? p.regex : 0;
    const norm = p.norm != null ? p.norm : 0;
    totals.raw += p.raw; totals.regex += regex; totals.norm += norm; totals.persisted += p.persisted;
    console.log(
      `  ${String(i + 1).padStart(6)}        ${String(i).padStart(5)} ${String(p.ordinal != null ? p.ordinal : '-').padStart(7)} | ` +
      `${String(p.raw).padStart(5)} ${String(regex).padStart(6)} ${String(norm).padStart(6)} ${String(norm).padStart(6)} ${String(p.persisted).padStart(7)} | ` +
      `${(p.regexBlob || '-').padEnd(12)} ${notes.join(' · ')}`,
    );
  }
  console.log('  ------------------------------------------------------------------------------------------------');
  console.log(`  TOTAL                        | ${String(totals.raw).padStart(5)} ${String(totals.regex).padStart(6)} ${String(totals.norm).padStart(6)} ${String(totals.norm).padStart(6)} ${String(totals.persisted).padStart(7)} |`);
  console.log('  (dedup == norm: first-seen-wins dedup runs inside the regex stage; no spot-level dedup exists)');

  // --- per-record detail for the page under investigation -------------------------
  const src = detailPage - 1;
  const detail = trace.filter((e) => (e.stage === 'record' || e.stage === 'blob' || e.stage === 'page') && e.index === src);
  console.log(`\n  --- page ${detailPage} (source data-index ${src}) record-level detail ---`);
  if (!detail.length) console.log('  (parser produced no events for this page — check the raw column above)');
  for (const e of detail) {
    if (e.stage === 'blob') console.log(`  blob   ${e.source}: ${e.outcome}${e.records != null ? ` (${e.records} records)` : ''}`);
    if (e.stage === 'record') console.log(`  record offer=${e.offerId}: ${e.outcome}${e.w != null ? ` (w=${e.w} h=${e.h})` : ''}`);
    if (e.stage === 'page') console.log(`  page   in=${e.in} out=${e.out} dims=${e.dims ? `${e.dims.w}x${e.dims.h}` : 'MISSING'}`);
  }
  const rawDetail = blobs.filter((b) => b.pageIndex === src);
  for (const b of rawDetail) {
    console.log(`  raw    ${b.kind} blob (quote=${b.quote}, visible-to-production-regex=${b.prodMatch}): ${b.records} records${b.estimated ? ' (estimated, blob unparsable)' : ''}${b.parseError ? ` — ${b.parseError}` : ''}`);
  }
  return { offer, totals, pages: byPage };
}

// --- main -----------------------------------------------------------------------
async function main() {
  let targets = [];
  if (file) {
    targets = [{ html: readFileSync(file, 'utf8'), offer: { id: 0, slug: 'file', url: `file://${file}`, expiry: null } }];
  } else if (leafletUrl) {
    targets = [{ html: await fetchText(leafletUrl), offer: { id: 0, slug: 'cli', url: leafletUrl, expiry: null } }];
  } else if (store) {
    const storeUrl = `${HOST}/en/saudi-arabia/${city}/offers/${store}`;
    console.log(`store page: ${storeUrl}`);
    const html = await fetchText(storeUrl);
    const today = new Date().toISOString().slice(0, 10);
    const offers = extractOffers(html, store, city)
      .filter((o) => !o.expiry || o.expiry >= today)
      .sort((a, b) => b.id - a.id)
      .slice(0, 4); // the adapter's maxCandidates
    console.log(`current leaflets: ${offers.length}${offers.map((o) => `\n  #${o.id} ${o.slug} (expires ${o.expiry})`).join('')}`);
    for (const o of offers) targets.push({ html: await fetchText(o.url), offer: o });
  } else {
    console.error('usage: node debug/hotspot-census.mjs --store <d4d-key> | --leaflet <url> | --file <html>  [--city riyadh] [--page 6]');
    process.exit(2);
  }
  for (const t of targets) await censusLeaflet(t.html, t.offer);
}

main().catch((err) => {
  console.error(`census failed: ${err.message}`);
  process.exit(1);
});
