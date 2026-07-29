# Price Watch v2 — SUPERSEDED

> **This document describes the attribute-tuple design replaced on 2026-07-29.**
> The current reference is [PRICE-WATCH.md](PRICE-WATCH.md).
>
> What changed and why: a watch is now anchored to a registry product (`pr_`)
> or to a declared class (`spec`), and identity is resolved once, in the
> foreground, by the shared resolver. The conjunction of exact attribute
> equalities described below — in which a MISSING attribute on a candidate was
> a veto — was the cause of watches that went silent permanently.
>
> Retained as history. Do NOT implement from this document.

---

# Price Watch v2

Permanent technical reference for the Price Watch v2 implementation.

Last validated: 2026-07-27

## 1. Scope and compatibility

Price Watch v2 applies attribute-based matching to `grocery` watches. As of
2026-07-28 the same attribute identity is also the ANCHOR of a `product` watch
(section 13): the provider catalog ID it was created from is a lookup cache in
front of that identity, not the identity itself. A `registry` watch remains an
exact registry-product lookup, because a registry `pr_` ID *is* stable identity.

Every grocery watch has four matching attributes:

1. Product Identity — always mandatory.
2. Brand — mandatory when `matchBrand` is true.
3. Size — mandatory when `matchSize` is true.
4. Variant — mandatory when `matchVariant` is true.

The three configurable flags default to true. Missing flags also read as true
in both the matching layer and storage mapper, and the migration columns have
database defaults of `1`. Existing watches therefore retain strict behavior
without being rewritten.

There is no separate “category watch” mode or state. A category-level watch is
the natural result of setting Brand, Size, and Variant matching to false while
Product Identity remains mandatory.

Primary implementation files:

- `src/priceWatch.js` — attributes, unit normalization, promotion pricing.
- `src/monitor.js` — candidate retrieval, filtering, selection, and alert state.
- `src/matching.js` — taxonomy, relevance, size parser, and journey gates.
- `src/storage/watchStore.js` — persistence and legacy defaults.
- `src/storage/offerStore.js` — flyer retrieval and initial ranking.
- `migrate-2026-07-27-price-watch-v2.sql` — database migration.
- `migrate-2026-07-28-watch-identity-anchor.sql` — identity anchor + catalog
  cache columns (section 13).

## 2. Architecture overview

For each active grocery watch, the daily monitor performs this pipeline:

1. Hydrate missing v2 identity attributes for a legacy watch.
2. Select a search query:
   - strict Brand + Variant: the original query with size expressions removed;
   - otherwise: the stored Product Identity query.
3. Fetch up to 50 results from each online provider and up to 50 current flyer
   offers.
4. Determine each candidate's effective purchase price.
5. Extract candidate identity, brand, size, and variant attributes.
6. Apply the mandatory Product Identity gate.
7. Apply the enabled Brand, Size, and Variant gates.
8. If Size is disabled, normalize both target and candidate to unit price and
   require the same canonical comparison unit.
9. Apply the shared alert journey gates: best search-stage band, family, type,
   and fresh-produce intent.
10. Select the lowest comparison price from the surviving pool.
11. Classify it as target reached, close to target, or above target.
12. Emit a crossing alert only when the watch enters an alert zone.

Online providers are `panda`, `tamimi`, `danube`, `lulu`, `ninja`, `amazon`,
and `noon`. Failure of one provider does not fail the entire watch check.

## 3. Product Identity

### 3.1 Identity construction

Identity is generated once when a watch is created and stored as:

- `identityFamily`
- `identityType`
- `identityQuery`

The reference text is the concatenation of label, query, and supplied size
text. The taxonomy extracts:

- a product family: what the item is or its aisle-level class;
- an optional product type: the more specific physical form.

Family priority is:

1. Derived family, such as chocolate, soda, sauce, cereal, or care.
2. Base family, such as chicken, milk, rice, oil, or fish.
3. Produce family, such as tomato, lemon, or strawberry.

This priority prevents an ingredient or flavor word from replacing the actual
product family. For example, “Strawberry Milk” is `milk`, not `strawberry`.

The type taxonomy is deliberately narrower. Current forms include nuggets,
burger, sausage, roll, mince, fillet, breast, strips, wings, kofta, and
luncheon.

When a family is found:

```text
identityQuery = "<family> <type>"  // type omitted when absent
```

When no family is found:

```text
identityQuery = original query with recognized size expressions removed
```

### 3.2 Candidate identity gate

If the watch has a known family:

- the candidate family must equal the watch family;
- if the watch has a known type, the candidate type must also equal it.

If the watch has no known family, the candidate must pass the legacy lexical
relevance threshold against `identityQuery`.

Product Identity can never be disabled.

### 3.3 Exact answer for Sadia Chicken Breast

For:

```text
Sadia Chicken Breast 900 g
```

the stored attributes are:

```text
identityFamily = chicken
identityType   = breast
identityQuery  = chicken breast
brandId        = sadia
size           = 900 g
variantKey     = ""
```

With Brand, Size, and Variant disabled, the anchor is therefore **Chicken
Breast**. It is not all Chicken, Poultry, or Frozen Food.

Examples:

| Reference | Family | Type | All three relaxed watches |
|---|---|---|---|
| Sadia Chicken Breast 900 g | chicken | breast | all recognized Chicken Breast |
| Americana Chicken Nuggets 750 g | chicken | nuggets | all recognized Chicken Nuggets |
| Chicken 1 kg | chicken | none | all recognized Chicken products |
| Pepsi Zero 1 L | soda | none | all recognized Soda products |
| Twix Twin 50 g | chocolate | none | all recognized Chocolate products |
| Fresh Milk 2 L | milk | none | all recognized Milk products |
| Dove Repair Shampoo 400 ml | care | none | all recognized Care products |

The last three examples illustrate that category breadth is determined by the
current taxonomy. A family without a type can be broad.

## 4. Brand, Size, and Variant gates

### 4.1 Brand

Brand names and aliases are normalized to a canonical `brandId`. With Brand
enabled, a known reference brand requires exact canonical-ID equality. A
candidate with an unknown or different brand does not match.

If the reference brand itself is unknown, strict mode preserves the v1
behavior by requiring lexical relevance to the original query.

With Brand disabled, the brand gate is skipped.

### 4.2 Size

With Size enabled, a parsed reference size requires:

- the same canonical unit family; and
- total package quantity within 3%.

The 3% tolerance absorbs OCR and decimal representation noise; “same size” is
therefore not byte-for-byte equality. If the reference has no parsed size,
strict mode has no size gate for compatibility. If the reference is parsed but
the candidate is not, the candidate is rejected.

With Size disabled:

- package price is never used for comparison;
- the target is converted to unit price when settings are saved;
- every candidate must have a trustworthy quantity;
- every candidate is converted to unit price;
- the candidate's canonical comparison unit must equal the target's unit.

For example, `SAR/kg` cannot compete with `SAR/Piece`.

### 4.3 Variant

Variant matching is deterministic lexicon extraction, not fuzzy semantic
similarity. The engine:

1. removes recognized size expressions;
2. normalizes case, punctuation, and bilingual spelling;
3. extracts recognized variant phrases and words;
4. sorts and joins them into a stable `variantKey`;
5. requires exact key equality when Variant is enabled.

Variant signals include flavors, colors, scents, formulations, hair types,
editions, pack forms, and selected product-specific descriptors.

Current named examples:

| Reference | Candidate | Keys | Strict result |
|---|---|---|---|
| Dove Repair | Dove Intensive Repair | `repair` vs `intensive repair\|repair` | different |
| Pepsi Zero | Pepsi Sugar Free | `zero` vs `sugar free` | different |
| Snickers Original | Snickers Peanut Butter | `original` vs `peanut\|peanut butter` | different |
| Snickers plain | Snickers Peanut Butter | empty vs `peanut\|peanut butter` | different |

“Zero” and “Sugar Free” are not collapsed into a synonym group. Strict mode
means exact normalized variant identity, not marketing-equivalence inference.

When Variant is disabled, the variant-key gate is skipped.

## 5. Unit Price normalization

### 5.1 Canonical quantities

The size parser reads the product name and structured size field. It supports
single packages, measured multipacks, count packs, and plausible bonus packs.

| Input unit | Canonical stored quantity | Comparison unit |
|---|---|---|
| g, gram | total grams (`g`) | SAR/kg |
| kg, kilo | multiplied by 1,000 into grams (`g`) | SAR/kg |
| ml | total milliliters (`ml`) | SAR/L |
| L, liter, litre | multiplied by 1,000 into milliliters (`ml`) | SAR/L |
| piece | total generic pieces (`pcs`) | SAR/Piece |
| roll | total generic pieces (`pcs`) | SAR/Piece |
| sheet | total sheets (`sheets`) | SAR/100 Sheets |
| tablet | total generic pieces (`pcs`) | SAR/Piece |
| capsule | total generic pieces (`pcs`) | SAR/Piece |

Rolls, tablets, and capsules are numerically normalized per individual unit but
currently share the generic display label `SAR/Piece`. Sheets are kept
separate and normalized per 100 sheets.

Weak counts such as `12 ct`, `12x`, or `12's` are accepted for strict size
comparability but are not trusted for unit-price advertising and return no
unit price.

### 5.2 Formulas and examples

Weight:

```text
unit price per kg = purchase price × 1,000 / total grams
```

`20 SAR / 500 g = 40 SAR/kg`

`20 SAR / 1 kg = 20 SAR/kg`

Volume:

```text
unit price per L = purchase price × 1,000 / total milliliters
```

`20 SAR / 750 ml = 26.6667 SAR/L`

`20 SAR / 1.5 L = 13.3333 SAR/L`

Count:

```text
unit price per piece = purchase price / total trusted pieces
```

`20 SAR / 8 rolls = 2.50 SAR/Piece` (numerically per roll)

`20 SAR / 20 tablets = 1.00 SAR/Piece` (numerically per tablet)

Sheets:

```text
unit price per 100 sheets = purchase price × 100 / total sheets
```

`20 SAR / 100 sheets = 20 SAR/100 Sheets`

Multipack:

`6 × 200 ml` becomes `1,200 ml`, then compares in `SAR/L`.

Buy X Get Y:

`Milk 1 L, Buy 2 Get 1 Free, 10 SAR each` has a purchase price of `20 SAR`
and a received quantity of `3 L`, so its comparison price is `6.6667 SAR/L`.

The stored target unit price is rounded to four decimal places. Effective
purchase price is rounded to two decimal places. Candidate unit calculations
retain numeric precision for comparison and are formatted by the UI.

## 6. Missing size behavior

There is no package-price fallback in size-relaxed mode.

Reference behavior:

- Creating a grocery watch with Size disabled requires a readable reference
  quantity. Creation otherwise returns a validation error.
- Disabling Size on an existing watch also requires a calculable target unit
  price. The settings update otherwise returns a validation error.
- A malformed legacy relaxed watch with no target unit price produces no
  comparison data.

Candidate behavior:

- A candidate with no recognized or trusted quantity cannot produce a unit
  price and is removed from the pool.
- A candidate that normalizes to a different unit dimension is also removed.
- The engine never substitutes package price, guesses a size, or compares
  unlike units.

Therefore, in the question's example, a brochure product without a recognized
size is **rejected as a candidate for that check**.

## 7. Effective purchase price

There is no field-name precedence in which `finalPrice` always beats
`memberPrice`, or similar. The actual implementation uses a staged process.

### 7.1 Eligible explicit prices

The engine collects positive numeric values from:

```text
finalPrice
checkoutPrice
couponPrice
memberPrice
salePrice
offerPrice
nowPrice
currentPrice
price
prices[]
priceCandidates[]
```

Array entries may include a role. Roles containing `old`, `was`, `list`,
`regular`, `rrp`, `mrp`, or `unit` are excluded. Advertised unit prices are
therefore evidence for neither checkout total nor package price.

### 7.2 Exact selection and transformation order

1. Select the **lowest eligible explicit price**. Field scan order does not
   break price ties in a meaningful way and does not override the minimum.
2. Convert promotion terms into the required transaction total:
   - `N for PRICE` uses the advertised total;
   - `Buy X Get Y` or `X+Y` multiplies the selected package price by `X`.
3. Apply a coupon:
   - a valid fixed amount is preferred;
   - otherwise a valid percentage is applied.
4. If the selected explicit value is already labelled as a coupon price, do
   not apply the structured coupon again.
5. Round the effective purchase price to two decimal places.

This means the conceptual priority is:

```text
lowest eligible explicit payable price
→ required bundle/paid quantity
→ additional coupon
→ rounded checkout total
```

Member and coupon prices are eligible values, not hard-coded ranks. The lowest
eligible one wins. Old/list/regular and advertised unit-price roles never win.

Examples:

| Inputs | Effective purchase price |
|---|---:|
| regular 30, sale 27, member 25 | 25 |
| price 30, coupon amount 5 | 25 |
| price 30, coupon 10% | 27 |
| couponPrice 25 plus duplicate couponAmount 5 | 25 |
| 2 for 40 plus 10% coupon | 36 |
| 10 each, Buy 2 Get 1 Free | 20 |
| was 30, now 22 | 22 |
| package 35 plus advertised unit price 2 | 35 |

Quantity normalization uses the number received, while effective purchase
price uses the amount that must be paid. This is what makes bundle and BOGO
unit prices correct.

## 8. Candidate selection strategy

The window is 50, but the meaning differs by source.

### 8.1 Online providers

For each provider:

1. the connector tries provider strategies in declared order;
2. the first strategy returning results wins;
3. the connector returns the **first 50 results in that strategy's order**;
4. Price Watch does not rerank beyond that window before attribute filtering.

Therefore, online candidates are not the globally best 50 according to the
Price Watch matcher. They are the provider strategy's first 50.

### 8.2 Flyer offers

The flyer database first requires every query token to appear through one of
its bilingual synonym variants. It then ranks the retrieval window by:

1. summed token boundary quality:
   - whole word = 2;
   - word start = 1;
   - substring only = 0;
2. lower stored package price within the same boundary score.

The top 50 from that SQL ordering are returned. JavaScript then requires a
name-tier match and applies Price Watch attributes.

### 8.3 Ranking after retrieval

All surviving online and flyer candidates enter the shared journey resolver:

1. retain only the best search-stage band present;
2. enforce target family;
3. enforce target type;
4. enforce fresh-produce intent where applicable;
5. select the lowest package or unit comparison price.

For multiword identity queries, full-coverage stages 2–5 share the same band so
word order does not hide a cheaper valid product. For single-word queries,
exact/primary placement receives stronger separation.

The 50-item cap happens before Price Watch attribute filtering. A legitimate
candidate below an online provider's first 50, or below the flyer SQL top 50,
cannot be recovered later.

## 9. Close Price threshold

Let:

```text
T = target comparison price
P = best current comparison price
C = close threshold percentage
close boundary = T × (1 + C / 100)
```

Classification is inclusive, with a small floating-point epsilon:

```text
P <= T                         → target reached (green)
T < P <= close boundary        → close to target (yellow)
P > close boundary             → above target (no alert)
```

For target `20 SAR` and threshold `10%`, the close boundary is exactly
`22 SAR`:

| Current comparison price | Result |
|---:|---|
| 22.00 | Yellow — Close Price |
| 21.99 | Yellow — Close Price |
| 20.01 | Yellow — Close Price |
| 20.00 | Green — Target Reached |
| 19.99 | Green — Target Reached |

When Size is disabled, `T` and `P` are unit prices. When Size is enabled, they
are effective package purchase prices.

Alerts are edge-triggered:

- entering the yellow zone from above/unarmed emits one close alert;
- remaining yellow does not repeat it;
- entering green emits a target alert, including after yellow;
- rising from green into yellow does not emit a lower-severity close alert;
- returning above both zones rearms the watch.

Changing matching settings resets both crossing-state flags because the
candidate pool may have changed.

## 10. Category-watch examples

### Chicken Breast across brands and sizes

Reference:

```text
Sadia Chicken Breast 900 g
target package price = 20 SAR
Brand = off
Size = off
Variant = off
```

Stored target:

```text
20 × 1,000 / 900 = 22.2222 SAR/kg
```

Candidate:

```text
Americana Chicken Breast 1 kg for 22 SAR
= 22 SAR/kg
```

It matches Product Identity (`chicken` + `breast`), ignores brand and variant,
uses unit price, and reaches the target.

These do not match:

- Chicken Nuggets — type differs.
- Beef Breast — family differs.
- Chicken Breast with no readable size — cannot be normalized.
- Chicken Breast counted only as pieces — comparison unit differs.

### Pepsi across variants

Reference `Pepsi Zero 1 L` has family `soda` and variant `zero`.

- Strict defaults: same soda family, Pepsi brand, same size, and `zero` variant.
- Variant off only: other Pepsi variants of the same size may match.
- Brand + Size + Variant off: any recognized soda with a compatible volume
  unit may match, compared in `SAR/L`.

### Twix and Snickers regression

Both names map to the broad `chocolate` family. In strict mode, canonical brand
matching keeps Twix and Snickers separate. With Brand disabled, they may
compete in a chocolate category watch if all other enabled gates pass. This is
intentional relaxed behavior, not a false positive.

## 11. Known limitations

1. **Finite Product Identity taxonomy.** Category breadth depends on curated
   family and type dictionaries. A known family with no recognized type can be
   broad: Dove Shampoo currently anchors to `care`, and Twix anchors to
   `chocolate`.
2. **Lexical fallback outside the taxonomy.** When no family is recognized,
   identity falls back to the size-stripped original query. Brand and variant
   words may remain in that query, so disabling those gates may not broaden an
   unknown-category watch as much as the UI implies. This is the main remaining
   architecture risk for category-watch coverage.
3. **Finite variant lexicon.** Unlisted descriptors produce no variant signal.
   Exact key equality is deterministic but not a complete semantic product
   model. New high-volume variants should be added with regression tests.
4. **No semantic variant synonym groups.** “Zero” and “Sugar Free” remain
   distinct. The engine does not decide that two marketing terms are
   nutritionally equivalent.
5. **Generic counted-unit label.** Rolls, tablets, capsules, sachets, and
   diapers normalize numerically per item but display as `SAR/Piece`. Only
   sheets currently retain a category-specific display unit.
6. **No unit-price fallback for missing quantity.** This is intentional for
   correctness, but it reduces recall when brochure extraction misses size.
7. **Pre-filter candidate cap.** Online provider order determines which first
   50 products can be evaluated. Flyer SQL ranking is stronger, but its cap is
   also before the full matcher.
8. **Promotion grammar is bounded.** The engine recognizes explicit price
   fields, `N for PRICE`, `Buy X Get Y`, `X+Y`, percent coupons, and amount
   coupons. Free-form promotions outside those patterns require extractor
   structure or a new parser rule.
9. **Eligibility is not personalized.** Member and coupon prices are treated as
   payable candidates when supplied. The engine does not know whether a user
   has membership, possesses a code, meets a cart minimum, or can stack offers.
10. **Ambiguous “final” source semantics.** If a provider labels a price as
    final but also supplies promotion terms, the engine assumes the explicit
    price is per represented package before the promotion unless the promotion
    itself supplies an `N for PRICE` total. Provider contracts should state
    whether a value is per item or per transaction.
11. **Currency is SAR-oriented.** Unit labels are hard-coded as SAR units and
    monitor fallbacks assume SAR.
12. **OCR and source quality remain upstream dependencies.** Effective price
    and size decisions can only be as accurate as the structured fields and
    promotion text returned by providers or brochure extraction.

## 12. Validation record

The pre-production review validated:

- strict defaults and missing-flag compatibility;
- Sadia Chicken Breast identity as `chicken + breast`;
- independent Brand, Size, and Variant gates;
- weight, volume, piece, roll, sheet, tablet, and capsule normalization;
- candidate rejection for missing or incompatible unit dimensions;
- Twix/Snickers canonical-brand separation;
- Dove Repair/Intensive Repair, Pepsi Zero/Sugar Free, and
  Snickers Original/Peanut Butter variant boundaries;
- member, sale, coupon, was/now, bundle, BOGO, and unit-price role handling;
- coupon application after bundle-total construction;
- protection against applying an already explicit coupon price twice;
- candidate window constant of 50;
- inclusive yellow/green threshold boundaries at 22.00 and 20.00;
- edge-triggered close and target alert state.

Automated regression coverage lives in `src/priceWatch.test.mjs` and storage/API
compatibility coverage lives in `src/storage/watchStoreV2.test.mjs` and
`src/watches.test.mjs`.

## 13. Catalog references are a cache, not an identity

Added 2026-07-28. Applies to `product` watches; `grocery` watches never held a
catalog ID, and `registry` watches hold a registry ID, which is identity.

### 13.1 The problem

A `product` watch was anchored to `provider` + `product_id`. Retailers rotate
those IDs on re-listing, supplier changes and catalog re-indexing — Panda alone
rotates the numeric prefix in front of a stable slug — and they also RECYCLE an
ID onto a different product. The old resolution treated the ID as identity,
with one narrow rescue (exact normalized name **and** an unchanged image or URL
slug). A retailer that rotated the ID and reworded the title at the same time
silently killed the watch: every later check reported `product not found in
current results`, forever, with no alert and no repair.

### 13.2 The anchor

A watch is anchored to the stable product identity the project already derives
for every offer:

    brand + normalized name (family/type) + normalized size + variant

stored per watch as `brand_id`, `identity_family` / `identity_type`,
`size_unit` / `size_total`, `variant_key`, and serialized into `identity_key`
(`priceWatch.identityKey`) for legibility and indexing. It comes from the
project's own lexicons, so it is retailer-independent by construction. **No
check ever rewrites it** — only the user, by creating a different watch.

`priceWatch.identityStrength` classifies the anchor:

| Strength | Condition | Re-anchoring rule |
| --- | --- | --- |
| `full` | brand **and** family/type **and** size all present | may re-anchor a watch on its own |
| `partial` | any of those missing | additionally needs independent proof: an unchanged image asset, URL slug, or exact name |

### 13.3 The cache

`product_id`, `link` and `image` are a *catalog reference*: where this identity
currently sits in one retailer's catalog. `catalog_checked_at` records when it
was last confirmed and `catalog_rebinds` counts how often the retailer moved
it. `storage/watchStore.refreshCatalogRef` is the only writer of those columns
— deliberately separate from `updateState` so the cache can never be confused
with the anchor or with the crossing state.

### 13.4 Resolution order (`monitor.resolveCatalogCandidate`)

1. Filter the provider's results to candidates that pass the **identity gate**
   (`matchesProductIdentity`: the section 3–4 attribute gates at strict
   settings, plus a veto when the candidate's *name* claims a different brand
   than its brand column does — a stale brand field never carries a look-alike).
2. **Cache hit** — a surviving candidate sits at the cached ID: use it. This is
   the common case and costs one comparison.
3. **Re-anchor** — the ID moved. From the same already-fetched results, prefer
   candidates corroborated by an unchanged image, slug or name; fall back to
   the bare identity match when the anchor is `full`. Exactly one distinct
   candidate ID must survive, or the check stays silent.
4. Persist the refreshed reference (`rebound`), then continue with the ordinary
   price, crossing and validation logic.

`validateNotificationObservation` re-verifies against the watch *as resolved*.
A refreshed ID cannot self-certify: `matchesProductWatch` requires the identity
first and only then accepts a reference as a locator.

### 13.5 Retrieval

`monitor.productSearchQueries` returns at most two queries: the watch's own
query, and — only when the first found nothing — the product's own name or the
bare identity terms, which survive a retailer rename. The second search is
issued on the miss path only.

### 13.6 Cost

Unchanged in the common case: one search per product watch per day, exactly as
before. Re-anchoring adds no network I/O (it re-scans the response already in
hand) and one `UPDATE` on the rare check where an ID actually moved. A total
retrieval failure costs one additional search. Grocery and registry evaluation
costs are untouched.

### 13.7 Registry watches

A registry ID is identity, but a merge relocates it. `evaluateRegistry` now
follows the tombstone chain across multiple hops (bounded at 8, cycle-safe)
instead of a single hop, and writes the surviving `pr_` ID back through the
same refresh path, so a chain of merges cannot strand a watch.

### 13.8 Guarantees

- A catalog ID change never breaks a watch when the identity is re-findable.
- A catalog ID match is never sufficient: a recycled ID cannot alert.
- Ambiguity is silence — two candidates that re-anchor equally produce no alert
  and no cache write.
- The anchor is never rewritten by a check; only the cache moves.

Regression coverage: `src/watchIdentity.test.mjs` (resolution, rebinding,
recycling, ambiguity, retrieval budget, registry merge chains) and the catalog
cache / migration-parity assertions in `src/storage/watchStoreV2.test.mjs`.
