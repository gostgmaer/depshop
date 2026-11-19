# Payments: shared EasyDev payment service

**What it does:** paid plans (subscriptions, renewals, refunds). DealMind never talks to
Razorpay directly: the shared **payment-microservice** holds the Razorpay keys and sends
DealMind a signed webhook when a payment or subscription changes.

**What we use today:** **nothing is charged.** The free launch offer (`LAUNCH_FREE_PLAN=PRO`)
gives every account the Pro plan at no cost, and checkout is refused. Locally,
`BILLING_PROVIDER=sandbox` simulates payments for testing.

## Settings (api and worker unless noted)

| Variable                                       | Value                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `BILLING_PROVIDER`                             | `none` (default) · `easydev-payments` (real) · `sandbox` (development only; refused elsewhere) |
| `PAYMENT_SERVICE_URL`                          | From the payment-service team                                                                  |
| `PAYMENT_SERVICE_API_KEY`                      | From the payment-service team                                                                  |
| `PAYMENT_WEBHOOK_SECRET` (api)                 | Issued when the webhook is registered (≥ 32 chars)                                             |
| `PAYMENT_TENANT_ID` / `PAYMENT_APPLICATION_ID` | `easydev` / `dealmind`                                                                         |
| `BILLING_GRACE_DAYS`                           | Paid access kept after a failed renewal, default 3                                             |
| `LAUNCH_FREE_PLAN`                             | `PRO` during launch; **empty** to start charging                                               |

## Turn on paid plans

1. Ask the payment-service team to register DealMind as an application and to register the
   webhook URL:
   ```
   https://<API_DOMAIN>/webhooks/easydev-payments
   ```
   (outside `/api`; authenticated by the HMAC signature, not cookies). They give you the URL,
   API key and webhook secret. **Staging uses the service in TEST mode.**
2. Set `BILLING_PROVIDER=easydev-payments` and the three values; `check-env.sh` then requires them.
3. Review plan prices and limits. They are stored in the `SubscriptionPlan` table (seeded
   from `DEFAULT_PLANS` in `@dealmind/shared`); there is no admin screen for editing them
   yet, so changes are made in the database by an operator. See `../BILLING.md`.
4. When ready to charge, set `LAUNCH_FREE_PLAN=` (empty). Recreate api + worker.
5. **Verify (staging, TEST mode first):**
   - Admin → System health → **Shared payment service** is OK.
   - Buy a plan with a test card on `/pricing`; the subscription appears in Admin →
     Subscriptions and the user's Billing page shows it active.
   - Cancel or refund in TEST mode and confirm the change arrives by webhook.

## Turn it off

`BILLING_PROVIDER=none` (or set `LAUNCH_FREE_PLAN` again) and recreate api + worker.
Existing subscribers keep their recorded state.

More: [`../BILLING.md`](../BILLING.md), [`../PRICING.md`](../PRICING.md).
