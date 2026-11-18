# Programmatic SEO: public discovery pages

**Status 2026-11-18: not built. Blocked on trustworthy catalog data.** The catalog holds only labelled **mock** offers from development, and no real marketplace is authorized. Under the policy below every candidate page would be thin or fake, so building them now would only produce pages that must not be indexed. Today product and category pages exist only inside the signed-in app (noindex).

## Planned page types

| Path                 | Content                                                                                                  | Built from                |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------- |
| `/categories/[slug]` | Category intro, current offers with timestamps, filters as links (not indexable combinations)            | Catalog + offers          |
| `/brands/[slug]`     | Brand's products with offers                                                                             | Catalog                   |
| `/products/[slug]`   | Specs, every marketplace offer (attributed, with observed time), price history, genuine-discount verdict | Catalog, pricing engine   |
| `/deals/[category]`  | Offers whose discount is `GENUINE` per the pricing engine, sorted by the objective ranking               | Pricing + ranking engines |
| `/compare/[slug]`    | Variant-matched comparison of two products                                                               | Matching engine           |

These are public **server-rendered** routes, separate from the signed-in `/products/[id]` pages, using the public catalog API. Canonical: one URL per product or variant (slug), never per offer or filter.

## Indexability policy (a page is indexable only if every rule holds)

1. At least one **current** offer (observed within the freshness window, 24 h) from an **ACTIVE, non-sample** source. `isSample` sources (mock data) never make a page indexable.
2. Product identity is settled: no pending `ProductMatchReview` for it; variants are matched (an "unmatched variant" stays out).
3. Specifications shown come from marketplace data, not inferred.
4. **Categories and brands:** at least N indexable products (N set at launch from real coverage, e.g. 5).
5. **Deal pages:** at least one `GENUINE` discount; otherwise noindex.
6. Filter combinations, sort orders and pagination beyond page 1 are `noindex, follow` with a canonical to the base page.

A page that fails the policy is still served to users if useful, as `noindex`, and is left out of the sitemap.

## Stale and removed offers

- **Offer stale (> 24 h):** shown as "Not current" with its observed date; it doesn't count toward rule 1.
- **Every offer for a product gone (`missingSince`) for > 30 days:** the page stays (price history is useful) but becomes `noindex` and leaves the sitemap.
- **Product merged into another by a match review:** `308` to the surviving product's URL.
- **Never** a page that shows an old price as current, and never a price without its source and time.

## Sitemaps at scale

At more than 10,000 URLs, a sitemap index (`/sitemap.xml`) with partitions per type: `products-N.xml`, `categories.xml`, `brands.xml`. `lastmod` = the time the page's content (offers or specs) last changed, from data, never the generation time.

## Before building

- An authorized source returning real offers (BLOCKED).
- Real coverage numbers to set N in rule 4.
- An estimate of how many pages pass the policy. If it's a handful, build the category and product templates only.
