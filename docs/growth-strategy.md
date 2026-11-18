# Growth strategy

**Baseline (2026-11-18): none.** DealMind is not launched ([production-go-live.md](production-go-live.md)): no visitors, registrations, searches or subscriptions exist. **No growth target is set here.** Targets are set only after two weeks of measured baseline, as the brief requires.

## Funnel and how each step is (or isn't) measured

| #   | Step                            | Event                                              | Measurable today?                                                                                      |
| --- | ------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 1   | Visitor discovers DealMind      | Organic or referral visit                          | **No:** no visit analytics; Search Console after launch                                                |
| 2   | Lands on a relevant page        | Landing page view                                  | **No:** no page-view analytics (only Traefik access logs, which have no paths by design)               |
| 3   | Understands the value           | — (qualitative)                                    | No                                                                                                     |
| 4   | Performs a search               | Search created                                     | **Yes:** `Search` rows, admin search analytics                                                         |
| 5   | Views useful results            | Search COMPLETED with results; product page opened | Partly: completion yes; product-detail visits **not recorded**                                         |
| 6   | Creates an account              | Registration                                       | **Yes:** `newUsers7d/30d`. **Search requires an account today**, so steps 4 and 6 are in reverse order |
| 7   | Saves products / creates alerts | Watchlist, alert created                           | **Yes:** derivable from `Watchlist`, `UsageRecord(ALERT_CREATED)`                                      |
| 8   | Returns through price updates   | Notification → visit                               | **No:** a notification click isn't linked to a visit                                                   |
| 9   | Subscribes                      | Paid activation                                    | **Yes:** `subscriptionAnalyticsView.monthly`                                                           |

Steps 4, 6, 7 and 9 are measurable now. Steps 1–2, 5 (product visits) and 8 need event tracking ([growth-analytics.md](growth-analytics.md)).

## The biggest structural constraint

**A visitor can't search without an account,** and every product page is behind sign-in. Today the funnel is "landing page → register → first search". Making a limited anonymous search possible is the largest likely activation lever, but it touches rate limits, abuse protection and LLM cost. It's a product decision to take with the first real numbers, not before.

## Priorities (by expected impact ÷ risk, once launched)

1. Technical SEO and an honest landing page: **done** ([seo-architecture.md](seo-architecture.md)).
2. Privacy-safe activation events: product-detail view, first search, notification-click-through ([growth-analytics.md](growth-analytics.md)).
3. Public discovery pages, once real catalog data exists ([programmatic-seo.md](programmatic-seo.md)).
4. Short onboarding ([onboarding-flow.md](onboarding-flow.md)).
5. Search suggestions from k-anonymous popular queries (data exists; UI after launch).
6. Referrals, lifecycle e-mails, editorial guides and experiments: each after the measured need and the legal review in [privacy-and-growth.md](privacy-and-growth.md).

## Status of Prompt 25 stages

| Stage                                    | Classification                                                                                                             |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1. Growth baseline and event definitions | Event definitions written ([growth-analytics.md](growth-analytics.md)); baseline **BLOCKED** (not launched)                |
| 2. Technical SEO and public landing page | **IMPLEMENTED AND VERIFIED** (unit, built-app HTTP in both modes, Playwright; real crawling BLOCKED until a domain exists) |
| 3. Product and category discovery pages  | **BLOCKED:** no trustworthy catalog data; policy written                                                                   |
| 4. Onboarding                            | **RECOMMENDED** (design ready)                                                                                             |
| 5. Search suggestions                    | **RECOMMENDED:** the static examples and catalog autocomplete already exist; popular searches need traffic                 |
| 6. Referrals                             | **RECOMMENDED** after legal review (design ready)                                                                          |
| 7. Lifecycle communications              | **RECOMMENDED:** transactional already built; marketing needs consent design and legal review                              |
| 8. Editorial workflow                    | **RECOMMENDED** (design ready)                                                                                             |
| 9. Growth dashboard                      | **RECOMMENDED** (needs step-2 events)                                                                                      |
| 10. Experimentation                      | **RECOMMENDED** (needs traffic for any test to reach significance)                                                         |
| 11. Performance, privacy, regression     | SEO privacy verified; Core Web Vitals **BLOCKED** (no real traffic or devices)                                             |
