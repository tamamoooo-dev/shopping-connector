# Brochure image retention

The daily 03:00 UTC sweep deletes page images of noncurrent brochures more
than seven days after expiry, only when positive processing evidence remains.
Age alone and absence of offer rows never establish completion.

Every linked offer must have an accepted, published reading of its current
crop, a settled Registry assignment with a saved price sighting, and settled
verification. Review assignments and missing price history block deletion. Active recovery,
OCR or price fallback blocks deletion. The complete page and hotspot manifests
must account for every hotspot product through a processed offer or explicit
price rejection. Legacy/PDF editions without this proof retain their bytes.

Before deletion, the sweep writes the brochure metadata, geometry, offer
prices, extracted fields and processing decisions to `brochure-data/` in R2
and reads it back to verify its SHA-256 hash. Existing Vision evidence remains
in `vision-verification/attempts/`. Small manifests and brochure D1 rows remain;
only page image bytes are removed from both R2 and the KV fallback.

Failed archive verification stops deletion. A page deletion failure leaves
the row unpruned and the manifests intact for retry. Current brochures and
editions in the seven-day review window are preserved. A run processes at most
40 candidate editions and 750 image keys; offer/history retention is unchanged.
