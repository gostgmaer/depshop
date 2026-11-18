# Privacy and growth

Growth features must not weaken the privacy and isolation guarantees already in place ([SECURITY_AUDIT.md](SECURITY_AUDIT.md), privacy notice at `/privacy`).

## Verified in this phase (Prompt 25)

| Guarantee                                                                                                                                                                   | Evidence                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No private page is indexable: dashboard, searches, products (signed-in), watchlists, alerts, notifications, history, billing, settings, admin, auth and one-time-link pages | `X-Robots-Tag: noindex, nofollow` on every private path (Playwright, 5 paths; unit test over the full list); noindex page metadata; robots.txt disallow; anonymous visitors are redirected to sign-in |
| Nothing is indexable before launch, including staging                                                                                                                       | Default robots `Disallow: /` and site-wide `noindex` (built-app HTTP test, Playwright); `check-env.sh` refuses `SEO_INDEXING=enabled` outside production                                              |
| Structured data exposes nothing personal or invented                                                                                                                        | WebSite + Organization only; unit-tested for no ratings, offers or actions; `<` escaped                                                                                                               |
| Public landing copy makes no unsupported claims                                                                                                                             | Playwright and unit checks against "every store", "all marketplaces", "guaranteed"                                                                                                                    |

## Rules for future growth features

| Area                             | Rule                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Analytics                        | Aggregate counters only; no per-user clickstream; k-anonymity for breakdowns; no query text outside the existing k-anonymous popular-query view                                |
| Popular searches and suggestions | Only queries searched by ≥ `minUsers` distinct users; a user's own recent searches are visible only to that user                                                               |
| Referral                         | Referrers see counts, never who joined; codes are random; the ledger is deleted with the account (or the referred account) except for fraud records kept for the stated period |
| Marketing                        | Separate opt-in category, off by default, one-click unsubscribe; transactional messages never conditional on it                                                                |
| Experiments                      | First-party random cookie or user id; no fingerprinting; no experiments on prices, rankings or consent                                                                         |
| Deletion                         | Every new per-user table cascades on account deletion (the Prompt 22 deletion test is the pattern to extend)                                                                   |
| Dark patterns                    | No fake urgency, scarcity, countdowns or pre-ticked consent; no confirm-shaming                                                                                                |

## Legal review required before activation

Before launching promotional e-mail, referrals or campaigns, have qualified counsel review them against applicable Indian law, including:

- the Digital Personal Data Protection Act, 2023 and its rules (consent, notice, purpose limitation);
- the Consumer Protection Act, 2019 and the guidelines on misleading advertisements and dark patterns;
- the Information Technology Act and its intermediary rules;
- TRAI rules on unsolicited commercial communication, if SMS or phone is ever used.

This is a requirement of the brief, not legal advice. It's tracked as a launch blocker for those features.
