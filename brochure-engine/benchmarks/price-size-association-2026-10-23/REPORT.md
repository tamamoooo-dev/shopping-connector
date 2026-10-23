# Price-specific package sizes — 2026-10-23

The reported Tamimi offer `tamimi:central:d4d:99491418` served SAR 16.99 with
12 × 1 L and a derived SAR 1.415833/L. Visual inspection of its original crop
shows SAR 49.99 CASE beside 12 × 1 L and SAR 16.99 PACK. The smaller pack's
contents cannot be read reliably. Neither a count of pictured cartons nor a
ratio of prices establishes its contents.

## Behavior

- Retailer prices remain authoritative and unchanged. Vision prices select
  evidence; they cannot replace a commerce price.
- Each selected sale option owns its size. Missing, unmatched, ambiguous or
  stale price-specific size evidence cannot inherit the general caption's size
  through Vision validation, OCR fallback, identity building or serving.
- Source-local explicit PACK/CASE tickets with different current prices veto
  a contradictory legacy carton quantity, including a new option that copied
  that same carton size. This check supplies no new price, size or count.
- A separately bound smaller size remains valid. Selected sizes cannot absorb
  another option's sizes from the general caption. Unbound assorted sizes do
  not imply one common price for per-size unit comparisons.
- Rejected measured sizes are removed from served grocery captions; stored
  observations remain intact. Search, Browse and watch listings use the same
  quantity decision. Clients cannot reconstruct an explicitly withheld size.

For the reported offer the correct safe output is SAR 16.99, unknown package
size and no derived litre/item price, with `quantityReviewRequired: true` and
reason `different_package_prices`. Control offer `99491928` remains SAR 14.99
for 18 × 125 ml (SAR 6.662222/L).

## Validation and limits

`src/offers/priceSizeAssociation.test.mjs` covers the real source text, Arabic
digits, regular-price/savings rejection, selected and missing sizes,
contradictory package options, OCR/old-validation recovery, canonical identity,
different 500 ml/1 L prices, assorted-size refusals, watch projection and the
actual SQLite-backed Browse query/document path. Existing extraction, sale
count, title and size tests also run in the complete deployment test suite.
The frontend package projection test checks that a legacy caption cannot
reconstruct a withheld carton size in comparisons or product details.

An offline replay reused 1,131 saved Vision receipts across 17 stores, including
1,003 Panda offers. Of these, 91 have a numeric visual reference: before and
after both give 79 correct, 0 wrong and 12 withheld unit prices. There are 47
changed unit-price outputs overall; this does not constitute visual approval
of every changed output or every replayed receipt. The Tamimi live-row replay
additionally confirms the reported failure is withheld and the control stable.
Replay artifacts and the original crop are under the workspace directory
`multi-price-size-audit-2026-10-23/`.

No new model calls, commerce-price rewrites, database migrations or registry
reassignments were used. The frozen price-reader prompt/model are unchanged.
The enrichment prompt now explicitly requires price-specific size association;
its recorded SHA-256 is
`95dd69b2ea19f8e06f9875c35068292d97dd07faf35c6c058fca82aa362bacca`.
Client Browse caches are versioned to discard previously cached wrong quantities.
