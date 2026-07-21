# Identity V2 — Structured Product Identity Specification

Status: **LOCKED 2026-07-18 (`ALGO_VERSION = 1`) — EXPERIMENT FAILED (§7.2).**
The cross-week stability experiment falsified the exact-hash key design:
pooled cross-week agreement 60.5% vs the ≥98% target, with a 92.8%
determinism ceiling (same crop, two calls). ALGO_VERSION 1 must NOT be
implemented as canonical identity. §7.2 records the results and the failure
patterns; the §3 gates, §3.1 verdicts, §6 storage/freeze, §9 versioning and
§10 standing metrics SURVIVE and carry into any ALGO_VERSION 2 redesign
(candidate directions in §7.2). Name-serving (the enrichment overlay) is
unaffected — it never depended on exact keys.

Date: 2026-07-18. Evidence base: the 10,180-offer shadow comparison, the
20-case human adjudication, and the V1 pollution measurements (31,143
identities minted from ~38k offer sightings in 16 days; 75% with no parsed
size; 38.5% seen exactly one week).

## 1. Purpose and failure model

An identity is the cross-week join key of Price History: *same product ⇒ same
key, forever; different product ⇒ different key*. V1 derives it by hashing the
normalized OCR display-name string plus a parsed size. Measured failure modes:

- **Fragmentation** (dominant): OCR text varies per flyer render, so the same
  product mints a new identity most weeks → history is single-sighting stubs.
- **Size collision**: 75% of V1 identities parse no size, so pack variants of
  the same name merge → "lowest ever" can attach a small-pack price to a
  large pack. This is *wrong* data, not just sparse data.

V2 exists to fix both by deriving the key from vision's **structured** reading
(brand / name / size as separate fields) instead of hashing a free-text string.
Design principle: **stability by construction** — every rule below is chosen to
make phrasing variance NOT change the key, rather than hoping the model
phrases identically.

## 2. Inputs

Per offer, in priority order:

| Input | Source | Trust |
|---|---|---|
| `vision.name`, `vision.nameAr` | enrichment record | primary, gated |
| `vision.brand`, `vision.size` | enrichment record | primary, gated |
| `corroboration` | enrich.js (token overlap vs OCR text) | the serving gate |
| `search_text` | offer row (raw OCR) | witness + guard input only |
| `category` | aggregator taxonomy | metadata only, never in the key |
| `store`, `region` | offer row | **not in the key** (see §5) |

## 3. Mint gates — when an offer gets NO V2 identity

An offer is excluded from Price History (exactly like V1's null-identity
offers) unless ALL hold:

1. **Enrichment servable**: a stored enrichment with (name or nameAr) and
   `corroboration ≥ 0.3`. A hallucinated read must not mint a fake product —
   with V2, an uncorroborated identity would fabricate a *price history*, a
   worse failure than a bad display name.
2. **Multi-product tile handling — MEASURED, rule revised (2026-07-18).**
   The draft excluded any tile matching an assortment/OR-deal marker.
   Pre-measurement over the shadow set falsified that as too blunt:
   bare `" او "`/`" or "` matching fired on 20.7% of the catalog (OCR noise),
   and even explicit markers (`assort|combo|تشكيل|متنوع|اصناف`, plus
   `selected|مختار` found by the §7.1 crop review) hit **~16%**
   — because most "assorted" tiles are legitimate single-price flavor
   assortments ("MOBI Dishwash 1L Assorted" = one price, any flavor) that
   DESERVE a price history. The failure to prevent is narrower: vision naming
   ONE flavor of an assortment (the Ruffles case). Revised rule (Q3 resolved
   toward "degraded assortment identity"):
   - explicit assortment marker present → mint an **assortment identity**:
     token set from the name minus flavor-specific tokens beyond the brand +
     product-type core, plus a literal `assorted` token; never key on
     vision's single-flavor read.
   - bare OR-deal tiles (`او`/`or` between two product phrases with two
     crops) → no identity (these are true two-product choices); the detection
     pattern needs design and must be re-measured before lock.
     **Designed + built 2026-07-18 (registry/read.js `isOrDeal`):** the
     marker is read from the VISION name fields ONLY (matching raw OCR was
     the measured 20.7% false-fire trap), word-bounded, and both sides of
     the conjunction must carry ≥2 evidence tokens — "fresh or frozen" and
     "or"-substrings never fire. Verdict `or_deal` is recorded per §3.1, so
     the lock-gating re-measurement is a standing /registry/stats read once
     the catalog is enriched (plus `calibrate-registry.mjs measure` offline).
3. **≥ 2 core tokens** after normalization (§4.2) — V1's own single-token
   rule, kept: one word is not a product identity.

### 3.1 Mint verdicts — every exclusion is recorded, never silent

Minting is a total function: every current offer receives exactly one verdict,
stored (column on the enrichment row) and surfaced as Ops Console counters:

| Verdict | Meaning |
|---|---|
| `minted` | identity assigned |
| `no_enrichment` | no enrichment record yet (drain hasn't reached it) |
| `declined` | vision could not identify the product |
| `low_corroboration` | enrichment exists, gate 1 failed |
| `assorted_tile` | gate 2 failed (which marker matched is logged) |
| `or_deal` | gate 2b failed (bare two-product choice tile — 2026-07-18) |
| `too_few_tokens` | gate 3 failed |
| `no_size` is NOT a verdict — sizeless offers still mint (`nosize` key part); the rate is tracked as a metric instead |

Rationale: the V1 postmortem required manual archaeology to learn that 75% of
identities were sizeless. V2's failure surface must be a dashboard read, not an
investigation — improvements get prioritized by verdict counts, not anecdotes.

## 4. The key

```
key      = "idv2:" ALGO_VERSION ":" tokenPart ":" sizePart
identity = "ph2_" fnv64(key)
```

The full serialized `key` is stored alongside the hash (debuggability, and
collision audit — fnv64 collision odds at catalog scale are negligible but
must be observable, not assumed).

### 4.1 Language rule — DECIDED BY MEASUREMENT (challenge round, Q2)

Three candidate strategies, all derivable from the same enrichment record:

- **A. EN-preferred**: tokens from `vision.name` when present, else `nameAr`.
- **B. Bilingual union**: tokens from both names, one sorted set.
- **C. AR-preferred**: the mirror of A.

The hypothesis behind A (fewer variance sources; EN read more consistently)
is plausible but unmeasured — the stability experiment derives keys under all
three strategies from the same calls and the most stable one is locked.
Static facts that scope the question (measurable offline from shadow data):
EN-name coverage, AR-only rate. Bilingual reach for *matching* remains
`search_text`'s job regardless of the winner.

### 4.2 Token part

From the chosen name:

1. `normalizeText` (matching.js — lowercase, punctuation strip, Arabic glyph
   folding: the existing engine-wide normalizer, byte-identical rules).
2. Apply the brand-normalization repair index (viewer/brandNormalize rules as
   ported in browse/brands.js) to each token — "sensodine" → "sensodyne" —
   so known misreadings collapse to one form.
3. Add `vision.brand` tokens (same normalization). Union with name tokens —
   brand-in-name vs brand-in-field disagreement resolves to "both contribute
   tokens once".
4. Drop: banner words (contract.js BANNER_WORDS), digit-only tokens, tokens
   consumed by the size parser (§4.3), single-character tokens.
5. Keep alphanumeric model codes ("hr2535") — they distinguish appliance
   variants. (Flagged §8-Q4: the stability experiment measures both with and
   without.)
6. **Sort remaining tokens lexicographically, dedupe, cap at 8** (keep the 8
   lexicographically-first; deterministic). Sorting makes the key
   order-insensitive: "Halah Sunflower Oil" ≡ "Sunflower Oil Halah".

`tokenPart = tokens.join(" ")`

**Clarification (challenge round, Q-brand):** brand *tokens* ARE in the hash —
step 3 unions `vision.brand` tokens into the token set, so two products with
different visible brands key differently as long as vision reads either the
brand field or a brand word in the name. What stays OUT of the hash is only
the canonical `brand_slug` (detectBrand) — a *metadata column* — so growing
the brand vocabulary improves Browse joins without ever re-keying history.
The residual false-merge risk is the case where vision reads NO brand signal
at all for two same-named same-sized products of different brands. This rate
is measured, not intuited: the collision audit (§7) runs over the full shadow
dataset offline and reports key groups whose members carry conflicting
`vision.brand` values or visibly different crops.

### 4.3 Size part

Parsed from `vision.size` (the structured field) first; if absent/unparseable,
from the chosen name via the same grammar. Grammar:

- Units canonicalized to three bases: `ml` (l→×1000), `g` (kg→×1000), `pcs`
  (pc/pcs/pieces/حبه/قطعه). Arabic unit words map to the same bases
  (لتر→l, مل→ml, كجم/كغ→kg, جم/جرام/غرام→g).
- Pack multiplier from `x2 | ×2 | 2x | 2 pcs pack | "1l x12"` forms:
  `total` is the unit size, `pack` the count. "1.5L x 2" → `ml:1500:2`.
- A single approximate weight ("approximately 900 gm") parses as its number:
  `g:900:1` — stable iff the flyer prints the same nominal weight weekly
  (the experiment measures this).
- A **range** ("7 to 9 kg") or multiple conflicting sizes ("1.9L + 1.3L")
  → `nosize`. A range is not a pack size, and multi-size tiles are usually
  §3.2 combos anyway.
- Nothing parseable → `nosize`.

`sizePart = unit ":" round(total) ":" pack` or `"nosize"`.

Expectation vs V1: V1 measured 75% `nosize`; vision returned a usable size
field for the large majority of shadow-run reads. The experiment reports the
V2 nosize rate; if it is not dramatically below 75%, that alone is a design
failure worth revisiting.

### 4.4 Worked examples (real shadow-run reads)

| Vision read | tokenPart | sizePart |
|---|---|---|
| "Samyang Chicken Ramen Bowl", brand Samyang, 105g | `bowl chicken ramen samyang` | `g:105:1` |
| "Fresh Duck" / approx 900gm | `duck fresh` | `g:900:1` |
| "Halah Pure Sunflower Oil", brand Halah, "1.5L x 2" | `halah oil pure sunflower` | `ml:1500:2` |
| "Sunflower Oil — Halah 1.5L ×2" (phrasing wobble) | `halah oil sunflower` ✗ | `ml:1500:2` |

The last row shows the residual risk the experiment quantifies: sorting kills
*ordering* variance, but token *presence* variance ("Pure" read one week,
dropped the next) still splits keys. This is measured, not assumed away.

## 5. Scope of the key: market-wide — EARNED BY MEASUREMENT (challenge round, Q1)

Decision rule agreed: the key ships **store-scoped unless** the cross-store
stability metric (§7) reaches its target — market-wide identity is the
preferred direction but must be earned by the experiment, not assumed.
The rest of this section describes the market-wide design that measurement
would unlock.

V1 keys include `store|region`, so the "same product" at two stores is two
identities and Price History can never say "lowest ever *across the market*".
V2's key content (brand/tokens/size) is store-independent, so the store scoping
becomes a **query-time choice, not a key-time loss**:

- `price_identities_v2` row: one per (identity) — the product.
- `price_history_v2` point: (identity, store, region, date, price) — the
  observation.

Per-store views (V1 semantics) group by (identity, store); the market-wide
"lowest ever anywhere" view comes free. Risk accepted: cross-store keying
requires the same product to read identically from two stores' flyers —
different crops, same product. The stability experiment includes cross-store
pairs to measure exactly this (§7).

## 6. Storage and the freeze

- New tables `price_identities_v2`, `price_history_v2` (same shapes as V1
  plus: `key_text`, `algo_version`, `corroboration_at_mint`).
- V1 tables are **frozen in place**: no writes, no reads from product paths;
  retained for diagnostics. No row migration, no dual-stamping, ever.
- Badges (lowest-ever / weeks-seen) go dark and rebuild; with 16 days of
  depth and 38.5% single-sighting stubs, the visible loss is near nil.

## 7. The stability experiment this spec must pass (step 4)

Run against the LOCKED algorithm; produces the go/no-go number:

- **Pairs**: recurring products across ≥2 distinct weeks (from held flyer
  crops + offers history), same store (primary metric) and cross-store
  (secondary, gates §5).
- **Procedure**: independent vision calls per crop → V2 derivation → compare
  keys. Also re-call the SAME crop twice (call-to-call determinism control).
- **Metrics**: same-store key agreement (target **≥ 98%**), cross-store
  agreement (target ≥ 95%, else §5 falls back to store-scoped keys — a
  1-line change), nosize rate (target ≪ 75%), and component-level failure
  attribution (tokenPart vs sizePart) for every disagreement.
- **A/B inside the run**: with vs without model-code tokens (§8-Q4);
  language strategies A/B/C (§4.1); token caps 6/8/10 (§8-Q5). All variants
  derive from the SAME vision calls — the A/Bs are free re-derivations.

### 7.1 Offline pre-measurements — RESULTS (run 2026-07-18, 10,180 shadow reads)

- **Collision audit (Q-brand): two-layer methodology, revised finding.**
  Layer 1 (automated proxy): flag key groups whose members carry textually
  different non-null `vision.brand` strings — 15 of 6,146 keys (0.24%),
  ALL 15 manually reviewed: every one is brand-string granularity on the
  same real product ("johnson" vs "johnson johnson", "dabur" vs "dabur
  vatika"). Zero true merges in this layer; brand tokens in the hash work,
  `brand_slug` stays metadata-only. Layer 2 (blind-spot check the proxy
  can't see — both-brands-null and same-brand variant merges): CROP-level
  review of 10 randomly sampled multi-member key groups (of 1,250):
  9 correct merges (incl. desirable cross-store convergence: same Geepas
  microwave from two retailers), **1 true variant merge** — a Ranch
  dressing keyed with the same brand's "SELECTED" any-flavor assortment
  tile. Sample is small (1/10; wide interval) so the honest statement is:
  brand-driven false merges measure ~0, variant/assortment-driven merges
  exist at low-single-digit-to-~10% of multi-member groups and are the
  dominant residual risk. Two consequences: `selected|مختار` joins the
  assortment marker list, and the stability experiment's disagreement
  review must include a variant-merge count on a LARGER sample before
  this point closes.
- **Language coverage (Q2)**: 97.6% of reads carry BOTH names; AR-only 0.6%,
  EN-only 0.1%. Coverage cannot decide the strategy — it is purely the
  stability experiment's question.
- **V2 nosize rate: 27.6%** vs V1's 75% — a 2.7× improvement, with much of
  the residue genuinely sizeless (per-kg produce). §4.3's target is met.
- **Mint-verdict baseline (§3.1)**: minted 81.4%, assorted-marker 15.9%
  (see revised rule in §3 gate 2), low-corroboration 1.5%, too-few-tokens
  1.0%, declined 0.2%.
- **Early cross-store signal (Q1)**: 1,250 multi-member keys already include
  same-product-across-stores convergence (e.g. Al Watania chicken parts
  keying together from different retailers' flyers) — encouraging for the
  market-wide key, still gated on the cross-week experiment.

### 7.2 RESULTS (run 2026-07-18) — TARGETS NOT MET

520 new vision calls (400 prior-week crops, 120 same-crop determinism
controls) + the existing 10,180 current-week reads. Locked derivation
(lang A, model codes on, cap 8):

| Metric | Result | Target |
|---|---|---|
| Cross-week, V1-stable pairs (n=211) | 68.7% | — |
| Cross-week, hard pairs (n=126) | 46.8% | — |
| **Cross-week pooled (n=337)** | **60.5%** | ≥ 98% |
| **Determinism (same crop, 2 calls, n=97)** | **92.8%** | (implicit ~100%) |
| Cross-store convergence (OCR-matched candidates, n=251) | 48.2% | ≥ 95% |

A/B grid: EN-preferred is decisively the best language strategy (bilingual
23.6%, AR-preferred 22.1% — Arabic read variance is enormous); model codes
and token caps are immaterial (±2%).

Failure attribution (133 dumped disagreements): 36% token-SUBSET wobble
(descriptors appear/disappear between reads: "…ice cream vanilla" vs
"…ice cream"), 17% size-only (size read one week, missed the next — or the
flyer genuinely printing 800g vs 900g), 47% other token divergence — itself
partly normalization gaps (Latin diacritics not folded: "président" vs
"president") and single-glyph misreads ("iws"/"lws"), partly genuinely
different products (true splits, which are correct behavior).

**Why adjudication cannot rescue the verdict:** even crediting EVERY
"other" disagreement as a true split, pooled agreement caps at ~79% — far
under target. And the 92.8% determinism result is a hard ceiling: no
exact-match key over free-text reads can beat the model's own run-to-run
variance, before crop variance is even considered.

**Conclusion:** exact-hash identity over free-text vision names is
falsified — by the source material as much as the model (flyers reprint
different descriptions and sizes weekly; V1's OCR fragmentation was the
same disease). ALGO_VERSION 2 candidate directions, in preference order:

1. **Identity resolution against a registry** (entity-resolution): a new
   sighting MATCHES into existing identities by brand/size/token-overlap
   tolerance instead of deriving a key independently — wobble is absorbed
   by design. Stateful, but the engine is stateful.
2. **Canonical-vocabulary keys**: brand slug + product family/type from the
   engine's existing lexicons (browse taxonomy, offerFamily/productType) +
   size — a small closed token space that free-text wobble cannot touch,
   at the cost of coarser identities (variants collapse unless the
   vocabulary distinguishes them).
3. Hybrid: vocabulary key as the bucket, resolution within the bucket.

Either direction is a redesign requiring its own §7-style validation.
Interim: V1 identity remains canonical (unchanged, warts included) until an
ALGO_VERSION 2 passes; the names/display expansion proceeds independently.

### 7.3 Failure decomposition (run 2026-07-18, same data re-scored — no new calls)

Comparator ladder over identical reads: L0 exact key (locked) → L1 +Latin-
diacritic folding → L2 +size-tolerant (nosize matches sized) → L3 +token
containment ≥ 0.6 instead of set equality → L4 +brand-compatibility required.

| Set | L0 | L1 | L2 | L3 | L4 |
|---|---|---|---|---|---|
| Determinism (reader-only, n=97) | 92.8 | 92.8 | 93.8 | **99.0** | 99.0 |
| Cross-week pooled (n=337) | 60.5 | 61.1 | 64.4 | **86.9** | 82.5 |

Precision control: **0.00%** false matches at BOTH L3 and L4 on 300
different-product same-store pairs. Field stability when both sides read:
brand compatible 89.9%, size equal 90.1%, mean token containment 0.93.

Attribution of the 39.5-point exact-key failure:
- **Identity design (literal consumption): ~26 points** — recovered by
  comparator change alone, same model, same reads (60.5 → 86.9).
- **Reader variance: ~1 point** — determinism under tolerant consumption is
  99.0%; the reader is semantically consistent, its exact wording is not.
- **Residual ~12 points**: source-material variance (flyers printing
  different facts across weeks) PLUS hard-pair contamination (OCR-similarity
  candidates include genuinely different products, so 86.9 UNDERCOUNTS true
  same-product matching). Separating those needs human-labeled pairs.
- Normalization fixes alone: negligible (+0.6). Requiring brand agreement
  HURTS (−4.4): brand reads vary in granularity across weeks.

Consequence: registry RESOLUTION (§7.2 direction 1) is validated in
principle by simulation — same reads, tolerant consumption, zero measured
precision cost — and a real registry should exceed the pairwise 86.9%
because accumulated token evidence bridges wobble pairwise matching cannot.

## 8. Open questions for the challenge round

- **Q1 — Market-wide key (§5)**: accept the cross-store risk for the
  market-wide-lowest capability, with the measured fallback? Or stay
  store-scoped from day one?
- **Q2 — EN-preferred single-language rule (§4.1)**: accept that AR-only
  sightings key separately, for one fewer variance source?
- **Q3 — Assorted tiles fully excluded (§3.2)**: or mint a degraded
  "assortment" identity so those offers still get *some* history?
- **Q4 — Model-code tokens (§4.2 rule 5)**: variant precision vs phrasing-stability
  risk — decided by the experiment's A/B, but the tie-break preference
  should be stated now (proposal: precision wins ties).
- **Q5 — Token cap of 8**: arbitrary; the experiment can also report
  agreement at caps 6/8/10.

## 9. Versioning and maintenance

- `ALGO_VERSION` is inside the hashed key: ANY rule change (token filters,
  guard lists, size grammar) bumps it and starts a new generation — there is
  deliberately no such thing as an in-place algorithm tweak, because a tweak
  IS a re-key. Generations can coexist in the v2 tables (version column);
  read paths pin the current version.
- Model swaps do NOT bump the version (the key doesn't encode the model),
  but require re-running the stability experiment before the new model's
  enrichments mint identities: the 20 adjudicated cases + a pairs sample
  become the standing regression suite.
- The corroboration floor (0.3) is shared with name-serving and owned by
  enrich.js; raising it tightens both serving and minting together.

## 10. Standing quality metrics (permanent, not experiment-only)

The variant/assortment false-merge rate — the dominant residual risk found by
the §7.1 crop review — is a **permanent regression metric**, evaluated on
every change to the identity algorithm, the guard lists, the prompt, or the
model. Three layers, cheapest first:

1. **Automated suspicion rate** (computed at every ingest, surfaced as an Ops
   Console counter next to the §3.1 verdicts): within multi-member key
   groups, flag (a) members whose vision names differ in tokens that were
   dropped by the cap (a variant word may have been absorbed), (b) an
   assortment marker present in one member's OCR text but not the others,
   (c) same-week intra-group price spread beyond a threshold (one product,
   one week, two prices = suspicious). The *rate* of suspicious groups is
   tracked over time; a rise is investigated, not tolerated.
2. **The labeled merge corpus** (the regression gate): every group a human
   has ever adjudicated — the 15 brand-conflict groups, the 10 crop-reviewed
   groups, and every group reviewed during the stability experiment and
   later spot checks — accumulates into a fixed labeled set. Any change to
   the algorithm re-derives keys over the corpus and must keep every
   correct merge merged and every known false merge split. Changes that
   regress the corpus don't ship. (Companion to the 20-case adjudicated
   name suite; both run before any model swap per §9.)
3. **Sampled human review** (small, periodic): each week's ingest samples a
   handful of NEW multi-member groups for crop-level review via the Ops
   Console; verdicts feed layer 2's corpus, so the labeled set grows with
   the catalog instead of fossilizing at spec time.
