# Value Watch identity — benchmark (2026-11-03)

Question: of everything 7 stores return for a watch's searches, which listings
are the watched product (same brand, line, type, variant, size per item, any
pack)? A wrong "yes" is a false alert; a wrong "no" is a missed deal.

## Data

- `candidates.json` — 8 references (the 6 production watches + Almarai fresh
  milk 1 L + Pepsi 18 × 330 cans), with every listing the stores returned for
  their searches on 2026-11-03: **2,505 candidates**.
- `labels.json` — hand labels per `reference|store|listing`: `same`, `not` or
  `ambig`. **60 same.** Corrections made while labelling: Panda 35485 is the
  Nadec skimmed 4 × 1 L (same, by barcode); Tamimi 152693 "علبة" variants are
  the regular Pepsi can; Danube 27567 / 44349 / 54275 (320–325 ml) ambiguous.
- Silver set: **1,060 cross-store pairs sharing a barcode**. A deterministic
  rule may never veto one of them.

## Scripts

```
node conflicts.mjs          # every conflict rule vs the labels and the twin pairs (no network)
TAG=r1 node run.mjs         # the production path: buildWatch → sweepValueWatch with the
node score.mjs results_e2e_r1.json   # live ministral-14b judge (local keys via local-secrets.mjs)
```

`run.mjs` drives the real `watchIndex.sweepValueWatch` (rules, conflicts,
same-barcode twins, per-product judging, two votes, judged size check) with
each store answering from `candidates.json`, 50 per query as in production.

## Results

| Method | Same found | False matches |
|---|---|---|
| Rules only | 25/60 | 0 |
| Previous prompt, token cap fixed (12 of 22 replies had been cut off) | 41/60 | 10–12 |
| Few-shot prompt, one vote, 3 runs | 59/60 | 1–2 |
| Agreement of two runs, earlier prompts | 50–51/60 | 0 |
| **Production: few-shot + conflict rules + two votes, 3 runs** | **58/60 ×3** | **0 ×3** |

The remaining two are kept as "unsure" (never rejected): Ninja's
"نادك حليب خالي الدسم 1 لتر" cannot say fresh or long-life.

## What was tried and dropped (measured)

| Idea | Why not |
|---|---|
| One-sided diet / light marker | 52 false vetoes on twins ("تونة خفيفة" is light meat) |
| Hold "fresh" when the other side is silent | 58 twin holds |
| Hold on product-line words | 232 twin holds |
| Prompt clause "unsure when silent" | lowered recall |
| Flavour rule for every product type | live probe: stores title plain Sprite "بنكهة الليمون والليمون الأخضر", Mirinda "برتقال علبة" — kept to tuna / sardine / milk / laban / yogurt / cheese / labneh |
| Mistral Medium judge | "retries exhausted"; the one-model policy keeps 14B |

## Rule checks (conflicts.mjs, 2026-11-03)

220 flavour vetoes and 12 bundle vetoes on the candidates; **0** on the 60
same, **0** on the 1,060 twin pairs.
