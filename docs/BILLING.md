# Subscriptions, payments and usage (Phase 6.1)

**Status:** the billing system is built and tested against a sandbox provider. **Real Razorpay payments are not live.** There are no Razorpay test keys yet, the shared payment service isn't running locally, and its outbound-webhook change is on an uncommitted branch (see [Payment integration status](#payment-integration-status)).

**Rules:**

- Subscriptions belong to individual users. There is no tenant or organization billing.
- All money is integer paise (INR).
- A paid plan is granted only from the payment provider's verified state, read server-to-server; never from a browser callback.
- Usage limits are enforced atomically.
- Affiliate commissions (`AffiliateClick` / `AffiliateConversion`) are a separate ledger and don't touch subscription billing.

## Free launch offer (`LAUNCH_FREE_PLAN`)

While DealMind launches, it's free: set `LAUNCH_FREE_PLAN` (`FREE`, `PRO` or `BUSINESS`; the templates use `PRO`) on the API and the worker.

|                      | Behaviour                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Limits and features  | Every account gets that plan's limits and features at no cost, enforced server-side by `EntitlementService` like any plan. A higher paid plan (an existing subscriber) still applies |
| Buying               | Checkout is refused (409, "Paid plans are paused…"); no payment details are asked for. Existing paid subscriptions can still be managed and cancelled                                |
| UI                   | Pricing and billing pages show "Free during our launch" and no upgrade buttons; limit messages don't suggest upgrading                                                               |
| Public signal        | `GET /api/v1/billing/offer` → `{ freeLaunch: { planCode, planName }                                                                                                                  | null }` |
| Limits during launch | Edit the plan's limits in Admin (plan rows); no deploy needed. The LLM monthly token cap (Admin → AI models) still bounds AI cost                                                    |
| Ending it            | Remove the variable (or leave it empty) and restart the API and worker: normal plans, prices and checkout return. Nothing is deleted or migrated                                     |

Tested: `launch-offer.db.test.ts` (offer endpoint, Pro limits for a new account with nothing charged, checkout refused, no upgrade wording), web unit tests (billing and pricing pages in both modes), and the full billing suite still passes with the setting unset.

## Architecture

```
Browser ──POST /billing/checkout──▶ DealMind API ──/payments/initiate──▶ EasyDev payment service ──▶ Razorpay
   │  (plan + interval only)          (amount computed here)               (Razorpay keys live here)
   │◀── Razorpay Checkout (subscription_id, key id) ─────────────────────────────┘
   │── payment id + signature ──▶ /billing/checkout/:id/confirm ──▶ /payments/:tx/verify (signature check)
   │                                         │
   │                                         └─▶ SubscriptionSync: GET /subscriptions (authoritative) ─▶ local mirror
   │
EasyDev payment service ── signed webhook (thin event) ──▶ POST /webhooks/easydev-payments ─▶ SubscriptionSync
Worker (hourly) ── reconcile: re-read due / stale subscriptions, expire abandoned checkouts ─▶ SubscriptionSync
```

- **Payment service:** DealMind uses the shared EasyDev `payment-microservice` (your decision; see [SHARED_SERVICES.md](SHARED_SERVICES.md)). It owns the Razorpay integration: Razorpay plans and subscriptions, signature verification, renewals, dunning, cancel-at-period-end, plan changes, GST invoices and refunds.
- **DealMind's side:** it keeps a mirror of each user's subscription for fast entitlement checks, plus its own usage counters.
- **`@dealmind/billing` modules:**

| Folder           | What                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans/`         | The configurable catalogue: `SubscriptionPlan` rows read defensively, with a per-key fallback to `DEFAULT_PLANS`; and `provisionProviderPlans`    |
| `entitlements/`  | `effectivePlan` (grace-period policy) and `EntitlementService` (`checkEntitlement`, `requireFeature`, `consumeUsage`, `enforceGauge`, `getUsage`) |
| `usage/`         | IST day and month windows                                                                                                                         |
| `providers/`     | `BillingProvider` interface; `EasyDevPaymentsProvider` (shared service); `SandboxBillingProvider` (test double)                                   |
| `webhooks/`      | Signature verification (`t=…,v1=HMAC-SHA256(secret, "t.body")`, 5-minute tolerance, constant time) and the event schema                           |
| `subscriptions/` | `SubscriptionSync` (the only writer of the mirror) and `reconcileSubscriptions`                                                                   |

- **Payments and invoices** are read from the payment service, not copied, so its ledger stays the single source of truth. DealMind filters them to its own: payments whose plan is a DealMind plan, and invoices linked to those payments.

## Plans

Prices, limits and features live in `SubscriptionPlan` rows (admin-editable). `DEFAULT_PLANS` in `@dealmind/shared` is only the seed and the per-key fallback; nothing else hardcodes a limit.

|                                  | Free    | Pro                         | Business                    |
| -------------------------------- | ------- | --------------------------- | --------------------------- |
| Price (default)                  | ₹0      | ₹199 / month, ₹1,990 / year | ₹999 / month, ₹9,990 / year |
| AI searches / day (IST)          | 20      | 200                         | 2,000                       |
| Active price alerts              | 5       | 100                         | 1,000                       |
| Watchlists                       | 2       | 20                          | 200                         |
| Tracked products (bulk tracking) | 25      | 500                         | 10,000                      |
| Price history                    | 90 days | 365 days                    | everything stored           |
| Compare side by side             | 2       | 4                           | 4                           |
| CSV exports / month              | —       | 10                          | 200                         |
| Priority search processing       | —       | ✓                           | ✓                           |

- **Default prices** are DealMind's configurable list prices, not marketplace data. Taxes (GST) appear on the payment service's invoices.
- **Listed features are only the ones actually built.** Not built: analytics, reporting and API access.

### Enforcement

- **Searches:** `consumeUsage` runs inside the transaction that creates the search. It is one conditional upsert on `UsageCounter (user, metric, IST day)`: `… ON CONFLICT DO UPDATE … WHERE quantity + n <= limit`. Concurrent requests can't exceed the limit, and a rolled-back search doesn't use up a slot.
- **Exports:** the same mechanism per IST month. Exports also require the `exports` feature.
- **Active alerts, watchlists, tracked products:** `enforceGauge` takes a per-user transaction advisory lock, counts, then inserts in the same transaction. This covers alert creation and resume, watchlist creation, and adding watchlist items.
- **History and compare:** history depth is clamped to the plan (the response carries `planLimitDays`). Compare rejects more items than the plan allows (403 `PLAN_UPGRADE_REQUIRED`). Signed-out visitors get the FREE limits.
- **Priority:** search jobs are queued with BullMQ priority 1 on paid plans, 10 on free.
- **Errors:** an exceeded limit is 429 `USAGE_LIMIT_EXCEEDED` (with the reset time); a missing feature is 403 `PLAN_UPGRADE_REQUIRED`.

## Subscription lifecycle

The statuses are TRIALING, ACTIVE, PAST_DUE, CANCELLED, EXPIRED and PAUSED, the same as the payment service.

| Event (provider state)                   | DealMind                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Verified first payment                   | Mirror created, checkout SUCCEEDED, "plan active" notification                                                                                      |
| Renewal paid (period end advances)       | "Renewed" notification                                                                                                                              |
| Renewal failed → PAST_DUE                | Paid limits kept for `BILLING_GRACE_DAYS` (default 3) from the first PAST_DUE sighting, then FREE; "payment failed" notification with the grace end |
| Cancel requested                         | Cancels at period end: access continues, "will end" notification                                                                                    |
| CANCELLED / EXPIRED                      | FREE; "plan ended" notification                                                                                                                     |
| PAUSED                                   | FREE while paused                                                                                                                                   |
| Plan change                              | Applied by the payment service (its pricing rules for the switch); mirror updated                                                                   |
| Refund (`refund.updated`)                | Mirror re-read; "refund updated" notification; the payment shows its new status                                                                     |
| ACTIVE but period ended + grace, no sync | FREE (a lost webhook can't grant paid access indefinitely)                                                                                          |

- **Single writer:** `SubscriptionSync` takes a per-user advisory lock, reads the provider's subscriptions, picks the live one (else the newest ended one), and writes the mirror.
- **Per transition**, in the same transaction, it records a billing notification (outbox, category BILLING, always in-app) and an audit entry (`billing.subscription_synced`), and completes any pending checkout the provider now confirms.

## Checkout

1. `POST /billing/checkout {plan, interval}`:
   - the body is strict, so the client can't send an amount;
   - the server computes the amount from the plan and refuses if a paid subscription is live;
   - a repeated click resumes the same open checkout;
   - it creates a `CheckoutSession` (30-minute expiry) and calls `/payments/initiate`, which returns the Razorpay subscription id and public key id.
2. The browser opens Razorpay Checkout. Its success handler only forwards `razorpay_payment_id`, `razorpay_subscription_id` and `razorpay_signature` to `POST /billing/checkout/:id/confirm`.
3. The server checks that the subscription id belongs to this checkout and claims it (PENDING → VERIFYING, one confirmation at a time). The payment service then verifies the signature with Razorpay.
   - **Not verified:** FAILED, with the reason.
   - **Verified:** the server reads the provider's subscription. The checkout is SUCCEEDED once that subscription is visible; until then it stays VERIFYING and the UI polls.
   - **Provider unreachable:** back to PENDING so the confirmation can be retried.
4. **Double-payment guard:** while a payment verified in the last hour is VERIFYING, a new checkout is refused (409), and the UI hides "Try again".

**SANDBOX:** test mode for tests and local development only, refused in production. Checkouts are labelled "Sandbox checkout: test mode, no real money moves" and offer simulate-success / simulate-decline buttons, which go through the same verification and sync path.

## Webhooks

- **Endpoint:** `POST /webhooks/easydev-payments`. It sits outside `/api`, so the browser CSRF check doesn't apply; the HMAC signature is the authentication. The body is parsed raw so the signature covers the exact bytes.
- **Rejected with 401:** a missing, malformed, mismatched or stale (over 5 minutes) signature.
- **Ledger:** each event id is recorded once in `BillingEvent` (`provider`, `providerEventId` unique) with `processingStatus` RECEIVED, PROCESSED, IGNORED (unknown customer) or FAILED, plus attempts and error.
- **Duplicates:** an already PROCESSED or IGNORED event answers `{duplicate: true}`.
- **Failures:** answer 500 so the sender retries; FAILED events are reprocessed on retry.
- **Thin events:** the payload is only a trigger. DealMind re-reads the authoritative subscription with its service key, so replays or out-of-order events can't set a wrong state.

## API

| Endpoint                                                                                                         |                                                                               |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/v1/billing/plans`                                                                                      | Public. Prices, limits, features, purchasable intervals                       |
| `GET /api/v1/billing/subscription`                                                                               | Subscribed plan, effective plan, status, period, grace, provider              |
| `POST /api/v1/billing/checkout`, `GET /api/v1/billing/checkout/:id`, `POST /api/v1/billing/checkout/:id/confirm` | Checkout. Rate limit: 10 per minute                                           |
| `POST /api/v1/billing/cancel`                                                                                    | At period end. Idempotent                                                     |
| `POST /api/v1/billing/change-plan`                                                                               | Upgrade or downgrade; FREE means cancel at period end; refused while PAST_DUE |
| `GET /api/v1/billing/payments`, `GET /api/v1/billing/invoices`                                                   | The user's DealMind payments and invoices (from the payment service)          |
| `GET /api/v1/usage`                                                                                              | Usage against the effective plan                                              |
| `GET /api/v1/exports/{watchlists,alerts,searches}.csv`                                                           | Plan feature. Counted monthly. Formula-safe CSV                               |
| `POST /webhooks/easydev-payments`                                                                                | Payment service webhook                                                       |

Every record is scoped to the authenticated user; another user's checkout answers 404. Audit entries: `billing.checkout_started`, `billing.checkout_failed`, `billing.plan_change_requested`, `billing.subscription_synced`.

## Web

- **`/pricing`:** public plan comparison with a monthly/annual toggle and annual savings.
- **`/billing`:**
  - current plan with status, renewal or end date, grace and paused notices, and cancel (with confirmation);
  - usage meters;
  - plan cards with upgrade (checkout dialog) or switch (confirmation);
  - payments and invoices tables;
  - CSV exports when included.
- **Checkout dialog:** loads Razorpay Checkout (`checkout.razorpay.com/v1/checkout.js`) only when paying. It shows success only after the server confirms, and handles a closed window, a failed payment and retries.

## Data model (`20261122100000_billing`)

- **`SubscriptionStatus`:** CANCELED renamed to CANCELLED; TRIALING, EXPIRED and PAUSED added.
- **`Subscription`:** `providerRef` renamed to `providerSubscriptionId`. New columns: `interval`, `trialEnd`, `pastDueSince`, `cancelledAt`, `lastSyncedAt`. CHECK: a paid plan names its provider, subscription id and interval.
- **`SubscriptionPlan`:** new columns `description`, `annualPricePaise`, `features`, `sortOrder`, `providerPlanIds` (CHECKs on prices and JSON shapes).
- **New tables:**
  - `CheckoutSession` (user-owned; amount > 0; INR; paid plans only; unique provider order);
  - `UsageCounter` (PK user + metric + period start; quantity ≥ 0).
- **`BillingEvent`:**
  - new columns `eventType`, `processingStatus`, `processedAt`, `error`, `attempts`;
  - `userId` is now nullable (a verified event for an unknown customer is still recorded); the FK stays ON DELETE RESTRICT so financial records are retained;
  - CHECK: processed and ignored events have `processedAt`.
- **Enums:** `UsageMetric` gains EXPORT. Notification types gain SUBSCRIPTION_ACTIVATED, SUBSCRIPTION_RENEWED, PAYMENT_FAILED, SUBSCRIPTION_CANCELLED, SUBSCRIPTION_ENDED and REFUND_UPDATED. Category and source BILLING added.
- The migration was written by hand to preserve data; the drift check is empty.

## Configuration

| Variable                                                               | Where       |                                                                                             |
| ---------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `BILLING_PROVIDER`                                                     | API, worker | `none` (default), `easydev-payments`, `sandbox` (API only; refused in production)           |
| `PAYMENT_SERVICE_URL`, `PAYMENT_SERVICE_API_KEY`                       | API, worker | Shared payment service and its service key                                                  |
| `PAYMENT_TENANT_ID` (`easydev`), `PAYMENT_APPLICATION_ID` (`dealmind`) | API, worker | The payment service's tenant (a config constant) and DealMind's application id              |
| `PAYMENT_WEBHOOK_SECRET`                                               | API         | Same as the secret in the payment service's `OUTBOUND_WEBHOOK_TARGETS` entry for `dealmind` |
| `BILLING_GRACE_DAYS` (3)                                               | API, worker | Paid access kept after a failed renewal                                                     |

- **Provision plans** in the payment service with `pnpm --filter @dealmind/api billing:sync-plans`. It is idempotent; a changed price creates a new provider plan and existing subscribers keep theirs.
- **Payment service settings:** `OUTBOUND_WEBHOOK_TARGETS=[{"applicationId":"dealmind","url":"<API origin>/webhooks/easydev-payments","secret":"…"}]`, plus its own `RAZORPAY_*` keys with Subscriptions enabled on the Razorpay account.

## Payment integration status

| Item                                                                                | State                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Razorpay credentials                                                                | **None.** No test keys exist; Razorpay was never called                                                                                                                                                                                                                                                            |
| Shared payment service                                                              | Not running locally (no container)                                                                                                                                                                                                                                                                                 |
| Outbound webhooks (`Backend/payment-microservice`, branch `feat/outbound-webhooks`) | Outbox table and migration, signed delivery with retries/backoff/DEAD, `subscription.updated` from every status broadcast, `refund.updated` from Razorpay refund webhooks, Razorpay public `keyId` returned with the checkout option. 9 new unit tests; the full suite passes (139). **Uncommitted, not deployed** |
| DealMind ↔ service contract                                                         | The adapter is written to the service's documented and observed API (source read). Verified with a fake HTTP layer in unit tests, **not** against a running instance                                                                                                                                               |
| Razorpay Checkout in the browser                                                    | Tested with a mocked `window.Razorpay`; a real Checkout window wasn't opened                                                                                                                                                                                                                                       |

## Tests (actual results)

- **`@dealmind/billing` (10):** plan fallbacks and purchasable intervals; grace and lapse policy; live-subscription choice; IST windows; webhook signatures (valid, tampered, other secret, stale, missing, malformed); payment-service adapter (initiate headers and body, missing order/key, verify 2xx/4xx/5xx, DealMind-only subscription filter, string money).
- **API DB (18 new):**
  - plans; checkout (server amount, strict body, FREE refused, resume, Razorpay proof refused for sandbox, success, idempotent confirm, second checkout refused, audit, payments and invoices);
  - declined payment and recovery; checkout expiry;
  - webhooks: bad signature, stale timestamp, unsigned; one processing per event id; unknown customer;
  - renewal → failed renewal → grace → lapse → expiry, with notifications;
  - cancel at period end → ended; missed webhook caught by a provider re-read;
  - upgrade, downgrade, downgrade to FREE;
  - daily search limit from the editable plan and IST reset;
  - **concurrency:** 10 parallel searches with a limit of 3 → exactly 3; 8 parallel watchlists with a limit of 2 → exactly 2;
  - limits raised right after a verified payment;
  - cross-user checkout, payments, invoices and cancel; unauthenticated access;
  - refund; reconcile (due subscription, expired checkout, provider outage counted);
  - exports (feature gate, monthly limit, quoting, formula safety);
  - double-payment guard.
- **Existing tests updated:** search queue priority; history plan limit (Phase 4.3 test); preferences BILLING category.
- **Payment service (9 new):** target validation, signature, backoff, no-target skip, signed single delivery, retries to DEAD, concurrent claim, network error, publisher recording with Redis broadcast off.
- **Web (7 new):** server prices, annual saving and meters; sandbox checkout labelled, success only after the server confirms; Razorpay proof forwarded, failure shown with retry; cancel only after confirmation; grace notice and blocked switch; lapsed notice.
- **E2E:** the axe scan covers `/billing` and `/pricing` (light/dark, desktop/mobile).
- **DB schema tests:** new tables; BillingEvent's nullable, RESTRICT user FK.

## Not done / limitations

- **Refund initiation:** only handled when it happens (the webhook). The payment service only allows starting refunds with a user JWT, not DealMind's service key.
- **Proration:** a plan change follows the payment service's rules; DealMind doesn't compute proration.
- **Trials:** DealMind's plans have no trial (`trialDays: 0`); TRIALING is still honoured if the service reports it.
- **Not built:** analytics, reporting and API access (not listed in the plans).
- **Sandbox state** lives in the API process's memory (lost on restart), so the worker's reconcile job runs only with `easydev-payments`.
- **The local dev DB** still needs the pending reset before these migrations can be applied there.
