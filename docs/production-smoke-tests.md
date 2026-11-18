# Production smoke tests

Run after every deployment and every rollback. `deploy.sh` and `rollback.sh` run the automated part themselves and roll back automatically if it fails. The manual part is run once per release, by a person, with designated test accounts.

**Rules:**

- Use **dedicated test accounts only**, never a real user's account.
- **No real payments:** checkout is exercised only in Razorpay test mode on staging.
- **No fabricated data:** don't insert offers, prices or price history to make a check pass. If no marketplace is live, a search correctly returns "no sources available" and that is the expected result.
- The scripts never print cookies, tokens or response bodies.

## 1. Automated (`scripts/smoke-tests/smoke.sh`)

```sh
scripts/smoke-tests/smoke.sh                                    # URLs from APP_DOMAIN/API_DOMAIN in .env.production
SMOKE_EMAIL=smoke@<domain> SMOKE_PASSWORD=… scripts/smoke-tests/smoke.sh   # + signed-in flow
```

| Check                                 | What it proves                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| internal: api `/ready`                | API reaches PostgreSQL and Redis (and IAM) from inside the private network        |
| internal: agent `/ready`              | Python agent up, its database role works                                          |
| internal: worker heartbeat            | Worker running and connected to Redis                                             |
| web: `/healthz`                       | Frontend served over HTTPS                                                        |
| web: login page with security headers | TLS, CSP with nonce, HSTS, frame-ancestors / X-Frame-Options                      |
| edge: http → https redirect           | Traefik redirect                                                                  |
| api host: `/health/live`              | API host routed over HTTPS                                                        |
| api: catalog categories               | Same-origin `/api` proxy works                                                    |
| api: marketplace source status        | Readiness is reported honestly; no source claims to be live without authorization |
| auth: sign in / `/auth/me` / sign out | IAM integration and session cookies (**needs `SMOKE_EMAIL`**)                     |
| search: submit → background finish    | API → queue → worker → agent → internal API → result (**signed-in only**)         |
| notifications: unread count           | Notification read path                                                            |

Optional settings:

- `SMOKE_SEARCH_TIMEOUT_MS` (default 120 s);
- `SMOKE_IGNORE_CHECKS=a,b`, **only** for a dependency that is known to be absent, and recorded in the release manifest.

**Not covered automatically:** TLS certificate validity dates (blackbox `CertificateExpiringSoon` covers it), and whether monitoring receives telemetry (manual step 3.6).

## 2. Test accounts

| Account                          | Role  | Purpose                                     |
| -------------------------------- | ----- | ------------------------------------------- |
| `smoke@<domain>`                 | USER  | Automated signed-in flow; owns nothing else |
| `qa-a@<domain>`, `qa-b@<domain>` | USER  | Manual workflows and the isolation check    |
| the owner's admin account        | ADMIN | Admin checks                                |

Create them in the shared IAM. Keep the passwords in the vault. Exclude them from analytics by e-mail domain.

## 3. Manual checks (once per release)

### 3.1 User workflow (as `qa-a`)

1. Sign in, then load the dashboard.
2. Submit a controlled search, e.g. _"smartphone under ₹35,000 with 8GB RAM"_. Expect:
   - progress per marketplace;
   - each unauthorized marketplace shown as skipped, with its reason;
   - if no source is live, an honest "no results from the sources searched".
3. If results exist:
   - open a product;
   - check offers, pricing and price history;
   - check that every price matches the marketplace page at the time of the check. This verifies we don't invent prices.
4. Create a watchlist, add the product, and rename it.
5. Create a price alert. Check that it appears in the list and that its next-check time is set.
6. Notifications page: loads, and unread count matches.

### 3.2 Isolation (as `qa-b`)

Open `qa-a`'s search, watchlist and alert URLs (copied from 3.1). Expect **404** on every one, with no data shown.

### 3.3 Admin (as ADMIN)

1. Sign in; `/admin` loads.
2. **Sources:** every connector's state is correct (`PENDING_APPROVAL`/`PENDING_CREDENTIALS` until approved); enabling an unready source is refused.
3. **Jobs:** queues listed with worker counts above 0.
4. **Users:** the list loads, and opening `qa-a` shows their usage.
5. **Audit logs:** the source check in step 2 and the sign-ins appear.
6. As `qa-a`, open `/admin` and `/api/v1/admin/users`: expect a redirect or **403**.

### 3.4 Billing (staging only, test mode)

Run the test-mode checkout, cancel and failed-payment flows. **In production, open the pricing page only.** Never complete a real purchase.

### 3.5 Affiliate

An outbound "Buy" link shows the disclosure and has `rel="sponsored"`. The redirect goes to the marketplace URL stored for the offer. In production, affiliate tags appear only for approved programmes.

### 3.6 Monitoring

Prometheus targets all up. The API `/metrics` scrape is fresh. A test alert reaches the receiver (staging: stop the worker for 6 minutes).

## 4. Recording results

Record each result in the release manifest's **Smoke tests** line, as public N/N, internal N/N, signed-in N/N and manual pass/fail, with any skipped check and its reason.

**Status 2026-11-18:** all automated checks passed **only in the local staging simulation** (11/11 public, 3 internal; the signed-in flow wasn't run because there was no IAM). Never run against production.
