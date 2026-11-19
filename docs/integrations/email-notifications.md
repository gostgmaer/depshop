# E-mail: shared notification service

**What it does:** sends DealMind's e-mails (price-drop alerts, search finished, digests,
billing notices). SMTP and templates' delivery are configured **in the notification service**,
not in DealMind. Verification and password-reset e-mails are sent by the IAM, not by this.

**What we use:** the shared EasyDev `notification-service`.

| Where              | URL                                                           |
| ------------------ | ------------------------------------------------------------- |
| Local (host)       | `http://127.0.0.1:4004`                                       |
| Local Docker stack | `http://host.docker.internal:4004` (set by the local compose) |
| Production         | From the platform team                                        |

## Settings (api and worker)

| Variable                                         | Value                                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `NOTIFICATION_SERVICE_URL`                       | The URL above. Empty = no e-mails (in-app notifications still work)                                         |
| `NOTIFICATION_API_KEY`                           | API key issued by the notification-service team                                                             |
| `NOTIFICATION_TENANT_ID`                         | `dealmind` (the service's own header)                                                                       |
| `NOTIFICATION_TOKEN_SECRET`                      | `openssl rand -hex 32`; signs one-click unsubscribe links. Rotating it breaks links in e-mails already sent |
| `NOTIFICATION_CONCURRENCY`                       | Worker tuning, default 5                                                                                    |
| `PRIVACY_OPERATOR_NAME`, `PRIVACY_CONTACT_EMAIL` | Required for production; shown in the privacy notice and e-mail footers                                     |

## Turn it on

1. Get the URL and API key from the notification-service team; generate the token secret.
2. Put them in `.env` / `.env.production`.
3. Recreate **api and worker** (the worker sends, the api queues and records preferences).
4. **Verify:**
   - `curl -s http://127.0.0.1:4000/health/ready` → `"optional":{"notifications":"ok"}`.
   - Admin → System health → **Shared notification service (email)** is OK.
   - With a test account: create a price alert or run a search with e-mail notifications on,
     and confirm the e-mail arrives and its unsubscribe link works.
   - Admin → Jobs: no failed notification jobs.

## Who gets e-mail

Only signed-in users who allowed that type of e-mail in Settings. Guests never get e-mail
or push (in-app only).

## Turn it off

Empty `NOTIFICATION_SERVICE_URL` and recreate api + worker. Queued e-mails are not sent;
in-app notifications continue.

More: [`../NOTIFICATIONS.md`](../NOTIFICATIONS.md), [`../lifecycle-communications.md`](../lifecycle-communications.md).
