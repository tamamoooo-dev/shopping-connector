# Price Watch — product-anchored

Permanent technical reference. Supersedes `PRICE_WATCH_V2.md`, which described
the attribute-tuple design replaced on 2026-07-29 and is retained only as
history.

Last validated: 2026-07-29

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
