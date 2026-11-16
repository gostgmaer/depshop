# Global price tracking (Phase 5.1)

DealMind tracks **marketplace offers**, not users' alerts. Everyone shares the catalog, the offers, the price history and the tracking jobs; each user owns only their alerts, watchlists, notifications and preferences.

**If 1,000 users watch one offer, DealMind fetches it once per interval** and then evaluates all 1,000 alerts against that one observation. A DB test proves it: one marketplace call served 25 users' alerts.

## Pipeline

```
tracking-control (BullMQ job scheduler, every 60 s)
   └─ scheduleDueOffers ── claims due offers ──► price-refresh  (1 job per offer + due slot)
                                                   └─ processPriceRefresh ──► PriceCheck (+ PriceSnapshot)
                                                                         └─► alert-evaluation (1 job per check)
                                                                               └─ processAlertEvaluation ──► Notification + deliveries
                                                                                                     └─► notification-delivery (email)
tracking-control (hourly) ── runCleanup
any queue ── retries exhausted ──► dead-letter
```

| Spec item   | Where (`apps/worker/src/…`)                                                                                                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queues      | `queues/price-tracking.queue.ts`, `queues/alert-evaluation.queue.ts`, `queues/notification.queue.ts`. Contracts are in `@dealmind/queue` (`jobs.ts`) |
| Workers     | `workers/tracked-worker.ts` (shared reliability), `workers/tracking-workers.ts` (refresh, alerts, notifications, control)                            |
| Schedulers  | `schedulers/tracking.scheduler.ts`, `schedulers/cleanup.scheduler.ts`                                                                                |
| Processors  | `processors/price-refresh.processor.ts`, `processors/alert-evaluation.processor.ts`, `processors/notification.processor.ts`                          |
| Services    | `services/price-change.ts`, `services/alert-rules.ts`, `services/tracking-metrics.ts`                                                                |
| Policies    | `policies/tracking-policy.ts`                                                                                                                        |
| Tests       | `tests/tracking-logic.test.ts` (pure), `tests/tracking.db.test.ts` (PostgreSQL + Redis + BullMQ)                                                     |
| Entry point | `main.ts` (existing worker; `TRACKING_ENABLED` toggles everything)                                                                                   |

LangGraph is not involved: scheduling is BullMQ job schedulers (`upsertJobScheduler`, BullMQ 5).

## Which offers are tracked

The scheduler selects due offers where all of these hold:

- `trackingState` is `ACTIVE` or `MISSING` (never `EXPIRED`);
- `trackedUntil` is null or in the future;
- the source is `ACTIVE` and has `trackingEnabled`;
- the source's connector can look up a single listing (`productLookup` and `getProduct`), is registered, enabled and ready, and is not a mock in production;
- `nextCheckAt` is null or past.

Today that means **only the mock stores in development**. Flipkart's connector supports lookups but has no credentials. Amazon's Creators API connector has no single-listing lookup. Croma, Reliance Digital and Tata CLiQ have no authorized integration.

## Frequency

The demand tier comes from shared interest, not one user: **active alerts + watchlist entries** on the offer's variant.

| Tier   | When                             | Default interval (per source, editable) |
| ------ | -------------------------------- | --------------------------------------- |
| HIGH   | ≥ `TRACKING_HIGH_DEMAND_MIN` (3) | `trackingHighMinutes` = 30              |
| NORMAL | ≥ 1                              | `trackingNormalMinutes` = 180           |
| LOW    | 0                                | `trackingLowMinutes` = 720              |

- **Jitter:** the next check is due at the interval ±10%, so offers don't fall due together.
- **Failure backoff:** after a failure the interval doubles per consecutive failure, capped at 24 h.
- **Priority:** BullMQ priority follows the tier (1 / 5 / 10).
- **Configurable starting points:** these intervals are examples to tune per marketplace's permitted usage, not marketplace requirements. A database CHECK enforces 5 min – 7 days and high ≤ normal ≤ low.

## One refresh

1. **Load the offer.** If it's no longer trackable (source inactive, tracking off, expired, past `trackedUntil`), record `SKIPPED` and push it back.
2. **Skip the fetch if a search just observed it** (within the source's `cacheTtlSeconds`). That observation is current, so no request is spent.
3. **Look up the listing** through `ProductLookupExecutor` (`@dealmind/connectors`), which applies:
   - the per-source Redis rate limit, shared with interactive searches; tracking may use at most `TRACKING_SOURCE_SHARE` (50%) of it, so searches are never starved;
   - the circuit breaker, a per-attempt timeout with `AbortSignal`, and retries with full jitter;
   - strict Zod validation;
   - single-flight for identical concurrent lookups.
4. **Validate the observation:**
   - INR only, positive integer paise, MRP positive when stated, shipping ≥ 0;
   - **an `INDICATIVE` price is not an offer price**;
   - a **drop over 80% or a rise over 5× is held** (`INVALID` / `IMPLAUSIBLE_CHANGE`) until the next check confirms the same price.
5. **Detect the change against the stored offer:** `change = new − previous` (paise) and `changeBp = (new − previous) × 10000 / previous`, BigInt, truncated toward zero.
   - Outcomes: `PRICE_DECREASED`, `PRICE_INCREASED`, `OTHER_CHANGED` (stock, MRP or shipping), `UNCHANGED` or `REAPPEARED`.
6. **One transaction:**
   - **append** a `PriceSnapshot` when anything changed, or as a heartbeat when the last one is over 12 h old (keeps history coverage within the pricing engine's 48 h gap rule). Snapshots are never updated or deleted;
   - update the offer: price fields, stock, `offerConditions`, `observedAt`, state `ACTIVE`, `nextCheckAt`;
   - insert a `PriceCheck` (execution metadata: previous/new price and stock, change, snapshot, attempt, duration, error).
7. **Afterwards:** invalidate the product's catalog caches. Enqueue alert evaluation when something changed, or when an alert on the variant has never been evaluated (a new alert gets an answer on the next check).

**When the lookup doesn't succeed:**

| Lookup result  | What happens                                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOT_FOUND`    | The offer becomes `MISSING` and its last price is kept, **never zeroed**. After 7 days missing, cleanup makes it `EXPIRED`. Reappearing gives `REAPPEARED`, which triggers back-in-stock alerts |
| `INVALID`      | Recorded; the offer is not changed; backoff                                                                                                                                                     |
| `FAILED`       | Retried by BullMQ while retryable; the last attempt records `FAILED` and backs off                                                                                                              |
| `RATE_LIMITED` | The job is moved back to delayed **without using an attempt** (`DelayedError`); nothing is fetched past the budget                                                                              |

## Alerts (individual)

Alert types (`PriceAlert.type`), each with only its own parameters (CHECK constraints):

| Type             | Condition (delivered price = selling + shipping; offer must be in stock/limited)                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TARGET_PRICE`   | ≤ target ("target reached")                                                                                                                                                          |
| `PRICE_BELOW`    | < target ("falls below")                                                                                                                                                             |
| `PERCENT_DROP`   | Down ≥ N% from a baseline. The baseline is the current lowest fresh delivered price when created, or else the first observed price; never invented                                   |
| `HISTORICAL_LOW` | Below every earlier observation of that offer in the last 30/90/180/365 days. Needs ≥ 3 earlier observations spanning ≥ 7 days, otherwise `INSUFFICIENT_DATA`. Never called all-time |
| `PRICE_CHANGE`   | Any observed price change (optionally on one marketplace: the "preferred marketplace")                                                                                               |
| `BACK_IN_STOCK`  | Was out of stock or missing, now in stock/limited                                                                                                                                    |

**Re-notification:** level alerts (target, % drop, historical low) notify when met, then again **only if the price falls further**, and re-arm once the condition stops holding. A user isn't told "still below target" every hour.

**Per alert, one transaction:**

- `AlertEvaluation` is unique on `(alertId, checkId)`: a retried, duplicated or concurrent job never evaluates, or notifies, twice. Tested with two concurrent evaluations plus a retry: one notification.
- **Cooldown** (`cooldownMinutes`, default 24 h): the trigger claims it with a conditional `UPDATE … WHERE lastTriggeredAt <= now − cooldown`. Two marketplaces' checks seconds apart can't both notify; the second is recorded as `COOLDOWN`.
- **Preferences** (`UserPreference.notifyInApp` / `notifyEmail`):
  - both off: `SUPPRESSED`, nothing sent;
  - otherwise a `Notification` (the in-app record) plus per-channel `NotificationDelivery` rows (`IN_APP` SENT or SKIPPED, `EMAIL` PENDING or SKIPPED).
- **Ownership:** the notification's `userId` is the alert's. Paused alerts aren't evaluated.
- **History:** every evaluation (`TRIGGERED`, `NOT_MET`, `COOLDOWN`, `SUPPRESSED`, `INSUFFICIENT_DATA`) is stored with its reason. Users see it at `GET /api/v1/alerts/:id/evaluations` (owner only).

**Email** goes through the shared EasyDev notification service (`@easydev_org/notification-sdk`):

- **Templates:** `wishlistPriceDropAlertTemplate`, `cartItemPriceChangedTemplate`, `wishlistBackInStockTemplate`.
- **The idempotency key is the delivery id**, and only a `PENDING` delivery is ever sent.
- **No service configured:** the delivery becomes `SKIPPED`.
- **Exhausted retries:** `FAILED` and dead-lettered.
- **Lost enqueues:** cleanup re-enqueues `PENDING` deliveries older than 10 minutes.
- **Push** isn't available (recorded `SKIPPED`).

## Reliability

| Concern                 | Mechanism                                                                                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duplicate jobs          | Stable job id `price.<offerId>.<due minute>`. Atomic claim `UPDATE … RETURNING` with a 15-min lease. Redis `SET NX` marker per job id. Each prevented duplicate is counted. Tested with two concurrent scheduler ticks |
| Retries                 | Attempts 4 / 5 / 5 (refresh / alerts / delivery), custom `jitter` backoff = full jitter over `base × 2^(n−1)`, capped                                                                                                  |
| Idempotency             | Refresh: offer-level claim + history append. Alerts: unique evaluation per check + cooldown claim. Delivery: `PENDING` guard + provider idempotency key                                                                |
| Dead letters            | Exhausted or unrecoverable jobs go to the `dead-letter` queue (payload, reason, attempts). Deliveries are marked `FAILED`                                                                                              |
| Concurrency             | `PRICE_TRACKING_CONCURRENCY` (8), `ALERT_EVALUATION_CONCURRENCY` (4), `NOTIFICATION_CONCURRENCY` (4). Control queue concurrency 1                                                                                      |
| Per-source limits       | Redis limiter per source (shared with search) + tracking sub-budget                                                                                                                                                    |
| Isolation               | A failing marketplace fails only its own jobs. Tested: one source failing on every call while 8 offers on another updated                                                                                              |
| Timeouts                | Per-attempt connector timeout, a 60 s lookup cap per job, BullMQ lock 120 s                                                                                                                                            |
| Stalled jobs / restarts | `stalledInterval` 30 s, `maxStalledCount` 2: a job whose worker died is re-queued. The scheduler lease expiry makes a lost job's offer due again. Both tested                                                          |
| Shutdown                | `SIGTERM`/`SIGINT` close every worker gracefully (active jobs finish), then the queues                                                                                                                                 |
| Backpressure            | No more than `TRACKING_MAX_QUEUED` refresh jobs waiting. Overdue offers stay due and are taken most-overdue first                                                                                                      |

## Observability

- **Counters:** hourly Redis hashes (`<prefix>:tracking:metrics:<hour>`, kept 8 days) written by every worker process. Mirrored to OpenTelemetry (`dealmind.tracking.events`, and the histogram `dealmind.tracking.lookup_ms`); these are no-ops unless an SDK is configured.
  - Jobs: total, succeeded, failed, dead-lettered, rate-limited.
  - Prevented duplicates.
  - Price changes (decreases and increases), stock changes, snapshots created.
  - Offers missing, invalid observations, fresh skips.
  - Alerts evaluated and triggered, notifications created, deliveries sent and failed.
  - Scheduler enqueued and backpressure, queue delay.
  - Per-source lookup latency.
- **Spans:** `tracking.refresh`, `tracking.alerts`, `connector.lookup <source>`.
- **Logs:** structured Pino. Credentials, API keys and user contexts are redacted.
- **`GET /api/v1/admin/tracking?hours=24`** (ADMIN only):
  - queue counts per queue, worker counters, average queue delay;
  - per-source intervals and lookup latency;
  - offers by tracking state and due now;
  - checks, alert evaluations and deliveries by outcome;
  - the 20 most recent dead letters.

## Data model (migration `20261119100000_price_tracking`)

- **`ProductOffer`:** `trackingState` (ACTIVE / MISSING / EXPIRED), `lastCheckedAt`, `nextCheckAt` (indexed with the state), `consecutiveFailures`, `missingSince`.
- **`ShoppingSource`:** `trackingEnabled` and `trackingHigh/Normal/LowMinutes`.
- **`PriceCheck`:** one row per check; retention 30 days.
- **`PriceAlert`:**
  - new fields: `type`, `dropPercentBp`, `baselinePricePaise`, `historicalWindowDays`, `cooldownMinutes`, `lastEvaluatedAt`;
  - `targetPricePaise` is now nullable (required only for target types);
  - unique on `(user, variant, source, type)` with `NULLS NOT DISTINCT`.
- **`AlertEvaluation`:**
  - unique on `(alertId, checkId)`; retention 90 days;
  - its `checkId` is `SET NULL` when a check is pruned, so evaluation history outlives the 30-day checks.
- **`NotificationType`:** adds `PRICE_CHANGED`.
- **`PriceSnapshot`:** unchanged. Append-only and never pruned.

## Performance and cost analysis

**Request volume grows with offers, not users or alerts.**

- **Per-user scheduling (rejected):** 1,000 users each refreshing the same offer every 30 min = 48,000 marketplace calls/day for one offer.
- **Global tracking:** the same 1,000 users make the offer HIGH demand, so it gets 48 calls/day, **1,000× fewer**, and alert evaluation becomes database work.

**Worked example** (assumed mix, default intervals): 100,000 tracked offers.

| Tier          | Offers       | Checks/day each | Checks/day              |
| ------------- | ------------ | --------------- | ----------------------- |
| HIGH (30 min) | 2,000 (2%)   | 48              | 96,000                  |
| NORMAL (3 h)  | 18,000 (18%) | 8               | 144,000                 |
| LOW (12 h)    | 80,000 (80%) | 2               | 160,000                 |
| **Total**     | 100,000      | avg 4.0         | **400,000 (≈ 278/min)** |

**Capacity per source:**

- **Formula:** sustainable offers ≈ `rateLimitPerMinute × TRACKING_SOURCE_SHARE × 1440 / average checks per offer per day`.
- **Defaults:** 60/min × 0.5 = 30 lookups/min = 43,200/day, which supports **≈ 10,800 offers per source** at this mix.
- **Beyond that,** backpressure keeps the queue bounded and offers are checked later than their interval, most overdue and highest demand first. Requests never exceed the budget.
- **More capacity** means raising the source's permitted rate (if the marketplace allows), lengthening the LOW interval, or lowering demand thresholds.

**Savings built in:**

- One job per offer, with the claim and dedupe guards.
- A search observation within `cacheTtlSeconds` replaces a fetch.
- Single-flight for concurrent identical lookups.
- The circuit breaker stops calls to a failing source.
- Demand is computed with two grouped queries per scheduler tick, not per offer.
- The scheduler query uses the `(trackingState, nextCheckAt)` index.

**Database growth at 100k offers:**

- **`PriceCheck`:** about 400k rows/day, roughly 60 MB/day; 30-day retention keeps about 1.8 GB.
- **`PriceSnapshot`:** about 200k heartbeat rows/day plus one per change, kept permanently. Partition by month before it gets large.
- **`AlertEvaluation`:** grows only with changes × affected alerts; 90-day retention.

**Not measured:** throughput benchmarks of the worker against real PostgreSQL and Redis haven't been run for this phase. The figures above are calculated from the configuration, not measured.

## Limitations

- **No real marketplace is tracked yet.** It needs an authorized connector with single-listing lookup (Flipkart credentials; Amazon's Creators API has no lookup in this connector). In development the mock stores' fixture prices don't change on their own.
- **"Preferred marketplace" is the alert's `sourceId`.** `UserPreference.preferredSourceIds` isn't used for alerts.
- **There is no push channel.** In-app notifications are the `Notification` rows; email depends on the shared service, which was failing to deliver locally when last checked (see SHARED_SERVICES.md).
- **Circuit breaker state is per worker process,** while rate limits are shared across processes.
- **The demand tier counts users' interest in the variant,** not search traffic (no popularity data is collected).
- **The evaluation history is in the API;** the web shows it on the alerts page. Admin metrics have no web UI yet.
