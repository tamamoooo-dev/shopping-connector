# Quality Scores: Independent Architecture Axes

Status: **Permanent architecture contract**

Scope: Builder Score, Commerce Score, and any future production quality scores.

Design principle:

> One score = one responsibility.

Builder Score and Commerce Score measure different properties. They are not interchangeable, compensating, or composable. They must never be averaged, summed, normalized into a shared score, or used as substitutes for one another.

> **Amended 2026-07-26 (VISION-PIPELINE.md C-4).** Builder Score's documented
> responsibility changed from *Arabic-name construction quality* to **Identity
> Readiness**, because that is what the implementation has always computed. The
> **formula is unchanged**, so by rule 7 this is **not** a new score version:
> `builder-score-v1` stands. Everything else in this contract — axis
> independence, non-composition, the forbidden-dependency tables, versioning,
> never user-facing — is unaffected.

## Architectural invariants

1. **Builder Score measures identity readiness only** — whether the Structured
   Product holds enough deterministic information to build a high-quality Arabic
   identity. It is not a measure of the rendered Arabic string.
2. **Commerce Score measures commercial usefulness only.**
3. A linguistic score must never influence commercial identity.
4. A commercial score must never influence Arabic-name quality.
5. Neither score is a probability, AI confidence, or statement that a product is objectively correct.
6. Both scores remain versioned deterministic metadata. They are not exposed to end users.
7. A workflow that needs both properties must apply independent minimum thresholds:

   ```text
   identity_ready    = builder_score  >= BUILDER_MINIMUM
   commerce_eligible = commerce_score >= COMMERCE_MINIMUM
   workflow_eligible = identity_ready AND commerce_eligible
   ```

   The workflow must not replace this conjunction with a weighted average or composite score. A high value on one axis cannot compensate for a low or missing value on the other.
8. Thresholds must be calibrated and documented against a specific score version. A formula change requires a new score version and renewed calibration.
9. The current production rollout remains unchanged: both scores are diagnostic shadow metadata and neither controls the Arabic-name feature flag.

## 1. Builder Score — Identity Readiness

### Purpose

Builder Score measures how completely the deterministic Shopping Lexicon understood the English source name for the purpose of constructing a built Arabic name. It answers:

> **Does the Structured Product contain enough deterministic information to build a high-quality Arabic identity?**

It does **not** answer *"did we generate a good Arabic name?"* — see Non-goals.

**It evaluates the Structured Product, never the rendered name.** Every input is a pure function of the Structured Product, including the dropped-fragment deduction: `built.dropped` is itself derived only from `structured.residual_en` and `structured.brand` (`arabicBuilder.js`), and is populated before composition runs. `calculateBuilderScore` accepts the built object as a parameter but never reads `built.name`, `built.parts` or `built.lines`. Its position after the Arabic Builder in the call graph is incidental, not a data dependency — the two are **siblings** over the Structured Product (`VISION-PIPELINE.md` C-3).

It evaluates linguistic readiness signals such as:

- category resolution;
- deterministic lexical coverage;
- brand resolution;
- size resolution;
- descriptor coverage;
- flavour coverage;
- unknown or dropped fragments; and
- guard outcome, which determines whether a numerical Builder Score exists.

The current implementation is `builder-score-v1`. Its implementation remains authoritative; this document does not change its formula.

| Component | Current maximum contribution |
|---|---:|
| Category resolved | 30 |
| Lexical coverage | 30 |
| Brand resolved | 10 |
| Size resolved | 10 |
| Descriptor coverage | 10 |
| Flavour coverage | 10 |
| Dropped-fragment deduction | -2 each, capped at -10 |

The score is produced only for names with builder status `BUILT`. Refused, fallback, and no-category outcomes do not receive an invented Builder Score.

### Consumers

Builder Score is appropriate for:

- Arabic Builder developer diagnostics;
- Shopping Lexicon coverage and curation reports;
- analysis of unknown and dropped English fragments;
- Arabic-name regression and validation reports; and
- prioritizing linguistic review work.

**Removed 2026-07-26 (C-4): a future Arabic-name display-quality gate.** A readiness score answers *"should we have attempted this name?"*, not *"is the name that came out safe to show?"* Those questions coincide today only because the Arabic Builder is a filter-and-join that is lossy by **drop**, never by **guess** — it structurally cannot lose anything already accounted for in `dropped`. The moment the builder acquires a real linguistic decision (definiteness, construct state, number or gender agreement, ordering exceptions), a rendering defect becomes invisible to this score, and a display gate built on it would pass a malformed name at a score of 95. Display eligibility must not depend on this axis.

### Non-goals

Builder Score does not measure or decide:

- **rendering quality of the built Arabic name** — its fluency, grammar, agreement, or whether it is safe to display;
- product identity;
- whether two offers represent the same product;
- registry attachment, merge, or product-ID creation;
- price correctness;
- package comparability for commerce;
- historical price-series membership;
- watch matching;
- search relevance or commercial usefulness;
- whether an offer is safe to include in price comparison;
- general data quality; or
- AI/model confidence.

A high Builder Score means the lexicon understood enough of the source name to **attempt** a good Arabic name. It does not mean the name that was produced is good, and it does not mean the offer has a usable price, brand, package size, or commercial identity.

### Recorded limitation

A numerical score exists only for builder status `BUILT`. Refused, fallback and no-category outcomes receive no invented score. Under the Identity Readiness responsibility this makes the metric **survivorship-biased**: it is undefined on exactly the cohort whose readiness is lowest and whose lexicon gaps most need prioritizing. The §6 calibration below is therefore bound to a built-only denominator and does not describe the whole catalogue. Widening the denominator would be a formula change and thus a new version under rule 7; it is not proposed here.

## 2. Commerce Score

### Purpose

Commerce Score measures how useful the deterministically extracted offer is for product identity and grocery price-comparison workflows.

It prioritizes the fields that support:

- product identity;
- price comparison;
- historical pricing;
- cross-store matching;
- watches; and
- search quality.

The current implementation is `commerce-score-v1`:

| Component | Current contribution |
|---|---:|
| Authoritative price and currency resolved | 35 |
| Structured package size resolved | 25 |
| Canonical brand resolved | 20 |
| English identity usable | 10 |
| Category resolved | 5 |
| Deterministic descriptors or flavour resolved | 5 |

Commerce Score is deterministic. It is computed from structured production fields and does not consume Builder Score, Arabic-name quality, or AI confidence.

### Consumers

Commerce Score is appropriate for:

- developer and operations diagnostics for commercial extraction;
- production measurement of offer usefulness;
- Super Search quality reports;
- identifying offers that need price, package-size, brand, or identity remediation;
- prioritizing commercial-data review; and
- future commercial admission, triage, or eligibility gates only after explicit production calibration for the relevant Commerce Score version.

Commerce Score may summarize commercial completeness for diagnostics. It does not replace the underlying evidence required by an identity or pricing decision.

### Non-goals

Commerce Score does not measure or decide:

- Arabic fluency, grammar, readability, or lexical completeness;
- whether a built Arabic name should be displayed;
- transliteration quality;
- Shopping Lexicon vocabulary quality;
- Arabic Builder guard behavior;
- whether a registry identity is proven;
- whether two records may be merged;
- model confidence or a probability of correctness; or
- price truth beyond the deterministic structural checks represented by the current formula.

A high Commerce Score means the offer contains useful structured commercial fields. It does not mean the built Arabic name is good, complete, or eligible for display.

## 3. Allowed production dependencies

Both scores are currently diagnostic only. There are no score-driven production behavior changes in the present rollout.

The following dependency boundaries are allowed for future work, subject to explicit approval, versioned thresholds, and production validation:

| Production component | Builder Score | Commerce Score |
|---|---|---|
| Arabic Builder diagnostics | Primary quality axis | May be shown alongside it for comparison only |
| Shopping Lexicon curation and coverage analysis | May prioritize linguistic review | No dependency |
| Built-Arabic display eligibility | **No dependency** (C-4) — readiness is not render quality | No dependency |
| Commercial extraction diagnostics | No dependency | Primary quality axis |
| Super Search commercial-quality reporting | No dependency | May measure or triage offer usefulness |
| Price-comparison eligibility | No dependency | May become an independent commercial threshold |
| Commercial review queues | No dependency | May prioritize incomplete offers |
| Cross-domain validation reports | Display as a separate axis | Display as a separate axis |

“Shown alongside” means separate fields, distributions, or two-dimensional cohorts. It never means combining the values.

## 4. Forbidden production dependencies

### Components that must never depend on Builder Score

Builder Score must never affect:

- product-registry identity resolution;
- product-ID minting;
- record attachment or merge decisions;
- cross-store product matching;
- canonical commercial identity;
- price extraction or validation;
- unit-price calculation;
- historical price-series assignment;
- watches or alerts;
- commercial search eligibility or ranking;
- **built-Arabic display eligibility** (C-4 — a readiness score cannot authorize showing a rendered string); or
- Commerce Score or any of its inputs.

The Product Registry must continue to use its own deterministic identity evidence and conflict rules. Linguistic completeness is not commercial identity evidence.

### Components that must never depend on Commerce Score

Commerce Score must never affect:

- Arabic token selection;
- phrase-first matching;
- longest-match behavior;
- rightmost head-noun selection;
- the head-final guard;
- brand/size exclusion from category selection;
- Arabic descriptor, flavour, or category rendering;
- whether an ambiguous lexicon term is accepted;
- built-Arabic quality assessment;
- Builder Score or any of its inputs; or
- built-Arabic display eligibility.

Commercial completeness is not evidence that an Arabic name is linguistically safe.

### Components that must not use either score as authority

Neither score may, by itself:

- override a guard or safety rule;
- convert missing evidence into resolved evidence;
- authorize a destructive registry merge;
- manufacture a category, brand, size, price, or identity;
- replace the feature-flag rollback path;
- be exposed in an end-user API or user interface; or
- be treated as confidence or truth.

Developer diagnostics and validation reports may present both scores, but must preserve their names, versions, breakdowns, and separate distributions.

## 5. Workflows that require both axes

Some future workflows may require both a commercially useful offer and a sufficiently complete built Arabic name. Such a workflow must define two independently justified thresholds.

Example:

```text
commercially_usable =
    commerce_score_version == "commerce-score-v1"
    AND commerce_score >= COMMERCE_MINIMUM

identity_ready =
    builder_status == BUILT
    AND builder_score_version == "builder-score-v1"
    AND builder_score >= BUILDER_MINIMUM

eligible =
    commercially_usable
    AND identity_ready
```

Note the second predicate is named `identity_ready`, not `arabic_display_eligible` (C-4). Built-Arabic **display** eligibility is governed solely by builder status and the reversible feature flag; no score participates in it.

Forbidden:

```text
quality = (builder_score + commerce_score) / 2
eligible = quality >= COMBINED_MINIMUM
```

The forbidden form allows strong commercial data to conceal a poor Arabic name, or a polished Arabic name to conceal weak product identity.

Missing scores must not be imputed from the other axis. Each workflow must define how absence on its relevant axis is handled.

## 6. Production evidence for keeping the axes separate

The production validation set demonstrates that the scores measure different properties:

- Mean Builder Score: **82.3** across built names.
- Mean Commerce Score: **75.4** across production offers.
- Pearson correlation on rows containing both scores: **0.4539**.
- Low-Builder/high-Commerce cohort: **26** rows.
- High-Builder/low-Commerce cohort: **17** rows.

Examples reinforce the distinction:

- `Vicks Vapo Drops` has strong commercial fields but incomplete linguistic coverage, producing a low Builder Score and high Commerce Score.
- `Tomato` and `School Backpack` can have lexically complete built Arabic names while lacking the package-size, brand, or descriptor evidence needed for a high Commerce Score.

The moderate correlation and both mismatch cohorts show that neither score can predict or replace the other. These measurements support independent axes rather than a composite metric.

## 7. Rules for introducing additional scores

Every proposed score must satisfy all of the following before implementation:

1. **Declare one responsibility.** State the single property the score measures in one sentence.
2. **Name the owner and consumers.** Identify which component produces it and which components may read it.
3. **Define non-goals.** Explicitly list adjacent decisions that the score must not influence.
4. **Use deterministic, auditable inputs.** Document every input, weight, deduction, missing-value rule, and output range. If a future metric uses probabilistic or model-derived evidence, it must be named and governed as a separate kind of metric, not hidden inside a deterministic score.
5. **Do not consume another score.** A score may use shared source facts when appropriate, but must not use Builder Score, Commerce Score, or another aggregate score as an input.
6. **Prevent compensation across responsibilities.** Do not average, sum, blend, or normalize unrelated axes into a composite.
7. **Version the formula.** Any change to inputs, weights, deductions, or missing-value behavior creates a new immutable version.
8. **Start in shadow metadata.** Keep the score developer-only and non-behavioral until its production distribution and failure modes are validated.
9. **Validate with production measurements.** Report distribution, missingness, correlations with existing scores, mismatch cohorts, and the downstream outcome the score is intended to support.
10. **Calibrate thresholds independently.** Bind every threshold to one score and one version. A workflow needing multiple properties must use separate thresholds joined by explicit boolean logic.
11. **Preserve source evidence.** Aggregate scores must not replace their component breakdowns or the authoritative fields used for decisions.
12. **Test isolation.** Regression tests must prove that unrelated signals cannot change the score and that the score cannot change prohibited components.
13. **Document rollout and rollback.** Enabling a score-driven behavior requires a separate architecture decision, a reversible flag or equivalent control, and measured acceptance criteria.
14. **Amend this contract.** A new score is not production-ready until its responsibility and dependency boundaries are added to the permanent architecture documentation.

## 8. Implementation and enforcement references

The current implementation boundaries are:

- Builder Score: [`src/lexicon/arabicRollout.js`](src/lexicon/arabicRollout.js)
- Commerce Score: [`src/offers/commerceScore.js`](src/offers/commerceScore.js)
- Developer-only score diagnostics: [`src/offers/arabicBuilderDebug.js`](src/offers/arabicBuilderDebug.js)
- Production validation report generator: [`validation/arabic-builder-rollout-report.mjs`](validation/arabic-builder-rollout-report.mjs)
- Commercial identity authority: [`IDENTITY-OWNERSHIP.md`](IDENTITY-OWNERSHIP.md)
- Pipeline stage boundaries and the C-4 decision: [`VISION-PIPELINE.md`](VISION-PIPELINE.md)

Architecture review must reject any change that:

- crosses the forbidden dependency boundaries above;
- creates a combined Builder/Commerce score;
- uses one axis as a fallback for the other;
- changes rollout behavior without a separate approved decision; or
- exposes score metadata to end users.
