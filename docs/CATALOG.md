# Product catalog (Phase 2.2)

The catalog is **global**: one copy shared by every user. Users never own,
copy or edit it, and there is no tenant, organization or membership concept
anywhere in it. User features (watchlists, alerts, searches) reference shared
variants and offers by id.

Code: `packages/catalog` (`@dealmind/catalog`: normalization, matching,
import, sample data, cache keys), `apps/api/src/modules/catalog` (read APIs),
`apps/api/src/modules/admin/admin-catalog-routes.ts` (review queue).

## Data model

| Model                | Purpose / notable fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Category`           | Tree via `parentId` (self-parent rejected by CHECK). `description`, `imageUrl`, `isActive` (inactive categories are hidden from browsing; their products remain).                                                                                                                                                                                                                                                                                                                                                   |
| `Product`            | `name`, `normalizedName` (matching key), canonical `brand`, `description`, `manufacturer`, `modelNumber`, `gtin`/`ean`/`upc` (unique when present, format CHECKs), `specifications` (JSONB object, source data only), `launchDate`, `imageUrl`, `isActive`, `fingerprint` = `brandKey:modelKey` (unique when present). GIN trigram indexes on `name` and `normalizedName`.                                                                                                                                          |
| `ProductVariant`     | `variantKey` (unique per product, e.g. `color=onyx-black\|ram_gb=8\|storage_gb=256`), `attributes` (JSONB, GIN `jsonb_path_ops`), `sku`, `gtin` (unique).                                                                                                                                                                                                                                                                                                                                                           |
| `ShoppingSource`     | `slug`, `name`, `domain`, `baseUrl`, `logoUrl`, `status` `ACTIVE`/`DISABLED`/`MAINTENANCE` (default `DISABLED`), `isSample`, tuning (timeouts, rate limit, retries), health.                                                                                                                                                                                                                                                                                                                                        |
| `ProductOffer`       | One listing per `(sourceId, externalId)` (unique, so no duplicate offers). `productId` plus composite FK `(variantId, productId)`, so an offer can't point at another product's variant. `productUrl` (http(s) only), original `title`, `sellerName`, `mrpPaise`/`sellingPricePaise`/`shippingPaise` (**BIGINT** paise), `stockStatus`, `currency` (`INR` only), `offerConditions`, `sourceUpdatedAt`, `observedAt`, `firstSeenAt`, `trackedUntil`, `matchMethod`, `matchConfidence` (0–10000 bp), `matchEvidence`. |
| `PriceSnapshot`      | Append-only history: `mrpPaise`, `sellingPricePaise`, `shippingPaise`, `stockStatus`, `observedAt`. A trigger (`PriceSnapshot_append_only`) rejects every UPDATE; corrections are new rows.                                                                                                                                                                                                                                                                                                                         |
| `ProductMatchReview` | Uncertain matches held for an admin: the validated listing, the candidate product, method, confidence and evidence. Unique per `(sourceId, externalId)`.                                                                                                                                                                                                                                                                                                                                                            |

Every `*Paise` column in the schema is now `BIGINT`. The API returns JSON
numbers through `paiseFromDb`, which throws rather than lose precision above
2^53.

Migration `20261115100000_catalog_model` is hand-written. Prisma's naive diff
would have dropped and re-created 15 renamed columns, so it uses `RENAME`, then
backfills the new required columns (`normalizedName`, source `domain`/`status`,
offer `productId`) and widens money columns in place. It was verified on a
scratch copy with data: values were preserved and the drift check is empty.

## Import pipeline (`CatalogImporter`)

For each listing from an **ACTIVE** source (anything else raises
`SourceNotActiveError`):

1. **Validate** with `sourceListingSchema` (strict Zod). Prices must be
   non-negative safe integers in paise and `currency` must be `INR`. URLs must
   be `http(s)`, and the `productUrl` host must be on the source's `domain`.
   Unknown keys are rejected. Invalid listings are reported per item and the
   rest still import.
2. **Normalize** (`normalizeListing`):
   - Brand aliases map to one canonical brand (`MI` → Xiaomi, `Samsung Electronics` → Samsung, `Hewlett-Packard` → HP; sub-brands like Redmi and POCO stay separate).
   - Model numbers are canonicalized (`SM-S921B/DS` → `SMS921BDS`).
   - Barcodes are check-digit validated and filed as GTIN-8/14, EAN-13 or UPC-A; invalid codes are dropped.
   - RAM and storage are parsed only from explicit patterns (`8GB RAM`, `8GB+128GB`, `1 TB SSD`). A lone "128 GB" is ambiguous and not assigned.
   - Appliance capacities (L, kg, ton) are parsed.
   - Colours: the published name is kept, plus a key and a coarse family (`Titanium Blue` → `blue`).
   - The display name drops variant descriptors, and `normalizedName` keeps the brand, line, generation tokens and qualifiers.
3. **Match** (`CatalogMatcher`), in priority order:
   1. Barcode on a variant or product, in any equivalent form (UPC-A ≡ `0`+EAN-13 ≡ `00`+GTIN-14). The exact variant is pinned.
   2. Brand + model-number fingerprint (confidence 9800).
   3. Brand + exact normalized name (confidence 9500).
   4. Brand + pg_trgm similarity of normalized names (confidence = similarity × 10000).

   **Guards that prevent wrong merges:**
   - Every token with a digit (`15`, `s24`, `55inch`, `2024`) and every line qualifier (`pro`, `max`, `plus`, `ultra`, `lite`, `mini`, `fe`, `5g`, …) is a discriminator.
   - If both sides have discriminators the other lacks (`iPhone 14` vs `15`), it's a different product.
   - A one-sided difference (`Nova 7` vs `Nova 7 Pro`) is always sent to review and never auto-merged.
   - A different model number is a different product.
   - A barcode hit on another brand goes to review.
   - RAM, storage, capacity and colour are variant attributes, so they produce separate variants of one product and are never merged into one variant.

   **Thresholds** (configurable `MatchThresholds`, validated `reviewBp ≤ autoMatchBp ≤ 10000`): auto-match at 9200 bp or more; review from 7500 bp up to (not including) 9200; fuzzy candidates are only considered at pg_trgm similarity 0.55 or more. Anything below the review threshold becomes a new product. Semantic/embedding similarity is not used yet.

   The method, confidence and evidence (identifier, fingerprint, similarity, conflicts, reason) are stored on the offer, or on the review.

4. **Write**, in one transaction per listing, serialized per brand with `pg_advisory_xact_lock` so concurrent imports can't create duplicate products. A unique-violation race is retried once.
   - Create the product (NEW) or fill only its still-empty fields (never overwrite).
   - Upsert the variant by `variantKey`.
   - Upsert the offer by `(sourceId, externalId)`.
   - Append a snapshot when the offer is new, when the price, MRP, shipping or stock changed, or when the last snapshot is older than 6 h (`snapshotRefreshMs`).

   An offer that is already matched keeps its product on re-import.

5. **Invalidate** the cache through `onProductsChanged(productIds)`. Use `invalidateProductCaches(redis, prefix, ids)` outside the API.

**Manual review:** `resolveReview(id, {action: "match", productId} | {action: "create"} | {action: "reject"})` replays the stored listing through the same write path. Admin API:

- `GET  /api/v1/admin/catalog/match-reviews?status=PENDING`
- `POST /api/v1/admin/catalog/match-reviews/:id/resolve` (ADMIN only, audited as `admin.catalog_match_review_resolved`)

## Read APIs (public, no account needed)

| Endpoint                                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/categories`, `/categories/tree`               | Active categories, flat or as a tree                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/v1/categories/:idOrSlug`                         | Breadcrumb, children, product count of the whole subtree                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /api/v1/products`                                     | `q`, `category` (includes descendants), `brand` (canonicalized like imports), `minPricePaise`/`maxPricePaise`, `launchedAfter`/`launchedBefore`, `inStock=true`, `spec=key:value` (repeatable; **one variant** must satisfy all, each on the variant's attributes or the product's specifications; numbers numeric, text case-insensitive), `sort` = `relevance`\|`newest`\|`price_asc`\|`price_desc`\|`name`, `page`/`pageSize` ≤ 100 |
| `GET /api/v1/products/:id`                                 | Details, variants, offer summary (`lowestPricePaise`, `offerCount`, `inStock`, `sampleData`)                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/v1/products/:id/variants`                        |                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /api/v1/products/:id/offers`                          | Active sources only, cheapest first. Fresh offers only unless `includeStale=true`; each offer has `isStale` and `source.isSample`                                                                                                                                                                                                                                                                                                      |
| `GET /api/v1/products/:id/history`                         | Append-only snapshots (`days` ≤ 365, `variantId`, `source`); `/price-history` is an alias                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/v1/sources`, `/sources/status`, `/sources/:slug` | Active sources, status of every source                                                                                                                                                                                                                                                                                                                                                                                                 |

All query strings are strict Zod schemas. Invalid input returns
`422 VALIDATION_ERROR` (the API's existing convention) and unknown products or
categories return `404 NOT_FOUND`.

**Freshness:**

- An offer not observed for `CATALOG_OFFER_STALE_HOURS` (default 24) is stale.
- Stale offers never count toward lowest price, offer count or "in stock", and are hidden from offer lists unless asked for.
- When they are shown, they are flagged and labeled as last-known, never as live.
- Offers from non-ACTIVE sources are never exposed.

## Caching (Redis, shared `…:cache:v1:catalog:*` keys)

| Data                           | TTL env (default)                   | Invalidation                              |
| ------------------------------ | ----------------------------------- | ----------------------------------------- |
| Category list (tree derived)   | `CATALOG_CATEGORY_TTL_SECONDS` 3600 | `invalidateCategories()`                  |
| Product detail (static fields) | `CATALOG_PRODUCT_TTL_SECONDS` 300   | `invalidateProducts(ids)` / importer hook |
| Offer summary and offer lists  | `CATALOG_OFFER_TTL_SECONDS` 60      | same                                      |
| Price history                  | `CATALOG_HISTORY_TTL_SECONDS` 300   | same                                      |

- The freshness cut-off for cached offer data is shifted by the offer TTL. As a result, a cached response can never include an offer older than the stale limit.
- `isStale` is recomputed on every read, never frozen into the cache.
- The product listing endpoint isn't cached; it's computed per request.
- Redis errors fall back to PostgreSQL (tested).
- A TTL of 0 disables that cache.

## Seed data

- `pnpm db:seed` (reference data, safe everywhere): plans, the 5 Indian marketplaces (**DISABLED**), and the category tree, 28 categories in all:
  - Electronics: Smartphones, Laptops, Tablets, Televisions, …
  - Fashion: Men's/Women's Clothing, Footwear, Watches
  - Home and Kitchen: Home Appliances (Refrigerators, Washing Machines, Air Conditioners), Kitchen Appliances, Furniture, Home Decor
  - Beauty and Personal Care, Sports and Fitness, Books, Grocery, Automotive

  The legacy slug `mobiles` is renamed in place to `smartphones`, so its products are kept.

- `pnpm --filter @dealmind/catalog build && pnpm --filter @dealmind/catalog seed:sample` loads **development sample data only** and refuses to run when `NODE_ENV=production`:
  - The store is the fictional "DealMind Sample Store" (`isSample = true`, `example.com` URLs). The products are 7 well-known models (iPhone 15, OnePlus 12, Galaxy S24, MacBook Air M2, iPad 10th gen, Sony WH-1000XM5, Levi's 511) with 13 variants.
  - Every price and MRP is **made up**. Specifications, model numbers, barcodes and launch dates are deliberately empty, because none came from an authoritative source.
  - Data is loaded through the real importer, and APIs flag it (`source.isSample`, `sampleData`).

## Query plans (EXPLAIN ANALYZE)

These were measured on a disposable database (`dealmind_explain_test`, since
dropped) with 50,000 products, 100,000 variants, 300,000 offers (3 sources, 2
of them active) and 600,000 snapshots. The data is synthetic and has
low-diversity names, so the trigram numbers are pessimistic.

| Query                                               | Plan                                                                              | Time       |
| --------------------------------------------------- | --------------------------------------------------------------------------------- | ---------- |
| Offers of one product                               | Bitmap index scan `ProductOffer_productId_sellingPricePaise_idx`                  | 0.5 ms     |
| Price history of one product (90 d)                 | `ProductOffer_productId_…` + `PriceSnapshot_offerId_observedAt_idx`               | 0.25 ms    |
| Product list, category filter, aggregate pass       | `Product_categoryId_isActive_idx`, but a seq scan aggregating all fresh offers    | 87 ms      |
| Same, **LATERAL** per-product offer summary         | Category index + 1,000 index lookups                                              | **23 ms**  |
| Whole catalog sorted by price, aggregate pass       | One hash aggregate over the offers                                                | **181 ms** |
| Same, LATERAL                                       | 50,000 index lookups                                                              | 1,102 ms   |
| Trigram `%` on a selective term                     | Bitmap index scan `Product_normalizedName_trgm_idx`                               | 5.9 ms     |
| Trigram `%` on a term shared by all synthetic names | Seq scan (the index matches all 50k rows; forced index scan is no faster, 184 ms) | 157 ms     |
| Spec filter on a selective value                    | Bitmap index scan `ProductVariant_attributes_gin_idx`                             | 0.06 ms    |
| Spec filter matching half the variants              | Seq scan (correct choice at that selectivity)                                     | 50 ms      |

The listing query therefore picks its plan: LATERAL when a selective filter
(category, brand, `q`, spec, launch date) is present, a single aggregate pass
otherwise.

## Limitations (honest status)

- **No live marketplace data.** No connectors exist yet (Phase 3), all real sources are DISABLED, and the only offers are labeled sample data. The worker completes searches with zero results and a `SKIPPED`/`NO_CONNECTOR` run per active source.
- **Barcodes are stored on variants.** The importer never sets product-level `gtin`/`ean`/`upc`, because marketplace barcodes identify a sellable variant. The product columns exist for curated data.
- **Deterministic matching only.** It's tuned on the cases in the tests, not on a real marketplace corpus; thresholds will need calibration once connectors provide data. There's no semantic (embedding) matching yet. Titles that write a model token differently (`Nova7` vs `Nova 7`) aren't merged automatically; they become separate products or go to review.
- **Product listing isn't cached.** At large scale, a denormalized offer summary maintained by the importer would replace the per-request aggregation.
- **Some writes skip cache invalidation.** Admin category and product edits don't exist yet; when they do, they must call `invalidateCategories()`/`invalidateProducts()`. Until then, out-of-band SQL edits show after the TTL (tested).
- **No admin UI for the review queue yet.** The API exists; the UI is Phase 10.
