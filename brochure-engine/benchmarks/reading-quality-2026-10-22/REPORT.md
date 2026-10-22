# System reading revision — 2026-10-22

The user requested a system-level improvement to Arabic product captions and multi-package offer prices, using Panda and other retailers as test data.

## Scope and evidence

Read all **1,003 indexed offers** in Panda flyer 790098 (21–27 October) and **128 crops from 16 other retailers**, for 1,131 distinct source images. The assistant visually reviewed 157 images. A final 32-image set (two unused samples per other retailer) was annotated only after the selection rules were fixed. No independent human annotator was available.

## Measured results

| Measure | Existing reading | New reading |
|---|---:|---:|
| Correct comparable quantities, 91 visually checked cases | 38 | 79 |
| Wrong comparable quantities in those cases | 53 | 0 |
| Withheld ambiguous quantities | 0 | 12 |
| Arabic search-word probes recovered, 251 probes | 165 | 197 |
| Final-set Arabic probes, 48 probes | 30 | 37 |

The final-set quantity checks had 17 correct and two withheld results. These are targeted regression measurements, not a population accuracy claim. Arabic probes do not establish perfect full-title transcription. Across the entire 1,131-row replay, 142 associations require an image review; one crop had no accepted product name.

## Changes

- A product reading records each selling-price option with its own package contents and external sale count. Only an option matching the existing authoritative retailer price can supply quantity evidence. Model prices never replace the retailer price.
- Internal contents (ten cheese slices in a 200 g package) cannot multiply net weight. External quantities multiply the complete package, including existing internal multipacks: two six-packs of 1.5 L water contain 18 L. The structured-product shadow follows the same distinction.
- Ambiguous, repeated, stale or unmatched quantities withhold unit arithmetic. The UI shows the offer package count, its contents and package price, or asks the shopper to verify the image. Search, Browse, the product sheet and comparison adopt the same resolved quantity.
- Arabic names use a constrained spelling repair and, where stronger, an Arabic retailer caption anchored to a unique English title prefix. Selection requires additional confirmed product/brand words. The original Vision observation stays preserved; display provenance identifies the retailer caption. The chosen caption also enters search text.
- The model remains Ministral 14B, with one request per new offer. The independent price-reading prompt and existing account/request caps are unchanged. Upscaling, Arabic-only prompting and replacing captions with generated Arabic names were tried and rejected because they did not improve the checks.

## Validation and rollback

Engine unit suite: 99 files. Frontend unit suite: 18 files. Mobile-browser check: cheese, water and the separately priced three-chicken option; correct 18,000 ml water denominator and Arabic package labels. Production deploy runs its full test gate again.

Full source snapshots, raw reads, candidate rows, annotated image sheets and the verified pre-publication enrichment backup are retained locally under panda-reading-audit-2026-10-22. No full database backup was uploaded to R2. The code can be rolled back through the existing Worker deployment mechanism; the local backup retains prior rows for all selected ids.

Prompt SHA-256: 9a07db2363cd94489460ecb6a2664a9b42a25dc9ee2cde2e8ead1b1650851215.

## Final coverage check

The live viewer contained 29 additional Panda records after the paired audit was frozen: 24 unpriced/unavailable rows and five newly priced rows. All 29 additional images were read with the same candidate model/prompt and their raw outputs retained locally. This brings coverage to 1,032 Panda viewer images plus 128 other-retailer samples (1,160 reads in the adopted-method coverage set). They do not change the frozen 91-reference/157-image measurements above. Unavailable prices were not guessed or overwritten.
