# Hotspot Root-Cause Investigation — Al Madina page 6

Why the in-app brochure viewer shows only **3** tappable products on Al Madina
page 6 when the page carries **20** product hotspots.

Every number below was **measured**, not inferred. The instrumentation lives on
branch `claude/hotspot-count-instrumentation-kgph3s` in two repos:

- backend `tamamoooo-dev/shopping-connector` — `brochure-engine/debug/*.mjs`
  (parser, join, API, and offers-shortfall censuses) + the
  `hotspot-census` workflow.
- frontend `tamamoooo-dev/live-shopping-assistant` — `debug/hotspot-stage-census.mjs`,
  `debug/hotspot-dom-census.mjs` + `viewer-harness.html` (real `viewer.js` in
  headless Chromium) + the `hotspot-stage-census` workflow.

The sandbox has no egress to D4D or the production Worker, so every live
measurement was run from GitHub Actions (which does) and read back from the job
logs.

---

## Symptoms

- Production viewer (`brochure-engine.tamamoooo.workers.dev` + the frozen
  frontend) renders **3** interactive product hotspots on Al Madina
  "Summer Shop N Win" (edition `2026-W28`, D4D flyer `742356`) **page 6**.
- The same page visibly contains ~20 products, and an early report claimed the
  parser "only captured the first spread," which page 6 already contradicted
  (it had spots at all).

---

## Measurements

Four independent censuses, each reproducing a real stage with production code:

| Census | What it exercises | Harness |
|---|---|---|
| Parse | raw HTML → regex → normalize → dedup → persisted, per page | `brochure-engine/debug/hotspot-census.mjs` |
| Join | ingest-time `spot.offerId` → offers row, per page | `brochure-engine/debug/hotspot-join-census.mjs` |
| API + viewer | prod `/brochures/hotspots` → `loadHotspots` → `renderSpots` → DOM | `live-shopping-assistant/debug/hotspot-stage-census.mjs` + `hotspot-dom-census.mjs` |
| Offers shortfall | why prod D1 holds 64 offers, not 462 | `brochure-engine/debug/offers-shortfall-census.mjs` |

The parser and join were measured **lossless** for page 6, so the loss is
downstream of both:

- **Parse** (live D4D): page 6 = **20** spots (Summer) / **28** (Smashing
  Prices), identical through raw → regex → normalize → dedup → persisted. The
  only parser loss anywhere was 6 records across the 32-page flyer (pages 10,
  26, 28) from a duplicate `data-coords-json` container copy the strict
  container regex (`hotspots.js:76-77`) does not match — **unrelated to page 6**.
- **Join** (ingest-time, live D4D): the 722 company offers partition exactly
  onto the three live flyers (`742356:462 · 742491:235 · 743796:25`), and
  **every** page-6 spot joins — Summer **20/20**, Smashing Prices **28/28**,
  zero failed joins of any class.

---

## Eliminated hypotheses

| # | Hypothesis | Verdict | Basis |
|---|---|---|---|
| — | `parseHotspots()` drops spots | **Eliminated** | page 6 lossless raw→persisted (Parse census) |
| — | hotspot→offer **join logic** drops spots | **Eliminated** | 20/20 and 28/28 join at ingest (Join census) |
| — | **viewer rendering logic** is buggy | **Eliminated** | viewer faithfully renders every offer-backed spot; it only skips spots with no offer (`viewer.js:279`) |
| 3 | rows deleted by `pruneExpiredBefore()` | **Eliminated (code)** | cutoff is `today − 180d` (`retention.js:73`); these offers expire 2026-07-11/07-14 — impossible to prune |
| 2 | D4D `products/search` returned only ~64 | **Eliminated** | survivors span the near-full flyer id range `92773374..92774643`; D4D serves all 462, every one priced |
| 6 | ingested before D4D finished publishing/pricing | **Eliminated** | same as #2 — the full id range was already published; all 398 missing ids are priced now |
| 1 | offset-paging terminated early | **Eliminated** (as stated) | survivors are not a low-**id** prefix (leading id-run = 1 of 64) — but see Root cause: they *are* the leading rows in **write** order |
| — | price gate (`buildOffer`) dropped rows | **Eliminated** | 0 survivors price-gated; all 398 missing ids are priced now |

---

## Runtime measurements

Al Madina page 6, production, traced `D1/KV → GET /brochures/hotspots →
loadHotspots → renderSpots → DOM`. Confirmed two independent ways — a
deterministic transform of the live payload **and** the literal shipped
`viewer.js` running in headless Chromium — which agreed exactly:

| Stage | Count | Where |
|---|---|---|
| 1 — API returned | **20** | `getHotspotsDoc` response body |
| 2 — received by `viewer.js` | **20** | `loadHotspots` passes all spots + the whole offers map through (`brochure.js:281-282`) |
| 3 — DOM `.bv-spot` elements created | **3** | real `viewer.js` in Chromium |
| 4 — interactive | **3** | each created button gets its click listener unconditionally (`viewer.js:291`) → stage 4 == stage 3 |

The 17 missing spots are dropped at **`viewer.js:279`**:

```js
const offer = hotspots.offers[s.offerId];
if (!offer) continue;   // no matching offer -> no DOM element, never interactive
```

A spot with no matching offer produces **no element at all**. So the clickable
count equals the number of page-6 spots whose `offerId` is present in the API's
`offers` map — and that map is short.

---

## Production census

The `offers` map the API shipped alongside page 6's 20 spots covered only **3**
of them. The whole flyer:

- `byFlyer(742356)` in production returns **64** offers (authoritative,
  not currency-filtered) against **462** hotspot spots.
- All 64 share **one** `detectedAt`: `2026-07-09T06:00:38.076Z`. Because
  `detected_at` is **not** in the `ON CONFLICT DO UPDATE` set
  (`offerStore.js:24-32`), that is the **first-insert** time — no earlier or
  later run has inserted any of them.
- All 64 are priced; `validTo` = `2026-07-14` (61) / `2026-07-11` (3).
- Company-wide production coverage that run: `742356:64 · 742491:16 · 743796:0`
  = **80** offers total.
- Live D4D now: `742356:462 (all priced) · 742491:235 · 743796:25` = **722**.
- **398** of the flyer's 462 ids are missing from production; **all 398 are
  priced in D4D right now**.
- Engine offers table overall: `{total: 20626, current: 4465, stores: 11}`.

**80 = exactly 2 × 40**, and 40 is the `upsertMany` D1 batch size
(`offerStore.js:47-49`).

---

## Root cause

**A single offers-ingest run truncated its D1 write after 2 batches.**

On `2026-07-09T06:00:38Z` the cron ingested the new `2026-W28` edition. Brochure
and offers ingest share **one Worker invocation** under one Free-plan
50-subrequest budget (`engine.js:454-456`): the brochure ingest runs first and,
because this was a *new* edition, downloaded the flyer's page images (each a
subrequest), consuming most of the budget. The offers ingest then called
`offerStore.upsertMany(722 rows)`, which writes **40 rows per D1 batch = one
subrequest per batch**. It committed **2 batches (80 rows)** and the 3rd batch's
call exceeded the invocation limit and threw. The exception was swallowed by
`ingestOffersForTarget`'s `try/catch` (`offers/ingest.js:104`), so the partial
write left **no visible failure** — 80 rows persisted, the other 642 never
wrote.

Because `detected_at` is preserved across upserts, no later run has re-inserted
the missing rows (the next scheduled fire had not yet run at census time; once
it does with the edition already held and cheap, the offers write should get
full budget and self-heal).

Downstream, `byFlyer(742356)` returns those 64 rows; the viewer joins page 6's
20 spots against them, finds 3, and drops the other 17 at `viewer.js:279`.

This is hypotheses **1 + 4 + 5 acting together** (early termination, via an
exception, triggered by a per-invocation resource limit). It is **not** #2
(source shortfall), **not** #3 (retention), **not** #6 (publish race), and not
the price gate.

---

## Evidence

1. **Batch boundary.** 80 stored = exactly 2 × 40, the `upsertMany` chunk size.
2. **Single run.** All 64 survivors share `detectedAt 2026-07-09T06:00:38.076Z`;
   `detected_at` is first-insert-only (`offerStore.js` upsert omits it).
3. **Not the source.** D4D serves 462 for the flyer, all priced; survivors span
   the near-full id range, so the full flyer was published at ingest.
4. **Not the price gate.** 0 survivors price-gated; all 398 missing ids priced.
5. **Not retention.** `pruneExpiredBefore` cutoff is `today − 180d`
   (`retention.js:73`); these expire in days, not months.
6. **Shared-invocation mechanism.** `engine.js:454-456` runs brochure + offers
   ingest in one 50-subrequest invocation; D1 batches count as subrequests;
   the error sink is `offers/ingest.js:104`.
7. **Viewer gate.** Real `viewer.js` in Chromium created 3 `.bv-spot` elements
   for page 6; the drop is `viewer.js:279`.

---

## Remaining verification (batch-order positional test)

To distinguish "wrote 80 of 722" from "any other way to arrive at 80," the
positional test checks whether the stored rows are the **leading rows in D4D's
API/write order** (what 2 committed batches would be). Result:

- stored offers' index range in the current raws: **3 .. 86** of 722.
- stored offers within the **first 80** raws: **73 of 80**.
- perfectly contiguous `[0..79]`: **NO** — expected, because D4D's API order
  drifts between the 07-09 ingest and the 07-10 census (offers shift a few
  slots); the cluster at the very front is unambiguous.
- **80 == 2 × 40** exact batch boundary.

This confirms the survivors are the **front** of the write, not a scattered
subset — the signature of a truncation after 2 batches. It also reconciles the
earlier "scattered, not an id-prefix" finding: D4D's API order is not id-sorted,
so the leading write rows are contiguous in **position** yet scattered in **id**.

**Not yet distinguishable without production run logs:** which specific limit
threw on the 3rd batch — subrequest cap (most likely, given D1 batches are
subrequests and the brochure image downloads preceded it in the same
invocation), CPU, or wall-clock. The structural cause — one invocation, budget
exhausted mid-`upsertMany`, error swallowed — is fixed regardless. Re-running
the `hotspot-census` workflow after the next successful ingest of this store
should show the offers count for `742356` climb toward 462 and page 6 recover to
20 interactive; if it does not, capture the `/ingest` report's `offers` line
(it will carry the swallowed error message) to name the exact limit.
