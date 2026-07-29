# Production identity ownership

Quality scores are governed by [`QUALITY-SCORES.md`](QUALITY-SCORES.md). In particular,
Builder Score is never commercial identity evidence, and Commerce Score is diagnostic
commercial-completeness metadata rather than authority to mint, attach, or merge a
registry identity.

## Authoritative path

`Smart Extraction -> Identity Builder -> Product Registry -> pr_* Product ID`

Only Product Registry may return Known Product, Review, or New Product and only
Registry may mint a `pr_*` Product ID. Search, Compare, Watch, and registry-first
Price History consume Registry sightings. A Review verdict has no trusted
sighting until an operator acts through `/registry/review`.

## Transitional price-series key

`offers.identity` and the `price_identities` / `price_history` tables are a
legacy Browse and Price History analytics substrate. Their values are always
`ph_*` keys derived from OCR-era offer text. They are not Product IDs, are never
accepted as Registry input, never create Registry products or sightings, and
must never be exposed as `productId`.

They remain temporarily because Browse rails and the legacy Price History
fallback require uninterrupted historical series. New identity decisions and
new consumers must use Registry `pr_*` IDs. Removal is a later downstream
migration and is intentionally outside the extraction/Registry rollout.

## Conflict prevention

- `ph_*` keys may group price observations only; they cannot establish product
  identity or authorize a Registry match.
- `pr_*` IDs originate only from Registry storage and are the sole value used
  in the `productId` API field.
- Existing trusted Registry sightings are immutable during historical candidate
  staging. Re-resolution is allowed only for explicitly selected offers with no
  existing sighting.
- Review items remain in the verdict journal or the untrusted review band until
  the guarded operator workflow reassigns or splits them.

## Safe historical rollout

1. Apply the additive candidate-column migration before application code.
2. Stage candidates for an explicit offer-ID allowlist without clearing
   `mint_verdict`.
3. Preserve every offer that already has a `product_sightings` row; never
   re-resolve those rows automatically.
4. Activate only a small allowlisted cohort with no existing sighting, then run
   the normal Registry drain and inspect Known/Review/New results.
5. Before activation, retain the prior candidate/version/verdict values as the
   rollback snapshot. Rollback restores only rows that still have no sighting.
6. Selective Vision re-enrichment uses the same allowlist discipline and must
   snapshot the prior enrichment row. A trusted sighting is not removed or
   reassigned by re-enrichment because `product_sightings.offer_id` remains the
   idempotency boundary.
7. Expand cohorts only after false-merge, Review, and duplicate metrics pass.

No mass backfill, mass verdict reset, Registry token rebuild, or Product ID
rewrite is part of this rollout.
