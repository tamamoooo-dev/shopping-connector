# Price Watch

Permanent technical reference. Part A is the current default, the **Value
Watch** (v4, 2026-11-03). Part B is the product-anchored design of 2026-07-29,
kept as written; the explicit `amazon_exact` and `market_general` tracks still
follow it. `PRICE_WATCH_V2.md` is history only.

Last validated: 2026-11-03

# Part A — Value Watch (v4, `watch_track = 'indexed_value'`)

## A1. What it promises

The user picks ONE listing. The watch then means **this exact product** — same
brand, product line, type, variant and **size per item** — in **any pack** at
**any store** (online + this week's flyers), compared **per item**:

- 12 cans at 50 SAR (4.17 a can) beats one can at 5 SAR.
- The 80 g Tendrina tin and the 185 g Tendrina tin are two products.
- An alert fires on time (07:00 / 19:00 Riyadh) and once per deal.

## A2. How it works

```
create ──► background INDEX (minute tick, at creation, then weekly)
              search ≤4 queries × 7 stores + flyers  (50 results / query, wide)
              ├─ rules settle what needs no judgement
              ├─ AI judge (ministral-14b, two votes) the rest
              └─ watch_listings: one row per (store, listing) + verdict
round 07:00/19:00 ──► the same sweep; only NEW listings are judged
                      price the verified rows per item → decideAlert
```

`watchValue.js` is pure (quantities, rules, prompt, votes, alert state machine);
`watchIndex.js` is the runtime (sweep, index pass, round, listings view);
`storage/watchListingStore.js` keeps the index (`watch_listings`, migration
`migrate-2026-11-03-value-watch.sql`).

### Decision order, per listing

1. **user** — the owner's verdict ("this is it" / "not this") always wins.
2. **anchor** — the listing the watch was created from.
3. **size** — a size per item the listing states that contradicts the watched
   one rejects (`ITEM_SIZE_TOLERANCE` 6 %).
4. **barcode** — a barcode of the reference, the anchor or a user verdict.
   Never one learned from an AI verdict (stores file old and new codes on one
   listing, so learning would chain).
5. **no overlap** — no word in common rejects.
6. **conflict** (`conflictWith`) — provably another product:
   another known brand; a **bundle** of two sized products ("كيك 280 جم &
   حليب 1 لتر"); a stated **fat / freshness / dairy type / oil-vs-brine / oil**
   value that differs; a **flavour** on a plain tuna, sardine, milk, laban,
   yogurt, cheese or labneh reference. The conflict also applies to every
   listing with that one's barcode (a store that omits "طويل الأجل" from the
   long-life carton).
7. **kept** — a verdict already given for the same title is reused.
8. **judge** — everything else, two votes (A3).
9. **judged size** — a "yes" whose size per item contradicts is still a reject.

Only `match` + size-verified + in stock + seen this round can price a watch or
alert. A store that did not answer proves nothing: its listings are neither
missing nor above target, and it cannot end a deal.

## A3. The judge

- Model `ministral-14b-2512` (the one-model policy), temperature 0, batches of
  20, a few-shot prompt (`JUDGE_SYSTEM`) whose examples are deliberately not
  benchmark products. Few-shot demonstrations are what lift small models on
  entity matching (Peeters et al., arXiv 2310.11244); it raised recall from
  41/60 to 59/60 here.
- The reference is shown **without its pack count** (`withoutPackCount`): told
  "Pack of 12", the judge answered "wrong pack size" to 4-packs.
- One product, one judgement: a store's pack sizes of one product (Tamimi
  variants) share it.
- **Two votes** (`combineVotes`): each product is asked twice in one sweep, in
  batches with other neighbours and order. At temperature 0 the model still
  flips between batches. A match needs **both** yeses; a yes against a no or
  an unsure becomes an **unsure**.
- **An unsure is an answer**: kept for that title (pending, `verdict_by = 'ai'`),
  never asked again, so re-asking is never another chance at a yes. The owner
  sees it under "Not decided yet" and can confirm it. Only a listing with no
  answer yet (`verdict_by` null: cut off, or the call failed) is asked again.

## A4. Measured (2026-11-03)

`benchmarks/value-watch-judge-2026-11-03/`: the 6 production watches plus 2
more, 8 references, 2,505 store candidates, 60 hand-labelled true listings,
1,060 cross-store same-barcode pairs (a rule may never veto a true twin).

| Method | True listings found | False matches |
|---|---|---|
| Rules only | 25/60 | 0 |
| Previous judge prompt (token cap fixed) | 41/60 | 10–12 |
| Few-shot prompt, one vote (3 runs) | 59/60 | 1–2 |
| **Production path: rules + two votes (3 runs)** | **58/60 every run; the other 2 kept as unsure, 0 rejected** | **0** |

The two unsure are Ninja's "نادك حليب خالي الدسم 1 لتر" for a long-life
watch: Nadec also sells a fresh skimmed 1 L, the title does not say which, and
the watch's Amazon listing has no barcode to settle it — the owner confirms.

Every conflict rule: 0 vetoes on the 60 true listings and 0 on the 1,060 twin
pairs. Live probes (7Up, Sprite, Mirinda, Fanta, Lipton, Pepsi, Coca-Cola,
tea, candy) showed why the flavour rule is limited to the types above: stores
title plain Sprite "بنكهة الليمون والليمون الأخضر".

## A5. Rules that must not be weakened

1. Size per item is identity; pack count never is.
2. Value is per item: price ÷ items in the pack.
3. A match by AI needs two agreeing yeses; an unsure is kept, never re-asked.
4. Barcodes settle identity only from the reference, the anchor or the user.
5. A conflict rule ships only with 0 vetoes on the true listings and the twin
   pairs of the benchmark.
6. A store that did not answer tells nothing; a store that never had the
   product cannot block a round.
7. One deal, one alert.

# Part B — product-anchored (2026-07-29)

## 1. What a watch is

A target price on something the user wants to buy, anchored in exactly one of
two ways — never to a retailer-side reference.

| | Anchor | Question it answers |
|---|---|---|
| **Strict** | `registry_product_id` (`pr_`) | "THIS product, wherever it is sold" |
| **Flexible** | `spec` (pinned identity dimensions) | "any product of THIS class" |

`scope` says how wide to look: `store` (one retailer) or `market` (all
providers plus the current flyer offers). `kind` is vestigial — it is `NOT NULL`
and the previous deployment keys off it, so it is still written, but nothing
branches on it.

## 2. Why it changed

The previous design anchored a watch on a derived attribute tuple (brand +
family/type + size + variant) and gated candidates on a conjunction of exact
equalities. A **missing** attribute on a candidate was a veto, which inverted
the platform's own measured rule — `registry/resolver.js scoreCandidate`:
*"missing evidence is neutral, never a penalty"* — and nothing persisted the
outcome. A watch that had silently stopped resolving was indistinguishable from
one waiting for a discount. Both halves are fixed here.

## 3. The pipeline

```
Extractors → Resolver → Ledger
```

Extractors are plural; the resolver and ledger are singular. Watches are a
**consumer** of identity, never an owner of it.

- `identity/listingCandidate.js` — online listing → Identity Candidate. The
  second extractor (the first is the Vision Identity Builder). Pure.
- `identity/verify.js` — *"is this MY product?"* Verification against ONE known
  product via `scoreCandidate`. No blocking lookup, so a check costs one D1
  product read plus in-memory scoring.
- `identity/spec.js` — the Flexible Watch: an open map of pinned dimensions,
  validated against `CANDIDATE_DIMENSIONS`.

**Retrieval is still lexical** — a query string is how a store's search endpoint
finds anything. The **decision** never is.

## 4. Resolution happens once, in the foreground

`monitor.anchorWatch` runs at creation, while the user is present:

- `attach` → bind the existing product.
- `create` → mint from the listing (create-on-doubt) and report the mint.
- `review` / too thin → `needs-confirmation`. **Never a guess.**

An ambiguous identity is adjudicated by a human looking at the product, instead
of by an unattended cron choosing between guessing and going quiet.

## 5. Unknown evidence

Handled **oppositely** for the two types, and the asymmetry is deliberate:

- **Strict** — unknown *abstains*. The resolver weighs other evidence, so a
  missing signal must not veto. An unresolvable brand (the lexicon covers a
  minority of the market) does not reject a candidate.
- **Flexible** — unknown does **not satisfy a pin**. A predicate has no other
  evidence, so a candidate whose family cannot be read cannot be shown to be in
  the class.

Both **count and report** their exclusions. Neither goes silent.

## 6. States

Every watch is in exactly one, always:

| `registry_product_id` / `spec` | `last_resolution` | Meaning |
|---|---|---|
| set | check telemetry | **Monitoring** |
| null | `pending-migration` | backfill has not run |
| null | `needs-confirmation` | user must pick |
| null | `unresolvable` | nothing can bind it |

The invariant, assertable at any time — **must return zero rows**:

```sql
SELECT COUNT(*) FROM watches
 WHERE registry_product_id IS NULL AND spec IS NULL AND last_resolution IS NULL;
```

`checked_at` says a check RAN. `resolved_at` says it SUCCEEDED. Keeping them
apart is what makes a dead watch visible.

## 7. Caps

Two bounds, two purposes. Conflating them is what made an earlier draft
incoherent.

| Constant | Counts | Protects |
|---|---|---|
| `MAX_WATCHES` (24) | monitored per profile | daily cron fan-out |
| `MAX_WATCHES_TOTAL` (90) | monitored, all profiles | invocation cap |
| `MAX_WATCH_ROWS` (60) | rows per profile | storage |

An unanchored watch is skipped by the check and costs zero subrequests, so it
occupies **no** monitoring slot — but it does occupy a row.

## 8. Cadence

| Pass | When | Cost |
|---|---|---|
| Online sweep | daily, `45 5 * * *` (08:45 AST) | 7×market + 1×store searches |
| Flyer re-eval | on ingest completion (Tue/Wed/Fri) | **zero subrequests** |

Flyer prices change only at ingest, so that is when a flyer deal becomes
knowable. The flyer pass may only ever **improve** a watch: finding nothing
returns resolution `null` ("no change") and never overwrites the daily outcome.

Recompute rule: `requests = 7×(market) + 1×(store)`,
`invocations = 1 + ⌈monitored/3⌉`. The first thing to bind is retailer
politeness, not Cloudflare.

## 9. Merge safety

Merge is the one registry operation that is irreversible in practice (undoing
one is N per-sighting splits, each needing the sighting's Identity Candidate to
still exist) **and** it is automated. Kill switch:

```
ops/settings/registry-merge.json   {"enabled": false, "reason": "..."}
```

Absent or unreadable = enabled. Freeze it while the input distribution is
changing — which is what a migration does — and re-arm after.

## 10. Operations

| Route | Guard | Purpose |
|---|---|---|
| `POST /watches` | open (profile-scoped) | create + anchor in the foreground |
| `PATCH /watches` | profile | `closeThreshold`, or `registryProductId` to confirm |
| `GET /watches/candidates` | profile | products to choose from |
| `GET /watches/diagnose` | profile | **why is this watch quiet?** |
| `POST /watches/resolve-legacy` | `X-Ingest-Secret` | the ONE-TIME backfill (`?dryRun=1` writes nothing) |
| `POST /watches/check` | `X-Ingest-Secret` | the cron fan-out target |

Also from `/__ops`: `{"op":"watches/resolve-legacy","dryRun":true}` and
`{"op":"registry/merge","enabled":false,"reason":"…","confirm":true}`.

The backfill is idempotent and reports `stillPending`, which must reach 0.

### Diagnosing a quiet watch

`last_resolution` says WHAT happened; `/watches/diagnose` says why, per
candidate, against live results. It runs the real retrieval and the real
identity decision and reports each candidate with the resolver's own rejection
reason — `cut-conflict`, `size-conflict`, `brand-conflict`,
`variety-not-evidenced`, `below-identity-threshold` — plus the dimensions the
extractor read from it. Nothing is written and no alert can fire. Surfaced in
the app as "Why is this quiet?" on any anchored watch not reporting `ok`.

A rejection is never reported as a bare "no match": if the resolver's admission
gate did not name the dimension, `verify.js namedVeto` does, mirroring
`scoreCandidate`'s own veto order.

## 11. Files

```
src/identity/listingCandidate.js   extractor
src/identity/verify.js             strict verification
src/identity/spec.js               flexible class
src/monitor.js                     one evaluation path
src/priceWatch.js                  price + quantity ONLY (no matching)
migrate-2026-07-29-watch-product-anchor.sql
```

Tests: `watchAnchor.test.mjs`, `watchLegacy.test.mjs`,
`identity/*.test.mjs`, `watches.test.mjs`, `storage/watchStoreV2.test.mjs`.

## 12. Rules that must not be weakened

1. Identity is never derived from text at check time.
2. Unknown abstains (strict) / fails a pin (flexible) — never the reverse.
3. Every check records an outcome, including the ones that find nothing.
4. Ambiguity asks; it never guesses.
5. There is **no monitoring path for an unanchored watch** — not a degraded
   one, not a temporary one. That fallback is the lexical matcher this design
   deleted, and it would return wearing a migration-shaped disguise.
6. A watch's identity is fixed at creation. Loosening it later would silently
   change which product it alerts on.
