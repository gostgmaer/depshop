# Lifecycle communications

Everything goes through the existing notification system ([NOTIFICATIONS.md](NOTIFICATIONS.md)) and the shared EasyDev notification service for e-mail.

## What exists (transactional, implemented and tested)

| Message                                                                   | Type                                                                                    | Status                                                      |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Account verification, password reset                                      | IAM e-mails (shared service)                                                            | Implemented (IAM)                                           |
| New sign-in, password changed (security)                                  | `NEW_SIGN_IN`, `PASSWORD_CHANGED`; always recorded in-app, never delayed by quiet hours | Implemented                                                 |
| Price drop, target reached, back in stock, alert expired                  | `PRICE_ALERTS` category                                                                 | Implemented; verified end to end in-app (Prompt 22 journey) |
| Search finished or failed (long searches)                                 | `SEARCH` category                                                                       | Implemented                                                 |
| Subscription activated, renewed, cancelled, ended; payment failed; refund | `BILLING` category                                                                      | Implemented; **not live** (payments not activated)          |

**Guarantees already in place:**

- one notification per event (dedupe key);
- one send per delivery (idempotency key);
- per-category channel preferences and quiet hours;
- consent re-checked **at send time**;
- signed one-click unsubscribe;
- retries with delivery tracking.

E-mail delivery itself is **unverified** until the notification service is configured (BLOCKED).

## What is not built

| Message                                 | Kind                                       | Recommendation                                                                                  |
| --------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Welcome e-mail                          | Transactional (sent once, on verification) | Build with onboarding. One message, no marketing                                                |
| First-search guidance                   | **Marketing-like:** needs opt-in           | Only with consent ↓                                                                             |
| Alert activation confirmation           | Transactional                              | Low value: the alert is visible in-app at creation. Skip unless users ask                       |
| Watchlist / price-drop summary (weekly) | User-requested digest                      | Build as an **opt-in** `DIGEST` preference; send only when something changed (no empty digests) |
| Renewal reminder                        | Transactional (billing)                    | With live billing                                                                               |

## Rules for anything promotional

1. A separate **`MARKETING`** notification category, **off by default**, opt-in only (an unticked box). Transactional and price-alert messages never depend on it.
2. Promotional e-mails carry the one-click unsubscribe (already built) and identify the sender.
3. Frequency cap: at most one promotional message per user per week. **Price alerts are never delayed or batched behind marketing.**
4. No promotional message without the legal review in [privacy-and-growth.md](privacy-and-growth.md).
