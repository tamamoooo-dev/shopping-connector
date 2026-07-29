# Vision Ingestion Pipeline — Permanent Architecture Contract

Status: **Architecture contract. §2 settled 2026-07-26. No code written.**

Author date: 2026-07-26. Revised 2026-07-26 (§2 decisions settled).

Governs: the pipeline structure surrounding Vision extraction — stage
boundaries, stage contracts, routing, recovery, and ownership.

Companion contracts:
[`QUALITY-SCORES.md`](QUALITY-SCORES.md) ·
[`IDENTITY-OWNERSHIP.md`](IDENTITY-OWNERSHIP.md) ·
[`ARCHITECTURE.md`](ARCHITECTURE.md) · [`REGISTRY-DESIGN.md`](REGISTRY-DESIGN.md)

`QUALITY-SCORES.md` was amended on 2026-07-26 to match C-4 (Identity Readiness).
The two contracts agree; no divergence is outstanding.

## Settled decisions

| # | Decision | Outcome | Recorded in |
|---|---|---|---|
| C-1 | Extractor tiers | **Roles, not models.** Primary / Recovery; `visionModel.js` binds them. Budget and Quality profiles both supported | §2 C-1, §6 S2/S5 |
| C-2 | Price ownership | **Outside Vision.** S1 and S4 read `offers.price`; validated 1000/1000 | §2 C-2, §4.1 M1 |
| C-3 | Lexicon stage order | **A DAG.** S8e, S8f and S8g are siblings under S8d | §2 C-3, §3 |
| C-4 | Builder Score | **Identity Readiness metric**, not a rendering-quality metric. One score, no new version | §2 C-4, §6 S8f |
| C-5 | S4 mandatory set | **Confirmed at three conditions.** No fourth; a fourth is `v2` | §11 C-5, §4.1 |
| C-6 | OCR in recovery | **Retained**, by explicit act; the cheapest processor | §11 C-6, §6 S5 |
| C-7 | Human override authority | **Immutability binds machine rungs only.** The human rung may override, recorded | §11 C-7, P6/P15 |
| C-8 | Recovery model | **Queue-driven, not pipeline-driven.** S4 ends the pipeline; Vision Medium and OCR are processors attached to the queue; spending is the operator's decision (Manual / Auto) | §11 C-8, §6 S5, P9 |
| R1 | `Human` provenance | **First-class provenance.** Correctness prerequisite for S7 | §6 S7, §9 R1 |
| — | Commerce Score | **Never gates S4.** Downstream evaluation metric only | §4.4, P8 |

§11 is the full decision log. §12 tracks implementation status.

---

## 0. Scope and non-scope

**In scope.** Pipeline structure, stage responsibilities, entry/exit contracts,
routing, recovery flow, ownership boundaries, long-term maintainability.

**Explicitly out of scope.** Vision extraction itself. The prompt, its request
settings, the field-admission rules, the confidence rules and the acceptance
behaviour of `validateVisionOutput` are treated as a **stable black box** and are
not redesigned, reworded, reordered, retuned or reinterpreted here. Prompt
optimisation is CLOSED (`src/offers/enrich.js`, `VISION_PROMPT_SHA256`
`e643b2a1…`). Ideas for improving extraction quality are quarantined in §10 as
future recommendations and take no part in the architecture below.

**What this document adds** over the deployed system is four things and nothing
else:

1. an explicit **Extraction Admission** stage (today implicit in
   `enrichStore.listDebris`);
2. an explicit **Business Acceptance Gate**, separate from the existing
   field-admission validator;
3. an explicit, ordered **Recovery Ladder** terminating in a human stage;
4. a named **Developer Review** stage (does not exist today in any form).

Everything else is a written contract for behaviour that already ships.

---

## 1. What is already built (the baseline this contract describes)

Verified in the working tree, 2026-07-26. Undeployed items are marked.

This table is the **pre-existing** baseline the contract was written against.
Modules built *for* this contract are tracked separately in §12.

| Concern | Where it lives | State |
|---|---|---|
| Offer rows (price, currency, crop, OCR text) | `offers` table, `src/offers/ingest.js` | deployed |
| Extraction queue selection | `enrichStore.listDebris` (`scope: 'all'`) | deployed |
| Vision call, frozen baseline | `offers/enrich.js` `buildVisionRequest` | **undeployed** (§44) |
| Model tier selection | `offers/visionModel.js` | deployed, **INERT** |
| Field admission validator | `smartExtraction.validateVisionOutput` | deployed |
| Vision/OCR merge, Vision-immutable | `smartExtraction.mergeValidatedExtractions` | deployed |
| Per-source attempt journal | `offer_extraction_attempts` | deployed |
| OCR escalation queue | `offer_ocr_queue`, `drainOcrEnrichment` | deployed |
| Brand Lexicon | `lexicon/brands.js` | **undeployed** (§45) |
| Shopping Lexicon, Package Parser, Structured Product, Arabic Builder | `lexicon/*.js` | **undeployed** (§47) |
| Builder Score (Identity Readiness — C-4) | `lexicon/arabicRollout.js` | **undeployed** |
| Commerce Score | `offers/commerceScore.js` | **undeployed** |
| Shadow metadata + feature flag | `extraction_json._arabic_builder`, `enrichmentNameArSql` | **undeployed** |
| Serving gate | `enrich.servable` / `SERVABLE_SQL` | deployed |
| Registry resolution, `pr_*` IDs | `src/registry/*` | deployed |
| Read-only per-offer inspector | `ops/console.js` `inspectOffer` | deployed |
| Human review actions (identity-level) | `registry/review.js` — 3 bounded actions | deployed |

**There is no human field-editing surface anywhere in the system today.**
`offer_ocr_queue` is a machine retry queue with no operator view;
`/registry/review` acts on identity (`clear_flag`, `reassign`, `split`), never on
extracted fields. Stage S7 below is entirely new.

---

## 2. Conflicts resolved before adoption

Three requirements in the brief contradicted permanent directives or shipped
invariants, and a fourth question was raised during review. They are stated here
rather than silently designed around, because each changes what the pipeline is.
**All four are settled**; each resolution is marked `SETTLED 2026-07-26`.

### C-1 · "Vision Small is the default production extractor" inverts a PERMANENT directive

The brief makes Small the default and Medium the recovery pipeline. The standing
directive (2026-07-25, `offers/visionModel.js` header, memory
`vision-model-selection-policy`) is the opposite: **Medium is the production
baseline, Small is a manual budget fallback, and models are never switched
automatically.** Small-first-then-escalate was measured over 30 crops and
rejected — escalation fired 0/30, and the 91.1% cost saving bought a 16.7%
defect rate (Wilson CI 7.3–33.6%).

**Two distinct things are being conflated, and only one of them was rejected.**

- The *rejected* design escalated on a **correctness validator** (package size
  vs D4D/registry). It failed because the validator had no coverage — D4D has no
  structured size field at all, and could form an opinion on 14% of crops.
- The design in this brief escalates on **mandatory-field presence**. A presence
  test has 100% coverage by construction: a field is either admitted or it is
  not. The routing logic will actually fire.

So the *topology* is sound in a way the rejected one was not. **The measured
defect profile still stands, and the topology cannot fix it:** Small's failures
were *silent, well-formed and confident* — the `10 KG` hallucination against a
printed `5kg` at 0.98 confidence **passes** a presence gate. Three of five
adjudicated defects were size errors; two were brand-only, which no gate in this
architecture can see because brand is deliberately non-blocking (§4). A presence
gate recovers **absent** fields. It cannot recover **wrong** fields. That is this
architecture's known ceiling and it must be written down, not discovered later.

**Resolution — SETTLED 2026-07-26.** The pipeline is defined in terms of
**roles**, not model names:

```
PRIMARY EXTRACTOR   — the default extractor for all traffic
RECOVERY EXTRACTOR  — runs only on a Business Acceptance failure, only when armed
```

This document names only the roles. Which tier fills which role is owned
entirely by [`offers/visionModel.js`](src/offers/visionModel.js) as an
**operator-armed setting** (`ops/settings/vision-model.json`) — never a code
constant, never automatic, and never a property of the architecture. Changing
the binding must never require changing this contract.

#### Operating profiles

A profile *is* a role→tier binding. Both are supported by the architecture; they
are not equally recommended.

| Profile | Binding | Intended for | Measured consequence |
|---|---|---|---|
| **Quality** (recommended production configuration) | PRIMARY = Medium | Deployments where inference budget is not the binding constraint | The frozen baseline: name accuracy 24% → 86% |
| **Budget** (supported, not recommended) | PRIMARY = Small | Deployments where inference budget is limited and the operator accepts a degraded correctness floor | −91.1% inference cost; **16.7% defect rate** (n=30, human-adjudicated, Wilson CI 7.3–33.6%) |

**The Budget profile trades cost for a higher probability of *silent* extraction
errors, and that word is the whole point.** The measured escalation rate for
Small-first was **0/30**. The failures were not loud — they were well-formed,
plausible and self-reported at 0.98+ confidence (`10 KG` returned against a
printed `5kg`). Three of five adjudicated defects were size errors; two were
brand-only, and brand is deliberately non-blocking (§4.2), so no gate in this
architecture can see them at all. A Business Acceptance failure is what triggers
recovery, and these defects **pass** S4. They therefore reach canonical product
data without ever entering recovery at all.

**Amended by C-8, and the amendment cuts both ways.** Under queue-driven
recovery the escalation trigger is an operator working a queue rather than a
validator, which is a genuine answer to the measured 0/30 escalation rate and
makes the Budget profile more defensible than automatic small-first ever was.
But it does **not** rescue the defects described above: they pass S4, so they are
never queued, and no amount of operator diligence at the queue will surface an
error the gate did not catch. The ceiling is unchanged — a presence gate cannot
detect a confident misread — and Medium remains the baseline.

Recorded explicitly so it is never inferred from the abstraction alone:

> **The Budget profile is a conscious operating decision by an operator, not the
> recommended production configuration.** Arming PRIMARY = Small is a deliberate,
> visible act that accepts a measured 16.7% defect rate on canonical product
> data, with no automatic detection and no automatic recovery. Today's arming
> resolves PRIMARY = Medium, which satisfies both this contract and the permanent
> `vision-model-selection-policy` directive with no change to either. The
> directive's core rule is unaffected by role abstraction: **models are never
> switched automatically.**

This is the "one deliberate quality knob" the directive asks for, and role
abstraction makes it a configuration decision rather than an architectural one.

### C-2 · "Current price" cannot come from Vision, by construction

The brief makes current price a mandatory extracted field. Prices are
**structurally quarantined** from the enrichment side-car
(`QUARANTINED_OBSERVATION_FIELDS`, `preservedObservation()`), because the 50-crop
validation measured a current-price **role inversion on 2/50 crops** — the
crossed-out price returned as the selling price at 0.99+ self-reported
confidence, identically under both prompts. The deterministic price guard that
would license extracted prices is HANDOFF §11 TODO -1.5 and **does not exist**.

**Resolution — SETTLED 2026-07-26.** The price mandate is satisfied from the
**authoritative offer row** (`offers.price`, `offers.currency`) — the same source
Commerce Score's price component already reads, via the existing
`hasUsableCommercePrice()`. It is a **precondition of entering the pipeline**,
evaluated at S1 before any model call, and re-asserted at S4. No extracted price
is read, and the quarantine is untouched. This is strictly cheaper than the
brief's version (a priceless offer never costs a model call) and requires no new
guard.

Business Acceptance consumes the commerce price we already own rather than asking
Vision to extract a fact we hold with higher confidence.

#### Supporting measurement

The exact S1/S4 predicate (`hasUsableCommercePrice()`) was run over the
authoritative offer rows for the frozen 1,000-row production corpus. Read-only,
no new production call — the inputs are captured in
`validation/commerce-price-snapshot-1000-2026-07-26.json`
(`capture-commerce-price-snapshot.mjs`, D1 `SELECT` at 2026-07-26T01:45:35Z,
1000/1000 rows found, 0 missing).

| Check | Result |
|---|---:|
| **Passes `hasUsableCommercePrice()`** | **1000 / 1000 — 100.00%** |
| `price` null, non-finite, or ≤ 0 | 0 — 0.00% |
| Currency missing or non-SAR | 0 — 0.00% (SAR = 1000) |
| **Role-inversion shape** (`old_price < price`) | **0 — 0.00%** |
| `old_price == price` (discount that is not one) | 0 — 0.00% |
| `old_price` absent | 58 — 5.80% (legitimate: no promotion) |

The decisive comparison is the last-but-two row against the finding that opened
this conflict. The **same failure mode** — current/old price role inversion — was
measured at **2/50 (4%)** in Vision-extracted prices at 0.99+ self-reported
confidence, and at **0/1000 (0.00%)** in the offer row. The offer row is not
merely adequate; it is measurably the better source.

**Two limits on what this proves**, recorded so the 100% is not read as more than
it is:

1. **Structural, not semantic.** It proves `offers.price` is always present,
   positive and correctly denominated — exactly what S1 and M1 consume. It does
   not prove the number equals what a shopper pays at the till; that would need
   human adjudication against crops. Vision cannot answer it better, because the
   question is about the retailer feed.
2. **Possible selection bias.** The corpus was drawn for OCR-first validation and
   may over-represent offers with clean crops. The unbiased population is the
   `listDebris` candidate set. R4 (§9) makes this self-measuring in production by
   moving the predicate into SQL — **built 2026-07-26**, so the candidate set now
   *is* the price-filtered population — and either way a wider sample can only
   *lower* a 100.00% result; it cannot change which source wins.

One implausible value appeared and is not a defect: `lulu:central:d4d:93296904`
at 7499 SAR is a correctly priced HONOR 5G phone. Its *size* is a defect, and it
belongs to a different open question — see §4.3.

### C-3 · The stage order in the brief is not executable as written

The brief lists `Builder Score → Commerce Score → Arabic Builder` as a sequence.
No such sequence exists. Commerce Score reads only the Structured Product and the
offer row. Builder Score reads only the Structured Product (C-4). Neither depends
on the other, and — as C-4 establishes — neither depends on the Arabic Builder's
output either.

**Resolution — SETTLED 2026-07-26.** The lexicon pipeline is a **DAG, not a
line**. S8e, S8f and S8g are **siblings**, all three children of S8d, and any of
them may run in any order or in parallel. An earlier draft of this document
described S8f as downstream of S8e; that was a call-graph observation, not a data
dependency, and it is corrected in §3 and §6. This is a correction to the
diagram, not a change to any stage.

### C-4 · Builder Score does not measure what its name claims

*Raised during review, 2026-07-26.*

`QUALITY-SCORES.md` §1 defines Builder Score as measuring *"Arabic-name
construction quality"*, which places it logically after the Arabic Builder. The
implementation does not do this. **Every input to `calculateBuilderScore` is a
pure function of the Structured Product**
([`arabicRollout.js:71`](src/lexicon/arabicRollout.js:71)):

| Component | Actually reads |
|---|---|
| `category_resolved` | `structured.category` |
| `lexical_coverage` | `structured.coverage` |
| `brand_expected` / `brand_resolved` | `structured.observed.brand`, `structured.brand.display_ar` |
| `size_expected` / `size_resolved` | `structured.observed.size`, `structured.size.display_ar` |
| `descriptor_coverage` / `flavor_coverage` | `structured.descriptors[].ar` |
| `unknown_fragment_count` | `structured.residual_en` |
| `dropped_fragment_penalty` | `built.dropped` — itself computed at [`arabicBuilder.js:92-95`](src/lexicon/arabicBuilder.js:92) from **only** `structured.residual_en` and `structured.brand`, populated before composition runs and returned even on the `NO_CATEGORY` path |
| `isBuilt` gate | reduces to `source === ENGLISH ∧ category != null ∧ ¬head_final_guard` — all readable from `structured` |

The function accepts `built` as a parameter and **never reads `built.name`,
`built.parts` or `built.lines`**. It cannot see the rendered Arabic string. Its
post-builder position is a call-graph accident with no semantic content.

**Resolution — SETTLED 2026-07-26.** Builder Score's documented responsibility is
redefined to match what it computes. It is an **Identity Readiness** metric:

> **Does the Structured Product contain enough deterministic information to build
> a high-quality Arabic identity?**

It is explicitly **not** a rendering-quality metric. Full contract in §6 S8f.

**Scope of this decision — deliberately narrow.** This changes the *documented
responsibility* only. There is no second score, no new score version, and no
implementation change. `builder-score-v1` keeps its exact inputs, weights,
deductions and outputs; `QUALITY-SCORES.md` rule 7 binds a new version to a
**formula** change, and no formula changes here.

**Why no Render Fidelity score today.** The Arabic Builder is currently a
filter-and-join ([`arabicBuilder.js:122-128`](src/lexicon/arabicBuilder.js:122))
that is lossy *by drop*, never *by guess* — it structurally cannot lose anything
not already accounted for in `dropped`. A render-fidelity score would therefore
return the same value on every row, and `QUALITY-SCORES.md` rule 8 rightly
rejects a metric with no variance. Naming Builder Score honestly now means that
if the builder later acquires real linguistic decisions, the gap appears as a
**visibly missing score** rather than a silently wrong one. Recorded as a future
possibility only in §10 — not part of this architecture.

---

## 3. Architecture diagram

```
                        ┌─────────────────────────────────────────┐
                        │ S0  OFFER INGESTION                      │
                        │ owns: offers row — price, currency,      │
                        │ crop URL, OCR text, validity window       │
                        └───────────────────┬─────────────────────┘
                                            │ offer row
                                            ▼
                        ┌─────────────────────────────────────────┐
                        │ S1  EXTRACTION ADMISSION                 │
                        │ "is this crop worth one model call?"     │
                        │ crop present · in validity window ·      │
                        │ never attempted · USABLE PRICE (C-2)     │
                        └───────┬─────────────────────┬───────────┘
                        admitted│                     │not admitted
                                ▼                     ▼
                ┌───────────────────────────┐   ┌──────────────────────┐
                │ S2  PRIMARY EXTRACTION     │   │  NOT-A-CANDIDATE      │
                │ role, tier operator-armed  │   │  no call, no record,  │
                │ FROZEN BLACK BOX           │   │  no queue entry       │
                │ exactly ONE call per crop  │   └──────────────────────┘
                └───────────────┬───────────┘
                                │ raw observation (verbatim, journaled)
                                ▼
                ┌───────────────────────────────────────────────┐
                │ S3  FIELD ADMISSION VALIDATOR                  │
                │ smartExtraction.validateVisionOutput — FROZEN  │
                │ per-field Accepted / Rejected / Missing        │
                │ NO business opinion. NO accept/reject verdict. │
                └───────────────┬───────────────────────────────┘
                                │ admitted field set + evidence
                                ▼
                ┌───────────────────────────────────────────────┐
                │ S4  BUSINESS ACCEPTANCE GATE            (NEW) │
                │ boolean conjunction over source facts:        │
                │   price (offer row) ∧ comparable quantity ∧   │
                │   admitted English name                       │
                │ brand / old price / promo / flavor / variant  │
                │ / descriptor / package details CANNOT block   │
                └──────┬────────────────────────────────┬───────┘
                ACCEPT │                                 │ REJECT
                       │                                 ▼
                       │             ┌───────────────────────────────────┐
                       │             │ S5  RECOVERY QUEUE    (NEW, C-8)  │
                       │             │ ═══ PIPELINE ENDS HERE ═══        │
                       │             │ the reject is WRITTEN to a durable│
                       │             │ queue with its verdict + missing[]│
                       │             │ and nothing is invoked. Execution │
                       │             │ mode Manual (default) | Auto      │
                       │             └───┬───────────────────────────┬───┘
                       │   OPERATOR      │                           │operator
                       │   drains (spend)▼                           │escalates
                       │   ┌──────────────────────────────┐          │
                       │   │ RECOVERY PROCESSORS           │          │
                       │   │ attached to the queue, NOT    │          │
                       │   │ pipeline stages:              │          │
                       │   │ · OCR completion (cheapest)   │          │
                       │   │ · Vision Medium re-read       │          │
                       │   │ Vision-accepted fields are    │          │
                       │   │ IMMUTABLE across every one    │          │
                       │   └────────┬─────────────────┬────┘          │
                       │      pass  │                 │ fail          │
                       │      (S4)  │                 └───────────────┤
                       │◄───────────┘                                 ▼
                       │                          ┌────────────────────────────┐
                       │                          │ S7  DEVELOPER REVIEW  (NEW) │
                       │                          │ crop · every rung's output  │
                       │                          │ side by side · structured   │
                       │                          │ fields · edit / accept /    │
                       │                          │ reject · provenance=Human   │
                       │                          └────────┬───────────┬───────┘
                       │                            accept │           │ reject
                       │◄──────────────────────────────────┘           ▼
                       │                                        ┌────────────┐
                       │                                        │ TERMINAL   │
                       ▼                                        │ recorded,  │
   ══════════════════════════════════════════════════           │ never      │
   S8  LEXICON PIPELINE  (a DAG — see C-3)                       │ re-queued  │
   ══════════════════════════════════════════════════           └────────────┘

        accepted observation
                 │
                 ├──────────────▶ S8a BRAND LEXICON      (pure, deterministic)
                 ├──────────────▶ S8b SHOPPING LEXICON   (pure, phrase-level)
                 └──────────────▶ S8c PACKAGE PARSER     (pure, printed size)
                                        │
                                        ▼
                            ┌───────────────────────────┐
                            │ S8d STRUCTURED PRODUCT     │  ← authoritative
                            │ the English commercial     │     product record
                            │ record; head-final guard   │
                            └──┬──────────┬──────────┬──┘
                               │          │          │   three SIBLINGS (C-3):
            ┌──────────────────┘          │          └──────────────────┐
            ▼                             ▼                             ▼
 ┌────────────────────┐      ┌─────────────────────────┐   ┌──────────────────────┐
 │ S8e ARABIC BUILDER │      │ S8f IDENTITY READINESS   │   │ S8g COMMERCE SCORE    │
 │ presentation only  │      │ ("Builder Score")        │   │ commercial usefulness │
 │ renders; evaluates │      │ evaluates S8d ONLY —     │   │ reads offer row price │
 │ nothing            │      │ never the rendered name  │   │ reads NO score        │
 └─────────┬──────────┘      └───────────┬─────────────┘   └───────────┬──────────┘
           │                             │                             │
           └─────────────────────────────┼─────────────────────────────┘
                                         │   no data dependency in any
                                         │   direction between the three
                                         ▼
                    ┌─────────────────────────────────┐
                    │ S8h SHADOW METADATA              │  diagnostic, versioned,
                    │ both scores, side by side, never  │  never user-facing
                    │ combined (QUALITY-SCORES §5)      │
                    └───────────────┬─────────────────┘
                                    ▼
                    ┌─────────────────────────────────┐
                    │ S9  ENRICHMENT RECORD WRITE      │  side-car, additive,
                    │ offer_enrichments (+ journal)    │  never mutates offers
                    └───────────────┬─────────────────┘
                                    │
             ┌──────────────────────┴───────────────────────┐
             ▼                                              ▼
  ┌───────────────────────┐                    ┌──────────────────────────┐
  │ S8i FEATURE FLAG       │                    │ S10 REGISTRY RESOLUTION  │
  │ read-path presentation │                    │ separate invocation      │
  │ switch; cannot mutate  │                    │ SOLE minter of pr_* IDs  │
  │ the source record      │                    │ own gate, own verdicts   │
  └───────────────────────┘                    └──────────────────────────┘
```

---

## 4. The Business Acceptance Gate (S4) — the one new decision

### 4.1 Mandatory conditions

Acceptance is a **conjunction of three independent presence facts**. All three
must hold.

| # | Condition | Source of truth | Existing primitive |
|---|---|---|---|
| M1 | Usable current price | `offers.price` + `offers.currency` — **never Vision** (C-2) | `hasUsableCommercePrice()` |
| M2 | Comparable quantity resolved | Comparable Quantity projection (§4.3) | `parsePackageSize`, `resolvePackageType` |
| M3 | English name admitted | `validation.acceptedFields` contains `name_en` | `validateVisionOutput` (S3) |

M3 deliberately reuses the frozen validator's own verdict rather than inventing a
second "is this name good enough?" bar. That validator already rejects
promotional lines, price fragments, specification lines and names with fewer than
two Latin letters. A third opinion would be a second definition of the same
thing — the failure mode `needsEnrichment()` was written to avoid. Measured
headroom: a usable English name exists on **99%** of the 1000-row production
corpus, so M3 is cheap.

### 4.2 Non-blocking fields — permanent

These are **high priority and never blocking**. Absence must never reject:
brand · old price · promotion · flavour · variant · descriptor · package details ·
`unit` · `package_type` · `attributes` · Arabic name · model confidence.

Two of these are load-bearing and easy to get wrong:

- **Brand.** Brand Lexicon coverage is measured at **20% of unique brand strings**
  (17% by volume). A blocking brand requirement would reject ~80% of the catalog
  for a vocabulary gap that is data work (TODO 0c), not an extraction failure.
- **Arabic name.** English is the source of truth by directive; the Arabic name
  is GENERATED at S8e. Requiring an observed Arabic name would make a
  presentation-layer input gate the commercial pipeline — precisely the
  cross-axis dependency `QUALITY-SCORES.md` §4 forbids.

> ⚠️ **Divergence from deployed behaviour, and it is deliberate.** The current
> production path treats `brand_missing_or_invalid` and
> `arabic_product_name_missing_or_invalid` as escalation triggers, so today a
> missing brand *does* block the canonical write and queue OCR
> (`passed = !validation.ocrRequired`). Under this contract those triggers keep
> their exact meaning — **"a recovery rung might add something"** — but they no
> longer decide acceptance. S3's trigger set is untouched; S4 is a new consumer of
> it. Same validator, one fewer job.

### 4.3 The Comparable Quantity contract

A **projection over existing parser outputs**. No new parser, no third
interpretation of a size — the project already forbids one
(`packageSize.js` header).

Implemented in [`lexicon/comparableQuantity.js`](src/lexicon/comparableQuantity.js).

```
ComparableQuantity {
  status      : 'RESOLVED' | 'ABSENT'
  basis       : 'measure' | 'count' | 'container' | null
  quantity    : number | null      // printed magnitude of ONE unit
  unit        : MeasureUnit | CountableUnit | null
  pack        : number             // >= 1
  unitPriceComparable : boolean    // arithmetic is possible
  source      : 'size_field' | 'name' | 'package_type' | 'canonical' | null
  version     : 'comparable-quantity-v1'
}

MeasureUnit   = ml | l | g | kg
CountableUnit = piece | pack | bag | carton | bottle | can | jar | box
```

Two corrections made during implementation, both to avoid inventing precision
the parsers do not have:

- **`oz` is not a `MeasureUnit`.** `matching.js` has no ounce support anywhere,
  so an `oz` unit here would be a display unit with no comparison behind it. See
  R7 (withdrawn) in §9.
- **`pack_count` is not a `source`.** `parsePackageSize()` labels its
  `packCount` fallback `size_field`, so the distinction is not observable from
  outside the parser. Reporting it would require a second interpretation of a
  size, which the project forbids.

For the `count` basis the count word is **not** carried: the comparable fact is
the integer, and 40 rolls compares with 40 pieces at 40.

Derivation, in order, first hit wins:

| basis | Derived from | Example |
|---|---|---|
| `measure` | `parsePackageSize().{quantity, unit, pack}` | `330 ml` → q 330, u ml, pack 1 |
| `count` | `parsePackageSize().count` / `canonical.pack` when `unit === 'pcs'` | `40's` → q 40, u piece |
| `container` | `resolvePackageType()` over the model's **printed** `package_type` | `bag` → q null, u bag |

`status: RESOLVED` on any basis satisfies M2. Numeric quantity is preferred, not
required — a carton with no printed magnitude is a valid, comparable product.

**`unitPriceComparable` is a second, separate bit and must stay separate.** It is
true only for `measure` with a finite quantity, or `count` with a finite count. A
`container` basis admits the product to the pipeline but supports **grouping**,
not **arithmetic**. Collapsing the two bits would let a later stage compute a
price-per-unit for "1 bag". The gate needs the first bit; unit-price ranking needs
the second.

> ⚠️ **Presence is not correctness, and M2 tests presence.** Surfaced by the C-2
> measurement: `lulu:central:d4d:93296904` is an HONOR 5G phone whose Structured
> Product carries `parsed_size: { unit: 'g', total: 5, src: 'measure' }` —
> `parseSize` read the **model designator** "5G" as five grams. That row
> satisfies M2 with a `measure` basis and a confidently wrong quantity, and the
> existing weak-count guard does not cover it because that guard keys on
> `canonical.src === 'count'` while this is `'measure'`. M2 is still the right
> mandatory condition — a correctness test has no available oracle at S4, which
> is the same ceiling C-1 documents — but `business-acceptance-v1` is
> calibrated knowing that `comparable_quantity: true` means *resolved*, never
> *correct* (C-5).

Deliberate consequence, do not "fix" it: a `container`-basis product **passes
S4** and simultaneously scores **0** on Commerce Score's `package_size` component,
which requires a canonical unit and a positive total. That is correct. Acceptance
is a floor; Commerce Score is a measurement. They answer different questions and
`QUALITY-SCORES.md` §4 requires they stay independent.

### 4.4 What the gate must never read

- **Commerce Score, or any threshold on it.** The gate is a conjunction; a
  weighted score is compensatory. `commerce_score >= X` would let brand's 20
  points substitute for package size's 25 — the exact forbidden form in
  `QUALITY-SCORES.md` §5. It is also circular: Commerce Score reads price and
  size, the same two facts the gate tests.
- **Builder Score / Identity Readiness.** Never, and C-4 strengthens rather than
  weakens this. The score measures *lexicon coverage of the English name*;
  gating S4 on it would reject commercially complete products because the
  Shopping Lexicon lacks vocabulary for them — a vocabulary gap (TODO 0c)
  masquerading as a commercial verdict, and exactly the cross-axis dependency
  `QUALITY-SCORES.md` invariant 3 forbids.
- **Model self-reported confidence.** Measured at 0.98 on every tile including
  misreads; `confidenceUsedForAdmission: false` is already the standing contract.
- **Registry state.** Registry resolution runs in a later, separate invocation
  and is structurally unavailable here — the same constraint that broke the
  rejected routing design.

---

## 5. Stage responsibilities

One stage, one responsibility. Names in `code font` are existing modules; stages
marked **(NEW)** have no implementation.

| Stage | Single responsibility | Owns | Must never |
|---|---|---|---|
| **S0** Offer Ingestion | Record what the aggregator published | `offers` row: price, currency, crop URL, OCR text, validity | Interpret product identity |
| **S1** Extraction Admission **(NEW)** | Decide whether a crop is worth one model call | The candidate predicate | Call a model; write an enrichment |
| **S2** Primary Extraction | Read pixels, return one observation | The raw model reply | Be invoked more than once per crop; know about lexicons, registry or storage |
| **S3** Field Admission Validator | Per-field Accepted/Rejected/Missing + evidence | `ruleVersion`, trigger codes | Emit a business verdict; be edited by S4 |
| **S4** Business Acceptance Gate **(NEW)** | One boolean: may this product enter commerce? | The mandatory conjunction | Read scores, confidence, registry, or any non-blocking field |
| **S5** Recovery Queue **(NEW, C-8)** | Persist the reject with its verdict and `missing[]`, and stop | Durable queue row; execution mode | **Invoke a processor.** Decide that recovery spend should happen |
| **S6** Recovery Extraction | Add fields the primary read lacked | Its own attempt journal row | Overwrite an accepted field from any earlier processor; run unless the operator armed it |
| **S7** Developer Review **(NEW)** | Human accept / edit / reject, with provenance | Human-authored field values | Mutate an earlier stage's stored observation in place |
| **S8a** Brand Lexicon | Observed brand → canonical brand identity | `brand_id` (= Browse slug), aliases | Fuzzy-repair; mint an unknown brand |
| **S8b** Shopping Lexicon | English name → category + descriptors | Category & descriptor vocabulary | Name a product from a brand or size token |
| **S8c** Package Parser | Printed sale size → structured + display | Printed magnitude, unit, pack | Invent a size; re-derive canonical totals |
| **S8d** Structured Product | Assemble the authoritative English record | Coverage, residuals, head-final guard | Be shaped by what reads well in Arabic; derive structure from Arabic |
| **S8e** Arabic Builder | Compose an Arabic presentation name | Built name, dropped fragments | Constrain S8d; transliterate untranslatable fragments; be read by any score |
| **S8f** Builder Score — **Identity Readiness** | Measure whether S8d holds enough deterministic information to build a high-quality Arabic identity | `builder-score-v1` | Read the rendered Arabic name; measure rendering quality; influence identity, price, or Commerce Score |
| **S8g** Commerce Score | Measure commercial usefulness | `commerce-score-v1` | Influence Arabic quality, or gate S4 |
| **S8h** Shadow Metadata | Persist both scores as separate axes | `extraction_json._arabic_builder` | Combine, average or normalise the axes |
| **S9** Enrichment Write | Persist the side-car record + journal | `offer_enrichments`, `offer_extraction_attempts` | Mutate `offers`; persist a price |
| **S8i** Feature Flag | Choose which Arabic name a read path shows | The reversible display switch | Mutate the source record |
| **S10** Registry Resolution | Product identity, `pr_*` IDs, sightings | Registry verdicts | Consume Builder or Commerce Score; accept a `ph_*` key as identity |

**Acceptance is not identity.** S4 says a product may enter commerce. S10
independently decides whether it is a *known* product, and remains the sole
minter of `pr_*` IDs. An S4-accepted product can still receive a `review` or
`defer` verdict, and `ph_*` keys never become identity
(`IDENTITY-OWNERSHIP.md`).

---

## 6. Stage contracts

Notation: **entry** = what the stage may read; **exit** = what it may emit;
**invariant** = what must hold across it.

### S0 · Offer Ingestion
- **entry** aggregator payload
- **exit** `offers` row: `{ id, store, region, price, currency, image_url, name, name_ar, search_text, valid_from, valid_to, detected_at }`
- **invariant** `id` = `store:region:source:offerId` and is the 1:1 join key for every downstream record. `offers` is never written by any later stage.

### S1 · Extraction Admission **(NEW)**
- **entry** `offers` row only
- **exit** `ADMITTED` | `NOT_CANDIDATE(reason)`
- **predicate** `image_url != null` ∧ `valid_to >= currentOn` ∧ no prior attempt ∧ `hasUsableCommercePrice({price, currency})`
- **invariant** exactly one Primary Extraction per offer id, ever. A `NOT_CANDIDATE` verdict costs zero model calls and writes no enrichment row.
- **note** the first three conditions are today's `listDebris` WHERE clause; the price condition is the only addition (C-2), and it *reduces* spend.
- **BUILT 2026-07-26 (R4)** the predicate now lives in SQL as `enrichStore.USABLE_PRICE_SQL` and is applied by `listDebris`, `countDebris` **and** `coverage`. All three had to move together: `coverage`'s denominator is what `remaining` is measured against, so filtering the work queue alone would have stranded priceless offers as permanently uncovered and capped coverage% below 100 forever. `isExtractionCandidate` is retained as the pure, testable form of the same predicate.

### S2 · Primary Extraction — FROZEN
- **entry** crop bytes + content type. **Nothing else** — no offer text, no OCR text, no registry text. (`buildVisionRequest` is pure and exported so tests can prove this.)
- **exit** `{ rawReply, parsedObject|null, model, cropUrl, observedAt }`
- **invariant** one request per crop. The verbatim reply — prices included — is journaled to `offer_extraction_attempts.output`. Nothing the model said is ever lost, and nothing extra is ever added.

### S3 · Field Admission Validator — FROZEN
- **entry** parsed observation object + usability flag
- **exit** `{ ruleVersion, confidence, fields{status,value,reasons,method?}, acceptedFields, rejectedFields, missingFields, sizeVisibilityEvidence, packCountEvidence, triggerDecisions, triggerReasons, ocrRequired }`
- **invariant** `confidenceUsedForAdmission: false`. Output is **read-only** to every later stage. Trigger codes retain their meaning — *"a recovery rung might add something"* — and are never repurposed as acceptance reasons.
- **recorded deviation** this stage is not purely a validator: it performs bounded field-placement repair (`pack_count` → `size`, count → size, pack-count derivation from name/size text). That is interpretation inside a validator. It is frozen and correct as measured; it is documented in §8 so no later stage assumes S3 output is untouched observation.

### S4 · Business Acceptance Gate **(NEW)**
- **entry** `{ offer: {price, currency}, validation.acceptedFields, comparableQuantity }`
- **exit**
  ```
  { accepted: boolean,
    version: 'business-acceptance-v1',
    mandatory: { price: bool, comparable_quantity: bool, english_name: bool },
    missing: string[],          // subset of the three, empty when accepted
    comparableQuantity: ComparableQuantity }
  ```
- **invariant** pure; total (never throws); deterministic; depends on exactly three facts. Adding a fourth mandatory field is a **new version** of the gate, never an edit of `v1`.

### S5 · Recovery Queue **(NEW — REVISED by C-8, C-9)**

> **Superseded design.** This stage was originally specified as automatic
> Recovery *Routing*: a router emitting `RUN(rung) | TERMINATE(reason) |
> HOLD(retryAt)` and an automatic Mode A / Mode B ladder. **C-8 withdrew that.**
> Recovery is queue-driven, not pipeline-driven. The paragraph below is the
> current contract; the router is not to be built.

- **admission (C-9)** ONE rule: the offer did not become a **servable canonical
  product** — `servable(row) ∧ S4.accepted` — evaluated once, at the pipeline's
  terminal point, after an extraction attempt exists. Business Acceptance, the
  Quality Gate and any future mandatory rule all admit through this same rule and
  differ only in the metadata recorded. There is no per-cause admission logic and
  no second queue.
- **entry** an S4 **reject** verdict, with its `missing` conditions
- **exit** a durable Recovery Queue row. **Nothing else.** S4 is terminal for the
  extraction pipeline: writing the queue row is the last thing the pipeline does,
  and it never triggers a processor.
- **execution mode**, operator-owned:
  - **Manual** (default) — items remain queued until the operator chooses how to
    process them.
  - **Auto** — draining with the configured recovery strategy is *authorised*,
    armed by the operator when the API budget allows. Auto governs **permission
    to spend without a per-item decision, not a schedule**: nothing in the
    engine wakes up and drains on its own. Each pass is still invoked — "Run
    Auto now" in the Operations Center, or `POST /recovery-drain` — and no cron
    is wired to it (see S5.7). Arming Auto and seeing nothing happen is the
    system working as designed.
- **recovery processors**, attached to the queue rather than sequenced by it:
  - **OCR completion** — deployed (`drainOcrEnrichment`), the cheapest processor.
    Fills fields the primary left missing; never overwrites an accepted field.
  - **Recovery Extractor (Vision Medium)** — a second read of the same crop by
    the operator-armed recovery tier.
  - **Developer Review (S7)** — the terminal processor, always human, never
    automatic.
- **invariant** queue position and attempt state are **durable state, not control
  flow** — they survive Worker eviction, subrequest exhaustion and provider rate
  limits, exactly as `offer_ocr_queue` does today. A processor runs at most once
  per offer per arming, and no processor is entered as an automatic consequence
  of the S4 verdict.
- **invariant** the queue row carries the verdict and the per-condition `missing`
  list (R5, R6). A queued item must be triageable without re-running the gate.
- **SETTLED (C-6)** OCR is **retained**. Deployed, tested code doing the job it
  was built for, and it is the cheapest processor — so it stays the sensible
  first choice whenever the operator does drain. Retained by explicit act, not
  by omission.
- **SETTLED (C-8)** the queue is the permanent architectural boundary. Vision
  Medium and OCR are processors attached to it, not mandatory pipeline stages;
  the decision to spend on recovery belongs to the operator.
- **SETTLED (C-9)** the queue is a **platform**, model-agnostic and
  reason-agnostic. No processor name may appear in its schema or its module — no
  CHECK constraint enumerating processor ids, no per-processor column, no
  per-processor status value. Status values are lifecycle verbs; processor
  identity is opaque TEXT resolved by a registry. **Adding a processor is one
  module plus one registry line**, touching no queue code, no schema and no
  migration — that sentence is the checkable form of this decision.
- **invariant (C-9)** a processor **proposes fields and never closes its own
  item**. The runner re-runs S4 after the commit, and only acceptance moves an
  item to `resolved`. Accepted-field immutability (C-7) is enforced at that same
  commit boundary rather than inside processors, so a processor added later
  cannot fail to implement it.
- **execution policy (C-9)** Manual (default) and Auto are one runner differing
  only in who supplies the item list. The setting is operational configuration
  in the object store, not schema; **every failure to read it resolves to
  Manual**, inverting `visionModel.js`'s fail-safe because here the safe
  direction is to spend nothing.

### S6 · Recovery Extraction
- **entry** crop bytes + the persisted earlier validations (never a re-read of an earlier rung's model)
- **exit** its own attempt journal row + a merged extraction
- **invariant** **accepted fields are immutable across machine rungs (C-7).** Enforced structurally: `mergeValidatedExtractions` throws on violation, and `validatedExtractionCorroboration` returns `null` when `acceptedVisionFieldsOverwritten !== 0`. Every *automated* rung inherits this rule — OCR never overwrites an accepted Vision field, and a recovery extractor never overwrites the primary. **The human rung at S7 is the sole exception**, because a review stage that cannot correct an accepted error cannot fix the defects this ladder exists to catch.
- **note** `offer_extraction_attempts` PK is `(offer_id, source)` with `source ∈ ('vision','ocr')`. Holding a primary *and* a recovery Vision read needs one additional `source` value; the CHECK constraint widening is additive.

### S7 · Developer Review **(NEW)**
- **entry (display)** crop image · every rung's raw output side by side · each rung's field decisions with reasons · the derived Structured Product · the S4 verdict with its `missing` list
- **entry (write)** operator edits to any field
- **exit** `ACCEPTED(fields, provenance='Human', actor, at)` | `REJECTED(reason, actor, at)`
- **invariant** an edit is a **new provenance layer**, never an in-place mutation of a stored observation. The model's reply and every validation stay byte-identical and auditable; the human record sits beside them.
- ⚠️ **contract gap that must be closed before build — SETTLED 2026-07-26.** Provenance is today `Vision | OCR | Null`, and `validatedExtractionCorroboration()` returns `null` unless every populated name field's provenance appears in that rung's `acceptedFields`. **A human-edited row would therefore be written NON-SERVABLE** — the Developer Tool would appear to succeed while producing rows that can never be served.
  **Resolution.** `Human` becomes a **first-class provenance source alongside Vision and OCR**, with its own acceptance rule: **a human edit *is* the evidence and requires no validator agreement.** A developer-approved extraction is self-evidencing; asking a machine validator to corroborate a human decision inverts the authority the review stage exists to exercise.
  This is a **correctness prerequisite, not an enhancement** — S7 cannot be built before it, because without it S7 does nothing observable. It remains the single largest implementation prerequisite in this document (§9 R1).
- **invariant** `REJECTED` is terminal and recorded. A rejected offer is never re-queued by an automatic path; it re-enters only by an explicit operator act, exactly as `resetVerdicts` works for registry verdicts.

### S8a · Brand Lexicon
- **entry** observed brand string
- **exit** `{ observed_brand, brand_id, canonical_brand, display_en, display_ar, matched_alias, status, lexicon_version }`
- **invariant** pure, exact-key only, `brand_id: null` on a miss — no fuzzy repair. `brand_id` **is** the Browse slug: one namespace, not two. Trademark marks are stripped **before** NFKC (NFKC turns `™` into `TM` and destroys the key).

### S8b · Shopping Lexicon
- **entry** English name (+ optional skip-token set)
- **exit** category (`{id, en, ar, matched_phrase, span}` | null), descriptors[], package type
- **invariant** phrase-level, longest match, rightmost head noun. Brand and size tokens are excluded **before** the head noun is chosen. Never wraps `matching.js productFamily()`, which is single-token and measurably wrong on English names ("Ice Cream" → the dairy `cream` family).

### S8c · Package Parser
- **entry** `{ size, name, packCount }`
- **exit** `{ present, quantity, unit, count, pack, printed, display_en, display_ar, canonical, version }` | null
- **invariant** `canonical` **is** `matching.js parseSize()` output, unchanged. There is exactly one comparison view of a size in the project. Failure mode is "no size", never "invented size". `canonical.src === 'count'` stays load-bearing: a weak count (`…26S` on a fridge model number) is rankable but must never be printed.

### S8d · Structured Product
- **entry** the accepted observation (either stored or Expanded JSON shape)
- **exit** frozen `{ source, observed, brand, category, category_diagnostics, content_tokens, descriptors, size, package_type, residual_en, coverage, lexicon_version, version }`
- **invariant** the **authoritative** commercial record — identity, search, matching all read from it. English-primary: `source: 'arabic-fallback'` carries the observed Arabic through unchanged and invents **no** structure from it. The head-final guard refuses a category with ≥2 trailing unknown content words; a refusal is the safe outcome, not a failure. `coverage` is a measurement, never a gate.

### S8e · Arabic Builder
- **entry** Structured Product
- **exit** `{ status, name, parts, dropped, version }`
- **invariant** presentation only. Untranslatable fragments are **dropped, never transliterated**. Cannot influence S8d, S8f, S8g, or identity.
- **invariant (C-3, C-4)** a **leaf**. Nothing downstream evaluates its output — no score reads `name`, `parts` or `lines`. Its quality is a *consequence* of S8d, not something measured here. It renders; it is not graded.

### S8f · Builder Score — Identity Readiness

**Single responsibility.** Measure whether the Structured Product contains enough
deterministic information to build a high-quality Arabic identity.

- **entry** the Structured Product. Nothing else.
- **exit** `{ version: 'builder-score-v1', score: 0–100 | null, components }`
- **invariant** **evaluates S8d, never S8e.** It must never read `built.name`, `built.parts` or `built.lines`. It answers *"do we understand this product well enough to build a good Arabic name?"* — never *"did we generate a good Arabic name?"*
- **invariant** a **sibling** of S8e and S8g, not downstream of either (C-3). The implementation takes `built` as a parameter for the `dropped` list and the `isBuilt` gate, both of which are pure functions of S8d ([C-4](#c-4--builder-score-does-not-measure-what-its-name-claims)); this is a call signature, not a data dependency.
- **non-goal — rendering quality.** Explicitly out of scope. A high Identity Readiness score means the lexicon understood the source well enough to attempt a good name. It is **not** a statement that the composed Arabic string is correct, fluent, or safe to display.
- **consequence for a display gate.** Because it measures readiness rather than output, this score **cannot authorise displaying a built Arabic name**. Display eligibility is governed solely by builder status and the S8i feature flag; no score participates. (`QUALITY-SCORES.md` §1, amended 2026-07-26.)
- **unchanged by C-4** everything in `QUALITY-SCORES.md` other than the responsibility statement: axis independence, non-composition, no score consumes another, never user-facing, and a **formula** change is a new version requiring recalibration. C-4 changes no formula, so `builder-score-v1` stands.
- **recorded limitation** a numeric score exists only for `BUILT`; see §8.7.

### S8g · Commerce Score
- **entry** Structured Product + `{ price, currency }` from the **offer row** (C-2). Nothing else.
- **exit** `{ version: 'commerce-score-v1', score, breakdown }`
- **invariant** governed entirely by `QUALITY-SCORES.md`. A **downstream evaluation metric**: it reads no score, and no gate reads it. S4 must never consume it (§4.4) — acceptance is a deterministic conjunction and this is a weighted measurement, so the dependency would be both compensatory and circular. Never exposed to an end user.

### S8h · Shadow Metadata → S9 · Enrichment Write
- **entry** the accepted record + both scores
- **exit** `offer_enrichments` row + `offer_extraction_attempts` journal row, committed together
- **invariant** **side-car, never a mutation** — deleting every enrichment restores prior behaviour exactly. **No price ever enters a row any read path can serve** (`preservedObservation`); prices survive only in the journal. Attempt + outcome commit atomically, so a Worker retry can neither lose an escalation nor strand an attempt without a result.

### S8i · Feature Flag
- **entry** stored shadow + flag state
- **exit** which Arabic name a read path presents
- **invariant** one reversible switch, read-path only. Disabled = byte-for-byte the historical expression. Eligible only when the persisted shadow status is exactly `BUILT`; legacy rows, guard refusals and missing metadata all fall back automatically. **Cannot mutate the source record.**

### S10 · Registry Resolution
- **entry** `identity_candidate` persisted at S9 (never reconstructed from raw columns — extraction and resolution run in different Worker invocations)
- **exit** verdict + optional `product_sightings` row
- **invariant** sole minter of `pr_*`. Consumes neither score. `ph_*` keys group price observations only and are never identity. Existing trusted sightings are immutable; `product_sightings.offer_id` is the idempotency boundary.

---

## 7. Pipeline invariants (checkable)

The brief's §9 rules, restated so a reviewer can test them mechanically.

| # | Invariant | How it is checked |
|---|---|---|
| P1 | One stage, one responsibility | Every stage in §5 states one; a second one is a new stage |
| P2 | No stage mutates an earlier stage's data | Later stages add keys; earlier keys are byte-identical downstream |
| P3 | Additive only | Removing every artefact of stages S4–S9 restores S0–S3 behaviour exactly |
| P4 | Vision extracts · lexicons enrich · scores evaluate · builder builds | No lexicon call inside S2/S3; no model call inside S8 |
| P5 | Exactly one model call per crop per rung | Attempt journal PK `(offer_id, source)` |
| P6 | Accepted fields immutable across **machine** rungs (C-7) | `mergeValidatedExtractions` throws; corroboration nulls out |
| P15 | A human override is recorded, never silent (C-7) | Every overridden field keeps its previous value and provenance in the review layer's audit list |
| P7 | Prices never reach a servable row | `preservedObservation` strips them on every write path |
| P8 | Scores are diagnostic and independent | `QUALITY-SCORES.md` §4; S4 reads neither |
| P13 | Identity Readiness never reads the rendered name | S8f touches no `built.name` / `parts` / `lines`; perturbing the composed string alone cannot change the score (C-4) |
| P14 | `Human` is servable provenance | A human-accepted row passes the same `servable` gate as a Vision-accepted one (§6 S7) |
| P9 | Recovery queue is durable state, and recovery spend is never automatic (C-8) | Queue row survives eviction; monotonic; no back-edges; no processor runs as a consequence of the S4 verdict alone |
| P10 | Acceptance ≠ identity ≠ servability | Three separate verdicts, three separate owners (S4 / S10 / `servable`) |
| P11 | One definition of "servable" | `enrich.servable` and `SERVABLE_SQL` both derive from `CORROBORATION_FLOOR` |
| P12 | Human edits are auditable, not destructive | S7 writes a new provenance layer; model replies stay verbatim |

---

## 8. Recorded deviations in the current implementation

Documented so the new stages are not built on a false assumption of purity.
**No change is proposed to any of these.**

1. **S3 interprets as well as validates.** `validateVisionOutput` performs
   field-placement repair, count→size mapping and pack-count derivation from
   name/size text. Frozen and correct as measured; simply not a pure validator.
2. **Extraction depends on the Browse vocabulary.** `smartExtraction` imports
   `browse/brands.js matchBrandToken` for OCR brand selection. So "Vision
   extracts, lexicons enrich" is already not strictly true — brand vocabulary
   participates in extraction. It is a *pure* dependency, so it is benign, but
   growing `BRANDS` (TODO 0c) therefore changes extraction output too.
3. **Storage runs lexicon code.** `enrichStore` computes `match_text` on write
   and calls `buildArabicShadow` in `backfillArabicBuilderShadows`. A storage
   layer invoking a lexicon crosses P4. The single-write-path benefit is real;
   the boundary cost should be acknowledged.
4. **The serving gate lives inside the extraction module.** `applyEnrichment` is
   exported from `offers/enrich.js`. Read-path presentation owned by the
   extraction module is an ownership inversion — the natural home is a serving
   module that imports the gate.
5. ~~**A duplicated contract.**~~ **CLOSED 2026-07-26 (R10).** The
   ≥2-Latin-letters bar existed twice, in `smartExtraction` and in
   `structuredProduct`, each with a comment promising to match the other. Both
   now import [`src/usableEnglish.js`](src/usableEnglish.js), a dependency-free
   leaf. It is a leaf deliberately: extraction must not pull in the lexicon tree
   to ask a one-line question, and the lexicon must not import the extraction
   module to ask it either — the second direction would invert P4.
6. **`corroboration` is a boolean wearing a float's clothes.**
   `validatedExtractionCorroboration` returns `1` or `null` into a REAL column
   compared against a `0.3` floor, for backward compatibility with historical
   OCR-overlap values. Under this contract, acceptance (S4) and servability
   (`servable`) become genuinely different questions, so a later phase should
   name the second one honestly rather than encode it as a fraction.
7. **Identity Readiness is emitted only where readiness is already high.**
   `calculateBuilderScore` returns `score: null` unless the row is `BUILT`, so
   `REFUSED_BY_GUARD`, `NO_CATEGORY` and `FALLBACK_OBSERVED` rows carry no score.
   Under C-4's responsibility this is a survivorship-biased metric: it is
   undefined on exactly the cohort whose readiness is lowest and whose lexicon
   gaps most need prioritising, while the component breakdown that would explain
   *why* readiness failed is computed and then discarded. The published
   calibration in `QUALITY-SCORES.md` §6 (mean 82.3, r = 0.4539) is bound to this
   built-only denominator and would not survive widening it. **No change is
   proposed** — widening the denominator is an implementation change and a new
   score version, and neither is in scope for C-4. Recorded so a future reader
   does not mistake the current mean for a statement about the whole catalogue.

---

## 9. Robustness recommendations (preserve the architecture)

Ordered by value. None changes Vision extraction.

- **R1 · Close the `Human` provenance gap before building S7. — SETTLED, and it
  is a prerequisite.** `Human` becomes a first-class provenance alongside Vision
  and OCR; a human edit is self-evidencing and needs no validator agreement.
  Without it the review tool writes non-servable rows and appears to do nothing.
  Highest priority; a correctness prerequisite, not a nicety. (§6 S7, P14)
- **R2 · Make the recovery queue one durable table, not two queues.** Generalise
  `offer_ocr_queue` into a processor-agnostic recovery queue (`offer_id`,
  `processor`, `status`, `attempts`, `next_attempt_at`, `last_error`). Its retry,
  backoff and atomic-commit discipline already proved out; a second parallel
  queue per processor would duplicate all of it and drift. **Promoted by C-8**
  from a robustness suggestion to the load-bearing boundary of the whole recovery
  design — it is no longer optional, and it needs the execution-mode (Manual /
  Auto) and per-processor arming state to live on it.
- **R3 · Version the gate, never edit it.** `business-acceptance-v1` is
  immutable. Any change to the mandatory set is `v2`, and stored verdicts carry
  their version — the same discipline the score contract already mandates.
- **R4 · Put S1's price precondition in SQL.** It belongs in the `listDebris`
  WHERE clause, not in JS after selection: it reduces model spend on offers that
  could never be accepted, and it makes the queue depth an honest number.
- **R5 · Record the acceptance verdict, including rejections.** A stored `reject`
  with its `missing` list is how the mandatory set gets calibrated against real
  traffic. Without it, the only measurable signal is queue depth.
- **R6 · Reject reasons must be per-condition, never aggregated.** `missing:
  ['comparable_quantity']` is actionable; `accepted: false` is not.
- ~~**R7 · Add `oz` to the Package Parser's measure units.**~~ **WITHDRAWN
  2026-07-26 — the premise was false.** The recommendation claimed `matching.js`
  `SIZE_PATTERN` accepts `oz`/`fl oz` while `packageSize.MEASURE_UNITS` does
  not. Verified during implementation: there is no `SIZE_PATTERN` identifier,
  and `matching.js` has **no ounce support anywhere** — not in `UNIT_TO_BASE`,
  not in `UNITS`, not in `unitFor`. `parseSize('', '12 oz')` returns
  `{unit: null}`. There is therefore no inconsistency to close: `oz` is
  uniformly unsupported, which is coherent, and an unsupported unit yields "no
  size" — the documented failure mode.
  **Measured before deciding:** `oz`/`ounce` appears in **0 of the 1,000** rows
  of the production corpus. Adding it would mean editing the comparison path
  that watch matching and unit-price ranking depend on, and resolving the
  `oz`(weight) vs `fl oz`(volume) ambiguity, for a unit that does not occur in a
  metric market. Not worth the risk; recorded here so it is not re-proposed.
- **R8 · Assert the container-basis divergence in a test.** A `container`-basis
  product must pass S4 *and* score 0 on Commerce Score's `package_size`. Pin it,
  or someone will "fix" one to agree with the other. (§4.3)
- **R9 · Cap the ladder, and alarm on the cap.** A bounded attempt count per rung
  with the exhaustion surfaced in the Operations Center. A recovery ladder whose
  terminal rung is human attention needs a visible backlog, or it becomes a
  silent hole.
- ~~**R10 · One shared "usable English" predicate.**~~ **DONE 2026-07-26** —
  [`src/usableEnglish.js`](src/usableEnglish.js). Deviation §8.5 is closed.
- **R11 · Contract tests at the boundaries, not just inside stages.** P2, P6 and
  P7 are cross-stage invariants and none of them is currently asserted end to
  end. The three cheapest high-value tests in the system.
- **R12 · Extend the Vision Inspector rather than building a new surface for S7.**
  It already composes offer + enrichment + sighting + product and renders crops
  under the existing CSP. S7 is that view plus per-rung columns and three
  actions — reusing it inherits `OPS_TOKEN` auth, audit rows and the mobile-first
  layout for free.

---

## 10. Future recommendations for Vision itself — NOT part of this architecture

Recorded per the brief's instruction and deliberately excluded from every stage
above. **None of these is proposed, scheduled, or assumed by this contract.**

- The architecture's known ceiling (C-1): a presence gate recovers **absent**
  fields and cannot recover **wrong** ones. Closing that would need a validator
  covering brand as well as size, available **at ingest** — registry resolution
  runs later and is structurally unavailable at the routing point.
- Registry `products.size_unit/size_total/size_pack` is populated for 84% of
  active products and is already in canonical form — the best-covered validator
  candidate measured so far. Caveat: registry sizes are Vision-derived, so they
  measure agreement with the established baseline, not independent truth, and
  they are blind on genuinely new products, which is where hallucination risk is
  highest.
- The deterministic price guard (TODO -1.5) would license extracted prices as a
  cross-check against the offer row. Shape when built: when two prices are
  visible, current must be the lower; when a crop shows two and the model returns
  one, reject rather than accept.
- Any future model comparison must use identical prompts, samples, scoring and
  methodology — see the two benchmark folders for the shape of a comparison that
  counts.
- **A Render Fidelity score — possible future extension only, deliberately not
  adopted (C-4).** If the Arabic Builder ever stops being a filter-and-join and
  acquires real linguistic decisions — definiteness, construct state, number or
  gender agreement, ordering exceptions — then rendering acquires measurable
  variance that Identity Readiness structurally cannot see, and a second score
  measuring `parts`/`name` against the Structured Product would become
  meaningful. **None of that is true today**, so such a score would return the
  same value on every row and `QUALITY-SCORES.md` rule 8 rightly forbids it.
  Recorded here, and only here, so the possibility is not rediscovered as a
  surprise. It is not proposed, not scheduled, and not part of this architecture.

---

## 11. Decision log

All architecture decisions are settled. Implementation status is tracked in
§12.

| # | Decision | Settled |
|---|---|---|
| C-1 | Roles, not model names. Budget and Quality profiles; Budget is a conscious operator decision, not the recommended configuration | 2026-07-26 |
| C-2 | Price ownership outside Vision; validated 1000/1000 | 2026-07-26 |
| C-3 | S8e / S8f / S8g are siblings under S8d | 2026-07-26 |
| C-4 | Builder Score is an Identity Readiness metric; no second score, no new version | 2026-07-26 |
| C-5 | `business-acceptance-v1` mandatory set is exactly three conditions | 2026-07-26 |
| C-6 | OCR is retained as recovery rung R1 | 2026-07-26 |
| C-7 | Accepted-field immutability binds machine rungs only; the human rung may override | 2026-07-26 |
| C-8 | Recovery is **queue-driven, not pipeline-driven**. S4 ends the extraction pipeline; the Recovery Queue is the permanent boundary and spending is an operator decision | 2026-07-26 |
| C-9 | The Recovery Queue is **model-agnostic and reason-agnostic**. One admission rule — the offer did not become a servable canonical product. Processors are replaceable plug-ins; failure reasons are metadata | 2026-07-27 |
| R1 | `Human` is first-class, self-evidencing provenance | 2026-07-26 |
| — | Commerce Score never gates S4 | 2026-07-26 |
| — | `QUALITY-SCORES.md` amended for C-4 | 2026-07-26 |

### C-5 · The `business-acceptance-v1` mandatory set is confirmed

Exactly `{ price, comparable_quantity, english_name }`. No fourth condition.

Each earns its place by a different argument, which is the test for whether the
set is right: **price** is the one fact the whole product exists to compare and
it is free (C-2); **comparable quantity** is what makes two prices comparable at
all, so without it a price is a number without a denominator; **english name** is
the identity anchor, and it reuses S3's own verdict rather than inventing a
second bar (measured at 99% availability, so it is nearly free).

Everything else is non-blocking by §4.2, and brand is the load-bearing exclusion:
at 20% lexicon coverage a mandatory brand would reject ~80% of the catalogue for
a vocabulary gap.

**Calibrated with a known limit.** M2 tests *resolved*, never *correct* — see the
HONOR 5G case in §4.3, where "5G" parses as five grams. No correctness oracle
exists at S4 (the same ceiling C-1 documents), so the honest contract is a
presence conjunction with the limitation written down. Adding a fourth condition
is `business-acceptance-v2`, never an edit of v1 (R3).

### C-6 · OCR is retained as recovery rung R1

Kept, deliberately and explicitly, rather than by omission. `drainOcrEnrichment`
is deployed, tested, and already does exactly the job R1 describes: fill fields
the primary read left **missing**, never overwrite an accepted one. Retiring it
would delete a working recovery tier and leave Mode A with no automated rung at
all — every S4 rejection would fall straight to human review, which is the one
rung that does not scale.

Its cost profile is also the right shape for a first rung: OCR is far cheaper
than a second Vision read, so the ladder spends the cheap recovery before the
expensive one, and human attention last.

### C-7 · Accepted-field immutability binds machine rungs only

**The question.** P6 states accepted fields are immutable across rungs, and §6 S6
adds *"every rung, human included, inherits this rule."* But S7 exists to correct
extraction errors, and the errors that matter most are **accepted** fields — the
`10 KG` hallucination against a printed `5kg` was accepted at 0.98 confidence.
Taken literally, the human rung could not fix the defects the ladder exists to
catch, and the review tool would be able to fill blanks but never correct a lie.

**Resolution.** P6 binds **machine rungs only**. Its purpose is to stop a weaker
automated source from clobbering a stronger one — OCR must never overwrite an
accepted Vision field, and a recovery extractor must never overwrite the primary.
The human rung is not another source competing on evidence; it is the terminal
authority the ladder escalates *to*. It may override any field.

Three constraints keep this from becoming a hole:

1. **The override is additive, never destructive.** The model's reply and every
   validation stay byte-identical (P2). A human edit writes a new provenance
   layer beside them.
2. **The override is recorded.** Every overridden field keeps its previous value
   and previous provenance in an audit list. "The human changed this" is always
   answerable, and a bad edit is always diagnosable.
3. **Machine immutability is unchanged.** `mergeValidatedExtractions` still
   throws, and `acceptedVisionFieldsOverwritten` still nulls corroboration. C-7
   adds an authority above those rules; it does not weaken them.

P6 is restated accordingly in §7, and P15 pins the audit requirement.

### C-8 · Recovery is queue-driven, not pipeline-driven

**User decision, 2026-07-26**, taken before S5 was implemented and superseding the
automatic-ladder form of S5 described in the original brief.

**The extraction pipeline ends at S4.** Business Acceptance is terminal, not a
branch point. A rejected product is written to the **Recovery Queue** together
with its verdict and its `missing` conditions, and the pipeline's job is over.
Nothing downstream of S4 runs as a consequence of the rejection itself.

**The queue is the permanent architectural boundary.** Vision Medium and OCR are
**recovery processors attached to the queue** — not mandatory stages, not rungs
the pipeline advances through. Whether they ever run is a separate, operational
decision.

**Two execution modes, both operator-owned:**

- **Manual** — rejected items stay queued until the operator explicitly chooses
  how to process them. This is the default posture.
- **Auto** — the queue is drained using the configured recovery strategy, when
  the operator judges that sufficient API budget exists.

**Why the boundary is architectural and not a scheduling detail.** Recovery is
the expensive half of this system: Vision Medium and OCR both cost materially
more per offer than a Vision Small read. An automatic ladder therefore commits
spend as a side effect of an extraction verdict — the pipeline decides the
budget. C-8 inverts that: the pipeline decides *what needs recovery*, and the
operator decides *whether to pay for it*. Queue depth becomes a budget forecast
instead of an invoice already incurred.

**What this changes from the original S5.** The `RUN(rung) | TERMINATE(reason) |
HOLD(retryAt)` router and the automatic Mode A / Mode B ladder are **withdrawn**.
Ladder position remains durable state (that part of S5 was right and is retained
by the queue itself), but there is no automatic progression from one processor to
the next. "Mode A / Mode B" no longer means "is the recovery extractor armed" —
arming is now per-processor queue configuration, and the Manual/Auto switch is a
different axis entirely: *whether a drain may process items the operator did not
name one by one*.

**What it does not change.** C-6 stands: OCR is retained, and it is still the
cheapest recovery processor, so it remains the sensible first choice when the
operator does drain. C-7 stands: machine processors may not overwrite accepted
fields; the human may. R5/R6 stand and become the queue's input contract — the
stored verdict and its per-condition `missing` list are precisely what a queued
item must carry for an operator to triage it.

**Interaction with the model-selection directive, recorded so it is not
misread.** C-8 does *not* reopen [`small-first routing`], which was measured and
rejected: Medium remains the production baseline and Small remains a manual
Budget toggle. But C-8 does change one premise behind that rejection. Small-first
was rejected in part because the measured escalation rate was **0%** — no
validator had the coverage to trigger a re-read, so defects simply stayed. Under
C-8 the escalation trigger is an operator working a queue, not a validator. That
is a real answer to the measured failure, and it makes the Budget profile
defensible in a way automatic small-first was not. It is still a conscious
operator choice under C-1, not a new default, and switching it requires the same
explicit act it always did.

---

### C-9 · The Recovery Queue is a platform, not a recovery strategy

**User decision, 2026-07-27**, taken before S5 was implemented and refining C-8's
queue into a permanent platform component.

**The queue is model-agnostic.** It knows nothing about Vision Medium, OCR, or
any specific recovery model. Its entire responsibility is to store recoverable
work together with the failure verdict, the missing conditions, recovery status,
attempt history and metadata. Recovery models are **independent queue
processors**; adding or replacing one must never require changing the queue.
Today that is the OCR Processor, the Vision Medium Processor and the Human
Review Processor (S7). Tomorrow it is a Vision Large Processor or an engine that
does not exist yet, and the queue must not notice the difference.

**The queue is also reason-agnostic — one admission rule.** A product enters the
Recovery Queue whenever it **fails to produce a servable canonical product**. The
specific cause is irrelevant to the queue. Business Acceptance, the Quality Gate
and any future mandatory rule all produce the same admission; they differ only in
the metadata recorded on the row. There are not two queues, two admission
predicates, or a taxonomy the queue branches on.

**Why one rule and not a union of causes.** A queue whose admission is
`acceptance_reject ∨ not_servable` has to be re-opened and re-reasoned every time
a mandatory rule is added — the failure taxonomy leaks into the admission logic,
which is the same coupling that makes today's `offer_ocr_queue` unreplaceable at
the status-enum level. Expressed as a single negation, a future mandatory rule
changes what "servable canonical product" means and the queue inherits it for
free.

**Two things this rule requires to be executable.** Both follow from the wording
rather than qualifying it, and neither reintroduces a taxonomy:

1. **"Servable canonical product" is the conjunction of every mandatory rule,**
   evaluated as one predicate: `servable(row) ∧ S4.accepted`. `servable()` keeps
   its exact present meaning — the identity gate of the 2026-07-21
   canonical-identity directive, names present and corroborated — and becomes one
   conjunct rather than the whole test. This is deliberately **not** a
   redefinition of `servable()` and **not** a change to `SERVABLE_SQL`: the read
   path is untouched by this decision, and whether an S4-rejected offer should
   also disappear from Search is a separate question with a live production
   effect, recorded in §9 and not settled here. Naming the composite
   *canonical product complete* keeps one meaning per name.
2. **Failure requires an attempt.** "Not servable" is trivially true of every
   offer that has never been extracted, so admission is evaluated **once, at the
   pipeline's terminal point** — after the primary extraction, where S4 already
   runs — and never as a standing predicate over `offers`. S1 owns "not yet
   tried"; the Recovery Queue owns "tried and failed". Without this the queue
   would admit the entire catalogue.

**What this settles about the queue's shape.** No processor name may appear in
the queue schema or the queue module: no CHECK constraint enumerating processor
ids, no per-processor column, no per-processor status value. Status values are
lifecycle verbs (`queued`, `claimed`, `resolved`, `exhausted`, `dismissed`),
never `ocr_pending`. Processor identity is opaque TEXT, and a registry — not the
database — is the authority on what may run. The checkable form: **adding a
processor is one new module plus one registry line, touching no queue code, no
schema and no migration.**

**Execution policy is a third independent axis.** Manual (the default — items
wait until the operator chooses a processor) and Auto (a drain may take the ready
set with the configured processors, when the operator judges quota and budget
allow) are the same runner differing only in who supplies the item list. Auto is
an *authorisation*, not a scheduler: every pass is still explicitly invoked, and
no cron drives one (S5.7). The setting is
operational configuration, not architecture: it lives beside the Vision model
selection in the object store, needs no migration, and **every failure to read it
resolves to Manual**. That fail-safe deliberately inverts `visionModel.js`, where
an unreadable setting resolves to the best model; here the safe direction is to
spend nothing.

**What it does not change.** C-8 stands entire: S4 is still terminal, and writing
the queue row is still the last thing the pipeline does. C-6 stands: OCR is
retained and is still the cheapest processor. C-7 stands, and gains an
enforcement location — accepted-field immutability is applied at the queue's
**commit boundary**, not inside processors, so a new processor cannot fail to
implement it. One consequence of that boundary is worth stating as an invariant:
a processor proposes fields but never closes its own item. The runner re-runs S4
and only acceptance moves an item to `resolved`, which is what keeps the closure
condition identical for every processor that will ever exist.

**Two properties the queue has to guarantee, both of them invisible when they
work.** Neither is processor knowledge, so both live in the queue and the runner.

*The lease FENCES; it does not merely expire.* `claim()` returns a **claim
token**, minted fresh per claim and stored on the row, and every write that
follows re-asserts ownership against it — including the canonical transaction.
Winning a claim only proves ownership at one instant; a Worker that is evicted,
throttled or simply slow finishes after its lease has passed to someone else, and
without a fence it would overwrite a successor's canonical row from the same crop.
That failure is silent — an overwritten good field looks exactly like a recovered
one, which is the failure mode C-7 exists to prevent, arriving by a different
route. The fence rides inside the commit batch (a statement that violates the
status CHECK when the token no longer matches, aborting the whole transaction),
so a stale worker's row, verdict, resolution and history all roll back together.
Losing that race is reported as `staleClaims`, not as an error.

*Exclusion turns on OUTCOME and on GENERATION, not on "has this processor
touched this offer".* A processor is skipped for an offer it has **settled**
(`recovered` / `no_change`) — that is the calibration signal. It is **not**
skipped after `failed` or `declined`, which reached no conclusion; excluding
those would let one transient provider error retire an offer permanently while
leaving it in `queued` forever, with `attempts`, `next_attempt_at` and
`maxAttemptsPerItem` all reduced to dead code. And exclusion is scoped to
`queued_at`, the evidence generation: a re-extraction resets both the attempt
counter and the history's relevance, because a processor that settled against the
old observation has said nothing about the new one. A `declined` run consumes no
attempt at all — otherwise an unbound credential walks the entire queue into
`exhausted` without a single model call.

---

## 12. Implementation status

Architecture is settled; this section tracks what exists in code.

| Stage / item | Module | State |
|---|---|---|
| Comparable Quantity (§4.3) | [`lexicon/comparableQuantity.js`](src/lexicon/comparableQuantity.js) | **built**, `comparable-quantity-v1`, 13 tests |
| S4 Business Acceptance Gate | [`offers/businessAcceptance.js`](src/offers/businessAcceptance.js) | **built**, `business-acceptance-v1`, 15 tests |
| S1 Extraction Admission predicate | `businessAcceptance.isExtractionCandidate` | **built** (pure form), tested |
| R1 · `Human` provenance | `offers/smartExtraction.js`, `offers/enrich.js` | **built**, 11 tests |
| R10 · one usable-English predicate | [`usableEnglish.js`](src/usableEnglish.js) | **built**, shared leaf module |
| R7 · `oz` measure unit | — | **withdrawn**, false premise (§9) |
| R4 · S1 predicate pushed into SQL | [`storage/enrichStore.js`](src/storage/enrichStore.js) `USABLE_PRICE_SQL` | **built**, applied to `listDebris` / `countDebris` / `coverage`, 15 tests |
| R5/R6 · Acceptance verdict persistence | `offer_acceptance_verdicts`, `saveVisionOutcome`, `acceptanceSummary` | **built**, 20 tests |
| S6 recovery processor `source` **CHECK removal** (not a widening — see below) | `schema.sql`, `migrate-2026-07-27-extraction-source-open.sql` | **built** |
| S5.1 Recovery Queue schema | `migrate-2026-07-27-recovery-queue.sql` | **built**, 2 tables, folds in `offer_ocr_queue` |
| S5.2 Recovery Queue store | [`storage/recoveryQueue.js`](src/storage/recoveryQueue.js) | **built**, 18 tests |
| S5.3 Admission at the S4 terminal point | `offers/enrich.js` `recoveryAdmission`, `saveVisionOutcome` | **built** |
| S5.4 Processor registry + runner | [`recovery/registry.js`](src/recovery/registry.js), [`recovery/runner.js`](src/recovery/runner.js) | **built**, 15 tests |
| S5.5 OCR as a queue processor | [`recovery/processors/ocr.js`](src/recovery/processors/ocr.js) | **built**, 4 tests |
| S5.6 Execution policy (Manual/Auto) | [`recovery/policy.js`](src/recovery/policy.js) | **built** |
| S5.7 Routes + Operations Center panel | `ops/console.js`, `ops/status.js` `recoverySnapshot`, `ops/ui.js`, `engine.js` `/recovery-drain` | **built**, 16 tests |
| S7 Developer Review surface (R12) | `ops/console.js` | not built |

The pure items are **additive**: they compute verdicts nothing yet consumes, so no
production read path changes until a caller is wired. Two items now do write, and
both are safe by construction:

- **R4** changes three SQL queries. It is the one change with a live production
  effect: priceless offers leave the extraction queue, so queue depth drops and
  spend drops with it. No row is written and no read path changes shape. The
  predicate is a hand translation of `hasUsableCommercePrice`, and hand
  translations rot, so it is pinned by a differential test that executes the real
  fragment against real SQLite and asserts row-for-row agreement with the JS
  predicate (`storage/extractionCandidate.test.mjs`). Two divergences were caught
  that way before shipping — NBSP-padded currency, where SQL was stricter than JS
  and would silently have starved an extractable offer, and `Infinity`, where it
  was more permissive.
- **R5/R6** add one new table and one statement inside the existing atomic batch.
  The write is **migration-tolerant by design**: the store probes once per
  instance for `offer_acceptance_verdicts` and omits the statement when it is
  absent. A verdict is a calibration record, so it must never be able to fail an
  extraction — and because it rides inside the batch, a hard dependency there
  would have turned a missing migration into lost extraction work.

R1 remains the one behavioural change to an existing function:
`validatedExtractionCorroboration` skips validator agreement for `Human`
provenance. That path is unreachable until S7 exists, because nothing else
produces a `Human` value, so it is inert in production today.

⚠️ **`migrate-2026-07-26-acceptance-verdicts.sql` has not been applied.** Until it
is, `report.acceptance.judged` climbs while `persisted` stays 0 — the gate is
running and its verdicts are being discarded. That divergence is the intended
signal, not a fault.

⚠️ **R5 covers the `vision-first` drain only.** The legacy / OCR-first drain
(reachable only by a runtime `strategy` override, since production is
`vision-first`) commits through `upsertMany`, which has no atomic attempt+verdict
batch to join — the very property that makes the verdict write safe. Wiring it
there means restructuring a legacy write path, so it is deliberately deferred to
the S5 Recovery Queue work that will touch this area anyway. The gap is visible
rather than silent: such a batch reports `acceptance.judged: 0`.

**S5 status, 2026-07-27.** S5.0–S5.7 are code-complete and uncommitted; 37
suites green (33 before S5, plus 4 new) and the full `dev.mjs selftest` (live
1,047-offer D4D ingest).
**The whole feature is INERT in production**: the execution policy defaults to
Manual and disarmed, and nothing drains the queue until an operator arms it. The
one production-visible change is that the extraction batch now also writes a
Recovery Queue row — and only once the migration is applied, since the write is
migration-tolerant and falls back to the legacy `offer_ocr_queue` insert.

⚠️ **The two queues are deliberately double-written during the cutover.** The
legacy `offer_ocr_queue` statements remain in `saveVisionOutcome`, so **no data
restore is ever needed to go back**. This cannot cause double processing,
because the recovery runner is disarmed by default. **Remove the legacy
statements once the recovery queue is observed working** — they are marked
`⚠️ TRANSITIONAL` in `enrichStore.js`.

⚠️ **Rollback is two steps, not one.** Both environments ship
`OCR_FALLBACK_ENABLED = "false"` (`wrangler.toml`), so the legacy OCR drain is
**not** running alongside the double-write — the legacy rows are being kept warm,
not consumed. Reverting the Worker therefore restores the pre-S5 *code path* but
leaves recovery switched off entirely. Restoring pre-S5 *behaviour* additionally
requires setting `OCR_FALLBACK_ENABLED = "true"` and binding
`MISTRAL_OCR_API_KEY`. Neither step touches data, which is what the double-write
actually buys.

**S5.7 operator surface, built.** A Recovery card in the Vision tab renders
queue depth by missing condition (with the overlap warning, since those buckets
must never be summed), per-processor effectiveness, and the execution mode.
Every processor button, cost line and effectiveness row is rendered FROM the
registry payload, so a processor added tomorrow appears in the console with no
UI change — verified by a test that invents one and finds it dispatchable.

**Operational safety, as built:**
- Every mutating route is confirm-gated; **dismissal requires the typed string
  `DISMISS`**, because it is terminal and no automatic path undoes it.
- **Manual dispatch deliberately does NOT consult the execution policy.** An
  operator choosing a processor IS the authorisation (C-8); refusing that
  because Auto is off would be the tool overriding the person. The policy
  governs only whether the queue drains ITSELF.
- Dispatch is capped at 10 offers per call — a subrequest-budget bound, not a
  policy one — and the cap is published so the console can forecast cost before
  the operator confirms.
- Processors declare `credential: 'ocr' | 'vision' | null`; the caller resolves
  the name to a key chain. A processor reusing an existing credential costs no
  caller change; only a genuinely new provider does.
- `POST /recovery-drain` exists for unattended draining but is **deliberately
  not wired to a cron.** The enrich cron's per-invocation CPU and subrequest
  budget has been exhausted before (drainResolution, 2026-07-20), and adding a
  paid drain to that child is how you rediscover that limit. Wiring it is an
  operator decision; Manual dispatch and "Run Auto now" both work without it.

**Next: S7**, which plugs in as `recovery/processors/human.js` with
`kind: 'human'` and needs no queue, schema, runner or console change — that it
does not is the C-9 design working.

⚠️ **Correction to the S6 scope recorded above: it is a CHECK *removal*, not a
widening, and it is not a one-line change.** `offer_extraction_attempts.source`
is `CHECK (source IN ('vision','ocr'))`, and SQLite's `ALTER TABLE` cannot modify
a CHECK constraint at all — the only route is the 12-step table rebuild, whether
the constraint gains one value or is dropped. Widening it to three values
therefore buys a full rebuild and leaves the schema still holding an enumeration
of processors, forcing another rebuild for the next one. That directly violates
C-9's checkable property. Rebuild **once**, drop the constraint, and let the
processor registry be the authority on what may run. The `(offer_id, source)`
primary key is unaffected and still holds one latest row per processor; append-
only attempt history belongs to the queue's own attempts table, not here.

**Calibrate before arming anything.** R5/R6 exist so the mandatory set can be
measured against real traffic. `acceptanceSummary()` reports per-condition
rejection counts and an `onlyCondition` view isolating offers a single condition
is keeping out. Read that on production traffic before tuning the gate or sizing
recovery spend — it is the number C-8 hands the operator, and the reason queue
depth is now a budget forecast rather than an invoice already incurred.
