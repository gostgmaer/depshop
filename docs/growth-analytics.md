# Growth analytics

**Status 2026-11-18:** no growth data exists (not launched). The existing admin analytics ([product-analytics.md](product-analytics.md)) already cover registrations, searches, subscriptions and affiliate revenue. This page defines the **missing growth events** and the dashboard that will read them. Neither is built yet (RECOMMENDED); the events come first, because a dashboard without data proves nothing.

## Design rules

- **Aggregate counters, not a per-user clickstream.** An event increments a daily counter keyed by event name and a small set of non-identifying dimensions (page type, channel, variant). There is no user id, no IP, no query text and no product a specific user viewed.
- **First-time events** ("first search", "first alert") are derived from existing per-user tables, which stay private. Only the aggregate count leaves them.
- Admin-only routes (`requireAdmin`), and the same **k-anonymity floor** as popular queries for any breakdown that could single out a user.
- Bots and the smoke-test account excluded (user-agent filter; test-domain accounts).

## Events to add

| Event                        | Dimensions                                                                                                                                        | Feeds                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `landing_view`               | page type (`home`, `pricing`, `category`, …), channel (`organic`, `referral`, `direct`, `campaign`), from `utm_source` / referrer **domain** only | Acquisition                              |
| `registration`               | channel (as above, carried in a short-lived first-party cookie, never in the account)                                                             | Acquisition by channel                   |
| `product_view`               | page type                                                                                                                                         | Search → product-detail conversion       |
| `compare_view`               | —                                                                                                                                                 | Comparison usage                         |
| `notification_open`          | notification category                                                                                                                             | Return through price updates             |
| `buy_link_view` (impression) | source                                                                                                                                            | Affiliate CTR denominator                |
| `experiment_exposure`        | experiment key, variant                                                                                                                           | [experimentation.md](experimentation.md) |

**Derived without new events:**

- first searches (users whose first `Search` is in the period);
- successful searches;
- watchlists and alerts created;
- weekly/monthly returning users (`User.lastLoginAt`; it undercounts long sessions, see product-analytics);
- conversions and plan distribution;
- affiliate clicks and verified revenue.

## Dashboard sections (Admin → Analytics → Growth)

| Section     | Contents                                                                                                                  | Status                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Acquisition | visits by channel, registrations by channel, referral registrations                                                       | Needs `landing_view`, `registration`     |
| Activation  | first searches, successful searches, product views, watchlists, alerts                                                    | Partly derivable now                     |
| Retention   | weekly and monthly cohorts, notification opens                                                                            | Needs cohort query + `notification_open` |
| Revenue     | conversions, plan mix, affiliate CTR and verified revenue; revenue by channel only when attribution is reliable           | Mostly instrumented                      |
| SEO         | indexable page count (= sitemap URL count), sitemap health; organic performance from Search Console **only if connected** | After launch                             |

No number is shown without its period and source; missing data shows "not available", never zero.
