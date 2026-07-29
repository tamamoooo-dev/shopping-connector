# Mistral Small vs Medium — 10-crop economic A/B

Date: 2026-07-25
Models: `mistral-small-latest` (new run) vs `mistral-medium-latest` (frozen baseline, re-scored)
Strategy: `medium_expanded_json_verbatim_name` — the frozen production configuration, unchanged
Prompt sha256: `e643b2a1b833d12256e0e3806b04c28bc5fd042bf3a86b647b989df9be7c3557`
Source sample digest: `32c2c00166e1e839fbfaebfdb7b61329cc7fc29e8ee99ffa80f917913eea70e9`
Visual report: `REPORT.html`
**Production code / configuration / model / data changes: none.**

## Question

Does the quality of `mistral-medium-latest` justify its ~10× API cost over
`mistral-small-latest`, using exactly the same extraction strategy?

## Controls

| Component | Value |
|---|---|
| Prompt | Verbatim Prompt, read out of `run-prompt-b.mjs` and hash-asserted at runtime |
| Temperature / top_p | 0 / 1 |
| Reasoning | `reasoning_effort: "none"` |
| Response format | `json_object` |
| OCR | not used |
| Images | the exact frozen bytes, sha256-verified per crop |
| Parser | `canonicalOutput()` / `parseJsonContent()`, copied character-for-character |
| Scorer | `score-ab.mjs`, normalizers copied character-for-character |
| Requests per crop | 1 |

`run-small-10.mjs` differs from the baseline runner `run-verbatim-50.mjs` only in the model
string, the sample list and log text — the request body differs in `model` alone.

**Scorer equivalence is proved, not asserted.** Re-scoring the full 50-crop Medium run through
`score-ab.mjs` reproduces the published `verbatim-metrics.json` byte-identically
(`equivalence-check-50.json`), including the 86.0 / 95.9 / 92.0 / 77.6 / 96.0 headline and the
$0.00205 per-crop cost.

## Sample

10 crops taken by index from the frozen 50. **No new images.** 10 retailers, 10 categories;
5 crops Medium scored clean on the 50-crop run (10, 13, 19, 40, 48) and 5 where it already had
at least one miss (8, 26, 30, 33, 44), so the set is not stacked toward either model.

Selection is **purposive, not random** — chosen to span easy/hard products, English captions,
prices and package sizes as briefed. Per-crop rationale is in `sample-10.json`. Neither column
therefore estimates a 50-crop rate; the valid comparison is the two columns against each other.

## Results — same 10 crops, same scorer, same truth

| Field | Medium @50 (context) | Medium @10 | Small @10 | Δ |
|---|---:|---:|---:|---:|
| English name | 43/50 (86.0%) | 7/10 (70%) | 4/10 (40%) | −3 |
| Brand | 47/49 (95.9%) | 10/10 (100%) | 8/10 (80%) | −2 |
| Current price | 46/50 (92.0%) | 8/10 (80%) | 8/10 (80%) | — |
| Previous price | 38/49 (77.6%) | 7/10 (70%) | 7/10 (70%) | — |
| Package size / quantity | 48/50 (96.0%) | 9/10 (90%) | 8/10 (80%) | −1 |

Field cells (10 crops × 5 fields): **Medium 41/50, Small 35/50.**
Head-to-head: Medium-only correct **7**, Small-only correct **1**, both wrong **8**.
Two-sided exact binomial on the 8 discordant cells: p ≈ 0.07 — directional, not significant at n=10.

`package_type` and `attributes` have **no adjudicated ground truth** in this benchmark and are
excluded from every accuracy claim. Observationally: package_type populated 9/10 Medium vs 8/10
Small (5/10 exact agreement); attributes populated 8/10 vs 9/10 (1/10 exact agreement).

## API metrics

| Metric | Medium | Small |
|---|---:|---:|
| Average prompt tokens | 741.8 | 741.8 |
| Average completion tokens | 136.0 | 126.6 |
| Average total tokens | 877.8 | 868.4 |
| Average latency | 1.98 s (median 1.28 s) | 1.36 s (median 1.30 s) |
| Average cost per crop | $0.002133 | $0.000187 |
| Cost for 10 crops | $0.02133 | $0.00187 |
| Valid JSON | 10/10 | 10/10 |
| Failures / retries | 0 / 0 | 0 / 0 |

Pricing basis is the one already used by this project's benchmarks
(`extraction-strategy-20-2026-07-23/score-benchmark.mjs`): Small $0.15/M input and $0.60/M output,
Medium $1.50/M and $7.50/M. That is a flat 10× on rate; measured cost lands at **11.4×** because
Medium also emits more completion tokens.

Medium's mean latency here is inflated by one 5.68 s outlier; on medians the honest read is that
Small is **25–30% faster**, not 1.5×.

## Failure analysis

### Medium succeeds, Small fails — 7 cells across 6 crops

Predominantly **perception**, on crops that are not hard:

- crop 10 — printed `17.95` (large, red, high-contrast strikethrough) read as **11.95**
- crop 13 — printed `REEM` (caption *and* can logo) read as **REEEM**; because the prompt requires
  the brand to be repeated in its own field, one perception error cost **two** fields
- crop 30 — `St Michel` read as **Michel**, the superscript `St` dropped

Two are **prompt following / over-inclusion**:

- crop 19 — on-pack `Break` lockup folded into a caption reading `Loacker Wafer 4x19g`
- crop 40 — `6×250 ml` spliced into the middle of a caption reading `Pepsi Bottles`
  (every token real and present on the crop; the word order is not — the softest failure in the run)

### The decisive failure — hallucination

crop 33: Small returned `package_size: "10 KG"` for a bag whose caption reads `5kg` and whose
Arabic reads `٥ كيلو`. **`10` appears nowhere on the image.** It also rendered the variety code
`1121` as `100%`. This is not a misread of a hard glyph — it is a plausible, well-formed pack size
invented whole, at 0.98 self-reported confidence, on a staple where price-per-kilo is the entire
basis of shopper comparison. Medium returned `5kg`.

Lower-stakes instance of the same tendency: crop 26, where Small returned the attribute `fresh`
for a pineapple crop that never prints the word. The prompt permits only directly visible
descriptors. Medium returned `[]`.

### Small succeeds, Medium fails — 1 cell

crop 44: Small read the struck-through `45.51` exactly; Medium truncated it to `45.5`. A genuine
perception win on a small figure.

Unscored but worth recording: on crop 8 Small **preserved** the brochure's printed misprint `Jmbo`
while Medium silently corrected it to `Jumbo`, which the frozen prompt forbids. Small lost the crop
anyway on caption spacing (`Diaper 5 Maxi` for a printed `Diaper5Maxi`).

### Both fail identically — 8 cells

All are already-documented Medium constraints, not new information:

- crop 8 — the known **current-price role inversion**: both returned the crossed-out `44.99` as the
  selling price on a crop whose price is a large `30` marked "now". The owed deterministic price
  guard catches this under either model (two prices printed, one returned).
- crop 30 — shared silent null on both prices.
- crop 26 — the documented per-piece / bare-unit convention.

Changing model fixes none of them.

### Confidence

Small reported 0.98 on the fabricated `10 KG`, on `REEEM`, and on the inverted price — the same
0.98 it reported on its clean crops. The uncalibrated-confidence constraint carries over unchanged.
Never gate acceptance on the model's own number.

## Recommendation — Option A: keep Medium in production

Small is genuinely **11.4× cheaper** and ~25–30% faster with identical JSON reliability, so the
operational case is real. But it lost 6 net field cells to Medium (7 losses against 1 win), and the
losses land in exactly the fields this product sells on: a fabricated pack size at double the truth,
a corrupted brand token that doubles as the Browse slug, and a misread of a plainly legible previous
price. At $0.00205/crop Medium's absolute cost is not this system's binding constraint — the saving
is ~$0.0019 per offer.

**Option C (document Small as an economical mode) was considered and rejected on the measured
evidence.** An economical mode is only safe if its failures are quieter than the primary model's,
and Small's are louder: hallucinated sizes and truncated brands are silent, well-formed and
confident, so they enter the corpus indistinguishable from good rows. If cost later becomes binding,
the measured path to revisit is Small-first with Medium escalation behind a deterministic validator
— which requires the price guard built first and a larger, randomly drawn sample to size the
escalation rate.

## Limitations

- n=10, purposively selected. Enough to expose failure modes and compare models on identical
  inputs; not enough for a precise rate. One crop moves any field by 10 points.
- The 7:1 head-to-head split is directional (p ≈ 0.07), not significant.
- Temperature 0 is not deterministic on this provider (documented in `PRODUCTION-PROMPT.md`
  constraint 3); expect ±1 crop of run-to-run noise on either side.
- `package_type` and `attributes` were requested for evaluation but have no adjudicated truth in
  this benchmark; producing it would require a fresh human adjudication pass.
- Measures the `*-latest` aliases on one date.
- The cost measurement is exact arithmetic on reported token counts and holds at any sample size.

## Artifacts

- `select-10.mjs` / `sample-10.json` — selection, per-crop rationale, byte verification
- `run-small-10.mjs` / `small-results.json` — runner and raw responses, usage, latency
- `score-ab.mjs` — scorer (normalizers copied from the frozen scorer)
- `equivalence-check-50.json` — proof the scorer reproduces the published Medium metrics
- `small-metrics.json` / `medium-10-metrics.json` — both sides of the A/B
- `build-report.mjs` / `REPORT.html` — the visual report
- Crop images are **not** duplicated here; they are read from
  `../mistral-medium-production-validation-50-2026-07-25/assets/` and hash-verified on every run.
