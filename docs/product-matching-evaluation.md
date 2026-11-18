# Product matching evaluation

The deterministic matching engine (`packages/intelligence/src/matching`) decides whether two marketplace listings are the same sellable item. **Precision matters more than recall:** a wrong merge shows a user the price of a different variant. A missed merge only sends a pair to human review.

## Signal hierarchy (already implemented)

In order: GTIN/EAN/UPC → manufacturer part number → brand + model number → variant attributes (RAM, storage, colour, size, capacity, rating) → normalised title → fuzzy title.

An **optional semantic fallback** exists (`matchers/semantic-matcher.ts`): pgvector embeddings, consulted only when no stronger matcher found a candidate, with its score capped below the review boundary so it can only _suggest_ a review, never merge. The bundled embedder is a deterministic lexical-hash stand-in, not a learned model. Every decision carries a confidence and explainable reasons (per-attribute comparisons). Variant conflicts (different RAM, storage, generation, size, capacity or rating) are rejected or held. Ambiguous cases go to `ProductMatchReview` for an admin decision. Details: [MATCHING.md](MATCHING.md).

## Labelled dataset and results (measured 2026-11-18)

Dataset: `packages/intelligence/src/matching/test/labeled-pairs.ts`, with 46 hand-labelled pairs:

- 13 SAME_VARIANT;
- 7 SAME_PRODUCT (different variant);
- 26 DIFFERENT_PRODUCT.

Titles imitate Indian marketplace listings, and identifiers are synthetic test values. Gate: `accuracy.test.ts` (runs in `pnpm check`).

| Metric                                                    | Value                      |
| --------------------------------------------------------- | -------------------------- |
| Auto-merge precision (same variant)                       | **1.00** (no wrong merges) |
| Product-level false positives (different products merged) | **0**                      |
| Auto-merge recall (same variant)                          | **0.77** (10 of 13)        |
| Pairs sent to human review                                | 10                         |

### The three same-variant pairs not auto-merged

| Pair                                          | Why it goes to review                                                                                        | Decision                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| p01 Galaxy S25 "Navy" vs "Blue"               | Colour names share a family but differ; could be a different colourway                                       | **Keep:** by design, never merge on a colour-family guess |
| l01 HP Pavilion 15, same config, two wordings | Title-only evidence (no barcode or MPN) is below the auto-merge threshold, though the variants compare equal | **Keep for now**                                          |
| t05 "139 cm (55 inch)" vs "55 inch" TV        | Same: title-only evidence                                                                                    | **Keep for now**                                          |

**No matching change was made in Prompt 24.** Raising recall means auto-merging title-only matches, which trades away the one property that must hold (precision 1.0). Whether the review queue is a real burden is unknown until production shows its volume.

**Revisit when:**

1. production shows review volume and turnaround;
2. the labelled set has grown with real listing pairs (≥ 200, labelled from reviewed production matches) so the effect on precision can be measured.

## Recommended next steps (not implemented)

- Grow the labelled set from resolved `ProductMatchReview` decisions: each admin decision is a free, real label.
- Report precision and recall per category; laptops and TVs have more title variation than phones.
- Replace the lexical-hash stand-in with a learned embedding model only if review data shows missed candidates. It stays a review-only candidate generator either way.
