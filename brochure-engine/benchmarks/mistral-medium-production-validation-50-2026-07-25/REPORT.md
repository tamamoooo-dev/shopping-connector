# Mistral Medium (Expanded JSON) — final production validation

> ## ⚠️ Superseded in part — read this first
>
> **Decision, 2026-07-25: this configuration is ADOPTED as the production baseline,
> with the Verbatim Prompt rather than the prompt measured below.**
> See [`PRODUCTION-PROMPT.md`](PRODUCTION-PROMPT.md) for the frozen prompt and config.
>
> Everything below measures the **original** Expanded JSON prompt. Its headline
> English-name figure of 24.0% was superseded by a follow-up run of the full frozen
> set under the Verbatim Prompt, which scored **86.0%** on the same 50 crops, same
> scorer, same truth — 31 crops gained, zero regressed, McNemar p ≈ 9.3 × 10⁻¹⁰.
> The other four fields were unchanged or marginally better.
>
> This report's closing recommendation — *"no, not as the primary extraction model
> for the English product name"* — was made against the 24% prompt and **no longer
> reflects the decision**. It is retained unedited as the record of what was measured.
>
> Two findings below are **not** superseded and still bind: the current-price role
> inversion on 2/50, and the uncalibrated self-confidence. Both are model properties
> that the prompt change did not affect.
>
> Prompt optimization is closed. Do not run further prompt experiments against the
> frozen baseline unless explicitly requested.

Date: 2026-07-25
Model: `mistral-medium-latest` (every response confirmed `mistral-medium-latest`)
Strategy: `medium_expanded_json`, single call per crop
Frozen sample digest: `32c2c00166e1e839fbfaebfdb7b61329cc7fc29e8ee99ffa80f917913eea70e9`
Production code / configuration / data changes: none

## Configuration actually used

| Setting | Value |
|---|---|
| Prompt | current Expanded JSON prompt, verified byte-identical to `extraction-strategy-20-2026-07-23` `FINAL_PROMPT` (both sha256 `5234b9beb8fd94d563e53df395bd6dc3e579c23a3dde22c0c4c6ab5667b4e021`) |
| Temperature / top_p | 0 / 1 |
| Response format | `json_object` |
| Reasoning | `reasoning_effort: "none"` — high reasoning NOT used |
| OCR | not used, on any crop |
| Comparison models | none |
| Requests per crop | 1 (50 requests, 0 retries, 0 failures) |

## Dataset

50 crops, all new. None has been processed by any previous benchmark or validation.

- Eligible pool: 13,265 current production offers carrying an image.
- Exclusion set: 1,613 image URLs and 1,613 offer ids drawn from every prior benchmark/validation artifact. Candidate-pool snapshots were deliberately *not* treated as prior usage — they list images that were eligible but never processed, and excluding them would have wrongly removed two whole retailers.
- Eligible after exclusion: 12,305. Selection is a seeded deterministic shuffle (`mistral-medium-production-validation-50-2026-07-25`), so the sample is reproducible.
- Mix: **17 retailers** (3 crops each; prime has only 34 live offers so it contributes 2) and **50 distinct declared categories** — no category repeats.

Categories span fresh produce, fresh/chilled meat and poultry, dairy, cheese, frozen food, bakery, rice, pasta, oils, canned goods, snacks, confectionery, soft drinks, juices, tea/coffee, baby diapers, hair/skin/bath care, fragrance, cosmetics, shaving, dental care, laundry, dishwashing, cleaning, disposables, pet food, cookware, small and large appliances, TV, tablets, lighting, luggage, kids' wear and home furnishing.

## Ground truth

Truth was adjudicated by direct inspection of every original-resolution crop, before any model output was examined. Struck-through prices too small to read were re-inspected at 6–14× upscale. Existing production price metadata was used **only** to disambiguate tiny crossed-out digits, never to supply a value absent from the pixels.

Two fields could not be adjudicated from the pixels even at maximum upscale and are excluded from their field's denominator: the old price on crop 29 and the brand mark on crop 45.

## Results

Headline denominator = all adjudicable crops. Correct nulls count as correct, as specified.

| Field | Accuracy (all adjudicable) | Accuracy (only where the field is actually present) |
|---|---:|---:|
| **English product name** | **12/50 — 24.0%** | 11/49 — 22.4% |
| **Brand** | **46/49 — 93.9%** | 39/42 — 92.9% |
| **Current price** | **46/50 — 92.0%** | 46/50 — 92.0% |
| **Previous price** | **37/49 — 75.5%** | 35/47 — 74.5% |
| **Quantity / size / weight / count** | **47/50 — 94.0%** | 44/47 — 93.6% |

Whole-record: 8/50 crops correct on all five fields; 33/50 correct on the four non-name fields; 38/50 correct on both price roles.

JSON validity 50/50. No API failure, no retry, no malformed response.

### Sensitivity note on quantity

Five crops (2, 11, 24, 35, 50) are loose goods priced per kilo, where the only printed quantity mark is a `KG` / `PER KG` price basis. The model returned nothing for all five, and the scoring treats "no package quantity" as acceptable there, consistent with the earlier finding that price basis is a separate concept from package size. If instead a per-kilo crop is required to yield an explicit `per kg` quantity, quantity accuracy falls to **42/50 — 84.0%**.

## Failure analysis

### English name — 38 misses, and they are almost all one behaviour

The model does not paraphrase badly; it **decomposes**. It returns a cleaned product name and moves the brand token and the size token into `brand` and `package_size`, so the printed caption is never reproduced verbatim.

| Class | Count | Meaning |
|---|---:|---|
| `decomposition_only` | 24 | every printed caption token is still present somewhere in the model's own output; the exact caption is reconstructible by deterministic fusion |
| `truncated_lost_tokens` | 6 | a caption token is gone from the whole record |
| `wrong_wording` | 6 | the model substituted different words |
| `decomposition_plus_extra_wording` | 2 | nothing lost, but wording added |

Typical decomposition: `ZAIQA PURE BEE HONEY 500 GM` → `name_en: "PURE BEE HONEY"`, `brand: "ZAIQA"`, `package_size: "500 GM"`. Counting exact captions only, that is a miss. Counting reconstructible records, **≈37/50 (74%)** of captions could be rebuilt from the model's own fields.

The genuinely wrong ones are the dangerous minority — the model read package marketing copy instead of the product caption:

- crop 19: `Loacker Wafer 4x19g` → `"Break 3"` (the on-pack sub-brand)
- crop 16: `Strong Lite Emerg. Light+2 Hand Torch…` → `"RECHARGEABLE LED LANTERN & FLASH LIGHT STROBE"`
- crop 17: `Olay Face Cream 2X50ml+Facewash 100ml` → `"Natural White"`
- crop 20: `Galaxy Chocolates 80g` → `"Galaxy Smooth Milk"` (picked one of two pictured flavours)
- crop 33: `Mughal Basmati Rice 1121 5kg` → `"Steamed 1121 Basmati Rice"`
- crop 37: `Balasham` → `null` (missed the only caption on the crop)

It also "corrects" printed text it thinks is misspelled — crop 14 prints `DISINFICTANT`, the model returned `Disinfectant`; crop 8 prints `Jmbo`, the model returned `Jumbo`. That is exactly the normalization the field forbids.

### Current price — 4 misses, of which 2 are role inversions

- crop 8 — returned **44.99**, the crossed-out price, as the current price (true current 30)
- crop 37 — returned **15.99**, the crossed-out price, as the current price (true current 10)
- crop 1 — returned `null` on a dual-variant crop (RED 28.99 was 37.95 / GOLD 34.99 was 45.95)
- crop 30 — returned `null` where the price is a small badge digit

The two role inversions are the most commercially serious error class here: the record is well-formed, confidently reported, and states a price that is higher than what the shopper actually pays.

### Previous price — 12 misses

- 10 are **silent nulls**: a crossed-out price is plainly visible and the model reported none.
- 2 are **misreads**: crop 21 returned 16.75 for a printed 16.95; crop 44 returned 45.5 for a printed 45.51.

Where no old price exists (crops 24, 40) the model correctly returned null, so the null-handling requirement is satisfied — the weakness is recall, not false positives.

### Brand — 3 misses

Two silent nulls (crop 7 `Tiny Tunes`, crop 23 `CRISPY`) and one invention: crop 47 returned **`"RAIN"`** for a suitcase set whose only brand tag reads `KAHK`. Brand is otherwise the model's strongest identity field.

### Quantity — 3 misses

Crop 9 (`7in1` present only inside the product name), crop 26 (`/PC` in the caption, nothing returned), crop 46 (returned `500` with the unit dropped, for a printed `500 ml`).

Two crops passed on one field while contradicting themselves on the other: crop 28 returned `package_size: "80 x 4 جرام"` alongside a correct `quantity: "4 x 85g"`, and crop 12 returned the size in Arabic (`800 جرام`) for a caption printed in English. Any consumer must read both fields and reconcile them.

### Self-reported confidence is not usable

Mean confidence on **correct** English names: 1.000. Mean confidence on **wrong** English names: 0.997. Mean confidence on crops with a price error: 0.995. The model is uniformly certain regardless of correctness, including on both current-price role inversions. Confidence must not gate acceptance.

## Cost and latency

| Metric | Value |
|---|---:|
| Requests | 50 (1 per crop, 0 retries) |
| Input / output tokens | 33,774 / 5,672 |
| Cost for 50 crops | $0.0932 |
| Cost per crop | $0.00186 |
| Latency avg / median / p95 / max | 1.78 s / 1.50 s / 2.85 s / 3.79 s |

Operationally clean: no rate limiting, no failures, stable sub-4-second latency.

---

# Recommendation

**Based on these results alone: yes for prices, quantity and brand — but no, not as the primary extraction model for the English product name.**

Mistral Medium is production-grade on four of the five fields. Brand 93.9%, current price 92.0%, quantity 94.0% and previous price 75.5% are usable numbers at $0.00186 and 1.8 seconds per crop, with perfect JSON validity and zero operational failures across 50 crops and 17 retailers. Nothing here suggests a throughput, reliability or cost obstacle.

The English name result — 24.0% — disqualifies it as the *sole* source of that field under the stated standard. The reason matters, and it cuts both ways:

- **In its favour:** this is not incompetence. 24 of the 38 misses are pure decomposition — the model splits the caption into name + brand + size and every printed token survives somewhere in its own output. Roughly 74% of captions are reconstructible by a deterministic fusion step that re-concatenates the model's fields. If the product requirement were "recover the printed identity from the record", Medium would be near 74%, not 24%.
- **Against it:** the remaining 14 misses cannot be fixed by fusion. The model substitutes on-pack marketing copy for the product caption (`"Break 3"`, `"Natural White"`, `"RECHARGEABLE LED LANTERN…"`), silently corrects printed spellings it dislikes (`DISINFICTANT` → `Disinfectant`, `Jmbo` → `Jumbo`), and occasionally drops a caption entirely. A prompt change will not reliably suppress that; the model is doing what a helpful assistant does, and the field requires a transcriber.

Two further findings should gate any rollout regardless of the name question:

1. **Current-price role inversion on 2/50 crops (4%).** The model returned the crossed-out price as the selling price, with confidence 0.99+. For a price-comparison product this is worse than returning null — it is a confident, well-formed, wrong price. This needs a deterministic guard (if both prices are present, current must be the lower one; if only one price is returned on a crop showing two, reject) before any Medium output reaches shoppers.
2. **Confidence is uncalibrated to the point of being noise.** 0.997 on wrong names versus 1.000 on correct ones. Any acceptance gate must be a derived validator score, never the model's own number.

**Concrete recommendation:** adopt Mistral Medium as the primary *structured* extractor — prices, quantity, brand — behind a deterministic price-role validator, and treat its `name_en` as a **candidate**, not an authority. Fuse `brand + name_en + package_size` to rebuild the printed caption where the tokens support it, and escalate the crops where they do not. This validation deliberately did not test OCR, so it cannot say what the escalation path should be; the prior 20-crop study found raw OCR materially better at exact captions (73.7% vs Medium's 15.8%), and that comparison should be re-run at this sample size before the escalation path is fixed.

If instead the requirement is strictly "one model, no fusion, no escalation, exact printed English name" — then no, Medium does not meet it at 24%.

## Limitations

- 50 crops across 17 retailers and 50 categories is enough to rank behaviour and expose failure modes, not enough for narrow confidence intervals per retailer. At n=50, a 92% result carries roughly a ±7-point 95% interval.
- Old price has 47 applicable crops, brand 42; sub-slices of those are directional only.
- Two fields on two crops were unadjudicable and excluded rather than guessed.
- This measures the `*-latest` alias on one date. A provider alias change requires re-running the frozen set.
- Some quantity credit depends on the documented per-kilo convention; the 84% sensitivity figure is given above.

## Artifacts

- `sample-manifest.json` — selection, seed, exclusion counts
- `build-sample.mjs` — reproducible sampler
- `frozen-sample.json` — per-crop sha256 and the ordered sample digest
- `assets/01.jpg` … `assets/50.jpg` — exact tested bytes
- `run-benchmark.mjs` — isolated runner (download / run)
- `model-results.json` — raw responses, structured output, usage, latency
- `human-canonical.json` — human-adjudicated truth with per-field accepted renderings
- `score-benchmark.mjs` / `benchmark-metrics.json` — deterministic scoring, per-image field status
- `diagnose-names.mjs` / `name-failure-diagnostic.json` — classification of every English-name failure
