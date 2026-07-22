# Vision-first with smarter selective OCR fallback — same 50 crops

This isolated experiment reused the exact ordered 50-crop set from the original Vision-first run (digest `9eb9c73cbd6f7995dd335e05447c94cf7864a06fe81aae448a63308930f8b499`). OCR triggers were deterministic, confidence-independent, and based only on missing/invalid required Vision fields plus direct Vision-text size evidence. Retries were disabled.

## Headline metrics

| Metric | Result |
|---|---:|
| Vision-only samples | 37 (74%) |
| OCR fallback samples | 13 (26%) |
| Vision accepted fields | 181 |
| OCR accepted fields | 40 |
| Fields completed by OCR | 15 |
| Final null source fields | 54 |
| Rule-derived fields populated | 127 |
| Total API requests | 63 |
| Average requests/sample | 1.26 |
| Average Vision latency | 1165.06 ms |
| Average OCR latency when invoked | 222 ms |
| Average end-to-end latency | 1224.92 ms |

Accepted Vision fields overwritten by OCR: **0**.

## Deterministic comparison result

Versus OCR-first: {"Comparable":42,"Better":8}; OCR reduction 74%. Versus original Vision-first: {"Comparable":33,"Better":17}; OCR change -6 calls. These are completeness/output-agreement measures, not human ground truth.
