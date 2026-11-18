# Product analytics

**Production baseline (2026-11-18): none exists.** DealMind has never been deployed ([production-go-live.md](production-go-live.md): LAUNCH BLOCKED), so it has no users, no searches and no revenue. **Every production value below is "not available".** No number on this page comes from mock or test data.

This page is the inventory of what the system can measure once it runs: where each metric comes from, and which ones are missing.

## Privacy rules for analytics

- Aggregates only. Admin views never show one user's searches to another user.
- Popular and empty-result queries are shown only when at least `minUsers` different users searched them (k-anonymity, already enforced in `searchAnalyticsView`).
- No sensitive personal attributes are collected. Deleting an account removes the user's usage rows (`onDelete: Cascade`). Shared catalog and price history are kept: they aren't personal data.

## Metric inventory

**Status key:**

- **Instrumented:** recorded today, with a view or metric that reads it.
- **Derivable:** the data is stored, but no view computes the metric yet.
- **Missing:** not recorded anywhere.

| Metric                                       | Status        | Source                                                                                       | Production value                         |
| -------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Total users, suspended users                 | Instrumented  | Admin overview (`platform.users`)                                                            | not available                            |
| Monthly active users (30 d)                  | Instrumented  | `platform.activeUsers30d` (users who signed in within 30 days, from `User.lastLoginAt`)      | not available                            |
| Daily / weekly active users                  | **Derivable** | `User.lastLoginAt` (sign-ins only; a returning user with a live session is not counted)      | not available                            |
| New registrations (7 d, 30 d)                | Instrumented  | `platform.newUsers7d/30d`                                                                    | not available                            |
| Retention cohorts                            | **Missing**   | needs a cohort query                                                                         | not available                            |
| Search volume, per day                       | Instrumented  | Admin → Analytics (`searchAnalyticsView.daily`), `dealmind_searches_15m`                     | not available                            |
| Searches per user                            | **Derivable** | `UsageRecord(metric=SEARCH)`                                                                 | not available                            |
| Completion, partial and failure rates        | Instrumented  | `successRateBp`, `partialRateBp`, `byStatus`                                                 | not available                            |
| Search latency                               | Instrumented  | `averageDurationMs`, `dealmind_agent_run_duration_ms_15m`                                    | not available                            |
| Popular categories and queries (k-anonymous) | Instrumented  | `categories`, `popularQueries`, `emptyResultQueries`                                         | not available                            |
| Popular brands                               | **Missing**   | brands are in each search's filters; no aggregate                                            | not available                            |
| Product comparison usage                     | **Missing**   | compare requests aren't counted                                                              | not available                            |
| Watchlist creation                           | **Derivable** | `Watchlist.createdAt`                                                                        | not available                            |
| Price-alert creation                         | Instrumented  | `UsageRecord(ALERT_CREATED)`, `platform.activeAlerts`                                        | not available                            |
| Alert conversion (alert → triggered → click) | **Missing**   | triggers are stored; the click after a notification isn't linked                             | not available                            |
| Notification delivery rate                   | Instrumented  | `dealmind_notification_deliveries_15m{channel,status}`                                       | not available                            |
| Subscription conversion and churn            | Instrumented  | `subscriptionAnalyticsView.monthly` (activations, cancellations), `plans`                    | not available                            |
| Payment failures                             | Instrumented  | `paymentFailures30d`, `dealmind_payment_webhooks_15m`                                        | not available                            |
| Affiliate click-through rate                 | **Derivable** | clicks: `AffiliateClick`; impressions of buy links aren't counted, so there's no denominator | not available                            |
| Verified affiliate revenue                   | Instrumented  | `revenue.affiliate.confirmedCommissionPaise` (partner-reported only)                         | not available                            |
| Marketplace source coverage and health       | Instrumented  | Admin → Sources, `dealmind_source_up`, `dealmind_connector_requests`                         | not available (all real sources pending) |
| LLM tokens and estimated cost                | Instrumented  | `AgentRun.inputTokens/outputTokens`, `dealmind_llm_tokens_month`, Admin → AI models          | not available                            |
| Infrastructure cost                          | **Missing**   | outside the app (provider bills)                                                             | not available                            |

## Gaps worth closing before launch

These are cheap and privacy-safe. They're listed here, not built, because nothing yet shows which ones matter most:

1. Count compare-page requests (an aggregate counter, no user id), for "comparison usage".
2. Count buy-link impressions per source (an aggregate), to get a CTR denominator.
3. A weekly cohort query (signup week → active in week N) from the existing session data.
4. A brand aggregate over search filters, with the same k-anonymity floor as popular queries.

## How to establish the baseline after launch

Two weeks after full launch (handbook §Launch window), record each **Instrumented** metric here, with its date range and the query or view that produced it. Optimisation work in [post-launch-roadmap.md](post-launch-roadmap.md) is prioritised against those numbers, not before.
