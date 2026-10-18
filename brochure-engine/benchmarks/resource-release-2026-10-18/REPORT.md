# Resource improvements — 18 October 2026

Prepared against production commit `fba1144aad881d441a6f3d29bb91a4957cefc9ab`, identified by the live Cloudflare deployment message. The original audit checkout was older (`bb2d1f9`); its pre-existing edits were preserved. This release retains production's queues, Arabic-only admission, stored-evidence rejudging, price fallback, key balancing, schedules and backups. No schema or architecture change is required.

## Changes

- Retain source search text alongside accepted vision text; use existing size, brand, attributes and package type for retrieval. SQL retrieval and the serving overlay retain the same evidence. Existing rows work without reindexing or new model calls.
- Add narrow wording aliases in both matcher copies: cornflakes/corn flakes, sunflower/sun flower, dishwashing/dish washing, mouthwash/mouth wash, almond/almonds, diaper/diapers, and the tested Loacker/wafer Arabic spellings. Add slicer, pet-food, creamer and prepared-kizhi evidence so the observed look-alikes rank below actual eggs/fish.
- Pass stored size into engine ranking and frontend flyer comparison. An unknown size remains unknown; existing comparisons use total package quantity and the existing 3% tolerance.
- Use the Saudi calendar for current-offer decisions across search, browse, monitoring, collection, enrichment and operations. Observation timestamps and retention remain UTC.
- Treat literal null/undefined/none/n/a sentinels as missing names, including previously stored rows. Use the same name rule in publication and verification eligibility. Normalize the visible Browse fields too.
- Withhold unit prices for body-weight confusion, explicit ranges/alternatives and identified mixed gifts. Sum explicit additive measures in the same unit family using the existing parser. An explicit sale-size field outranks a different incidental measurement, while matching name-level multipack evidence is retained. Shelf prices and product admission remain available.
- Make price-watch normalization, frontend comparison and the product sheet honor an explicitly withheld engine unit price rather than reconstructing the unsafe denominator from a display name. Older responses that omit the field retain the existing fallback. Flyer observations carry the engine's existing result internally; online listing behavior is unchanged.
- Expose only Ministral 14B in model selection. The current production default was already 14B; the old checkout's Medium default was not evidence that production used Medium. Retire the legacy Medium recovery processor while retaining its historical id.

The frozen extraction prompt is unchanged. Both deterministic validation stages remain. These changes follow VISION-PIPELINE sections 4.3, 5 and 7: quantity is separate from arithmetic readiness, validation is local, and useful observations are not fabricated.

## Measured results

| Check | Before | Proposed release |
|---|---:|---:|
| Fixed 32-image diagnostic set: correct unit prices | 19 | 20 |
| Same diagnostic set: wrong / withheld / excluded | 7 / 2 / 4 | 2 / 6 / 4 |
| New 32-image holdout: correct / wrong / withheld / excluded | 18 / 0 / 0 / 14 | 18 / 0 / 0 / 14 |
| Holdout: intended offer retrieved by authored EN/AR queries | 35/64 | 51/64 |

The holdout selected two current offers per store across all sixteen stores, excluding original image URLs. References and exclusions were written from original crops before inspecting their stored extraction fields or scoring. The original quantity candidate was frozen before selection, and its arithmetic code was preserved during the production-base port. The holdout uses existing stored 14B observations; it required no fresh inference. Annotation was by this assistant, without independent human adjudication.

Fourteen holdout images were excluded from exact numeric scoring because they were non-grocery specifications or ambiguous kits, counts or variants. All 32 source shelf prices matched the inspected crops. The simple scored holdout had no baseline errors, so it establishes preservation on these examples, not a new error-correction rate. The retrieval gain was reproduced through actual before/after D1 store SQL and serving overlays in SQLite over the captured 64-row production sample. It is not whole-catalog recall, full-catalog precision, or a load test.

Two diagnostic errors remain: palm oil misread as 5.5L and evaporated milk misread in ml instead of grams. Source OCR corroboration remains experimental; the existing stored search text has normalized punctuation and is not a safe substitute for the original measurement text. No blind OCR overwrite or disagreement veto is included.

## Verification costs: corrected production conclusion

The live queue's historical counters reached ten attempts, but deployed code already limits due failed reads to three attempts in total, excludes published current crops, and rejudges stored evidence before requesting another image read. A read-only D1 capture found 13,275 current queued rows and 410 verified rows, with **zero due** under that deployed rule. Queue status alone is not a work backlog or a count of billable API calls. This release preserves that policy; it does not claim savings from turning off a currently running blanket second pass.

## Live SQL resource cost

Six read-only production SELECTs exercised actual store query templates. `cornflakes` candidates increased from 0 to 21; `ويفر لواكر` from 0 to 13. `rice 1kg` filled the same 120-row candidate window. These are prefilter candidates, not final relevance or size-correctness counts.

The expanded query does more D1 work: approximately 52–74k rows read versus 26–27k for the old query in this capture. SQL execution times varied (old 57–606ms, proposed 200–301ms). This is a measured trade-off for recovered information, not a claim of free CPU or lower latency.

Twelve additional production SELECTs compared computing the combined text once through a materialized CTE. Results were identical, but timing was inconsistent: one rice run slowed from 278ms to 394ms, another improved from 273ms to 184ms. That variant was not adopted. No schema, index, embedding service, new queue or additional inference is introduced.

All remote audit SELECTs reported zero rows written. Audit validation made no production data or schema changes.

## Validation and release

The engine suite passes 91 test files, the companion frontend 14, and the connector 4. The two matchers agree on 7,207 shared cases with the same 46 previously documented divergences; eight deliberately changed outputs were regenerated on both sides. Focused tests cover ambiguous quantities, source retention through real SQL, Unicode null sentinels, Saudi midnight, size ranking and preserving engine withholding through frontend comparisons. A separate 96-observation check confirms that engine pricing, frontend product sheets and flyer-watch normalization preserve the same values, including all 25 withheld results; this is consistency evidence, not an accuracy score. The production-based Worker builds with project-local Wrangler in dry-run mode.

Run the suites and fixed holdout replay from the relevant checkouts:

```powershell
# Engine
npm test
node benchmarks/resource-release-2026-10-18/score-implementation-holdout.mjs

# Frontend
node src/resourceMatching.test.mjs
node src/matcherParity.test.mjs
```

The replay reconstructs its baseline from the pinned production commit and uses captured product data, without a credential or live model call. Original crops and extended experimental files remain available in the local audit artifacts.

Deployment must follow `deploy.mjs` and the companion frontend HANDOFF section 9: production engine releases require a clean, pushed main commit; the frontend main push publishes Pages. The tested engine and frontend changes must be released together so the frontend preserves withheld values. Publishing needs approval for the main-branch updates and live release, and any additional Cloudflare Worker authorization the existing read-oriented OAuth login lacks.

## Publication and live checks

The user approved publication. Engine `87ebe3e` and frontend `54b7abd` were pushed to main; both GitHub CI runs passed and Pages publication succeeded. Cloudflare deployed `87ebe3e` as version `09281311-fcd9-4a29-86a5-d348ae362df5`. Live health, brochure, English/Arabic search and Browse requests returned HTTP 200; published HTML and all three changed frontend modules matched the source. The cornflakes and Arabic Loacker checks returned 20 (requested limit) and 13 offers respectively. These are smoke checks, not relevance scores.

Inspection of those live responses found an additional explicit alternative: `farm:central:d4d:99041451`, size `110GR / 125GR`, was incorrectly priced at 109 SAR/kg using only 110g. A follow-up guard uses the existing package parser on slash-separated measures and withholds arithmetic when the alternatives differ. Equivalent measures (`1kg / 1000g`), package annotations (`500g / pack`) and per-kg bases remain supported. This newly found case is outside the original diagnostic/holdout counts above.
