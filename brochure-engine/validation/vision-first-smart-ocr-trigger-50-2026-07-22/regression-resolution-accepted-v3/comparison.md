# Comparison with both previous 50-crop experiments

All columns use the identical frozen crop set. Better/Comparable/Worse measures deterministic weighted field completeness; normalized agreement measures output equality and must not be read as human-adjudicated extraction accuracy.

| Metric | OCR-first baseline | Original Vision-first | Smart-trigger Vision-first |
|---|---:|---:|---:|
| OCR invocations | 50 | 19 | 13 |
| Vision invocations | 46 | 50 | 50 |
| Average requests/sample, no retries | 1.92 | 1.38 | 1.26 |
| Final null source fields | 64 | 71 | 54 |

## Completeness and quality proxies

- Versus OCR-first: {"Comparable":42,"Better":8}; regressions 0; equal-or-better 50/50.
- Versus original Vision-first: {"Comparable":33,"Better":17}; regressions 0; equal-or-better 50/50.
- OCR reduction versus OCR-first: **74%**.
- OCR reduction versus original Vision-first: **31.58%** (negative means an increase).

### Normalized output agreement

| Field | Versus OCR-first | Versus original Vision-first |
|---|---:|---:|
| name_en | 51.02% (25/49) | 77.55% (38/49) |
| name_ar | 14% (7/50) | 50% (25/50) |
| brand | 68.75% (33/48) | 93.75% (45/48) |
| size | 22.22% (8/36) | 69.44% (25/36) |
| pack_count | 38.46% (5/13) | 0% (0/13) |

## Observed advantages

- OCR is skipped for 37 samples.
- Accepted Vision fields are never overwritten.
- Confidence does not create fallback traffic.

## Observed regressions

- Worse versus OCR-first: 0.
- Worse versus original Vision-first: 0.
- Current null source fields: 54.
- Per-field normalized disagreements are in metrics.json.

## Every OCR fallback sample

- 2. `almadina:central:d4d:93545889` — brand_missing_or_invalid; OCR fields: brand
- 3. `alwafa:central:d4d:93172608` — english_product_name_missing_or_invalid, brand_missing_or_invalid; OCR fields: name_en, brand
- 5. `carrefour:central:d4d:93218136` — english_product_name_missing_or_invalid; OCR fields: name_en
- 11. `lulu:central:d4d:93281295` — english_product_name_missing_or_invalid; OCR fields: name_en
- 17. `ramez:central:d4d:93579768` — english_product_name_missing_or_invalid, brand_missing_or_invalid; OCR fields: none
- 19. `nesto:central:d4d:93535815` — english_product_name_missing_or_invalid; OCR fields: name_en
- 23. `alwafa:central:d4d:93172509` — brand_missing_or_invalid, required_field_validation_failure; OCR fields: brand
- 25. `lulu:central:d4d:93282216` — english_product_name_missing_or_invalid; OCR fields: name_en
- 28. `lulu:central:d4d:92778480` — english_product_name_missing_or_invalid; OCR fields: name_en
- 39. `lulu:central:d4d:93282276` — product_name_missing, english_product_name_missing_or_invalid, arabic_product_name_missing_or_invalid, required_field_validation_failure; OCR fields: name_en, name_ar, size
- 46. `nesto:central:d4d:93187185` — brand_missing_or_invalid; OCR fields: brand
- 49. `marksave:central:d4d:93191415` — brand_missing_or_invalid; OCR fields: brand
- 50. `marksave:central:d4d:93539499` — english_product_name_missing_or_invalid, brand_missing_or_invalid; OCR fields: name_en

## Validation conclusion

The experiment determines whether the smarter trigger recovered deterministic completeness while retaining substantial OCR savings. The measured result is reported above without changing production or making an architectural recommendation.
