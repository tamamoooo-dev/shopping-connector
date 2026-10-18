# Live 14B reading comparison, 18 October 2026

Question: which tested way of reading existing product crops yields the most useful, correct search information for the resources used?

Only `ministral-14b-2512`, temperature 0, top_p 1, JSON object output. No Small, Medium, OCR service, synthetic image enhancement, production writes, schema changes or model substitutions. API credentials remain in the existing local loader and are never recorded. `prepare.mjs`, `manifest.json`, `truth.mjs` and the phase protocols record reproducible inputs, image hashes, settings and frozen prompts.

The first 32 crops were reviewed in an earlier release, so are **development**, not a new blind sample. The next 32 are selected deterministically by stable offer id, two per store, without reading the stored model's fields. All original images were inspected and reference search terms, visible brand, size evidence and current price recorded before fresh inference. The same assistant authored and scored these references; there is no independent human adjudication. The stratification is by store, not a population-weighted accuracy estimate. A fresh selection does not prove no overlap with every historical experiment ever run.

Methods:

1. Baseline: exact current production prompt and original bytes, one request.
2. Upscale: same prompt, deterministic Lanczos 2x PNG, maximum side 1536, one request. This increases the model's visual input allocation; it cannot recover detail absent in the source. Diagnostic only: current Worker has no image transform binding.
3. Caption: one request, explicit caption-first extraction and full visible expressions, same output keys.
4. Staged: first 14B request literally transcribes text; second receives original image and untrusted transcription, with production extraction prompt. Both requests and both usages count.
5. Repeat: separate baseline request. Compare agreement using the existing `compatibleVisionIdentity`; agreement is not ground truth. This is a simulated universal two-read gate, not a claim the deployed pipeline currently requires two reads for every accepted product.
6. Image first: exact baseline prompt and original image, reversing the two user content blocks. Added as a separate development experiment before its requests, then frozen before held-out inference.

Within each image the method order rotates, concurrency is bounded at two requests; transient errors and provider rate limits back off. Store actual model, response, token usage, wall time including retries, attempts, validated fields and derived rows. Failed request usage is unavailable: token totals sum successful replies, not an audited provider invoice. Recorded latency is observed wall time with shared quotas, not an isolated load benchmark.

Primary assessment is **reference search-probe coverage**, one English and one Arabic semantic product probe per image; this is not exact OCR accuracy, overall search recall or an end-to-end website ranking score. Visible brand recognition and complete numeric size expressions are separate. Price reading is audit-only and never updates commerce prices. References for alternative sizes require preserving all labelled numeric alternatives. Raw and validated name coverage are scored separately.

Secondary practical quantity audit uses `applyUnitPrice` with frozen commerce prices and the new reading only, excluding pre-existing retailer text. Labels in `quantity-truth.mjs` were completed before held-out inference. Ambiguous combinations, specifications and unclear total quantities are excluded rather than guessed. This is an isolated vision-contribution diagnostic, not the complete live API projection with retailer context.

Select a candidate from development before opening any held-out replies. It must improve useful search evidence without trading away quantity/brand/price correctness; prefer the simpler, cheaper method when tied. Held-out evaluation can reject that choice. An unexpected held-out winner requires another fresh confirmation before production adoption. Do not force a production change when evidence is mixed. Retain deterministic acceptance checks unless the measured benefits justify a change; these checks do not invoke the model.
