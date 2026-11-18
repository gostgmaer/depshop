# Data quality and governance

Rules for the shared catalog, offers and price history, and what enforces them. **Status 2026-11-18:** the catalog holds only labelled mock data from development. There are no real offers to measure quality on.

## Provenance (implemented)

Every offer (`ProductOffer`) records:

- `sourceId` + `externalId` (unique per source), with `productUrl` / `canonicalUrl`;
- `observedAt` (when DealMind saw it), `sourceUpdatedAt` (when the marketplace says it changed, if stated), `firstSeenAt`, `lastCheckedAt`, `missingSince`;
- `matchMethod`, `matchConfidence` (bp) and `matchEvidence` (the explainable reasons from the matching engine);
- `currency` (INR only; anything else is rejected at the connector schema).

**Price history is append-only.** A database trigger rejects any `UPDATE` of a price snapshot (`PriceSnapshot_append_only`, migration `20261115100000_catalog_model`), so corrections are new rows and history is never silently rewritten. Deletion isn't blocked: snapshots are removed only when their offer is deleted (foreign-key cascade). No user action deletes shared offers (Prompt 22 deletion test).

## Checks: what exists and what's missing

| Problem                                                                                   | Detected today by                                                                                       | Gap                                                                                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Invalid prices (negative, fractional, zero MRP, selling > MRP without a stated exception) | Pricing engine rejects them (tested); DB checks reject negative prices and MRP                          | —                                                                                   |
| Currency inconsistencies                                                                  | Connector schema accepts only `INR`; mixed-source responses are `INVALID_RESPONSE`                      | —                                                                                   |
| Invalid URLs                                                                              | Connector schema URL validation; the redirect only follows the stored offer URL                         | —                                                                                   |
| Suspicious discounts (inflated MRP)                                                       | Genuine-discount verdict `NOT_GENUINE` when the "discount" equals the usual price (tested)              | No admin report listing them                                                        |
| Stale offers                                                                              | `missingSince`, `consecutiveFailures`; ranking excludes offers older than 24 h; UI labels "Not current" | No admin count per source                                                           |
| Incorrect variants and duplicate products                                                 | Matching engine (precision 1.0 on the labelled set); ambiguous pairs go to `ProductMatchReview`         | No periodic duplicate scan over existing products                                   |
| Missing product identifiers                                                               | Matching records the method used (`IDENTIFIER` vs. title-based)                                         | No report of title-only matched products                                            |
| Conflicting specifications across sources                                                 | —                                                                                                       | **Missing:** specs are stored per product; conflicts between sources aren't flagged |

## Review workflows

- **Matching:** Admin → products → match reviews (approve, reject, keep separate). Each decision is audit-logged and is a future labelled example ([product-matching-evaluation.md](product-matching-evaluation.md)).
- **Sources:** Admin → Sources (status, limits, tracking), audit-logged.
- **User feedback:** **not implemented.** The Prompt 24 brief proposes feedback (wrong match, wrong variant, incorrect price, …). Recommended design:
  - store it as reports linked to an offer or product, **never** applied automatically to product data;
  - an admin triages each one against the source;
  - the user id is kept only for abuse control and deleted with the account.

  Not built in this increment; see [post-launch-roadmap.md](post-launch-roadmap.md).

## Recommended next (in order)

1. An admin data-quality page with counts: stale offers per source, `NOT_GENUINE` discounts, title-only matches, offers failing tracking. All queries over existing columns.
2. A spec-conflict flag at import time (the same attribute with different values from two sources for the same variant), sent to the review queue.
3. A weekly duplicate scan over products with the matching engine, in review-only mode.
