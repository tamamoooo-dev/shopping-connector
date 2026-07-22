# Mistral OCR vs Vision — 50-crop cost benchmark

This standalone benchmark used the same ordered 50 crop images for both phases. It did not modify production code, validation code, prompts, admission rules, retries, Registry data, or enrichment data. OCR completed before Vision began. Every model call was sequential, with one call per crop and no retries or fallback.

## Sample

- Images: 50
- Retailers: 18
- Categories: 49
- Languages: 29 Arabic-only, 19 bilingual, 2 unlabeled
- Difficulty proxy: 21 easy, 22 medium, 7 difficult
- Seed: `mistral-cost-benchmark-50-2026-07-21-v1`
- Ordered sample digest: `9eb9c73cbd6f7995dd335e05447c94cf7864a06fe81aae448a63308930f8b499`

The complete ordered source-index and offer-ID lists are stored in both JSON reports.

## Results

| Metric | OCR | Vision |
|---|---:|---:|
| Images processed | 50 | 50 |
| API requests | 50 | 50 |
| Retries | 0 | 0 |
| Requests per image | 1.00 | 1.00 |
| Average latency | ~220 ms | ~1,192 ms |
| API execution elapsed | ~11.0 s | ~59.6 s |
| Account credit balance before | $0.00 | $0.00 |
| Account credit balance after | $0.00 | $0.00 |
| Dashboard model cost before | $0.00000 | $0.00000 |
| Dashboard model cost after | $0.00000 | $0.00000 |
| Actual charged credit consumption | **$0.00000** | **$0.00000** |
| Credit consumed per image | $0.00000 | $0.00000 |
| Raw consumption | 50 pages by the requested one-request/one-page rule | 39,447 response-reported tokens for 40 retained responses; first 10 token records unavailable |

## Usage percentage

No quota percentage was available before or after either phase. The authenticated Mistral Billing page showed:

- no payment method;
- a $0.00 credit balance;
- auto-recharge disabled;
- no enabled monthly spending limit.

The Usage page showed zero USD cost for both OCR and Completion. Its raw view showed 631 cumulative OCR pages after Phase 1. The raw page view was not captured before Phase 1, so that cumulative value cannot independently establish the 50-page delta.

Before Vision, the Completion counter was 16,395,652 tokens. It remained unchanged through the final poll at 2026-07-21T20:14:39.696Z, more than three minutes after execution began. Response payloads did report token usage, so this is an Admin-dashboard reporting delay rather than evidence that the calls did not execute.

## Relative cost ratio

The observed credit ratio is **undefined (0 ÷ 0)**. Both models consumed zero charged credits in this free-mode organization. Page counts and completion-token counts are different billing units and cannot be converted into a measured credit ratio without non-zero account charges.

## Measurement uncertainty

- OCR per-request stdout was not retained after the completed phase. Its latency is the sequential phase wall time divided by 50.
- Vision retained exact latency and token telemetry for 40 requests. The first 10 requests completed in a successful runner invocation, but their stdout was not retained and they were not repeated.
- The Mistral Admin dashboard did not publish the Vision token delta within the bounded reporting window.
- No inference was repeated to repair telemetry, because that would violate the one-request-per-image constraint.
- No quality or accuracy evaluation was performed.

## Conclusion

Based strictly on actual measured API credit consumption, **neither model can be identified as more economical in this benchmark**. Both phases charged $0.00000 because the account is in free mode, making the relative credit-cost ratio undefined. The experiment measured OCR page usage, Vision request/token usage, and latency, but it did not produce a billable-credit signal capable of ranking OCR against Vision economically.

For reference, Mistral documents account cost and raw consumption on its [Usage dashboard](https://docs.mistral.ai/admin/billing-usage/usage-limits) and credit balance on its [Billing page](https://docs.mistral.ai/admin/billing-usage/billing).
