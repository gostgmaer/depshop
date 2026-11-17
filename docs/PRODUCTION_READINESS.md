# Production readiness checklist

Status at 2026-11-17 (Phase 7.1).

**Legend:**

- ✅ done in the codebase;
- 🔧 needs configuration or a deployment step;
- ⏳ needs an external approval or account;
- ❌ not done.

Nothing here is a compliance certification. See [SECURITY_AUDIT.md](SECURITY_AUDIT.md) for the evidence behind each ✅.

## Environment and secrets

- ✅ Every service validates its environment at start-up (Zod). Production refuses `COOKIE_SECURE=false`, mock connectors and the sandbox billing provider.
- 🔧 Generate unique random values (≥ 32 chars) for:
  - `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY` (32 bytes, base64);
  - `INTERNAL_API_TOKEN`, `AGENT_SERVICE_TOKEN`, `AGENT_USER_CONTEXT_SECRET`;
  - `PAYMENT_WEBHOOK_SECRET`, `NOTIFICATION_TOKEN_SECRET`, `METRICS_TOKEN`;
  - VAPID keys (`pnpm notifications:vapid`);
  - `REDIS_PASSWORD`, `POSTGRES_PASSWORD`, `DEALMIND_APP_DB_PASSWORD`, `DEALMIND_AGENT_DB_PASSWORD`.
- 🔧 Store secrets in the platform's secret store (not in a committed file). Rotation:
  - `SESSION_SECRET` rotation invalidates CSRF tokens;
  - `TOKEN_ENCRYPTION_KEY` rotation signs everyone out;
  - service tokens are rotated by updating both sides together.
- ✅ No secrets in the repository or its history (pattern scan; see the audit §7). 🔧 Add gitleaks (or similar) to CI.
- 🔧 `API_DOCS_ENABLED` unset or `false` (the default in production). `CONNECTORS_ENABLE_MOCKS=false`.

## Network and TLS

- 🔧 Traefik:
  - HTTPS entrypoint with a certificate (ACME/Let's Encrypt or a managed certificate);
  - HTTP→HTTPS redirect;
  - HSTS (`max-age=31536000; includeSubDomains`), set at Traefik, because TLS terminates there.
- 🔧 Domain and DNS:
  - `APP_URL` set to the production origin;
  - the IAM app registration updated to it;
  - `TRUSTED_PROXY_COUNT=1` (web) and `TRUST_PROXY` (API) matched to the real proxy chain.
- ✅ Only Traefik is published. `/internal`, `/webhooks`, `/metrics` and the agent are not routed publicly. The web proxy can't be steered outside `/api` (DM-05).
- 🔧 Replace the Docker socket mount with a socket proxy or the file provider (DM-23).
- ✅ Postgres and Redis are not published beyond localhost and the private network. 🔧 On managed services, restrict them to the app's private network; use TLS (`sslmode=require`, `rediss://`) if traffic leaves a private network.

## Database

- 🔧 Run `pnpm migrate:deploy`, then `infrastructure/docker/postgres/roles.sql` as the owner. Point the API and worker at `dealmind_app` and the agent at `dealmind_agent`. The owner role is for migrations only (DM-02).
- 🔧 Backups: daily logical dumps plus WAL/PITR (or the managed provider's PITR), retained 30 days, encrypted, stored off-host.
- ❌ Restore procedure and a timed restore drill, written down and performed at least once before launch.
- ✅ Constraints: composite ownership foreign keys, CHECKs (money in integer paise, statuses), unique keys; drift check is clean.

## Redis

- ✅ Password, AOF (`everysec`) plus RDB snapshots, `noeviction`; `FLUSHALL`/`FLUSHDB`/`DEBUG` disabled (restart the container to apply).
- 🔧 Persistent volume backups (or managed Redis with persistence). Size `maxmemory` for queue backlog plus caches.

## Monitoring, logging, alerting

- ✅ Structured logs: pino (API/worker) and structlog (agent). Secrets and cookies are redacted. Request URLs are logged without query strings. Request ids flow from web to API.
- ✅ `/health/live`, `/ready`, agent `/health`, and admin console system health.
- ✅ `/metrics` (Prometheus): HTTP rate/latency by route, queue depth, memory. 🔧 Set `METRICS_TOKEN` and scrape from the private network.
- ❌ Error monitoring: Sentry (or equivalent) needs a DSN.
- ❌ Distributed tracing: OpenTelemetry SDK and exporter plus a collector.
- 🔧 Log retention policy (logs contain IP addresses): suggested 30–90 days.
- 🔧 Alerts:
  - `/ready` failing;
  - 5xx rate;
  - p95 latency;
  - queue `waiting`/`failed` growth;
  - dead letters > 0;
  - connector `DOWN`;
  - notification failure rate;
  - payment webhook signature failures;
  - search failure rate (admin analytics);
  - LLM budget reached.

## Deployment and rollback

- ✅ Reproducible images: frozen lockfiles, non-root users, security updates applied, no package managers at runtime.
- 🔧 Pin base images by digest (DM-25). Prune devDependencies from runtime images (DM-24). Rescan images (Trivy) in CI. Evaluate Debian 13 or distroless bases (DM-22).
- 🔧 Migrations run before the new version starts (the `migrate` service). They are written to be backward compatible (additive) so the previous version can run against the new schema during a rollback.
- 🔧 Rollback: redeploy the previous image tags. Data migrations are never destructive without a separate, reviewed step.
- 🔧 CI gate: `pnpm check`, all `test:db` suites, agent pytest, Playwright, `pnpm audit --prod`, `pip-audit`, image scan, and a secret scan.

## Disaster recovery

- ❌ Written RPO/RTO targets (suggested RPO ≤ 24 h with PITR ≤ 5 min; RTO ≤ 4 h).
- ❌ Runbook: restore the database from PITR, recreate Redis (queues are rebuilt by the scheduler; the notification outbox re-enqueues pending deliveries), redeploy services, rotate secrets if the compromise involved them.

## Privacy and legal

- ✅ `/privacy` notice, sign-up notice, export, deletion, notification consent controls, retention jobs.
- ⏳ Set `PRIVACY_OPERATOR_NAME` and `PRIVACY_CONTACT_EMAIL` (grievance contact). Legal review of the notice against the DPDP Act, 2023 and the rules in force at deployment.
- ⏳ Data-processing terms with the LLM provider and the EasyDev shared services. Breach-notification procedure.
- ✅ Affiliate disclosure on every "Buy" link (`rel="sponsored"`, disclosure text, never affects ranking).

## External approvals

- ⏳ Payments: Razorpay production activation and keys in the shared payment service (never in DealMind). The webhook secret is shared with DealMind.
- ⏳ Marketplace APIs: Amazon Creators API / Associates, Flipkart Affiliate API (approved accounts and credentials). Other sources stay disabled until approved.
- ⏳ Affiliate programs: tracking ids only after approval; commissions only as partner-reported.
- ⏳ LLM provider production account with spend limits (the admin console's monthly token budget is a second limit).

## Before go-live

- ❌ OWASP ZAP baseline scan against staging, and an independent penetration test.
- ❌ Core Web Vitals (Lighthouse and real-user monitoring) on staging.
- ❌ Load test on production-like infrastructure (`load/k6/api-read-mix.js`, plus a write mix with a running agent).
- ❌ Licence review of the dependencies.
- 🔧 zod 4 migration (DM-19) and Prisma 7 (DM-20), or a documented acceptance of these risks.
