# Controlled Mistral extraction benchmark

Date: 2026-07-23  
Mode: read-only production sampling and isolated API evaluation  
Production code/configuration/data changes: none  
Frozen sample digest: `a6a4e42e61c30fef8a93a9507270c3ce9264c4c0e9e74edf031cb538f22b209d`

## Executive result

No single tested strategy was best for every identity field.

- **Best single-call structured strategy:** Mistral OCR with structured annotation, with a 63.9% strict weighted identity score.
- **Best current-price extractor:** Mistral Medium, 20/20 (100%).
- **Best exact English and Arabic text source:** raw Mistral OCR text through the current deterministic parser, 14/19 (73.7%) English and 8/19 (42.1%) Arabic.
- **Best brand source:** Mistral OCR structured annotation, 16/17 (94.1%).
- **Best package-count source among tested model outputs:** Mistral Medium, 3/5 (60%); this is still not production-sufficient.
- **Best additional-attribute coverage:** Mistral OCR structured annotation, 32 useful returned attributes with 4 unsupported attributes.
- **Best production design:** field-level hybrid, not one model for the whole object.

The strict composite score counts only exact field matches at full weight and directly supported partial names at half weight. Wrong, missing, price-role errors, and unsupported values receive no credit. This favors literal product identity rather than fluent paraphrase.

## Experimental controls

- 20 frozen crops from recent production.
- 16 retailers and 17 declared categories.
- One random crop per selected retailer, plus four random second crops, so the set is diverse without allowing high-volume retailers to dominate.
- Every ranked variant processed the exact same bytes.
- All 20 crop hashes and the ordered sample digest were verified before requests.
- Temperature `0`, `top_p=1`, and current `*-latest` model aliases were used.
- Human truth was created by direct inspection of each original-resolution crop.
- Existing production price metadata was used only to disambiguate tiny crossed-out digits.
- No production write, re-enrichment, configuration change, or deployment occurred.

## Strategies tested

1. `small_current`: Mistral Small with the current production Vision extraction prompt and current field mapping.
2. `small_expanded_json`: Mistral Small with a literal, expanded JSON prompt including price, unit, package, quantity, and attributes.
3. `ocr_current_parser`: raw Mistral OCR markdown passed through the current deterministic OCR parser.
4. `ocr_structured_annotation`: the same OCR page request with a strict structured annotation schema.
5. `medium_expanded_json`: Mistral Medium with the expanded literal JSON prompt and reasoning disabled.

An additional Medium high-reasoning two-pass pilot was attempted. It completed only 6/20 before being stopped as operationally unsuitable. Successful calls averaged about 152 seconds per crop and generated unusually large reasoning outputs. It is excluded from all accuracy rankings. A no-reasoning two-pass retry stalled upstream before producing a first result and was also excluded.

The two OCR strategies were derived from the **same annotated OCR request** per crop. The benchmark therefore consumed 20 OCR pages, not 40.

## Overall ranking

| Rank | Strategy | Weighted identity | Strict unsupported/wrong-field rate | Missing-field rate | JSON consistency |
|---:|---|---:|---:|---:|---:|
| 1 | OCR structured annotation | 63.9% | 24.2% | 11.5% | 100% |
| 2 | Medium expanded JSON | 58.0% | 21.0% | 13.8% | 100% |
| 3 | OCR current parser | 53.3% | 35.2% | 35.4% | 100% |
| 4 | Small expanded JSON | 45.3% | 30.6% | 25.4% | 100% |
| 5 | Small current prompt | 37.5% | 38.8% | 42.3% | 100% |

“Strict unsupported/wrong-field rate” is the benchmark’s conservative hallucination measure: populated main fields whose value was not supported as that field by the visible crop. It includes invented content and materially wrong transcription, but excludes incomplete supported text and current/old price swaps. Price-role errors are tracked separately.

## Per-field exact accuracy

The denominator is the number of crops where the human-canonical field was actually present. Correct nulls do not inflate accuracy.

| Strategy | English name | Arabic name | Brand | Current price | Old price | Unit | Size | Package count | Package type |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Small current | 7/19 (36.8%) | 1/19 (5.3%) | 14/17 (82.4%) | 0/20 | 0/19 | 7/16 (43.8%) | 9/13 (69.2%) | 2/5 (40.0%) | 0/2 |
| Small expanded | 5/19 (26.3%) | 0/19 | 12/17 (70.6%) | 15/20 (75.0%) | 11/19 (57.9%) | 3/16 (18.8%) | 9/13 (69.2%) | 1/5 (20.0%) | 2/2 |
| OCR current parser | **14/19 (73.7%)** | **8/19 (42.1%)** | 15/17 (88.2%) | 0/20 | 0/19 | **8/16 (50.0%)** | 7/13 (53.8%) | 0/5 | 0/2 |
| OCR structured | 12/19 (63.2%) | 7/19 (36.8%) | **16/17 (94.1%)** | 13/20 (65.0%) | 10/19 (52.6%) | 4/16 (25.0%) | 9/13 (69.2%) | 2/5 (40.0%) | 2/2 |
| Medium expanded | 3/19 (15.8%) | 1/19 (5.3%) | 12/17 (70.6%) | **20/20 (100%)** | **16/19 (84.2%)** | 3/16 (18.8%) | 9/13 (69.2%) | **3/5 (60.0%)** | 2/2 |

Package-type recall is misleading in isolation. The expanded Small, OCR, and Medium variants also emitted unsupported package types on 7, 9, and 5 crops respectively. Package type therefore needs an explicit-text admission rule.

## Per-image comparison

Scores are strict weighted identity scores, not model confidence. The “best” column is the best tested single output for that crop; a field-level hybrid can be better.

| # | Store / category | Best single strategy | Small current | Small JSON | OCR parser | OCR structured | Medium JSON | Decisive observation |
|---:|---|---|---:|---:|---:|---:|---:|---|
| 1 | aljazera / poultry | OCR parser | 50 | 39 | **84** | 61 | 55 | OCR preserved both English product alternatives; Medium alone assigned both prices correctly. |
| 2 | aljazera / cheese | OCR parser | 18 | 29 | **47** | 47 | 44 | Tiny bilingual caption defeated exact extraction; no output was complete. |
| 3 | almadina / poultry | Small JSON / Medium | 57 | **68** | 55 | 50 | **68** | OCR preserved full names but omitted or reversed prices; Small/Medium got current price and 3×340g. |
| 4 | almadina / mobile | OCR structured | 27 | 55 | 50 | **100** | 77 | OCR structured preserved full TECNO model identity and visible specifications. |
| 5 | alwafa / yoghurt | OCR parser | 60 | 20 | **80** | 65 | 57 | OCR preserved exact bilingual caption; only Medium found the 10.00 current price. All missed Buy 2 PCS. |
| 6 | carrefour / rice | OCR structured / Medium | 50 | 34 | 53 | **66** | **66** | Structured OCR had full identity; Medium had reliable price roles. |
| 7 | cityflower / watch | Medium | 0 | 23 | 0 | 23 | **62** | Medium was most robust, but all variants missed the explicit 7-in-1 count as a quantity field. |
| 8 | danube / laundry | OCR structured | 37 | 53 | 63 | **79** | 66 | OCR gave exact bilingual identity; Medium gave correct price roles. OCR annotation invented 22.5 as price. |
| 9 | farm / dates | OCR structured | 16 | 21 | 68 | **84** | 55 | OCR structured was strongest across names, brand, prices, and size. |
| 10 | grandhyper / toy | Small JSON / Medium | 42 | **67** | 33 | 17 | **67** | OCR parser captured engineering/layout text as product identity; OCR annotation reversed prices. |
| 11 | hyperpanda / dates | OCR structured | 11 | 11 | 45 | **79** | 39 | OCR structured recovered exact identity, brand, current price, and size; old price remained missing. |
| 12 | lulu / appliance | OCR structured | 53 | 73 | 63 | **100** | 57 | OCR structured correctly captured bilingual name, model, prices, and origin attribute. |
| 13 | marksave / cotton buds | OCR structured | 15 | 30 | 50 | **65** | 35 | OCR recovered the full caption but misread Arabic 200 as 20 and the count field remained unreliable. |
| 14 | nesto / fresh meat | Medium | 29 | 50 | 64 | 79 | **86** | Medium correctly handled both price roles; OCR structured swapped them. |
| 15 | othaim / wraps | Small JSON | 47 | **65** | 47 | 50 | 62 | Small preserved the full variant list and price basis; OCR annotation invented `10+2` as size. |
| 16 | prime / tissue | OCR structured | 45 | 65 | 40 | **70** | 43 | OCR structured best combined full English caption, brand, prices, and outer count; Arabic was wrong. |
| 17 | prime / pasta | Small JSON / Medium | 50 | **66** | 58 | 53 | **66** | OCR had exact captions but bad price handling; Medium’s old price was off by 0.01. |
| 18 | ramez / preserves | OCR parser | 29 | 14 | **50** | 36 | 36 | Hardest crop: no strategy produced a fully reliable identity; models selected one pictured flavor or invented a generic English name. |
| 19 | ramez / toothpaste | OCR structured / Medium | 63 | 58 | 42 | **66** | **66** | OCR structured preserved the full Arabic caption; Medium was reliable for prices and package quantity. |
| 20 | tamimi / sugar | OCR structured | 53 | 66 | 74 | **89** | 55 | OCR structured preserved both full captions, brand, prices, and size; `EACH` was incorrectly used as product unit. |

The machine-readable file contains every field status for every image/strategy, plus each structured output.

## Cost, latency, and usage

Pricing uses the published rates applicable to these model families at benchmark time:

- Small: $0.15/M input tokens and $0.60/M output tokens.
- Medium 3.5: $1.50/M input tokens and $7.50/M output tokens.
- OCR raw: $4/1,000 pages.
- OCR with annotations: $5/1,000 pages.

| Strategy | Requests/pages | Input tokens | Output tokens | Cost for 20 | Cost/crop | Avg latency | P95 latency |
|---|---:|---:|---:|---:|---:|---:|---:|
| Small current | 20 requests | 21,993 | 1,277 | $0.00407 | $0.000203 | 1.19 s | 1.53 s |
| Small expanded | 20 requests | 13,553 | 2,062 | $0.00327 | $0.000164 | 1.48 s | 1.84 s |
| OCR current parser | 20 pages | not reported | not reported | $0.08000 theoretical raw | $0.004000 | 2.23 s | 3.81 s |
| OCR structured | 20 pages | not reported | not reported | $0.10000 | $0.005000 | 2.23 s | 3.81 s |
| Medium expanded | 20 requests | 13,553 | 2,251 | $0.03721 | $0.001861 | 2.52 s | 4.06 s |

Because raw OCR and OCR annotation came from the same annotated requests, actual OCR cost for the experiment was $0.10, not $0.18. OCR did not expose token counts in these responses.

## Robustness findings

- **Poor text quality:** Medium was strongest on the difficult watch crop, while structured OCR was strongest on the toothpaste crop. No strategy handled the mixed preserve-flavor crop reliably.
- **Exact wording:** raw OCR was decisively best. Medium frequently produced a semantically useful short name but removed visible brand, size, or variant wording.
- **Bilingual products:** raw OCR best preserved both caption lines. Structured annotation sometimes paraphrased or translated rather than copying.
- **Price semantics:** Medium was the clear winner. Structured OCR swapped current/old roles in 6/20 current-price cases; Small expanded did so in 3/20.
- **Invented/unsupported information:** package type was the most common inferred field. OCR layout artifacts also became false brands/names (`TIAB`, `PREVIOUSLY`, `JUP`), and Small occasionally treated model numbers or promotion marks as brands.
- **Model confidence:** not calibrated. Several materially wrong outputs claimed 0.95–1.00 confidence. Confidence must not be used as the sole acceptance gate.

## Field-by-field production source recommendation

| Field | Recommended source | Why / admission rule |
|---|---|---|
| English product name | **Raw Mistral OCR caption, with deterministic caption-region selection** | Best exact result: 73.7%. Do not use OCR parser output when it begins with price/layout words such as `PREVIOUSLY`, drawing metadata, or price-only text. Medium can propose a semantic fallback, but must not replace supported literal OCR wording. |
| Arabic product name | **Raw Mistral OCR caption** | Best exact result: 42.1%. Preserve raw Arabic; do not translate from English. Reject obvious numeral corruption and require Arabic-script evidence in the crop/OCR line. |
| Brand | **OCR structured annotation cross-checked against raw OCR tokens** | 94.1% exact. Admit only when the candidate occurs in OCR text or a visible brand region. Reject layout words, price labels, model numbers, and country/adjective tokens. |
| Current price | **Mistral Medium** | 20/20 exact. Add deterministic range/decimal validation and cross-check that the number is visibly present. |
| Old price | **Mistral Medium** | 16/19 exact. Require crossed-out/previous-price evidence; return null otherwise. |
| Unit | **Hybrid: OCR size/price-basis evidence + deterministic unit parser** | No direct model exceeded 50%. Parse the unit from the accepted complete size expression and retain `EACH`/`Per Kg` separately as `price_basis`, not product unit. |
| Package size | **OCR structured candidate cross-checked against raw OCR; Small-current candidate as a cheap second vote** | All leading structured variants reached 69.2% exact; OCR structured reached the best usable coverage. Require the complete numeral+unit expression to occur in visible/OCR evidence. |
| Package count / multiplier | **Medium candidate + deterministic regex over raw OCR, accepted only on agreement or explicit syntax** | Medium led at 60%, but all models missed visible counts. Recognize `N×size`, `N Pack`, `Buy N`, `N+M`, and `N in 1`; do not derive count from unrelated dimensions/specifications. |
| Package type | **Deterministic explicit-text gate; otherwise null** | Model recall looked good only because there were two applicable crops, while unsupported package types were frequent. Never infer bag/jar/box from appearance alone if literal extraction is required. |
| Additional attributes | **OCR structured annotation, evidence-gated** | Highest useful coverage: 32 supported attributes vs 4 unsupported. Require each accepted attribute to match raw OCR or a visible text region. |
| Model number / variant | **OCR structured annotation with Medium fallback** | OCR was strongest on TECNO and IKON identifiers; reject dimensions, dates, and drawing metadata. |
| Confidence | **Derived validator score, not any model’s self-confidence** | Wrong outputs frequently reported 0.95–1.00. Derive confidence from evidence presence, field agreement, syntax validity, and contradiction checks. |

## Recommended production strategy

For maximum quality without paying for two full expensive calls on every crop:

1. Run **Medium expanded extraction first** for price roles, a usable identity proposal, package count, and core structured fields. At observed usage this cost about $0.00186/crop.
2. Apply deterministic evidence checks.
3. Escalate to **one annotated OCR request** only when exact English/Arabic wording, brand, size, or count cannot be validated from the first result.
4. On escalation, use the OCR response twice at no extra page request:
   - raw OCR text for literal English/Arabic captions;
   - structured annotation for brand, size, and attributes.
5. Fuse fields only after per-field validation. Preserve both attempts and provenance. Never allow a fluent Medium paraphrase to overwrite a supported literal OCR caption.

If the overriding requirement is the absolute highest quality on every page, run Medium plus annotated OCR for every crop and use the field matrix above. Observed direct model cost is approximately **$0.00686/crop** before retries. The more cost-practical production option is Medium-first with selective OCR escalation; at a 30% OCR rate it would be approximately **$0.00336/crop**, about one-third cheaper than annotated OCR on every page, while retaining Medium’s superior price extraction.

Do not adopt the existing Small-current output as the sole identity source. It is cheap and fast, but it omits prices by contract, loses full English captions, performs poorly on exact Arabic, and its current unit mapping confuses several kg expressions with g.

## Limitations

- Twenty crops are enough to compare obvious behavior but not enough to establish narrow confidence intervals across all retailers/categories.
- Package count has only five applicable examples; its 60% leading result is directional, not conclusive.
- This benchmark evaluates current `*-latest` aliases on one date. Provider alias changes require rerunning the frozen set.
- The high-reasoning two-pass approach is not ranked because it did not complete all 20 crops.
- The recommended hybrid’s final end-to-end accuracy must be measured after the fusion/admission rules exist; the per-field oracle maximum from these independent results is not itself a production metric.

## Artifacts

- `frozen-sample.json`: immutable sample metadata, hashes, and sample digest.
- `assets/01.jpg` … `assets/20.jpg`: exact tested image bytes.
- `human-canonical.json`: human-adjudicated structured truth.
- `model-results.json`: raw responses, structured outputs, usage, latency, and parser diagnostics.
- `benchmark-metrics.json`: per-field and per-image adjudicated metrics.
- `per-image-comparison.csv`: compact per-image strategy scores.
- `run-benchmark.mjs`: reproducible isolated runner.
- `score-benchmark.mjs`: deterministic scoring and report-data generator.
