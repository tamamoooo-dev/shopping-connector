# Search follow-up — 18 October 2026

This follows deployed engine `e0670b5` and frontend `aa2addc`. It investigates the five named residual reference failures from the preceding release. The changes use existing observations and existing API fields: no architecture/schema/prompt/model change, reindex, production data write or new inference. Ministral 14B remains the only model.

## Observed causes and changes

Five original public flyer crops were fetched and inspected (under `images/`, hashes in `summary.json`). This assistant's inspection is not independent or blinded annotation.

- Gloria fruit cocktail: `كوكتيل`/`كوكتل`, `غلوريا`/`جلوريا`/`GLORIA`, and fruit/فواكه prevented full bilingual coverage. Exact bridges now preserve those spellings.
- Langnese honey: the stored English brand is intact, but Arabic differs (`لانجنيز`/`لنجنيز`). Exact brand and honey bridges recover it.
- Panda hazelnut cocoa spread: the picture explicitly calls it كريمة الشوكولاتة بالبندق. A compound wording bridge keeps hazelnut and spread as separate words and identifies this specific compound as `spread`. Generic dairy cream and cosmetic cream do not become spreads. An intermediate single-token compound hid an existing abbreviated Nutella listing; that candidate was rejected, and the final wording preserves the listing. No quantity is inferred from the product family.
- TRANDS mouse: the model captured `TRANDS` separately from the name `TR-MU570 Rechargeable Wireless Mouse`. The engine used that observed brand but the frontend had no corresponding brand. A servable reading can now fill a missing **existing `brandSlug` field**, using only exact resolution through the existing brand lexicon. Existing brands are preserved; unresolved strings stay unresolved. TRANDS is added as a field-only brand, not to Browse's name scanner. This does not assert a canonical product ID, rewrite a name, or invent any observation.
- The watch reference is faulty: the crop says **Swiszone**, while the old query says **سويز**. That is not verified brand equivalence. The query is deliberately not forced to match. A separate `ساعة swiszone` control uses the observed brand and the ordinary watch/ساعة bridge.

The matcher changes are mirrored in both repositories. The HTML import map uses a new module version. Real Chrome checks simulate the previous cached modules and exercise the actual frontend import graph and the recovered mouse admission.

## Evidence and limits

| Check | Immediately preceding release | This release |
|---|---:|---:|
| Exact final target found, original available reference probes | 53/60 | 57/60 |
| Gloria fruit cocktail Arabic query: final offers | 0 | 1 |
| Langnese honey Arabic query: final offers | 0 | 6 |
| TRANDS mouse Arabic query: final offers | 0 | 2 |
| Panda spread target position for كريمة بندق بنده | absent | 1 |
| Existing abbreviated Nutella result | present | preserved |

All **60 diagnostic queries** retain every previously admitted offer ID after frontend deduplication, not just their total counts. No previously found reference target is lost. Across **2,331 common-offer comparisons**, displayed names, shelf prices, old prices, sizes, unit prices and each-prices are unchanged. Brand values can intentionally fill an existing empty field; field names are unchanged. Remaining available exact-ID failures are the invalid watch-brand reference and the two previously documented duplicate representatives. The original score denominator is kept for comparability.

Validation: **92 engine test files**, **15 frontend test files**, **7,207 unchanged shared matcher vectors**, and the real Chrome stale-module check passed. New controls cover unknown and unservable brands, preserving an existing different brand, wrong-brand token coverage, dairy cream, cosmetic cream and the shortened Nutella listing. No canonical product ID is created by the brand projection.

The same frozen 12,972-row catalogue and real SQLite store queries, engine handler, frontend admission, deduplication and price/Featured sorting are used against the immediately preceding release. `summary.json` records final counts, exact target improvements/regressions, display/price field comparisons and source hashes. The original target set is retained unchanged for transparent comparisons, including the known faulty watch reference and four unavailable probes. Its exact-ID misses also include two duplicate representatives; it is not a product-level population recall estimate.

The checks expand during development and include the cases used to design the fixes. They are diagnostic/regression evidence, not a blind catalogue-wide accuracy benchmark. Public responses captured immediately before and after publication are checked separately; they can change as ingestion runs. No speed claim follows from these relevance checks. The previous release's SQL robustness fix and its measured cost limitations remain unchanged.

## Reproduce

Use Node 24 from `brochure-engine/`; the previous release's committed compressed catalogue is verified by its SHA-256 digest. Baseline graphs come from pinned Git history. No credential is needed for replay.

```powershell
node benchmarks/search-followup-2026-10-18/prepare.mjs <frontend-repository>
node benchmarks/search-followup-2026-10-18/evaluate.mjs <frontend-repository> --gzip
node benchmarks/search-followup-2026-10-18/evaluate.mjs <frontend-repository> --gzip --targets
node benchmarks/search-followup-2026-10-18/summarize.mjs <frontend-repository>
```

Run `node run-tests.mjs` and every frontend `src/**/*.test.mjs`. Both matcher mirrors must retain the shared vectors. The browser smoke script requires Chrome at its standard Windows installation path. Publication uses the existing main/CI/Pages release and the mandatory engine `deploy.mjs`; post-publication proof is recorded in local `DEPLOYMENT.md`.
