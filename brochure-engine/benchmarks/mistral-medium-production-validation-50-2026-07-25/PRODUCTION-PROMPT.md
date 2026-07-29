# Production extraction prompt — FROZEN

**Status:** adopted as the production baseline, 2026-07-25.
**Frozen by:** engineering decision after manual review of the 50-crop validation and its reported failures.

Do not edit this prompt. Do not merge it with other prompt variants. Do not run
further prompt-optimization experiments against it unless explicitly requested.
Replacing it requires a larger production validation and an explicit decision.

## Adopted configuration

| Component | Value |
|---|---|
| Model | `mistral-medium-latest` |
| Prompt | Verbatim Prompt (below) — sha256 `e643b2a1b833d12256e0e3806b04c28bc5fd042bf3a86b647b989df9be7c3557` |
| JSON schema | current Expanded JSON (11 fields) |
| Reasoning | `none` |
| Temperature / top_p | 0 / 1 |
| Response format | `json_object` |
| OCR | not used |
| Requests per crop | 1 |

Canonical copies of the prompt string, byte-identical:

- `production-prompt.txt` — the prompt alone, for hashing and diffing
- `run-prompt-b.mjs` → `PROMPT_B` — the original source it was frozen from
- `run-verbatim-50.mjs` — reads it from that source rather than restating it, so the validated string and the frozen string cannot drift

## Measured performance (50 frozen crops, 17 retailers, 50 categories)

| Field | Original prompt | **Verbatim (adopted)** | McNemar p |
|---|---:|---:|---:|
| English name | 12/50 (24.0%) | **43/50 (86.0%)** | 9.3 × 10⁻¹⁰ |
| Brand | 46/49 (93.9%) | **47/49 (95.9%)** | 1.00 |
| Current price | 46/50 (92.0%) | 46/50 (92.0%) | 1.00 |
| Previous price | 37/49 (75.5%) | **38/49 (77.6%)** | 1.00 |
| Quantity / size / weight / count | 47/50 (94.0%) | **48/50 (96.0%)** | 1.00 |

Cost $0.00205/crop, average latency 1.83 s, 50/50 valid JSON, zero failures.
31 crops gained on the English name, zero regressed; one crop-level brand
reversal (crop 32) against two brand gains.

## Why the benchmark understates this configuration

The manual review found that most remaining scored "failures" are not extraction
failures. They are cases where the model:

- placed the brand ahead of the product title;
- carried additional product information printed on the package;
- corrected an obvious misprint in the brochure;
- returned **more** identity than the ground truth expected.

For Super Search these outcomes are acceptable and frequently preferable — they
preserve or enrich product identity rather than losing it. The benchmark scores
exact-caption equality, which penalises enrichment, so the reported English-name
figure is a **floor**, not an estimate of practical usefulness.

The only genuine failure class observed is the model failing to detect the
English title at all (crop 37, `Balasham` → `null`).

## The Verbatim Prompt

```text
You are extracting one advertised product from one Saudi retail flyer crop.
The pixels are the only source of truth. Return null when a field is not
directly visible or cannot be assigned unambiguously to the advertised product.

For name_en, follow these rules exactly:
Copy the complete English product title exactly as printed on the package.
Do not remove the brand.
Do not remove the size.
Do not normalize.
Do not correct spelling.
Do not abbreviate.
Return the exact visible text.

Arabic is an independent literal display caption, not a translation. Do not
include promotional phrases, discount percentages, retailer names, or price text
inside either product name.

For price: current_price is the visibly promoted selling price. old_price is only a
visibly crossed-out, WAS, before, or otherwise clearly previous price.

Return exactly one JSON object with:
{
  "name_en": string|null,
  "name_ar": string|null,
  "brand": string|null,
  "current_price": number|null,
  "old_price": number|null,
  "unit": string|null,
  "package_size": string|null,
  "quantity": string|null,
  "package_type": string|null,
  "attributes": string[],
  "confidence": number|null
}

The brand and the size must ALSO be repeated in their own fields. Populating
brand or package_size never permits removing those words from name_en.

package_size must preserve the complete visible expression, such as "6×200 ml",
"10+2", "3 Pack", "900 g", or "1.5 L". quantity is only an explicitly visible
count/multiplier/bonus expression. package_type is only a directly printed form such
as pack, carton, bag, bottle, can, jar, box, or piece. attributes may contain only
short directly visible identity-relevant descriptors such as fresh, frozen, flavor,
cut, model number, or variety.
```

## Carried-forward constraints (not resolved by this decision)

These are properties of the model, not the prompt, and the prompt change did not
touch them:

1. **Current-price role inversion, 2/50 (4%).** On crops 8 and 37 the model
   returned the crossed-out price as the selling price, at 0.99+ self-reported
   confidence. Identical under both prompts. A deterministic guard is still
   required before any extracted price reaches shoppers: when two prices are
   present, current must be the lower; when a crop shows two prices and the model
   returns one, reject rather than accept.
2. **Self-reported confidence is uncalibrated.** 0.997 mean on wrong names versus
   1.000 on correct. Never gate acceptance on the model's own `confidence`.
3. **Temperature 0 is not deterministic.** Re-running this exact prompt over 20
   already-run crops produced 2 different outputs, one of which changed its score.
   Treat 86% as ±2 points of run-to-run noise, and expect re-runs of the frozen
   set to move slightly without any change having been made.

## Implementation status — INTEGRATED 2026-07-25 (HISTORY §44)

This configuration is now what `src/offers/enrich.js` runs. The prompt above is
unchanged and remains frozen; only the surrounding code moved.

- `DEFAULT_MODEL = 'mistral-medium-latest'`
- `VISION_PROMPT` is byte-identical to `production-prompt.txt` (sha256 above).
  `src/enrich.test.mjs` compares the live constant against **that file**, not
  against a copy of it, so the two cannot silently diverge.
- `buildVisionRequest()` sends temperature 0, top_p 1, `reasoning_effort: 'none'`,
  `json_object`, and the crop as a bare `data:` URL string — the exact request
  shape this validation used.
- Expanded JSON maps onto the existing stored contract through ordered aliases in
  `smartExtraction.js` (`package_size` → `size`, `quantity` → `pack_count`);
  no validation rule changed. `unit`, `package_type` and `attributes` are
  preserved in the new `offer_enrichments.extraction_json` column
  (`migrate-2026-07-25-expanded-extraction.sql`, additive, apply before deploy).
- **Prices are quarantined.** Per constraint 1 above, no extracted price enters
  any row a read path can serve; the full reply including prices stays in
  `offer_extraction_attempts.output` for audit. The deterministic price guard is
  still owed before extracted prices may be used anywhere.

Cost, unchanged from the review that accompanied the decision: Medium is roughly
**10×** Small per crop ($0.00205 vs ~$0.0002), so steady-state ingestion rises by
that multiple. Re-enriching the existing 54k-offer corpus would be on the order of
**$110** and was deliberately NOT done — existing rows keep their old-model
values until a re-enrichment is explicitly decided.
