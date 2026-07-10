# Brochure Engine — Architecture (Phase 2 Design)

> **Status:** Design only. **No code written.** This document is the source of
> truth for the Brochure Engine's architecture, to be reviewed/approved before
> implementation begins (Phase 3).
>
> **Inputs:** HANDOFF.md §10 (Discovery Report, approved 2026-07-01) and the
> proven search-connector patterns (`serverless-connector/src/connector.js`,
> `providers/*.js`). **Author date:** 2026-07-01.
>
> **Pillar this serves:** Pillar 2 (Weekly brochures for physical stores) and,
> because it keeps history, the foundation for Pillar 3 (price intelligence).

---

## 1. Design goals & non-goals

**Goals**
1. Reuse the battle-tested **Core → Provider → Strategy → normalized-contract**
   discipline from search, so the Brochure Engine is instantly familiar and the
   Core never needs store-specific edits.
2. **Three reusable collectors, not ten integrations** (Discovery §10.D.1). New
   stores in a known pattern are **config additions, not new code**.
3. Be **stateful by design**: remember which week is already held, dedupe by
   checksum, and **keep history** — the substrate Pillar 3 will mine.
4. **Official sources primary, aggregator as fallback** — never hard-depend on a
   single aggregator; never build a bot-protection bypass.
5. **Poll gently** (weekly Cron), keep snapshots private, stay a considerate
   personal tool over public endpoints.

**Non-goals (explicitly out of scope for this subsystem, this phase)**
- **Not** part of the stateless search connector. The "thin & stateless" rule
  governs *search only* (HANDOFF §9.1). The Brochure Engine is a **separate
  deployment** with storage and a scheduler.
- **No OCR / structured price extraction** in v1. Flyer PDFs are graphical; that
  is a separate hard problem deferred to the later `StoreSessionCollector` path
  and Pillar 3 (Discovery §10.F).
- No accounts, no ads (consistent with the product).

---

## 2. Where it sits (system context)

```
                 ┌──────────────────────────────────────────────────────┐
                 │  Souq frontend (GitHub Pages, static)                  │
                 │   • Pillar 1: live search  → search connector (exists) │
                 │   • Pillar 2: brochures    → brochure read API (new)   │
                 └───────────────┬───────────────────────┬──────────────┘
                                 │ GET /search            │ GET /brochures…
                                 ▼                        ▼
          ┌───────────────────────────────┐   ┌────────────────────────────────┐
          │  Shopping Connector (EXISTS)   │   │  Brochure Engine (NEW)          │
          │  Cloudflare Worker, STATELESS  │   │  Cloudflare Worker + Cron        │
          │  Provider→Strategy→Normalized  │   │  STATEFUL: R2 + D1               │
          └───────────────┬───────────────┘   │  Provider→Collector→BrochureDoc  │
                          │                    └───────┬───────────────┬─────────┘
             live product │                    ingest  │        serve  │ read
                    fetch │                     (Cron)  ▼               ▼
                          ▼                    ┌────────────┐   ┌───────────────┐
              Stores (Panda/Tamimi/…)          │ R2 objects │   │ D1 metadata   │
                          ▲                    │ (PDF/imgs) │   │ (brochure rows)│
                          └───── reused by ────┤            │   └───────────────┘
              StoreSessionCollector (later) ───┘  (see §7.3)
```

- **Sibling, not child, of the search connector.** They share *discipline* and
  (later) *store-session code*, but not deployment or state.
- The frontend gains a **second data source** for Pillar 2; Pillar 1 is untouched.

**Deployment recommendation (see §12 for the decision):** a **new repo**
`brochure-engine`, deployed as its own Cloudflare Worker with a **Cron Trigger**,
an **R2 bucket** (raw PDFs + page images), and a **D1 database** (brochure
metadata + history). Cloudflare is already the connector's platform (Wrangler is
authenticated, HANDOFF §8), so this reuses known ops with zero new vendors.

---

## 3. Layered component model

Five layers, mirroring the connector's separation of concerns:

| Layer | Responsibility | Store-agnostic? | Analogue in search |
|---|---|---|---|
| **1. Core / framework** | Routing (ingest + read), Cron dispatch, running a provider's collectors best-first, envelope shaping | **Yes** | `connector.js` |
| **2. Providers** | One per store: `{ id, label, regions, strategies:[collector…] }`; declares *which* collectors in *what* order | thin, store-specific config | `providers/<id>.js` |
| **3. Collectors (strategies)** | The 3 reusable patterns: `PdfIndexCollector`, `AggregatorCollector`, `StoreSessionCollector`. Config-driven. Emit **BrochureDoc[]** | pattern-generic | strategy `{name, run()}` |
| **4. Pipeline** | detect → download → dedupe → store → index. Idempotent, checksum-keyed | **Yes** | (new — search has no persistence) |
| **5. Storage** | `ObjectStore` (R2) + `MetadataStore` (D1) behind narrow interfaces | **Yes** | (new) |

**Rule preserved:** store-specific knowledge lives **only** in a provider's
config and (for sessions) the reused search-provider modules. The Core, the
collectors, the pipeline, and storage never learn store names.

---

## 4. The normalized Brochure contract

The equivalent of search's frozen 10-key result. This is the **hard contract**
between collectors, storage, and the read API — treat it like the search
contract (change it and you touch every collector).

```jsonc
// BrochureDoc — one weekly brochure for one store+region
{
  "store":       "othaim",            // provider id
  "region":      "central",           // canonical region key (see §5.3)
  "title":       "Weekly Offers",     // human label if the source gives one
  "validFrom":   "2026-07-02",        // ISO date | null if unknown
  "validTo":     "2026-07-08",        // ISO date | null if unknown
  "detectedAt":  "2026-07-01T09:00Z", // when the engine first saw this edition
  "sourceType":  "pdf",               // pdf | images | flipbook | api
  "sourceUrl":   "https://othaimmarkets.com/othaim-promotions/?pid=18", // stable index/landing
  "pdfUrl":      "https://.../api/pdfOffers/8842.pdf", // resolved weekly URL | null
  "pages": [                          // rendered/derived page images (may be empty in v1)
    { "index": 0, "imageUrl": "r2://brochures/othaim/central/2026-W27/p0.jpg" }
  ],
  "checksum":    "sha256:…",          // content hash — the dedupe & identity key
  "collector":   "pdfIndex",          // which strategy produced it (provenance)
  "storageKey":  "othaim/central/2026-W27"  // R2 prefix for this edition's assets
}
```

Notes:
- `checksum` is computed over the **downloaded bytes** (the PDF, or the
  concatenation of image bytes for image-set aggregators). It is the single
  source of "do we already have this week?" — **dedupe from day one** (§10.F).
- `pages[]` may be **empty in v1** for PDF sources: we store the PDF and serve it
  directly; page rendering to images is an optional later enhancement (§11).
- `pdfUrl` is **never hardcoded** — always the value *discovered this run* from
  the stable index (§10.F "weekly PDF URL churn").

---

## 5. Data model & storage

### 5.1 Object store (R2) — the bytes
Layout keyed so history is free and dedupe is obvious:

```
brochures/<store>/<region>/<edition>/original.pdf      # or /pageNN.jpg for image sets
brochures/<store>/<region>/<edition>/meta.json         # snapshot of the BrochureDoc
```
- `<edition>` = ISO week `YYYY-Www` (e.g. `2026-W27`) when derivable from
  `validFrom`, else `detected-YYYY-MM-DD`. History accretes naturally: last
  week's folder is never overwritten.

### 5.2 Metadata store (D1) — the index & history
One row per detected edition (the queryable projection of BrochureDoc):

```sql
CREATE TABLE brochures (
  id          TEXT PRIMARY KEY,   -- `${store}:${region}:${edition}`
  store       TEXT NOT NULL,
  region      TEXT NOT NULL,
  edition     TEXT NOT NULL,      -- YYYY-Www or detected-date
  title       TEXT,
  valid_from  TEXT,               -- ISO date
  valid_to    TEXT,
  detected_at TEXT NOT NULL,      -- ISO datetime
  source_type TEXT NOT NULL,
  source_url  TEXT,
  pdf_url     TEXT,
  checksum    TEXT NOT NULL,
  collector   TEXT NOT NULL,
  storage_key TEXT NOT NULL,      -- R2 prefix
  is_current  INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX ux_checksum ON brochures(checksum);
CREATE INDEX ix_store_region_current ON brochures(store, region, is_current);
```
- **`checksum` unique index enforces dedupe at the DB layer** — a re-download of
  an unchanged week is a no-op insert conflict.
- `is_current` flips off prior editions for the same `(store, region)` when a new
  one is stored, giving O(1) "latest brochure" reads while retaining history.
- **Why D1 over KV:** we need queries by `store`/`region`/currency-of-week and a
  uniqueness constraint for dedupe. KV is a plain key→value store; D1 (SQLite)
  gives indexes + `WHERE` for free. R2 holds bytes; D1 holds the index. (KV is a
  viable fallback if D1 is undesirable — see §12.)

### 5.3 Region map (per store)
"Central/Riyadh" is **not uniform** (Discovery §10.F): Othaim exposes a discrete
Central `pid=18`; Farm bundles Riyadh+Eastern+Western into one multi-region PDF.
So each provider declares a **region map** translating a canonical region key
into that store's addressing:

```jsonc
// othaim provider (excerpt)
regions: { central: { pid: 18 } }
// farm provider (excerpt) — Riyadh arrives inside a multi-region bundle
regions: { central: { regionPath: "2", note: "bundled Riyadh+Eastern+Western" } }
```
Canonical keys (`central`, `eastern`, `western`, …) are the engine's vocabulary;
the read API and frontend speak canonical keys only.

---

## 6. Control flow

### 6.1 Ingestion (Cron-driven, the write path)
```
Weekly Cron fires
  └─ Core.ingestAll(registry)
       for each provider, for each region it declares:
         runCollectorsBestFirst(provider, region)  ← mirrors runProvider()
            try collector[0].collect(cfg) → BrochureDoc[]   (e.g. pdfIndex)
            if empty/throws → try collector[1] (e.g. aggregator)
         for each BrochureDoc:
            pipeline.ingest(doc):
              1. compute checksum over downloaded bytes
              2. MetadataStore.exists(checksum)?  → yes: skip (dedupe)
              3. ObjectStore.put(storageKey, bytes)
              4. MetadataStore.upsert(row); flip prior is_current=0
       emit run report (counts: detected / new / deduped / failed)
```
- **Best-first, exactly like `runProvider`** (`connector.js:40`): official
  collector first, aggregator as the fallback that runs only if the official one
  yields nothing. Failures are collected per-collector, not fatal to the run.
- **Idempotent:** re-running the Cron (or a manual trigger) never double-stores;
  checksum + unique index guarantee it.

### 6.2 Read (frontend-driven, the serve path)
Stateless reads over the D1 index + R2 bytes. No store contact at read time
(unlike search) — brochures are pre-fetched weekly.

### 6.3 Scheduler
Cloudflare **Cron Trigger**, weekly (e.g. `0 6 * * 1` — Monday 06:00 UTC; exact
day/time TBD per when stores publish). A manual `POST /ingest` (guarded, see
§8) allows on-demand refresh and testing without waiting for the cron.

---

## 7. The three collectors (config-driven strategies)

Each collector is a **factory**: given per-store config, it returns a strategy
`{ name, collect(ctx) → Promise<BrochureDoc[]> }`. This is the brochure analogue
of a search strategy's `{ name, run(query) }`.

### 7.1 `PdfIndexCollector` (Pattern A) — ships first, covers Othaim + Farm
Config shape:
```jsonc
{
  indexUrl:        "https://othaimmarkets.com/othaim-promotions/?pid=18",
  // how to find the current PDF link on the stable index page:
  pdfLinkPattern:  /\/api\/pdfOffers\/(\d+)\.pdf/,   // or a DOM/selector rule
  regionResolver:  (region, cfg) => …,               // apply the region map (§5.3)
  editionFromPdf:  (url, headers) => "YYYY-Www"       // derive edition when possible
}
```
Behaviour: fetch stable index → extract the **current** PDF URL (never hardcoded)
→ download PDF → build BrochureDoc (`sourceType:"pdf"`). Adding a new
PDF-index store = **one config object, zero new code** (Discovery §10.D.1).

### 7.2 `AggregatorCollector` (Pattern D) — ships second, covers the other 8
- Instantly covers Panda, HyperPanda, Carrefour, Lulu, Danube, Tamimi, Manuel,
  Nesto for Riyadh — the **only** channel for Manuel and the bot-protected/app
  stores.
- **One collector, one adapter per aggregator.** Adapter interface:
  `{ name, listBrochures(storeKey, city) → { pages:[imageUrl], validFrom, validTo, sourceUrl } }`.
- Start with **one** aggregator (recommend **ClicFlyer** — broadest KSA coverage
  in Discovery; final pick in §12). `sourceType:"images"`; checksum over the
  concatenated page-image bytes.
- **Never the sole strategy for a store that also has an official source** — it
  sits *after* the official collector in that provider's list (§10.F risk #1).

### 7.3 `StoreSessionCollector` (Patterns B/C) — later, feeds Pillar 3
- **Reuses the live-search connector's existing sessions** (Panda API, Lulu
  Akinon w/ `pz-*` cookies, Danube Spree, Tamimi ZopSmart) to pull **structured
  promo items** — already normalized, `sourceType:"api"`, **sidesteps OCR**.
- Mechanism: import the relevant search-provider module and call a
  promo/offer-listing endpoint (the same fetch+normalize path search uses; see
  `providers/panda.js`, `providers/lulu.js`). This is the one place brochure and
  search code *share modules* — extract the shared fetch/session helpers into a
  small package both repos consume, rather than forking.
- Deferred to milestone 3 (§9) because it's the bridge to Pillar 3, not needed
  for basic brochure display.

---

## 8. API surface

**Read (public, CORS like the connector):**
- `GET /` → health + list of stores/regions held, freshness per store.
- `GET /brochures?store=<id>&region=<key>` → current BrochureDoc(s). Omit
  `store` → all current brochures (for a "this week's flyers" grid).
- `GET /brochures/history?store=<id>&region=<key>` → prior editions (Pillar 3
  substrate).
- `GET /asset/<storageKey>/<file>` → streams the PDF/page image from R2 (or
  return R2 public URLs directly).
- Errors mirror the connector: `400` missing/invalid param, `404` unknown
  store/region, `502` on storage failure. CORS on every response.

**Write (guarded, not public):**
- Cron invokes ingestion in-process (no HTTP needed).
- `POST /ingest?store=<id>` → manual refresh, protected by a shared secret
  header (Worker secret), for testing/backfill.

---

## 9. Implementation milestones (maps to Discovery §10.E)

Each milestone is independently shippable and leaves the engine working.

**M0 — Skeleton (framework + storage + one provider, no collectors yet)**
Core routing, Cron wiring, `ObjectStore`(R2)/`MetadataStore`(D1) interfaces, the
BrochureDoc contract, read API returning empty. Proves the deployment topology.

**M1 — `PdfIndexCollector` → Othaim + Farm (Central/Riyadh)** *(Discovery start)*
The reference collector. End-to-end proof of the pipeline:
**detect → download → store → dedupe → expose.** Two providers, both pure config.

**M2 — `AggregatorCollector` → one aggregator**
Adds one adapter; unlocks the remaining 8 stores for Riyadh in one collector —
max coverage per unit of code. Wired *after* official collectors where both exist.

**M3 — `StoreSessionCollector`** reusing the 4 search sessions
Structured promo items → **direct Pillar 3 input**, OCR-free. Requires extracting
shared session helpers into a package consumed by both repos.

**M4+ — Upgrade individual stores** aggregator → official where worthwhile;
optional PDF→page-image rendering; begin Pillar 3 price extraction.

---

## 10. How the architecture answers each Discovery risk (§10.F)

| Risk | Architectural mitigation |
|---|---|
| Aggregator dependency (biggest) | Aggregator is always a *fallback strategy*, never sole; official PDF primary; adapter-per-aggregator so a second can be added without touching the collector. |
| Bot-protection churn (Carrefour, Lulu) | **No bypass built.** Carrefour → aggregator. Lulu → `StoreSessionCollector` reusing the session we already own, else aggregator. |
| Weekly PDF URL churn (Othaim, Farm) | `PdfIndexCollector` **always resolves the PDF from the stable index each run**; `pdfUrl` is never persisted as config. |
| Region bundling not uniform | Per-provider **region map** (§5.3) translates canonical keys to each store's addressing (Othaim `pid` vs Farm bundle). |
| Price extraction is OCR-hard | v1 stores/serves brochures as-is; structured prices come only via `StoreSessionCollector` (API, not OCR). |
| Storage growth & dedupe | **Checksum unique index from day one** (§5.2); history via per-edition R2 prefixes. |
| Legal posture | Weekly Cron (gentle), snapshots kept private, public endpoints only, no bypass. |

---

## 11. Optional enhancements (post-v1, noted not scheduled)
- **PDF → page images** rendering to populate `pages[]` for PDF sources (nicer
  in-app viewing without a PDF plugin). Adds a render step in the pipeline.
- **Freshness/health monitoring** (parallels HANDOFF §9.4): alert when a store's
  brochure hasn't refreshed in N weeks — the brochure analogue of best-effort
  store monitoring.
- **Second aggregator adapter** for cross-checking freshness / filling gaps.

---

## 12. Decisions needing approval before Phase 3

1. **Storage backend:** recommend **R2 (bytes) + D1 (metadata index)**. D1 gives
   us dedupe-by-unique-index and region/store queries for free. Alternative:
   KV-only (simpler, but no queries/uniqueness — we'd hand-roll dedupe).
2. **Repo layout:** recommend a **new repo `brochure-engine`** (separate Worker,
   Cron, R2, D1) — keeps the stateless search connector's rule clean. Alternative:
   a second Worker inside the existing connector repo (shared code, muddier
   boundary).
3. **First aggregator:** recommend **ClicFlyer** (broadest KSA coverage per
   Discovery §10.B). Confirm before building the M2 adapter.
4. **Cron cadence/timing:** weekly; confirm the day/time stores typically publish
   (default proposed: Monday 06:00 UTC).
5. **Shared session code:** M3 needs the search providers' fetch/session helpers
   as a shared package. Confirm we may lightly refactor the connector to export
   them (vs. copying).

---

---

## 13. Operations Console (`src/ops/`, added 2026-07)

A hidden, admin-only maintenance & diagnostics subsystem mounted at **`/__ops`**
inside the same Worker — mobile-first, built to run the engine from a phone
without the Cloudflare Dashboard.

- **Native, zero duplication:** reads go through `ops/status.js`, pure
  orchestration over the engine's own interfaces (registry, metadataStore,
  offerStore, historyStore, watchStore, objectStore); writes only trigger the
  engine's production pipelines. The provider registry IS the store list —
  adding a provider appears in the console automatically.
- **Production execution path:** multi-store operations reuse the cron's
  Architecture-C SELF fan-out (`runFanOut` + `createServiceBindingDispatcher`),
  so manual runs and scheduled runs execute identical code with identical
  per-child subrequest budgets. `POST /ingest` gained an optional
  `mode=offers|brochures` for partial fan-outs.
- **Surface:** System Confidence score (weighted freshness / hotspot coverage /
  offers / scheduler heartbeat / subsystem health), per-store coverage table
  (hotspots, clickable, offers, coverage % = clickable/total spots), store
  inspector, manual operations (Run All / Selected / Retry Failed /
  **Repair Unhealthy** / Offers Only / Brochures Only / Verify), Emergency Heal
  (typed `HEAL` confirmation), self test, diagnostics, audit timeline.
- **Audit:** the console's ONLY table is `ops_runs` (schema.sql) — every ingest
  child, cron coordinator summary and manual operation records one row; the
  newest cron-origin row doubles as the scheduler heartbeat.
- **Auth:** dedicated `OPS_TOKEN` secret (human operators; `INGEST_SECRET`
  stays machine-only), digest comparison, HMAC-signed
  HttpOnly/Secure/SameSite=Strict session cookie scoped to `/__ops`, Bearer
  fallback, per-IP login rate limiting, no CORS, strict CSP, `noindex`.

---

_End of architecture design. Awaiting approval to proceed to Phase 3
(implementation), which per Discovery §10.E starts at **M1: `PdfIndexCollector`
for Othaim + Farm**._
