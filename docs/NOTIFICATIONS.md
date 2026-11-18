# Notifications (Phase 5.3)

DealMind notifies each user over three independent channels: **in-app** (with live updates), **email** (DealMind's own templates, sent through the shared EasyDev notification service) and **browser push** (Web Push with VAPID).

**Rules this design enforces:**

- Every notification has a **verified event source**: a committed alert evaluation, an alert expiry, a finished search, or an IAM-confirmed account action. Nothing else can create one.
- Notifications are **user-owned**. Every query is scoped to the signed-in user; another user's notification or push subscription answers **404**. The SSE stream only carries the caller's own channel.
- **One channel's failure never blocks another.** Each channel has its own delivery row and job.
- **Preferences and consent are respected**, and re-checked when a delayed delivery is about to go out.
- **No duplicates.** One notification per user per event (a unique dedupe key); one send per delivery (the job id and the email idempotency key are the delivery id); push remembers which browsers already received it.
- **Security notices can't be silently suppressed**: they are always recorded in-app and never delayed by quiet hours.
- No tenants or organizations.

## Architecture

```
alert evaluation / alert expiry / search finished / account action
        │  same DB transaction as the source change (outbox)
        ▼
Notification (+ category, critical, sourceType/sourceId, dedupeKey, link)
NotificationDelivery × 3  — IN_APP: SENT|SKIPPED   EMAIL/PUSH: PENDING|SKIPPED (+ scheduledAt)
        │  after commit
        ├─► Redis publish  <prefix>:notifications:user:<id>  ──► API SSE /notifications/stream
        └─► BullMQ notification-delivery job per PENDING delivery (delayed until scheduledAt)
                 │
                 ▼  worker (independent of price tracking)
          EMAIL → render HTML + text → shared notification service (pre-rendered mode)
          PUSH  → render payload → web-push (aes128gcm, VAPID) → each active subscription
```

- **No email or push inside a tracking or alert transaction.** The transaction only writes the notification and its delivery rows; sending happens in the delivery worker.
- **Recovery:** the hourly cleanup re-enqueues EMAIL/PUSH deliveries still `PENDING` 10 minutes after they were due (for example, the enqueue was lost in a crash). Enqueueing is idempotent (job id `delivery.<id>`).
- **Package `@dealmind/notifications`:**

| Folder         | Contents                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `events/`      | Zod event schemas (`alert.triggered`, `alert.expired`, `search.finished`, `account.password_changed`, `account.new_sign_in`) |
| `core/`        | `buildNotification` (event → record, pure); `recordNotification` (outbox insert with `ON CONFLICT DO NOTHING` dedupe)        |
| `preferences/` | `resolveChannels` (global × category × alert channels, quiet hours, critical rules); signed unsubscribe tokens               |
| `templates/`   | `renderEmail` (HTML + text) and `renderPush`                                                                                 |
| `channels/`    | `EmailProvider` / `SharedServiceEmailProvider`; `PushProvider` / `WebPushProvider`                                           |
| `delivery/`    | `DeliveryError` (permanent / transient / gone) and safe error text                                                           |
| `queue/`       | Real-time signal channel and publisher                                                                                       |

## Notification types

| Type                                                                   | Category       | Source (`sourceType` / `sourceId`)         | Notes                                                                                                                                                          |
| ---------------------------------------------------------------------- | -------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TARGET_PRICE_REACHED`, `PRICE_DROP`, `BACK_IN_STOCK`, `PRICE_CHANGED` | `PRICE_ALERTS` | `ALERT_EVALUATION` / `<alertId>:<checkId>` | Text from the alert rule engine; prices from the observed check                                                                                                |
| `ALERT_EXPIRED`                                                        | `PRICE_ALERTS` | `ALERT_EXPIRY` / alert id                  | Now also emailed (DealMind template), following the alert's channels                                                                                           |
| `SEARCH_COMPLETED`, `SEARCH_FAILED`                                    | `SEARCH`       | `SEARCH` / search id                       | Only for searches that ran ≥ `SEARCH_NOTIFY_MIN_SECONDS` (20 s); never for cancelled ones or clarification questions                                           |
| `PASSWORD_CHANGED`                                                     | `ACCOUNT`      | `ACCOUNT` / audit log id                   | **Critical.** After the IAM confirmed the change                                                                                                               |
| `NEW_SIGN_IN`                                                          | `ACCOUNT`      | `ACCOUNT` / session id                     | **Critical.** A device (user agent) not seen on the account in 90 days; not on an account's first sign-in. Shows "Chrome on Android", never the raw user agent |

- **Account notices are not emailed by DealMind.** The IAM already emails password-changed and new-device alerts, so DealMind sending its own would duplicate them.
- **Billing events** (activated, renewed, payment failed, cancelled, ended, refund) are recorded by `packages/billing/src/subscriptions/sync.ts` from verified payment-service events (tested in `billing.db.test.ts`). **Not built:** weekly digests.

## Channel rules

A channel is used only if **all** of these allow it:

1. **Global switch:** `inAppEnabled`, `emailEnabled`, `pushEnabled`. Push is off until the user turns it on.
2. **The category's switch.**
3. **For alerts, the alert's own channels:** `IN_APP`, `EMAIL`, `PUSH`.
4. **Something to send to:** an email address, or an active push subscription.

If no channel is allowed, nothing is recorded; an alert evaluation is then recorded as `SUPPRESSED` with the reasons.

| Category       | Default (in-app / email / push) | Fixed                                    |
| -------------- | ------------------------------- | ---------------------------------------- |
| `PRICE_ALERTS` | on / on / on                    | —                                        |
| `SEARCH`       | on / **off** / **off**          | —                                        |
| `ACCOUNT`      | on / off / on                   | in-app always on; email always off (IAM) |

- **Critical (security) notices** ignore the in-app switches and are never delayed. Push still needs push turned on and a subscription.
- **Quiet hours** (`HH:MM`–`HH:MM` in the user's time zone; may wrap midnight) delay email and push until they end. They never drop a notification, and in-app is immediate.
- **Consent at send time:** a delivery that waited (quiet hours, retries) is re-checked against the current preferences and the alert's channels, and is `SKIPPED` "at send time" if they no longer allow it.

## Email

- **Templates:** `renderEmail` produces a responsive, table-based HTML email (inline styles, viewport meta, hidden preheader) and a plain-text version.
  - Branding: "DealMind AI" header.
  - The product, marketplace, price now (delivered), previous price and target, all formatted from integer paise as INR (`₹29,500`), plus the observation time in IST.
  - A call to action linking into the app.
  - For price emails, a note that prices change and should be confirmed on the marketplace.
  - **Every dynamic value is HTML-escaped.** Links are only `APP_URL` + the notification's relative path; `//host` and absolute URLs are refused (also by a DB CHECK).
- **Footer:** why the user got the email, a link to notification settings, and a one-click unsubscribe link for that category.
- **Unsubscribe:**
  - The link is a signed token: HMAC-SHA256 with `NOTIFICATION_TOKEN_SECRET`, naming the user and category, valid for 365 days, compared in constant time.
  - `/unsubscribe` asks for a click before calling `POST /api/v1/notifications/unsubscribe`, so link scanners that prefetch emails can't unsubscribe.
  - It turns off only that category's email.
  - Without the secret, the link goes to the settings page.
- **Provider:** `SharedServiceEmailProvider` sends `{to, subject, html, text, idempotencyKey: deliveryId, metadata}` through `@easydev_org/notification-sdk`.
  - **4xx (except 408/425/429) and client validation errors are permanent**: the delivery is marked `FAILED` and not retried.
  - Timeouts, 429 and 5xx are transient: retried with jittered backoff (5 attempts). The last failure marks the delivery `FAILED` and the job goes to the `dead-letter` queue.
  - **Email credentials stay in the shared service.** DealMind holds only its API key.

### Shared-service change (pre-rendered mode)

The shared notification service could only render its own built-in templates. With your approval, it gained an optional **pre-rendered mode**: `subject` + `html` (+ `text`) instead of `template`.

- **Limits:** `html` ≤ 500,000 characters and `text` ≤ 200,000 (DTO `MaxLength`). `subject` is required, and combining `html` with `template` is refused.
- **Storage:** content isn't stored in the email log (not in its schema).
- **Other products:** template sends are unchanged.

| Item              | State                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code              | `Backend/notification-service`, branch `feat/prerendered-email`: DTO, `EmailService`, 5 unit tests, `docs/api-reference.md`                                                        |
| Commit            | **Not committed** (left for review)                                                                                                                                                |
| Running container | **Not rebuilt.** The local container runs the old code, so DealMind emails sent to it are rejected (400) and recorded as `FAILED` until the service is redeployed with this change |

## Browser push

- **VAPID:** `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` come from the environment; generate them with `pnpm notifications:vapid`.
  - The API needs only the public key, served at `GET /api/v1/push/config`.
  - The worker needs all three, and refuses to start with a partial set.
- **Permission is asked only when the user clicks** "Turn on for this browser" in notification settings. It is never requested on page load.
- **Subscribing:** registers `/sw.js`, subscribes with the public key, then `POST /api/v1/push/subscribe` stores the endpoint and keys for the user.
  - HTTPS endpoints only (Zod and a DB CHECK).
  - At most 10 active subscriptions per user.
  - A browser profile's endpoint moves to whoever subscribes from it.
- **Unsubscribing:** "Turn off for this browser" revokes the subscription on the server, then in the browser.
- **Delivery:** the payload `{title, body, url (relative path), tag, type}` is encrypted (aes128gcm) for the subscription.
  - **404/410 from the push service expires the subscription.** Other 4xx count as a permanent failure for that subscription; 429/5xx/network errors retry, and only to subscriptions that haven't received it yet (`sentTo`).
  - **The service worker** shows the notification and, on click, focuses or opens the app at the same-origin relative path. It caches nothing.

## In-app and real time

| Endpoint                                            | Purpose                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /notifications?page&pageSize&unread&category`  | The caller's in-app notifications (in-app delivery `SENT`), newest first |
| `GET /notifications/unread-count`                   | Unread count                                                             |
| `PATCH /notifications/:id/read`                     | Mark read (`POST` kept for older clients)                                |
| `POST /notifications/read-all?category`             | Mark all (or one category) read                                          |
| `DELETE /notifications/:id`                         | Delete (with its delivery rows)                                          |
| `GET /notifications/stream`                         | SSE: `ready {unread}`, then `change {signal, unread}`                    |
| `GET`/`PATCH /users/me/notification-preferences`    | Preferences (partial updates; unknown keys rejected)                     |
| `GET /push/config`, `POST`/`DELETE /push/subscribe` | Web push                                                                 |
| `POST /notifications/unsubscribe`                   | One-click email unsubscribe (signed token, no session)                   |
| `GET /admin/notifications?hours`                    | Admin: delivery aggregates                                               |

- **The SSE stream** uses one Redis subscriber per API process, fanned out to that user's open streams. Limits: 5 streams per user, a 25 s heartbeat, and 30 minutes per stream (EventSource reconnects).
- **Signals carry ids only;** the browser re-fetches through the authenticated API. The unread badge also polls every 60 s, so a lost signal only delays it.

## Web

- **Notification center** (`/notifications`):
  - all/unread and category filters;
  - a security badge on critical notices;
  - opening a notice marks it read and navigates to its link;
  - delete, mark read, mark all read.
- **App shell:** live unread badge (SSE).
- **Settings** (`/settings/notifications`):
  - a channel × category matrix, with global switches and the locked account cells explained;
  - the browser-push card: state (unsupported / unavailable / blocked / off / on), turn on or off for this browser, number of subscribed browsers;
  - quiet hours with a time zone;
  - language: English (India) only, the only templates available.
- **Alert form:** a "Browser" channel next to in-app and email.
- **`/unsubscribe`:** public page with a confirm button.
- **`public/sw.js`:** the service worker.

## Observability

- **Worker counters** (Redis, hourly): `notifications_created`, `deliveries_sent{,_email,_push}`, `deliveries_failed{,_email,_push}`, `push_subscriptions_expired`; also shown in `GET /admin/tracking`.
- **`GET /admin/notifications`** returns aggregates only:
  - deliveries per channel and status;
  - overdue PENDING deliveries (outbox backlog);
  - the 10 most common failure reasons (short provider messages);
  - notifications per type;
  - push subscriptions active, expired and revoked.
- **Never logged or stored:** payloads, titles, addresses and user ids. Stored delivery errors are capped at 300 characters, with no content.
- **Redacted from worker logs:** `NOTIFICATION_TOKEN_SECRET`, `VAPID_PRIVATE_KEY` and `privateKey`.

## Configuration

| Variable                                                                     | Where                     | Purpose                               |
| ---------------------------------------------------------------------------- | ------------------------- | ------------------------------------- |
| `NOTIFICATION_SERVICE_URL`, `NOTIFICATION_API_KEY`, `NOTIFICATION_TENANT_ID` | API, worker               | Shared notification service           |
| `NOTIFICATION_TOKEN_SECRET` (≥ 32 chars)                                     | API + worker (same value) | Unsubscribe tokens                    |
| `VAPID_PUBLIC_KEY`                                                           | API, worker               | Web push                              |
| `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`                                         | worker                    | Web push signing                      |
| `APP_URL`                                                                    | worker                    | Base of email links                   |
| `SEARCH_NOTIFY_MIN_SECONDS` (20)                                             | worker                    | Minimum search duration that notifies |
| `NOTIFICATION_CONCURRENCY` (4)                                               | worker                    | Delivery worker concurrency           |

## Data model (`20261121100000_notification_system`)

- **`Notification` gains:**
  - `category`, `critical`, `sourceType`, `sourceId`, `dedupeKey` (unique per user) and `link`;
  - CHECKs: relative links only; non-empty source and dedupe key;
  - an index on `(userId, category, createdAt)`.
  - Existing rows are backfilled: category and source from their type, the evaluation id (or alert id) as source, `legacy:<id>` dedupe keys, and links from their product data.
- **`NotificationType` gains** `SEARCH_COMPLETED`, `SEARCH_FAILED`, `PASSWORD_CHANGED` and `NEW_SIGN_IN`.
- **`NotificationDelivery.sentTo`:** push subscriptions already delivered to.
- **`UserPreference` gains** `notifyPush`, `notificationCategories` (JSON object, validated by `categoryChannelsOf`), `quietHoursStart`/`quietHoursEnd` (both or neither, `HH:MM`, different; CHECK) and `timezone`. The language is the existing `locale`.
- **`PushSubscription`** (user-owned): `endpoint` (unique, HTTPS CHECK), keys, `userAgent`, `failureCount`, `lastSuccessAt`, `revokedAt` and `expiredAt`.

## Tests (actual results)

- **`@dealmind/notifications` unit tests (17):**
  - verified sources and dedupe keys; invalid events rejected;
  - channel resolution (global/category/alert; defaults; critical not suppressed or delayed; quiet hours, including across midnight);
  - unsubscribe tokens (forgery, other secret, expiry, short secret);
  - templates (escaping, INR, links, no external links, push length);
  - email provider error classification;
  - **web push: the encrypted payload is decrypted with the subscription's private key** (real aes128gcm + VAPID header), and 404/410/429/5xx classification.
- **Notification-service unit tests (5):** pre-rendered send, subject required, html + template refused, template still required otherwise, DTO size limit.
- **API DB tests (11 new):**
  - visibility, ordering, category filter, pagination and unread count;
  - read (PATCH and POST), read-all, delete;
  - **IDOR:** another user's ids give 404 and change nothing;
  - session required; concurrent duplicate events produce one notification;
  - preferences: defaults, merge, locked account cells, 7 invalid inputs;
  - unsubscribe: affects only that category and user; forged and expired tokens refused;
  - push: config, auth, refresh, HTTPS only, cross-user revoke refused, endpoint takeover, revoke;
  - password change: critical, in-app despite in-app off, no DealMind email, audit id as source;
  - new device: not on the first sign-in or the same device; "Chrome on Android"; push delivery enqueued;
  - SSE: `ready` with the unread count, then only the caller's changes;
  - admin aggregates: admin only, no contents.
- **Worker DB tests (11 new):**
  - email fails while push and in-app deliver;
  - transient retry with one send and the same idempotency key;
  - last attempt → FAILED and dead-lettered;
  - consent re-check at send time; no provider → skipped;
  - gone subscription expired, retry only to the remaining ones;
  - push off / all subscriptions gone;
  - quiet-hours delay (and critical not delayed);
  - outbox recovery by cleanup;
  - a real BullMQ run to the dead-letter queue;
  - search notices (long only, once, never cancelled ones).
- **Existing worker tests** were updated for the third delivery row and expiry email.
- **DB constraint tests (2 new):** relative links, per-user dedupe, HTTPS push endpoints, quiet hours (this caught a CHECK that let a single bound through; fixed).
- **Web tests (10 new):**
  - center: categories, security badge, filter, open → read + navigate, delete;
  - settings: matrix toggles, global switches disable categories, account cells locked;
  - quiet hours payload and validation;
  - push: unsupported message; **permission requested only on click**, then subscription stored and push enabled; VAPID key decoding;
  - unsubscribe only after a click; live stream updates the badge and refreshes lists; alert form browser channel.
- **E2E:** the axe scan (light/dark, desktop/mobile) covers `/notifications` with sample (labelled) items, `/settings/notifications` and `/unsubscribe`.

## Not verified / limitations

- **Real email delivery** wasn't observed: the local shared service runs the old code (see above), and earlier its SMTP transport was failing (SHARED_SERVICES.md).
- **Real push delivery to a browser push service** (FCM, Mozilla autopush) wasn't exercised; it needs a real browser and network. Encryption and VAPID signing are verified by decryption in tests; the browser flow is verified with mocked browser APIs.
- **The dev database** still needs the pending reset before the new migrations can be applied (requires your consent); the test databases run all migrations.
- **Templates are English (India) only.** Hindi (`hi-IN`, offered in profile preferences) falls back to English for notifications.
- **No List-Unsubscribe header:** the shared service doesn't support custom email headers.
- **No digests and no billing notifications** (no verified source yet).
