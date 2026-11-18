# Production launch checklist

> Latest end-to-end evidence and release decision: [launch-readiness-report.md](launch-readiness-report.md) (Prompt 22).

**Status as of 2026-11-17.** DealMind AI has **not** been deployed to a real server, and no external provider has approved it.

**Status key:**

- ✅ **verified:** executed and checked (where, is stated);
- 🟡 **implemented, not verified:** built, but not yet exercised on real infrastructure or accounts;
- ⛔ **blocked:** needs an external approval, account or decision;
- ❌ **not done.**

Evidence: [SECURITY_AUDIT.md](SECURITY_AUDIT.md), [production-deployment.md](production-deployment.md), [backup-and-recovery.md](backup-and-recovery.md), [monitoring-and-alerting.md](monitoring-and-alerting.md), [ci-cd.md](ci-cd.md).

## A. Platform readiness (DealMind's own system)

| Gate                                            | Status                              | Evidence / what remains                                                                                                                                                                                                   |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production images build (5)                     | ✅ local                            | Multi-stage, base pinned by version and digest, non-root, no package managers at run time, health checks. Trivy: 0 fixable critical in all five.                                                                          |
| Production compose stack                        | ✅ local rehearsal                  | Full `deploy.sh` run: migrations, roles, all services healthy, smoke 11/11. Networks: backend has no internet; Postgres, Redis and the agent are unreachable from the edge; only Traefik is published.                    |
| Configuration validated                         | ✅ local                            | `check-env.sh` and start-up validation in every service; empty optional variables handled (three start-up bugs found and fixed in the rehearsal).                                                                         |
| Authentication and authorization                | ✅ test suites                      | API DB suites (auth, admin, IDOR, security). Signed-in flow in the smoke test **not** run (no IAM and no test account in the rehearsal) 🟡.                                                                               |
| TLS, HTTPS redirect, HSTS, security headers     | 🟡                                  | Redirect, headers and CSP verified with a self-signed certificate. Let's Encrypt issuance needs a real domain.                                                                                                            |
| Rate limits                                     | ✅                                  | App: per-route in Redis (tests). Edge: Traefik per-IP limit (configured; exercised only indirectly).                                                                                                                      |
| Database migrations as a release step           | ✅ local                            | Migrate job (owner role, `migrate deploy` only); idempotent re-run; drift check in CI.                                                                                                                                    |
| Least-privilege database roles                  | ✅ local                            | Applied by `deploy.sh`; the agent runs as `dealmind_agent` in the rehearsal.                                                                                                                                              |
| Backups and restore                             | ✅ local / 🟡 server                | Backup, restore test, tamper detection and a full disaster-recovery drill passed locally. **On the real host:** schedule the timers, encrypt with `age`, copy off-host, and run one restore test there.                   |
| Deployment, automatic rollback, manual rollback | ✅ local                            | A bad release was rolled back automatically; `rollback.sh` worked; the schema guard refused an incompatible rollback.                                                                                                     |
| Graceful shutdown                               | ✅ local                            | api, worker and agent exit 0 within 1–2 s on SIGTERM.                                                                                                                                                                     |
| Smoke tests                                     | ✅ local (11/11 public, 3 internal) | The signed-in flow needs `SMOKE_EMAIL`/`SMOKE_PASSWORD` (a dedicated test account) 🟡.                                                                                                                                    |
| CI pipeline                                     | 🟡                                  | Workflows lint clean (actionlint); ShellCheck clean; the steps were run locally. **Not yet run on GitHub** (push and enable Actions).                                                                                     |
| CD pipeline                                     | 🟡                                  | Requires the GitHub environments, SSH secrets, a server and registry access. Never executed.                                                                                                                              |
| Monitoring and alerting                         | 🟡                                  | Overlay ran in the rehearsal (7/7 targets, 23 rules). **No alert receiver configured; nothing runs on a server.**                                                                                                         |
| Error tracking (Sentry) / OpenTelemetry tracing | ❌                                  | Needs a vendor or account decision. Correlation ids are in place.                                                                                                                                                         |
| Load and performance                            | ✅ local                            | k6: shopper read mix 1,296 req/s at p95 ≤ 33 ms; catalog mix 1,022 req/s at p95 ≤ 58 ms (search submit 105 ms); BullMQ tracking 65 jobs/s at 80 ms upstream latency. One laptop. **Repeat on production-sized hardware.** |
| Security checks                                 | ✅ / 🟡                             | Phase 7.1 audit and tests. Open items: zod 4 migration (DM-19), Prisma 7 (DM-20), an OWASP ZAP baseline against staging, an external penetration test.                                                                    |
| Privacy and data retention                      | ✅ code / ⛔ legal                  | Export, deletion and retention jobs tested. **The operator's legal review and contact details are required** (`PRIVACY_OPERATOR_NAME`, `PRIVACY_CONTACT_EMAIL`; `check-env.sh` blocks production without them).           |
| Staging environment                             | ❌                                  | Needs its own host, domains, secrets, and the payment service in test mode. Rehearse every migration there first.                                                                                                         |
| Core Web Vitals                                 | ❌                                  | Lighthouse or real-user monitoring on staging.                                                                                                                                                                            |

## B. External integration readiness (third parties)

A connector without valid authorization stays disabled (the seed creates every source disabled). Readiness reports `PENDING_CREDENTIALS` or `PENDING_APPROVAL`, and search never reports such a source as searched. Mock connectors are refused when `NODE_ENV=production`.

| Integration                                                     | Status                   | Needed                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Amazon (Creators API / Associates)                              | ⛔ `PENDING_APPROVAL`    | Approved account; `AMAZON_CREATORS_CREDENTIAL_ID/SECRET`, `AMAZON_ASSOCIATES_PARTNER_TAG`; the program's eligibility rules met.              |
| Flipkart Affiliate API                                          | ⛔ `PENDING_CREDENTIALS` | Approved affiliate account; `FLIPKART_AFFILIATE_ID/TOKEN`.                                                                                   |
| Croma                                                           | ⛔ `PENDING_APPROVAL`    | A written integration agreement; no public API is used.                                                                                      |
| Reliance Digital                                                | ⛔ `PENDING_APPROVAL`    | A written integration agreement.                                                                                                             |
| Tata CLiQ                                                       | ⛔ `PENDING_APPROVAL`    | A written integration agreement.                                                                                                             |
| Web search / discovery provider                                 | ⛔ not configured        | A licensed provider and its terms; prices from it stay indicative-only by design.                                                            |
| Payment provider (Razorpay through the EasyDev payment service) | ⛔                       | Razorpay production activation and KYC; production keys in the payment service; `PAYMENT_WEBHOOK_SECRET`; a staging run in test mode first.  |
| E-mail (EasyDev notification service)                           | ⛔ / 🟡                  | The production sender domain verified (SPF, DKIM, DMARC) in the notification service; `NOTIFICATION_API_KEY`, `NOTIFICATION_TOKEN_SECRET`.   |
| Web push                                                        | 🟡 optional              | VAPID keys (`pnpm notifications:vapid`).                                                                                                     |
| LLM provider                                                    | ⛔                       | A production account with spend limits; `GOOGLE_API_KEY` or `OPENAI_API_KEY`; `LLM_MODEL`. Rule-based mode is refused in production.         |
| Shared EasyDev IAM                                              | ⛔                       | A production IAM reachable from the host; DealMind registered as an application with `APP_URL`.                                              |
| Affiliate disclosure and tracking                               | ✅ code / ⛔ programs    | Disclosure on every "Buy" link (`rel="sponsored"`); tracking ids are used only after program approval; commissions only as partner-reported. |

## C. Go-live sequence

1. **Staging:**
   1. Provision the staging host and DNS.
   2. Run the GitHub setup in [ci-cd.md](ci-cd.md).
   3. Tag a release candidate, which deploys to staging.
   4. Smoke-test it, including the signed-in flow with a test account.
2. **Staging checks:** restore test, a monitoring alert test, a payment test-mode purchase, an e-mail delivery test, an OWASP ZAP baseline, and a load test on staging hardware.
3. **Production prerequisites:** provision the production host. Fill `.env.production` only with approved production credentials. Leave unapproved connectors empty.
4. **Production deploy:** tag `vX.Y.Z`, approve the production deployment in GitHub, confirm the smoke tests, and enable the backup and restore-test timers.
5. **Launch watch:** watch the alerts for 48 hours, keep the previous release ready, and do not run destructive operations.
