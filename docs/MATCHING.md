# Product matching & deduplication (Phase 3.2)

The engine decides whether a marketplace listing is a product the shared
catalog already has (and which variant), a new variant of it, or a new
product. It also finds duplicate products, variants and offers. It is
deterministic TypeScript, independent of LangGraph and of any LLM.

**Design rule: prefer false negatives over dangerous false positives.** A
missed merge costs one more review item or a duplicate product, which can be
fixed later. A wrong merge shows a user the price of a different phone. So:

- title similarity alone never auto-merges;
- a conflicting critical attribute blocks a merge;
- anything uncertain goes to a **human** review queue;
- no LLM (and not the Python agent) can approve a merge.

The catalog is global and shared by every user; there is no tenant,
organization or per-user catalog anywhere in this engine.

Code: `packages/intelligence/src/matching/`

| Path                                                              | Role                                                                                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `normalizers/` (title, brand, model, specifications, identifiers) | Canonical keys. Builds on `@dealmind/catalog` normalization; adds a pg_trgm-compatible `trigramSimilarity`, processor/GPU/display/panel parsing and category profiles |
| `matchers/` (gtin, mpn, model, fuzzy, semantic, variant)          | Candidate retrieval via indexed lookups, plus variant placement                                                                                                       |
| `scoring/` (config, score)                                        | `scorePair` evidence, conflicts, thresholds and the decision                                                                                                          |
| `engine.ts`, `subject.ts`                                         | `MatchingEngine.matchListing` / `compareProducts`                                                                                                                     |
| `deduplication/` (importer, duplicates)                           | Transactional import, duplicate product, variant and offer detection, `mergeProducts`                                                                                 |
| `review/review-service.ts`                                        | Match records and the human-only review workflow                                                                                                                      |
| `service.ts`, `schemas/api.ts`                                    | Dry-run match API (single or batch) used by the internal endpoints                                                                                                    |
| `test/`, `bench/`                                                 | Labelled dataset, accuracy tests, DB tests, benchmark                                                                                                                 |

## Pipeline

1. **Normalize** the listing (`normalizeListing`): canonical brand, model key,
   MPN key, barcode forms, variant attributes (RAM, storage, capacity, colour,
   size), canonical offer URL.
2. **Pre-filter candidates** with indexed queries only (never all-vs-all):

   | Order | Matcher          | Query                                                                          | Index                                 |
   | ----- | ---------------- | ------------------------------------------------------------------------------ | ------------------------------------- |
   | 1     | GTIN/EAN/UPC     | every equivalent form (UPC-A ≡ 0+EAN-13 ≡ 00+GTIN-14) on variants and products | unique `gtin`/`ean`/`upc`             |
   | 2     | MPN              | normalized MPN on variants                                                     | `ProductVariant_mpn_idx`              |
   | 3     | Brand + model    | `fingerprint = brandKey:modelKey`                                              | unique `Product.fingerprint`          |
   | 4     | Normalized title | exact `normalizedName` within the brand                                        | btree                                 |
   | 5     | pg_trgm          | `normalizedName % $1` within the brand, ≥ 0.45 similarity, top 10              | GIN `Product_normalizedName_trgm_idx` |
   | 6     | Semantic         | optional, only when 1–5 found nothing reviewable; cosine ≥ 0.8, top 5          | HNSW on `matching.product_embeddings` |

   At most 25 candidates are scored.

3. **Score each candidate** (`scorePair`) and pick the best. If a second
   candidate would also auto-merge, the result goes to review instead.
4. **Place the variant** (`matchVariant`): same variant, a new variant of the
   product, or ambiguous (review).
5. **Decide** and **audit**: every decision is appended to
   `ProductMatchAudit`. The table is append-only (a trigger blocks UPDATE and
   DELETE).

### Evidence (base score, basis points 0–10000)

| Evidence                                                   | Base                       | Can auto-merge?               |
| ---------------------------------------------------------- | -------------------------- | ----------------------------- |
| Identifier (GTIN/EAN/UPC)                                  | 10000                      | yes                           |
| MPN                                                        | 9900                       | yes                           |
| Brand + model number                                       | 9600                       | yes                           |
| Exact normalized title, corroborated by an equal attribute | 9200                       | yes (HIGH)                    |
| Exact normalized title, nothing corroborating              | 8200                       | no, review                    |
| pg_trgm fuzzy title                                        | ≤ 8900 (5500 + sim × 3500) | **never** (capped below 9000) |
| Semantic similarity                                        | ≤ 8500                     | **never**                     |

`validateConfig` rejects any configuration where the fuzzy or semantic cap
reaches the auto-merge threshold.

### Guards (override evidence)

- **Different brand** → no match.
- **Critical product attribute differs** (hard conflict) → no match. If an
  identifier or MPN still says "same", it goes to review instead, because the
  data itself is inconsistent. Critical attributes depend on the category
  profile:

  | Profile   | Product-level (different value = different product) | Variant-level (different value = another variant) |
  | --------- | --------------------------------------------------- | ------------------------------------------------- |
  | phone     | connectivity, processor, model year                 | RAM, storage, capacity, colour                    |
  | laptop    | processor, GPU, display size, model year            | RAM, storage, capacity, colour                    |
  | tv        | display size, resolution, panel, model year         | colour                                            |
  | appliance | capacity (L/kg/ton), energy rating, model year      | colour                                            |
  | apparel   | none                                                | size, colour                                      |
  | default   | all of the above (strict)                           | all variant attributes                            |

  The profile comes from the category slug. Without one it is inferred only
  from unambiguous signals, otherwise the strict default applies.

- **Generation / line tokens** (`15` vs `16`, `S24` vs `S25`, `Pro`, `Max`,
  `Plus`, `Ultra`, `FE`, `5G`, …): differing on both sides → hard conflict,
  unless the model numbers are equal. Present on one side only → soft
  conflict: capped below auto-merge unless an identifier, MPN or model number
  pins the item.
- **Different model numbers** → hard conflict.
- **Critical attribute stated on one side only** (title-based evidence) →
  capped below auto-merge: it can't be verified.
- **Ambiguous variant** (colour family only, e.g. Navy vs Blue, or the listing
  doesn't state what the product's variants differ by) → review.

### Thresholds

| Score (bp) | Confidence | Decision                          |
| ---------- | ---------- | --------------------------------- |
| 9800–10000 | VERY_HIGH  | AUTO_MERGE                        |
| 9000–9799  | HIGH       | AUTO_MERGE                        |
| 7500–8999  | REVIEW     | MANUAL_REVIEW (human queue)       |
| < 7500     | LOW        | no merge (new product / no match) |

These are the spec's starting values; they are configurable
(`new MatchingEngine({ highBp, reviewBp, … })`, checked by `validateConfig`).
The audit stores confidence using the same configuration as the engine that
produced the score. The engine version (`match-v2.0`) is recorded on every
audit row, so decisions can be re-evaluated after tuning.

## Result shape

`POST /internal/v1/intelligence/match` returns (and the audit stores):

```jsonc
{
  "matchId": "…",                 // ProductMatchAudit id
  "productA": { "label": "…", "brand": "…", "sourceId": "…", "externalId": "…" },
  "productB": { "id": "…", "label": "…", "brand": "…" },  // best candidate or null
  "score": 92.0, "scoreBp": 9200, "confidence": "HIGH",
  "decision": "AUTO_MERGE" | "MANUAL_REVIEW" | "NEW_PRODUCT",
  "method": "IDENTIFIER" | "MPN" | "MODEL_NUMBER" | "NORMALIZED_TITLE" | "FUZZY_TITLE" | "SEMANTIC" | "NEW_PRODUCT",
  "evidence": { "identifier": "…", "titleSimilarity": 0.81, "corroborated": true,
                "comparedAttributes": [ … ], "notes": [ … ] },
  "conflicts": [ { "attribute": "generation", "a": "pro", "b": null,
                   "level": "product", "severity": "soft" } ],
  "variant": { "relation": "SAME_VARIANT" | "NEW_VARIANT" | "AMBIGUOUS", … },
  "candidates": [ { "productId": "…", "label": "…", "score": 82.6, "decision": "MANUAL_REVIEW" } ],
  "reviewId": null                // set when a review was queued
}
```

## Deduplication

- **Import** (`CatalogImporter.importListings`): one transaction per listing,
  serialized per brand with an advisory lock, unique-violation retry. Products
  are created or enriched (empty fields only, never overwritten); variants are
  upserted by variant key; offers by `(sourceId, externalId)`.
- **Duplicate offers:** the same canonical URL from the same source under
  another external id is recorded as `DUPLICATE_OFFER`, and no second offer is
  created.
- **Duplicate products** (`findDuplicateProducts`): a bounded self-join (the 5
  most similar same-brand products per product, by trigram), scored with
  `compareProducts`. Pairs that score above NO_MATCH are **always** recorded as
  MANUAL_REVIEW, never merged automatically.
- **Duplicate variants / offers** (`findDuplicateVariants`, `findDuplicateOffers`):
  reports only.
- **Merging** (`mergeProducts`, only from an approved review): same-key
  variants are folded together, and offers, watchlist items and alerts are
  re-pointed (duplicates dropped). Empty identifiers are filled and the merged
  product is deleted, all in one transaction.

## Manual review: humans only

A MANUAL_REVIEW decision can be resolved once:

- listings: `match` (with `productId`, optional `variantId` / `newVariant`), `create` or `reject`;
- product pairs: `merge` (with `keepProductId`) or `reject`.

The resolution is appended as a `REVIEW_RESOLVED` audit row that names the
reviewer. A DB CHECK requires `reviewOfId` and `reviewer` on such rows.

Who may resolve:

1. `MatchReviewService.review` requires the reviewer to be an **ACTIVE user
   with the ADMIN role**.
2. Through the internal API it also requires a **reviewer context** header
   (`x-dealmind-reviewer-context`). This is an HMAC token over
   `{reviewerUserId, matchId, exp}`, signed with `REVIEW_CONTEXT_SECRET`. It is
   bound to one match and lives at most 15 minutes.

`REVIEW_CONTEXT_SECRET` is meant for the admin backend only and **must never
be given to the agent**. The agent holds only `INTERNAL_API_TOKEN`, which is
not enough to resolve a review (tested). If the secret is unset, reviews can't
be resolved through the internal API at all; the cookie-authenticated admin
API (`POST /api/v1/admin/catalog/match-reviews/:id/resolve`) still works for
listing reviews.

## Internal API (service token, `/internal/v1`)

| Endpoint                                | Notes                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /intelligence/match`              | `{ listing, sourceId? }`. Listing uses the catalog source-listing contract. **Dry run:** the catalog is not written. Appends an audit row (`origin: INTERNAL_API`). Queues a review when MANUAL_REVIEW and the source is ACTIVE, but never reopens a review a human already resolved |
| `POST /intelligence/match/batch`        | `{ items: [...] }`, 1–100 items. Identical requests are computed once (`deduplicated: true` on repeats)                                                                                                                                                                              |
| `GET /intelligence/matches/:id`         | The audit record with its review status and resolutions                                                                                                                                                                                                                              |
| `POST /intelligence/matches/:id/review` | `{ resolution, note? }`. Requires the reviewer context plus an ACTIVE ADMIN reviewer. 403 without them, 409 if already resolved, 422 for an invalid resolution                                                                                                                       |

The routes are not rate-limited per client: they are internal-only and never
routed by Traefik (see [AGENT.md](AGENT.md)).

### Python agent

`apps/agent/app/clients/intelligence_api.py`:

- `match(listing, source_id=None)` → `MatchResult`
- `match_batch(items)` → `list[MatchResult]`, chunked at 100
- `get_match(match_id)` → `MatchRecord`

Match calls are not retried, because each call appends an audit row. There is
deliberately **no review method**, and the agent has no reviewer secret.

## Accuracy (labelled dataset)

`src/matching/test/labeled-pairs.ts` holds 46 hand-labelled pairs:

- phones, laptops, TVs, appliances, fashion, audio and wearables;
- same variant, other variant, other generation or line, other size, capacity or rating;
- colour spelling and families, brand aliases;
- identical titles across brands.

`accuracy.test.ts` asserts:

- zero product-level false positives;
- every "different product" pair is rejected or held for review;
- identifier, MPN and model matches reach VERY_HIGH or HIGH;
- Navy vs Blue goes to review.

Current result (`match-v2.0`):

```json
{
  "pairs": 46,
  "autoSameVariantPrecision": 1,
  "autoSameVariantRecall": 0.769,
  "sentToReview": 10,
  "productLevelFalsePositives": 0
}
```

Recall is about 77%: the remaining same-item pairs go to review rather than
being merged automatically. That is the intended trade-off.

**Bugs this dataset exposed and fixed** (in the catalog normalizer):

- `S25+` normalized to `S25`;
- a lone `128 GB` was dropped, so 128 and 256 GB variants shared a key;
- a colour named only in the title wasn't in the variant key;
- colour spelling and word order (`Gray`/`Grey`, `Titanium Black`/`Black Titanium`) produced different keys.

## Benchmarks

`pnpm --filter @dealmind/intelligence bench:matching [-- --products N --probes M]`
(script: `src/matching/bench/run-bench.ts`).

It runs on **synthetic data** (fictional "Bench…" brands) in a disposable
`*_matching_bench_test` database, which it wipes and migrates. The setup
refuses non-`_test` or non-local databases.

Probes are an even mix of five kinds:

- identifier hit;
- model-number hit;
- re-worded title without identifiers;
- sibling line (`… Ultra`, must not merge);
- brand-new product.

Each same-item probe is checked against the **exact expected product and
variant**.

Measured on the development machine (Windows 11, PostgreSQL 17 in Docker
Desktop, Node 24):

| Catalog         | Import        | `matchListing` p50 / p95 / p99 | Batch (dry run + audit) | Duplicate scan (500) | Accuracy                                                                                                                                                    |
| --------------- | ------------- | ------------------------------ | ----------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2,000 products  | 35 listings/s | 8.2 / 10.3 / 12.2 ms           | 82 listings/s           | 1.4 s                | 240/240 same-item probes on the right product **and** variant; 0/160 false auto-merges; all 80 siblings → review                                            |
| 10,000 products | 26 listings/s | 29.1 / 33.5 / 38.9 ms          | 29 listings/s           | 3.4 s                | 283/300 same-item probes auto-merged, all on the right product **and** variant; 17 → review (see below); 0/200 false auto-merges; all 100 siblings → review |

Query plans (`EXPLAIN ANALYZE`, in the benchmark output):

- the identifier lookup is an index scan (< 0.1 ms);
- the trigram candidate query is a sequential scan: about 9 ms at 2,000 products and 31 ms at 10,000. The synthetic names share most trigrams, so `%` matches 6–10% of rows and the planner prefers a seq scan. That makes `matchListing` latency grow roughly linearly with catalog size on this data. Real catalogs have more varied titles, but this is unverified; see Limitations.

The 17 same-item probes sent to review at 10k are a property of the generator, and the review is the intended outcome. The generator has only 9,600 unique names, so 400 names repeat in the 10k catalog, each with a different model number (the importer correctly kept those as separate products). Exactly those probes (9 identifier, 8 re-worded) went to review:

- **Re-worded titles:** the title can't tell the twins apart, so review is correct.
- **Identifier probes:** the GTIN pins one product, but the twin with the identical title is also an auto-merge-grade candidate. The engine sends rival auto-merge candidates to review rather than picking one (conservative by design).

Model-number probes were unaffected (the model number pins the item).

## Limitations

- **No real marketplace data.** Thresholds were validated on a 46-pair
  hand-built dataset and synthetic benchmarks, not on real Amazon or Flipkart
  listings. They will need recalibration with real data and reviewer
  outcomes. The audit trail (engine version + evidence) is there for that.
- **Semantic matching uses a lexical hash embedder** (`LexicalHashEmbedder`,
  `lexical-hash-v1`), not a learned model. It is a pluggable
  `EmbeddingProvider` and is off unless an embedder is passed. It can only
  surface candidates for review (capped at 8500). It needs the `vector`
  extension; without it the engine skips it.
- **Candidate retrieval scales roughly linearly on near-identical titles** (29 ms p50 at 10k synthetic products, a seq scan). The brand filter in the trigram query is an expression, not an index.
  The GIN trigram index narrows first; a stored `brandKey` column would make
  brand-scoped scans cheaper at large scale.
- **Import throughput (35 listings/s at 2k, 26/s at 10k, single-threaded)** is bounded by one
  transaction and several candidate queries per listing. It is fine for
  connector-sized batches; bulk backfills would need parallel brands.
- **No review UI** yet. The admin API and internal API exist; the UI is Phase 10.
- **The reviewer context must be minted by an admin backend.** Only the
  signing helper (`signReviewerContext` in `@dealmind/queue`) exists; no
  admin UI or service issues it yet.
- **Spec parsing is regex-based** (processor, GPU, display, panel, resolution,
  capacity). Unrecognized formats become "not stated". On title-based
  evidence that caps the score below auto-merge, which is safe but lowers
  recall.
