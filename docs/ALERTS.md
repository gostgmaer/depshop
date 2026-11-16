# Price alerts and watchlists (Phase 5.2)

**Ownership:**

- **Per user:** watchlists, watchlist items, price alerts, alert evaluations and notifications. Every query filters by the authenticated `userId`, composite foreign keys enforce it again in the database, and another user's record answers **404** (no existence leak).
- **Shared by everyone:** products, variants, offers and price history.
- **No per-user polling:** alerts never cause marketplace requests. They are evaluated after each global price check ([TRACKING.md](TRACKING.md)).

## Watchlists

- **Endpoints:** `GET/POST /watchlists`, `GET/PATCH/DELETE /watchlists/:id`, `POST /watchlists/:id/items`, `DELETE /watchlists/:id/items/:itemId`.
- **Duplicates refused (409):** two lists with the same name, or a variant already in the list.
- **Items are variant-specific:** a product with one variant has exactly one choice.
- **Each item shows:**
  - the **lowest delivered price** (selling + shipping) among fresh, in-stock offers of ACTIVE sources;
  - that offer's marketplace and the number of current offers;
  - **7-day movement:** compared with the lowest delivered price observed in the 24 hours before "7 days ago", from stored snapshots. It is `null` when nothing was observed then; never estimated.

## Alert conditions

| Type             | Condition (on an available offer, delivered price)                                         | Parameters                  |
| ---------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| `TARGET_PRICE`   | ≤ target ("target reached")                                                                | `targetPricePaise`          |
| `PRICE_BELOW`    | < target                                                                                   | `targetPricePaise`          |
| `PERCENT_DROP`   | ≥ N% below the start price                                                                 | `dropPercent` (1–90)        |
| `HISTORICAL_LOW` | Below every earlier observation in 30/90/180/365 days (≥ 3 observations over ≥ 7 days)     | `historicalWindowDays`      |
| `PRICE_DROP`     | Any decrease, optionally only on a preferred marketplace (`sourceId`) and only ≥ an amount | `minChangePaise` (optional) |
| `PRICE_CHANGE`   | Any increase or decrease, optionally ≥ an amount                                           | `minChangePaise` (optional) |
| `BACK_IN_STOCK`  | Out of stock or missing, then available                                                    | —                           |

Options common to all conditions:

- `sourceId`: the marketplace to watch, or any.
- `channels`: any of `IN_APP`, `EMAIL`, `PUSH` (browser, Phase 5.3). The user's preferences still apply.
- `cooldownMinutes`: default 24 h.
- `repeat`: default `false`, meaning one-shot.
- `expiresAt`: optional; future, ≤ 1 year.

Each type accepts only its own parameters (Zod, plus CHECK constraints in the database).

The **start price** is the current lowest delivered price when the alert is created, or `null` if there is none. It is the reference for `PERCENT_DROP` and for target-alert **progress**: `(start − current) / (start − target)`, clamped to 0–100%.

## Lifecycle

| Action (API)                       | Allowed from                             | Result                                                                                                              |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PATCH /alerts/:id`                | ACTIVE, PAUSED, TRIGGERED                | A changed condition or marketplace resets evaluation, so it can notify again                                        |
| `POST /alerts/:id/pause`           | ACTIVE (idempotent if PAUSED)            | PAUSED, not evaluated                                                                                               |
| `POST /alerts/:id/resume`          | PAUSED, TRIGGERED (idempotent if ACTIVE) | ACTIVE. From TRIGGERED it re-arms. Refused if the end date has passed; counts against the plan's active-alert limit |
| `POST /alerts/:id/cancel`          | ACTIVE, PAUSED, TRIGGERED (idempotent)   | CANCELLED (final, history kept)                                                                                     |
| `DELETE /alerts/:id`               | any                                      | Removes the alert and its evaluation history                                                                        |
| worker: condition met              | ACTIVE                                   | **One-shot:** TRIGGERED (stops). **`repeat`:** stays ACTIVE (cooldown applies). `triggerCount`+1                    |
| worker cleanup: `expiresAt` passed | ACTIVE, PAUSED, TRIGGERED                | EXPIRED (final) + an in-app "alert ended" notice                                                                    |

- **Invalid transitions answer 409.**
- **Status changes are conditional updates** (`WHERE status = <validated status>`), so a user action and a worker transition happening together can't overwrite each other.
- **The worker's trigger is atomic too:** a conditional `UPDATE … WHERE status = 'ACTIVE' AND cooldown elapsed`. Two concurrent checks can't both trigger a one-shot alert (tested).

**History:** `GET /alerts/:id/history` lists every evaluation with its outcome, reason, price and marketplace; `?outcome=TRIGGERED` gives previous triggers. `/evaluations` is an alias kept for 5.1 clients.

## Notifications

Alert events create user-owned `Notification` rows with per-channel `NotificationDelivery` rows. They are sent only on channels allowed by both the alert and the user's notification preferences. Delivery (DealMind email templates through the shared service, browser push) is described in [NOTIFICATIONS.md](NOTIFICATIONS.md).

| Event                                                       | Notification type                                        |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| Target reached                                              | `TARGET_PRICE_REACHED`                                   |
| Significant drop (% drop, historical low, marketplace drop) | `PRICE_DROP`                                             |
| Back in stock                                               | `BACK_IN_STOCK`                                          |
| Price change                                                | `PRICE_CHANGED`                                          |
| Alert expired                                               | `ALERT_EXPIRED` (in-app, email and push since Phase 5.3) |

## Data model

- **`20261120100000_alert_lifecycle_enums`:**
  - `AlertStatus` gains EXPIRED and CANCELLED;
  - `AlertType` gains PRICE_DROP;
  - `NotificationType` gains ALERT_EXPIRED.
  - It is a separate migration because PostgreSQL can't use a newly added enum value in the same transaction.
- **`20261120100100_alert_lifecycle`:**
  - adds `minChangePaise`, `repeat`, `expiresAt`, `channels` (1–3, NOT NULL), `triggerCount` and `cancelledAt`;
  - CHECKs: the minimum change only for PRICE_CHANGE/PRICE_DROP; `cancelledAt` set if and only if CANCELLED;
  - an index on `(status, expiresAt)`.
  - **Existing alerts are set to `repeat = true`,** keeping their Phase 5.1 behavior.

## Web

- **Alerts page:**
  - status tabs (Active, Paused, Triggered, Ended, Cancelled, All);
  - per alert: condition, current price and marketplace, progress bar (`role="progressbar"` with a text value) for target alerts, channels, repeat, cooldown, end date and trigger count;
  - history with a "Previous triggers" filter;
  - actions: pause, resume or "turn back on", edit (dialog), cancel, delete (confirmation).
- **Alert form** (create and edit): every condition with only its own fields, the optional minimum change, "marketplace to watch", channels (at least one), cooldown, "keep watching", and end date.
- **Product page:** create and edit alerts with the marketplace choice; tracking history.
- **Watchlist page:** product cards with the lowest delivered price, marketplace, offer count, 7-day movement (or why there is none), offers link, alert, remove and rename.

## Tests

- **Shared (2 new):** transitions, condition parameters.
- **API DB (6 new):**
  - watchlist create, rename (both duplicate cases), add, duplicate product, remove, price and movement (and none when unobserved);
  - lifecycle, including every invalid transition and idempotent repeats;
  - conditions and their parameters;
  - history and previous triggers;
  - **IDOR:** 12 endpoints called with another user's ids all return 404, and the owner's data is unchanged.
- **Worker DB (8 new):**
  - independent targets (₹30,000 and ₹28,000 at ₹29,500: only A is notified, and B's reason mentions only B);
  - one-shot then re-armed;
  - percentage drop;
  - preferred-marketplace drop with an amount;
  - change by an amount;
  - channels;
  - **concurrent checks against a one-shot alert:** one notification;
  - expiry once, with preferences.
- **Web (7 new):** current price and progress (accessible values), tab filter, re-arm, cancel, confirmed delete, edit payload, preferred-marketplace drop payload, at least one channel, watchlist prices, movement and rename.

## Limitations

- **Watchlist items are per variant;** "any variant of a product" isn't supported.
- **The E2E mock API returns no alerts,** so the axe scan of the alerts page covers the empty state; the alert cards are covered by Vitest.
