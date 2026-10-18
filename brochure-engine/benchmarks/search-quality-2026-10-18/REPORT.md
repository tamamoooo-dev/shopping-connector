# Search quality improvements — 18 October 2026

The previous release recovered source information, but that did not establish better final search results. A direct strawberry comparison exposed jelly, waffles and yoghurt ranked as the fruit, and separate probes exposed offers found by the engine but rejected by the frontend. This release addresses those measured failures without changing the schema, architecture, public payload fields, extraction prompt or model selection. Ministral 14B remains the only selectable model. No model inference, migration, reindex or production data write was needed.

## What changes

- Both matcher copies recognize the observed product heads: waffle/wafer, jelly, spring/egg rolls, dish wash, squeezers, rice cookers, grinders and makeup. Rice flour/vinegar are distinguished from rice; olives stuffed with lemon are distinguished from lemons. These products remain searchable when explicitly requested.
- Narrow, tested Arabic/English wording and brand bridges recover Ringo, Nadec, Alsafi, Doux, Parachute, Sunsilk, Huggies, Geepas, Olsenmark, Himalaya and Nestle queries, plus the observed travel-pack, chest-bag and clothing terms. They do not introduce approximate matching across arbitrary brands.
- An existing mapped non-produce category can disambiguate a fruit-only transcription; the cereal aisle disambiguates `CRISPY RICE`. Concrete, different named products are protected.
- `offerMatchItem` projects existing bilingual names, brand slug, category and size consistently into engine and frontend matching. Only the unambiguous `baby-diapers` category can supply a missing diaper noun, and only if the name identifies no other family. It changes no displayed name and asserts no quantity or unit price.
- Frontend admission, grid staging and comparison identity checks preserve the same evidence. Stored size now reaches the grid's stage check as it already did the engine and comparison. The lowest-price contract remains: price alone orders genuine matches; related products follow. Frozen fruit remains a genuine fruit result under that existing contract.
- History interpretation uses the same matching projection. Validation stages, selective vision retries, notifications and collection schedules are unchanged.

## Trials and results

Baselines are the actually deployed engine `8fe94ac` and frontend `59748de`. A single read-only production SELECT captured all **12,972 currently browseable offer rows** and their existing observation fields. The same captured catalogue was reconstructed using the real schema in SQLite. Both actual store queries, `engine.handleRequest`, frontend `flyerListing`, deduplication, price/Featured comparators and comparison model ran against that identical catalogue. The frontend's real 120-offer limit and 300-candidate window were retained.

| Check | Before | After |
|---|---:|---:|
| Strawberry fruit among first 10 Arabic price-sorted flyer results | 7/10 | 10/10 |
| Same target offer reaches final frontend list, available reference probes | 32/60 | 53/60 |
| Same target offer reaches engine list, same probes | 47/60 | 55/60 |
| `ويفر رينجو`: frontend offers | 2 | 4 |
| `زبادي يوناني نادك`: frontend offers | 6 | 9 |
| `alsafi labneh`: frontend offers | 2 | 7 |
| `huggies diapers`: frontend offers | 9 | 17 |
| `sunsilk shampoo`: frontend offers | 2 | 14 |
| `عصارة ليمون`: frontend offers | 0 | 1 |

The strawberry score includes **frozen strawberries**, not only fresh fruit. Original crops for all top-ten before/after examples were inspected. In default price ordering, jelly moves 1→13, waffle 2→14 and yoghurt 3→18; Driscoll's fruit moves 15→12. The lemon squeezer moves 4→28 for `ليمون` and becomes findable for `عصارة ليمون`; the egg spring roll moves 2→15 for `بيض`. A rice cooker and breakfast cereal leave the first 120 results for `rice 1kg`.

There were **48 diagnostic/expanded queries** in Arabic and English. Final admitted/deduplicated counts did not decrease for any of them; counts alone are not precision scores. Opposite-intent checks include yoghurt/waffle/jelly strawberry, frozen strawberry, tomato paste, egg roll and rice flour, and wrong-brand controls remain excluded from full token coverage. Across **2,122 common-offer comparisons**, display names, shelf prices, sizes, unit prices and each-prices were unchanged.

The reference probes reuse 64 previously authored English/Arabic queries. Four target probes concern two offers absent from the current browseable catalogue and are excluded from the available-target denominator. No previously found final target was lost among the remaining 60. Two residual exact-id misses are offers admitted and then represented by a duplicate listing (`oks steel scrubber`, `men slipper`); exact-id success is consequently not product-level recall. Five other reference misses remain: `ساعة سويز`, `كوكتيل فواكه غلوريا`, `عسل لانجنيز`, `كريمة بندق بنده`, `ماوس تراندز`. Ambiguous brand abbreviations or cream/spread equivalence were not forced to fit the target set.

These are development and regression checks, **not a blinded or independently annotated catalogue-wide accuracy benchmark**. This assistant inspected 25 original crops; references were recorded after inspecting failures and candidate results. No claim is made about all retailer online-search availability, load performance, or global precision. The larger query set was expanded during development. The tests support the specific fixes and preservation cases reported here.

## Validation and resource use

- Engine: **92 test files passed**. Frontend: **15 passed**. Unchanged connector: **4 passed**.
- Both matcher mirrors pass **7,207 shared vectors**, retaining the same **46 known divergences**. Thirty-seven expected outputs changed deliberately; the new tests add contrasting real product/brand/category cases.
- Expanded six-token searches are tested against the D1 limits: the four dense unit probes use at most **88 of 100 parameters** and **6,000 SQL bytes**. The equivalent old statement could exceed 100,000 bytes. The unchanged search expression is aliased, and equivalent synonym groups are combined while retaining their original ranking weight. All **118 full-catalogue SQL differential checks** preserve every returned field and row order. Limits: [Cloudflare D1](https://developers.cloudflare.com/d1/platform/limits/).
- Read-only live D1 checks confirm identical paired strawberry and rice results. Reads increased slightly (65,529→65,689 and 74,616→75,612); individual SQL durations also increased in these samples, so this is a robustness fix, **not evidence of improved speed**. The repeated six-spelling query exposed an out-of-memory failure in an intermediate candidate; the final grouped query succeeds with 106 rows, and the six-distinct-token probe succeeds with zero matches. See `sql-alias-live.json` for all timings and costs.
- A real Chrome module-graph check served the old frontend modules at unversioned URLs. The import map correctly loaded all three changed modules from versioned URLs; metadata-based admission and comparison behavior passed. This protects existing visitors from a mixed cached release.
- The production SELECTs reported **zero rows written**. All repeated relevance trials used the local snapshot. No additional production model calls, schema changes, services or queues were introduced. Alias expansion still has database/CPU cost; this release does not claim a measured latency saving.
- Live pre-deployment responses for twelve representative queries were captured locally. Post-deployment responses, website source hashes, CI and the stamped Worker version must be checked as the release is published.

## Reproduce without a credential

The committed `catalog.json.gz` contains the captured public offer/observation rows; `catalog-digest.json` verifies its exact bytes. Original inspected crops, their hashes and labels are under `crops/` and `visual-reference.json`. Baseline code is reconstructed from pinned Git history. Use Node 24, run from `brochure-engine/`, and supply a checkout of the companion frontend repository:

```powershell
node benchmarks/search-quality-2026-10-18/prepare-replay.mjs <frontend-repository>
node benchmarks/search-quality-2026-10-18/evaluate.mjs <frontend-repository> --gzip
node benchmarks/search-quality-2026-10-18/evaluate.mjs <frontend-repository> --gzip --targets
node benchmarks/search-quality-2026-10-18/metrics.mjs <frontend-repository>
```

`--smoke` replays the first two queries to check the compressed fixture and setup. Raw run output stays local; `results-summary.json`, `target-results.json` and the frozen source hashes are committed. Source hashes normalize CRLF to LF for portable Git checkouts while preserving the original raw capture hashes and freeze timestamp. Publish the frontend and engine together through their existing release paths; use the required `deploy.mjs` for the Worker.
