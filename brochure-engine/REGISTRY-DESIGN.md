# Product Registry & Registry Resolution — Technical Design

Status: **LOCKED + IMPLEMENTED (2026-07-18).** Every phase is code-complete
(src/registry/: model, read, resolver, learn, apply, drain, lifecycle,
history, review, calibrate, memstore + storage/registryStore.js; offline
suites green); NOT yet deployed — deploy runbook in the app repo's
HANDOFF §11 TODO 0. Every code change must cite a section of this design.
Companion to IDENTITY-V2.md (whose §3 gates, §3.1 verdicts, §6 freeze, §9
versioning and §10 standing metrics carry forward into this design; whose
§7.2/§7.3 experiments this design answers).

Implementation notes against the sections below:
- §3 gates: IDENTITY-V2 gate 2b (bare OR-deal) is now designed + built —
  vision-names-only, ≥2 substantial sides, verdict `or_deal`; its live rate
  in /registry/stats is the before-lock measurement.
- §5.4: merge bar = tMerge 0.85 (> tAttach) + brand-conflict veto + shared
  store OR same-size-both requirement; sightings keep their original
  product_id (reversibility); merge log = ops-audit rows.
- §7: Price History V2 + /offers productId + product watches (kind
  `registry`) + review surface are all behind the SEARCH_PIPELINE /
  ?pipeline A/B (user's validation method, supersedes §7's shadow-first
  ladder order); Browse-on-registry waits for the A/B verdict.
- §8: calibrate-registry.mjs (+ src/registry/calibrate.js) is the labeled-
  pair export/replay/sweep harness; ship gate encoded as GATE (95% / 0.5%).

Date: 2026-07-18.

## 0. The one-sentence idea, and why the evidence demands it

**Identity by ASSIGNMENT, not derivation:** a product's identity is an opaque
registry row minted once; every later sighting *matches into* it with
tolerance. The stability experiment proved no derived key can work — reads of
the same product agree only 60.5% under exact hashing — while the
decomposition proved the same reads agree **86.9–99.0%** under tolerant
comparison at **0.00%** measured precision cost. Wobble must be absorbed at
match time, because it cannot be eliminated at read time (the flyers
themselves reprint different facts weekly). A registry converts "same key
forever" from a property we *hope* derivation has into a property assignment
*trivially* has — the hard problem moves to matching, where the data says
tolerance is cheap and safe.

Design principles carried from the measurements:

- **P1 — Prefer false splits over false merges.** A false merge pollutes
  price history invisibly (wrong "lowest ever"); a false split only
  fragments, and fragments can be healed by a later merge. Every threshold
  below is biased accordingly.
- **P2 (revised 2026-07-21) — Brand is evidence, never a REQUIREMENT, but a
  determinable conflict is a veto.** Requiring brand agreement (penalizing a
  missing brand) cost −4.4 points, and granularity wobbles ("Sebamed" vs
  "Sebamed Baby") stay compatible. But production showed cross-brand
  review-band pollution (Nadec/AlRabie sightings on the Al Safi UHT product,
  pr_b01c5a6e2f8f) riding generic-token containment (milk/uht/full/fat):
  when BOTH sides read a brand and neither contains the other, the candidate
  is vetoed — create-on-doubt (P1) makes this safe.
- **P3 — Size is a strong veto but a weak confirmation** (90.1% stable when
  both read; frequently unread on one side — nosize must be compatible with
  sized, per L2→L3 gains).
- **P4 — Token containment ≥ 0.6 is the workhorse** (validated: +22.5 points,
  0% false matches), computed against an accumulated profile, not a single
  prior read.
- **P5 — Uncorroborated reads mint nothing** (unchanged from IDENTITY-V2 §3:
  a hallucination must not create a product).

## 1. Data model (D1, same database as the engine)

### 1.1 `products` — the registry

| column | notes |
|---|---|
| `id` | opaque `pr_<random>`; minted once; NEVER derived from content |
| `status` | `active` \| `merged` \| `dormant` |
| `merged_into` | product id when status=merged (tombstone; single-hop enforced) |
| `kind` | `product` \| `assortment` (IDENTITY-V2 §3 gate 2 carries over) |
| `display_name`, `display_name_ar` | best-evidence pick (§5.3) — presentation only, never matching input |
| `brand_slug` | canonical (detectBrand) when known; metadata |
| `brand_text` | best raw vision brand read; matching *evidence* |
| `size_unit/size_total/size_pack` | nullable; adopted per §5.3 |
| `family`, `category` | engine lexicon/taxonomy values; blocking + Browse |
| `token_profile` | JSON: token → {seen_count, last_seen_week} (capped, §5.2) |
| `sightings`, `stores_seen`, `first_seen`, `last_seen` | evidence summary |
| `review_flag` | needs-human (split suspicion, §6) |
| `algo_version` | resolver version that last touched it |

Rationale: one row per *product*, small and denormalized enough that a
resolver pass reads candidates in one query. The token profile IS the
product's identity evidence — richer than any single read, which is why a
registry should beat the pairwise 86.9% (a five-sighting profile bridges
wobble two single reads cannot).

### 1.2 `product_tokens` — the inverted index (blocking)

`(token, product_id)` rows for every token in an active product's profile.
Candidate retrieval = the products sharing at least one *distinctive* token
with the incoming read (§4.1). Trade-off: table is ~10× `products` in rows
but keeps candidate retrieval indexed — a full-registry scan per offer would
not survive D1 at 30k+ products.

### 1.3 `product_sightings` — the join that everything hangs off

| column | notes |
|---|---|
| `offer_id` | PK — resolution is idempotent per offer by construction |
| `product_id` | the assignment |
| `match_band` | `auto` \| `review` \| `created` |
| `match_score`, `corroboration` | audit + §10 metrics |
| `store`, `region`, `week`, `price` | denormalized for history/queries |

A sighting is the atomic fact: "this offer was this product, this week, at
this price." Price History V2 derives *entirely* from sightings; there is no
second bookkeeping path to drift out of sync. The offers table is untouched
(offer ids still churn weekly — sightings absorb that churn).

### 1.4 What is deliberately NOT stored

- No derived identity key anywhere — nothing to go stale.
- No V1 identity linkage — V1 stays frozen per IDENTITY-V2 §6; no mapping.
- No image bytes — `image_url` on the offer/sighting suffices for audit.

## 2. Where resolution runs

Inside the existing **paced enrichment drain** (offers/enrich.js flow), as a
post-step after an enrichment is stored: D1-only work, zero extra
subrequests, zero new scheduling machinery. Offers without a servable
enrichment simply have no sighting — exactly today's identity-null behavior.

Consequence to accept: resolution lags ingest by up to the drain latency
(hours). Price history points appear when the sighting does. This is fine —
history is a weekly-granularity dataset.

Concurrency: drain children run SEQUENTIALLY (already true, rate pacing).
The resolver therefore assumes a single writer; the §6 consolidation job is
the safety net for any duplicate creation that slips through.

## 3. Resolver workflow (per enriched offer)

```
enrichment stored → mint gates (IDENTITY-V2 §3, unchanged)
  → normalize read (EN-preferred tokens, fold diacritics, size grammar)
  → BLOCK: candidate products via token index + size compatibility
  → SCORE each candidate (§4)
  → best score ≥ T_attach  → attach sighting (band=auto), update product (§5)
  → T_review ≤ score < T_attach → attach to best (band=review), queue for
                                   sampled human review; profile NOT updated
  → score < T_review → CREATE product (band=created), profile = this read
```

Design choices and reasoning:

- **Review band attaches but does not teach.** Attaching keeps history
  usable (weekly review heals mistakes); not updating the profile prevents a
  wrong attachment from poisoning future matching — containment (P1) between
  "usable now" and "cautious forever".
- **Create-on-doubt** (P1): below T_review we mint a new product rather than
  force a match. New-product rate is a §8 metric; duplicates heal by merge.
- **Sticky incumbency:** if the offer's OWN prior-week counterpart (same
  store, near-identical OCR text) has a sighting, its product enters the
  candidate set with a score bonus — hysteresis against thrash between two
  similar products.

## 4. Matching strategy & confidence model

### 4.1 Blocking (candidate retrieval)

Candidates = products sharing ≥1 token whose registry frequency is below a
commonness ceiling (a token appearing in >2% of products blocks nothing —
"fresh", "chicken" alone retrieve half the catalog), UNION the sticky
incumbent. Size incompatibility (both sized, different) filters candidates
before scoring. Trade-off: blocking recall vs cost; the escape hatch is that
a miss creates a duplicate, which consolidation (§6) can later merge —
degradation is P1-shaped, never a wrong merge.

### 4.2 Score

Weighted evidence, calibrated on the labeled pair set (§8) — weights below
are priors for review, not constants to defend:

| signal | contribution | grounding |
|---|---|---|
| token containment (read vs profile) | dominant (~60%) | §7.3: +22.5pts, 0% FP |
| size relation | equal: strong + / one nosize: neutral score but caps band at review / conflict: **veto**; dual-size alternations ("12x1L / 4x1L") read as nosize | P3 revised 2026-07-21 |
| brand relation | compatible: + / conflict (neither contains other): **veto** / missing: neutral | P2 revised |
| family/category agreement | small + | lexicons are stable |
| sticky incumbent | small + | anti-thrash |
| corroboration of the read | scales the whole score down when near floor | P5 |

Two thresholds, not one (T_attach > T_review), initialized from the measured
containment separation (match cases clustered ≥0.6; negatives at 0.00%
false-match) and then CALIBRATED, not asserted: the human-labeled pair set
is the calibration input and becomes the §10 regression corpus.

### 4.3 Per-product confidence

Derived, not stored authority: sightings count, distinct stores, distinct
weeks, profile concentration. Consumers may render low-confidence products
differently (e.g. Browse hides 1-sighting products from "lowest ever"
claims). A 1-sighting product is a hypothesis; a 5-week 3-store product is a
fact.

## 5. Product lifecycle & update rules

### 5.1 States

`created → active ⇄ dormant → (merged)` — dormant after N (=6) weeks unseen:
excluded from current-facing views, retained forever for history (rows are
tiny; watches may reference them). `merged` is a tombstone pointing at the
survivor; single-hop (merging into a merged product re-points to its
survivor) so reads never chase chains.

### 5.2 Token profile update (auto-band only)

Increment seen tokens, add new ones, cap profile at ~24 tokens by dropping
lowest-count-oldest. Cap rationale: unbounded profiles drift toward matching
everything (poisoning); the cap plus count-weighting keeps the profile a
consensus of what this product is usually called.

### 5.3 Display fields & size adoption

- Display names: the highest-corroboration recent read wins (presentation
  freshness without matching consequences).
- Size: a sized read fills a nosize product; a CONFLICTING sized read (both
  read, different) does not overwrite — it flags `review_flag` (possible
  variant split hiding inside one product; §10's suspicion metric).
- `brand_slug`: re-run detectBrand on profile; only ever set/upgraded,
  conflicts flag review.

### 5.4 Merge & split

- **Merge (duplicate healing): automated but conservative.** Weekly
  consolidation job scores product pairs (same blocking) with a threshold
  strictly above T_attach plus requirements a live match never has (e.g.
  overlapping stores or same size read on both). Merges are logged,
  reversible in principle (sightings retain their own reads), and gated by
  the §10 corpus (a merge that would join a known-split pair cannot ship).
- **Split: human-gated only.** Signals (intra-product same-week price
  bimodality, size conflict, token bimodality) raise `review_flag`; the Ops
  Console review assigns sightings to a new product. Asymmetry rationale =
  P1: an automated wrong split is survivable, but split automation requires
  clustering sightings — complexity not justified until §8 metrics show
  splits are common.

## 6. Failure cases and their containment

| failure | containment |
|---|---|
| Hallucinated read | corroboration gate (P5) — no sighting, no product |
| Vision/API outage | offers simply lack sightings until drain resumes; history has gaps, never wrong data |
| Blocking miss | duplicate product → consolidation merge; never a wrong attach |
| Wrong auto-attach (false merge) | the top risk (P1): high T_attach, size veto, review-band buffer, §10 suspicion metrics, weekly sampled review; sighting-level reassignment is the repair |
| Wrong create (false split) | new-product rate metric; healed by merge job |
| Profile poisoning | review band doesn't teach; profile cap; algo_version stamps enable re-resolution of a poisoned window |
| Model swap | regression suites (20-case names + labeled pairs + §10 corpus) must pass before the new model's sightings attach; disagreement spike alarms in §8 metrics |
| Assortment tiles | `kind=assortment` products (IDENTITY-V2 rule): assortments match only assortments; a specific-flavor read never attaches to one |
| Registry growth | ~1 row/product + inverted index; at 30–50k products this is megabytes in D1; dormancy keeps hot queries small |
| Order dependence | acknowledged: different ingest order → different (but equivalent-quality) registries; what must be deterministic is per-offer idempotency (sightings PK) — re-runs are no-ops |

## 7. Consumer integration

- **Price History (V2):** points = sightings. Market-wide by construction
  (product ids are store-agnostic; per-store views group sightings by
  store) — the §5 IDENTITY-V2 goal achieved without cross-store key
  agreement ever being a requirement. "Lowest ever anywhere," "weeks seen,"
  price trend per store, all from one table. V1 history frozen, untouched.
- **Search (/offers):** the matching substrate (search_text + names +
  enrichment overlay) is UNCHANGED — resolution adds `productId` to served
  offers, enabling: cross-store grouping of the same product in results,
  "cheapest of 4 stores" annotations sourced from sightings rather than
  fuzzy name-matching, and history badges with zero extra lookups. Ranking
  changes are explicitly out of scope (locked lowest-price ordering is
  untouched).
- **Browse:** brand rails and family shelves join products directly
  (brand_slug/family on the registry row); "lowest ever" badges become
  per-product facts gated by product confidence (§4.3). Replaces the V1
  identity stamping path.
- **Watches/Alerts:** the biggest user-facing win — a watch can bind to a
  `productId` (stable across weeks!) instead of only a query. Query watches
  remain; product watches alert on "THIS product, any store, price ≤ X"
  with sighting precision. Profile-scoped as today.

Rollout order (each step independently reversible): shadow registry (no
consumer reads) → §8 metrics stabilize → Price History V2 writes → Browse
badges → /offers productId → product watches. Rollback at any step =
consumers reread V1 paths; the registry is side-car until the last step.

## 8. Metrics & validation (extends IDENTITY-V2 §10)

Standing: match-band distribution (auto/review/created per drain),
new-product rate over time (must DECAY toward the true new-product rate as
coverage builds — a flat rate means blocking is missing matches), merge-job
activity, suspicion rate, review-queue depth, per-product confidence
distribution. Pre-implementation validation: build the **human-labeled pair
set** (a few hundred pairs via the comparison-mode workflow), replay the
resolver over the held shadow + prior-week reads in simulation, and require:
same-product attach ≥ 95%, false-attach ≤ 0.5%, calibrated thresholds. The
same replay becomes the permanent regression harness for every resolver or
model change.

## 9. Explicit trade-offs accepted

1. **Statefulness over purity:** order-dependent, needs healing jobs —
  bought because pure derivation is measured-impossible (60.5%).
2. **Two-table bookkeeping** (products + sightings + index) over one derived
  column — bought for market-wide history, stable watch targets, and audit.
3. **Human review in the loop** (bounded: sampled weekly + flags) — bought
  by P1; the alternative (full automation) makes false merges silent.
4. **Resolution latency ≤ drain latency** — irrelevant at weekly data
  granularity.
5. **Free-tier reader retained** — resolution is D1-only; reader economics
  unchanged; upgrade triggers from the operational policy still stand.
