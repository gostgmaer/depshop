# Security, reliability and performance audit (Phase 7.1)

**Date:** 2026-11-17.

**Scope:** the whole monorepo: web (Next.js), API (Fastify), worker (BullMQ), agent (FastAPI/LangGraph), packages, PostgreSQL, Redis, Docker/Traefik, and the integrations with the shared EasyDev services (IAM, notifications, payments).

**Method:** code review of the security controls and every trust boundary, plus tests that were actually run (listed in §8) and tool scans (§7). This is an internal engineering audit, not an independent penetration test or a compliance certification.

## 1. Architecture and trust boundaries

```
Browser ──HTTPS──▶ Traefik ──▶ web (Next.js) ──/api/* proxy──▶ API (Fastify) ──▶ PostgreSQL
                     │                                         │   ├──▶ Redis (sessions-adjacent caches, rate limits, BullMQ)
                     └── /api/* ──▶ API                          │   ├──▶ shared IAM (sign-in, tokens)          [core-network]
                                                                  │   ├──▶ shared payment service + signed webhooks
                                                                  │   └──▶ agent /internal/agent (Bearer AGENT_SERVICE_TOKEN)
worker ──▶ PostgreSQL, Redis, agent, shared notification service, web-push services (allow-listed hosts)
agent  ──▶ API /internal/v1 (Bearer INTERNAL_API_TOKEN + HMAC-signed per-search user context), LLM provider
```

- **Public:** the web origin only. Traefik routes `/api/*` to the API and everything else to the web app.
- **Never routed publicly:** `/internal/v1`, `/webhooks` (reached by the payment service on `core-network`), `/metrics` and the agent.
- **Identity:**
  - It always comes from the server-side session (HttpOnly cookie → hashed token → `UserSession` → `User.role`/`status`, read on every request).
  - A client-sent user id or role is never used for ownership.
  - The agent acts for a user only with an HMAC-signed context bound to one search and its owner.

## 2. Controls verified (working as intended)

| Area           | Finding                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords      | Held and hashed by the shared IAM; DealMind never stores them.                                                                                                                                                                                                                          |
| Sessions       | Random tokens stored as SHA-256 hashes. Absolute (30 d) and idle (7 d) expiry. Rotation with replay detection, which revokes the whole family. Encrypted (AES-256-GCM) IAM tokens. Suspension and IAM revocation take effect immediately.                                               |
| Cookies        | HttpOnly, SameSite=Lax, `Secure` + `__Host-` in production (env refuses `COOKIE_SECURE=false` in production).                                                                                                                                                                           |
| CSRF           | Origin allow-list, `Sec-Fetch-Site` check, and HMAC double-submit token on every unsafe `/api` request (login included).                                                                                                                                                                |
| Login abuse    | Per-email lockout (`LoginThrottle`) plus per-route rate limits. Password confirmation for account deletion uses the same lockout key.                                                                                                                                                   |
| Authorization  | `requireAuth`/`requireAdmin` (role read from the DB each request). Admin routes check in `onRequest`, before validation. Every user-owned query is scoped by the session's `userId`. Composite `(id, userId)` foreign keys make cross-user references impossible at the database level. |
| Validation     | Zod schemas on every route, `.strict()` objects (mass assignment refused with 422). 1 MiB body limit. Safe error envelope with request id and no stack or SQL.                                                                                                                          |
| SQL            | Prisma and tagged-template `$queryRaw` only. The two `$executeRawUnsafe` uses take table names and conditions from code literals. SQLAlchemy Core with bound parameters in the agent.                                                                                                   |
| Open redirects | Affiliate redirects resolve only stored offer URLs (https, source domain, provider host allow-list). `next=` paths are sanitised (`safeNextPath`).                                                                                                                                      |
| Payments       | Signed webhooks (HMAC, timestamp tolerance, idempotent ledger). Webhooks only trigger a server-side re-read, so frontend "success" is never trusted. Integer paise. Ownership checks on checkout and subscription. No endpoint can mark a payment successful.                           |
| Queues         | Payloads carry ids only (no personal data or secrets). Zod-validated on both ends. Bounded attempts with jitter, dead-letter queue, concurrency limits, idempotent job ids.                                                                                                             |
| Agent          | Every route requires the service token (constant-time compare). No docs routes. Pydantic validation. No tool or code/SQL/shell execution from model output. Narration is checked against verified facts (new numbers or URLs are rejected). Timeouts and recursion limits.              |
| Connectors     | Fixed official API hosts only (no arbitrary URL fetching or scraping). Credentials come from env, never the DB, and are reported by name only. Response validation with Zod. Provenance stored per offer. Rate limits, timeouts and retries per source.                                 |
| Redis          | Password, localhost/private network only, AOF persistence, `noeviction` (correct for BullMQ).                                                                                                                                                                                           |
| Containers     | Non-root users, frozen lockfiles, health checks. The agent has no published port. Dev admin UIs are behind an opt-in profile. All published ports bind to 127.0.0.1.                                                                                                                    |

## 3. Vulnerability inventory

Severity uses likelihood × impact for this deployment.

**Status key:**

- **Fixed:** changed and covered by an executed test.
- **Fix ready:** remediation written and verified, but it needs a deployment step.
- **Open:** not yet remediated.
- **Accepted:** a documented decision.

| ID    | Sev.                      | Component                               | Issue                                                                                                                                                                                                                                           | Status                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DM-01 | **High**                  | Worker / notifications                  | **SSRF via web-push endpoints.** Any `https://` host was accepted and the worker POSTed to it (internal hosts; the failure counter acted as a port-scan oracle).                                                                                | **Fixed.** Allow-list of browser push services (FCM, Mozilla, WNS, Apple), checked at subscribe and before every send; rows that fail are retired. Tests: `security.db.test.ts`.                                                                                                                                                                                                 |
| DM-02 | **High**                  | Database                                | **All services connect as the Postgres superuser.** An SQL-injection bug would mean full cluster control (`COPY … TO PROGRAM`).                                                                                                                 | **Fix ready.** `infrastructure/docker/postgres/roles.sql`: `dealmind_app` (DML only) and `dealmind_agent` (two read models plus its checkpoint schema). Verified in a rolled-back transaction: app cannot DDL, read `_prisma_migrations`, `COPY PROGRAM` or create roles; agent cannot read `User` or write `Search`. Deployment must switch the connection strings (checklist). |
| DM-03 | **High**                  | Privacy                                 | **No account deletion or personal-data export** (DPDP erasure and access).                                                                                                                                                                      | **Fixed.** `POST /users/me/delete`: password re-check via IAM (throttled), typed confirmation, refused while a paid plan renews, ends all sessions, deletes cascaded data, detaches retained ledgers, audit without email. `GET /users/me/export` (JSON, own data only, no security material). UI in Settings → Privacy.                                                         |
| DM-04 | **Med-High**              | Web                                     | **No security headers**: no CSP, so pages including account deletion and the admin console could be framed; no nosniff, Referrer-Policy or Permissions-Policy.                                                                                  | **Fixed.** Per-request nonce CSP with `strict-dynamic` and `frame-ancestors 'none'`, plus static hardening headers. E2E checks headers and that no CSP violations occur.                                                                                                                                                                                                         |
| DM-05 | **Medium**                | Web proxy                               | **Path escape:** `..` segments (sent as `%2e%2e`) resolved outside `/api`, reaching `/internal/v1`, `/webhooks` and `/docs` through the public origin. These still needed their own tokens, but this bypassed the Traefik `/api`-only boundary. | **Fixed.** Dot/empty segments refused and the final path asserted. Unit and e2e (real Next runtime) tests.                                                                                                                                                                                                                                                                       |
| DM-06 | **Medium**                | Connectors, billing, IAM, agent clients | **Credential headers on redirects.** `fetch` keeps custom headers (`Fk-Affiliate-Token`, payment `x-api-key`) across cross-origin redirects.                                                                                                    | **Fixed.** `redirect: "error"` on every credential-bearing call.                                                                                                                                                                                                                                                                                                                 |
| DM-07 | **Medium**                | API                                     | **OpenAPI docs on by default in production**, which also disabled the CSP.                                                                                                                                                                      | **Fixed.** Default off when `NODE_ENV=production` (compose default `false`).                                                                                                                                                                                                                                                                                                     |
| DM-08 | **Medium**                | Dependencies                            | `@fastify/static` path traversal (GHSA-83w8-p2f5-377r), via swagger-ui.                                                                                                                                                                         | **Fixed.** `@fastify/swagger-ui` 6.1.4 brings `@fastify/static` 10.1.x.                                                                                                                                                                                                                                                                                                          |
| DM-09 | **Medium**                | Privacy                                 | **No retention** for ended sessions (IP, user agent), notifications, delivery records or search history.                                                                                                                                        | **Fixed.** Hourly cleanup: sessions 30 d after ending, deliveries 90 d, notifications 365 d, finished searches 365 d, with indexes (migration `20261125100000_security_hardening`). Worker DB test.                                                                                                                                                                              |
| DM-10 | **Medium**                | Web proxy                               | **Unbounded request buffering** before the API's 1 MiB limit (memory pressure).                                                                                                                                                                 | **Fixed.** Streamed cap at 1 MiB, 413 without contacting the API.                                                                                                                                                                                                                                                                                                                |
| DM-11 | Low                       | API logs                                | Request URLs, including query strings with search text, were logged.                                                                                                                                                                            | **Fixed.** Path-only request serializer.                                                                                                                                                                                                                                                                                                                                         |
| DM-12 | Low                       | Observability                           | No request-id propagation from web to API; no metrics.                                                                                                                                                                                          | **Fixed.** `x-request-id` end to end. Token-protected `/metrics` (route-template labels, queue depth).                                                                                                                                                                                                                                                                           |
| DM-13 | Low                       | Images                                  | Runtime images shipped npm/npx/corepack (npm's bundled deps: 10 High CVEs) and `uv`; no OS security updates applied.                                                                                                                            | **Fixed.** Removed and `apt-get upgrade` in runtime stages. API image application findings went from 11 to 1 (Trivy).                                                                                                                                                                                                                                                            |
| DM-14 | Low                       | Redis                                   | `FLUSHALL`/`FLUSHDB` were available to any client (a test wiped dev Redis earlier this project).                                                                                                                                                | **Fixed in config.** Renamed away in `redis.conf`; takes effect on container restart.                                                                                                                                                                                                                                                                                            |
| DM-15 | Low                       | Agent                                   | The narrator prompt didn't state that marketplace text is untrusted. Output is already validated against the facts.                                                                                                                             | **Fixed.** Rule added.                                                                                                                                                                                                                                                                                                                                                           |
| DM-16 | Info                      | Web proxy                               | Response-only header names (`location`, …) were forwarded from the client upstream.                                                                                                                                                             | **Fixed.**                                                                                                                                                                                                                                                                                                                                                                       |
| DM-17 | Critical (dev only)       | Test runner                             | `tinypool` prototype-pollution RCE (Vitest 3). Not in production images, but runs on CI/dev machines.                                                                                                                                           | **Fixed.** Vitest 4.1.12.                                                                                                                                                                                                                                                                                                                                                        |
| DM-18 | High (build only)         | Next build                              | `postcss` file-disclosure advisories (Next pins 8.4.31).                                                                                                                                                                                        | **Fixed.** pnpm override `postcss ^8.5.33`.                                                                                                                                                                                                                                                                                                                                      |
| DM-19 | **High**                  | API (runtime)                           | `zod` 3.25.76 memory exhaustion on oversized constrained collections (GHSA-mrhx-c7xc-m3w5). The only fix is zod 4.                                                                                                                              | **Open.** Mitigated by the 1 MiB body limit and rate limits. Requires a zod 4 + `fastify-type-provider-zod` migration across 12 packages.                                                                                                                                                                                                                                        |
| DM-20 | High (build/CLI)          | Prisma CLI                              | `deepmerge-ts` stack exhaustion (no Prisma 6 fix). It only processes our own config at migrate time.                                                                                                                                            | **Open.** Upgrade with Prisma 7.                                                                                                                                                                                                                                                                                                                                                 |
| DM-21 | Moderate (dev)            | ESLint                                  | `minimatch` ReDoS via typescript-eslint.                                                                                                                                                                                                        | **Open** (dev only).                                                                                                                                                                                                                                                                                                                                                             |
| DM-22 | Medium                    | Images                                  | Debian 12 OS packages: API 38, agent 101 High/Critical, all `affected`/`fix_deferred`/`will_not_fix` (no patched package exists). Criticals: zlib minizip CVE-2023-45853 (code path unused) and sqlite CVE-2025-7458.                           | **Open.** Evaluate Debian 13 or distroless bases; rescan on every build.                                                                                                                                                                                                                                                                                                         |
| DM-23 | Medium                    | Traefik                                 | Docker socket mounted (read-only still allows container enumeration and is a known escalation path).                                                                                                                                            | **Open.** Use a socket proxy or the file provider in production.                                                                                                                                                                                                                                                                                                                 |
| DM-24 | Medium                    | Images                                  | Runtime images copy the whole workspace including devDependencies.                                                                                                                                                                              | **Open.** `pnpm deploy --prod` per app.                                                                                                                                                                                                                                                                                                                                          |
| DM-25 | Low                       | Images                                  | Base images pinned by tag, not digest.                                                                                                                                                                                                          | **Open.**                                                                                                                                                                                                                                                                                                                                                                        |
| DM-26 | Info                      | Push                                    | Re-subscribing a known endpoint moves it to the caller (intended device handover; needs the secret endpoint URL).                                                                                                                               | **Accepted.**                                                                                                                                                                                                                                                                                                                                                                    |
| DM-27 | Medium (defence in depth) | Database                                | No PostgreSQL Row-Level Security.                                                                                                                                                                                                               | **Accepted for now** (see §4).                                                                                                                                                                                                                                                                                                                                                   |
| DM-28 | —                         | Infra                                   | The local compose stack is HTTP-only.                                                                                                                                                                                                           | **Production requirement** (TLS at Traefik; checklist).                                                                                                                                                                                                                                                                                                                          |
| DM-29 | —                         | Observability                           | Sentry and OpenTelemetry exporters are not integrated (they need a DSN and a collector). The worker records tracking metrics through `@opentelemetry/api`, which is a no-op until an SDK and exporter are installed.                            | **Open** (checklist).                                                                                                                                                                                                                                                                                                                                                            |

## 4. Row-Level Security evaluation (DM-27)

**Option considered:** RLS policies on every user-owned table, `USING ("userId" = current_setting('app.user_id')::uuid)`, with `FORCE ROW LEVEL SECURITY` and the API connecting as a non-owner role.

**Why it isn't implemented now:**

- **Every query would need an interactive transaction.** Prisma uses a connection pool, so the user id has to be set with `SET LOCAL` inside a transaction on the same connection, or it leaks to the next request using that connection. That's a change to every handler, with real pool cost.
- **Workers and internal routes legitimately act across users.** The scheduler, alert evaluation, notifications and retention need a separate bypass role, which brings back the privileged-connection problem.
- **Isolation is already enforced in three independent layers:** session-derived `userId` scoping in every service, composite `(id, userId)` foreign keys (cross-user references fail in the database), and the cross-user tests in `search*.db`, `alerts-watchlists.db`, `notifications.db`, `billing.db`, `internal.db` and `security.db`.
- **The least-privilege roles (DM-02) take away the main blast radius** of an SQL injection: DDL, superuser access and the agent reading user tables.

**If adopted later:**

- a `withUserContext(userId, fn)` Prisma interactive-transaction helper that runs `SELECT set_config('app.user_id', $1, true)` (transaction-local, so pooled connections can't leak it);
- policies on `Search`, `SearchResult`, `Watchlist*`, `PriceAlert`, `Notification*`, `PushSubscription`, `UserSession`, `UserPreference`;
- a `BYPASSRLS` role for the worker only.

There is no tenant context: the only scope is the individual user.

## 5. Performance

**Measured:**

- **Tool:** k6 0.54 (Docker), `load/k6/api-read-mix.js`, run by `pnpm --filter @dealmind/api test:load`.
- **Target:** the real Fastify API over HTTP on PostgreSQL 17 and Redis 7.4 (Docker), on one developer laptop that also ran k6 and the databases.
- **User data:** a signed-in user with 200 searches, 300 notifications and 3 watchlists.
- **Load:** 25 virtual users for 55 s, with a weighted shopper read mix (session, catalog, history, notifications, watchlists, usage).

| Endpoint                                         | p50 ms | p95 ms | p99 ms |
| ------------------------------------------------ | ------ | ------ | ------ |
| All (64,263 req, **1,211 req/s, 0.00 % errors**) | 19.4   | 28.2   | 33.3   |
| `GET /auth/me`                                   | 20.6   | 26.8   | 31.0   |
| `GET /categories/tree` (cached)                  | 10.6   | 16.1   | 19.0   |
| `GET /sources/status`                            | 13.3   | 18.6   | 21.6   |
| `GET /search` (history, page 1)                  | 21.3   | 27.7   | 32.5   |
| `GET /notifications`                             | 21.0   | 27.2   | 31.0   |
| `GET /notifications/unread-count`                | 20.4   | 26.8   | 31.3   |
| `GET /watchlists`                                | 20.4   | 26.7   | 31.3   |
| `GET /usage`                                     | 27.4   | 34.9   | 40.2   |

**Observations:**

- **Session-touch setting:** with the test harness's `sessionTouchIntervalMs = 0` (a `lastUsedAt` write on every request), the same mix ran at 413 req/s with p95 134 ms. That was row-lock contention from 25 virtual users sharing one session. The production default writes at most once per interval and gives the numbers above. Keep the default.
- **Cost of authentication:** authenticated reads cost about 10 ms more than public ones (session lookup).
- **Indexes:** retention deletes now have indexes (DM-09); user-scoped list queries use `(userId, createdAt DESC)`-style indexes.

**Not measured in this phase:**

- **Search and agent end-to-end time with live marketplaces:** no authorised marketplace credentials exist. The worker's tracking metrics and `AgentRun.durationMs` record these in production.
- **Core Web Vitals (Lighthouse/RUM):** not run.
- **Connector latency against real partners:** no credentials.
- **Write-heavy load:** search creation enqueues agent work and needs a running agent and LLM.

**Frontend:** production build route sizes are 108–315 kB first-load JS (admin analytics and subscriptions are the largest because of Recharts). Every page is now dynamically rendered (nonce CSP).

## 6. Reliability

| Check             | Result                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Graceful shutdown | API (`app.close()`, Prisma disconnect) and worker (BullMQ workers finish active jobs, then queues, Redis and Prisma close) on SIGTERM/SIGINT.          |
| Health            | `/health/live` (process) and `/ready` (DB and Redis critical; IAM and others optional; 3 s per-check timeout). Agent `/health`. Compose health checks. |
| DB outage         | **Tested:** API returns 503 `DEPENDENCY_UNAVAILABLE` with no internals, `/ready` 503, `/health/live` stays 200 (no restart loop).                      |
| Redis outage      | **Tested:** `/ready` 503 while down, liveness unaffected; recovers on reconnect with no restart. Rate limiting fails open by design.                   |
| IAM outage        | **Tested** (Phase 1.4): sign-in 503, signed-in users unaffected.                                                                                       |
| Worker crash      | **Tested** (Phase 5.1): stalled jobs re-queued; outbox re-enqueues lost deliveries.                                                                    |
| Retries / DLQ     | Jittered exponential backoff, bounded attempts, dead-letter queue visible in the admin console with single-job retry.                                  |
| Circuit breaking  | Per-source status (`DEGRADED`/`DOWN` from health checks), rate limiter and timeouts; partial results when a source fails.                              |
| Backups           | **Not configured in this repository** (checklist): PostgreSQL PITR/daily dumps, Redis AOF snapshot, restore drill.                                     |

## 7. Dependency and supply-chain audit

| Check                                                                        | Result (executed 2026-11-17)                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm audit` (all deps)                                                      | **Before:** 15 (2 critical, 5 high, 8 moderate). **After:** 3 (2 high, 1 moderate): `zod` (DM-19), `deepmerge-ts` (DM-20), `minimatch` (DM-21). Production-only before: 10.                                                                                                                                                                                                                                                               |
| Python (`pip-audit` 2.10.1, `uv export --frozen --no-dev`, 249 requirements) | **No known vulnerabilities.**                                                                                                                                                                                                                                                                                                                                                                                                             |
| Lockfiles                                                                    | `pnpm install --frozen-lockfile` and `uv sync --frozen` in every image build; overrides recorded in `pnpm-workspace.yaml`.                                                                                                                                                                                                                                                                                                                |
| Image scan (Trivy 0.58.1, High/Critical)                                     | API image: application deps 11 → 1 after hardening; OS 38 (no fixes available). Agent image: application deps 0; OS 101 (no fixes available). Docker Scout needs a Docker Hub login (not used).                                                                                                                                                                                                                                           |
| Secret scan                                                                  | Pattern scan (private keys, cloud/API key formats, Razorpay, JWTs, credentialed URLs, assigned secrets) of 602 tracked files **and the full git history**. 6 hits, all false positives: `.env.example` placeholders (verified unequal to the real `.env` values without printing them) and a fictional test canary. `.env` is git-ignored. No dedicated scanner (gitleaks/trufflehog) is installed; adding one to CI is on the checklist. |
| Licences                                                                     | Not reviewed in this phase (checklist).                                                                                                                                                                                                                                                                                                                                                                                                   |

## 8. Tests executed

All of these were run on 2026-11-17 and passed.

| Suite                                                                                              | Count                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm check --force` (typecheck, lint, unit tests, builds of 20 packages)                          | 52/52 tasks                                                                                                                                     |
| API DB (PostgreSQL + Redis)                                                                        | **182**. New: `security.db` 14, `observability.db` 3, `reliability.db` 2.                                                                       |
| API unit                                                                                           | 21                                                                                                                                              |
| Worker DB                                                                                          | **43** (new: personal-data retention)                                                                                                           |
| DB package (schema/constraints)                                                                    | 68                                                                                                                                              |
| Web unit (Vitest/RTL)                                                                              | **122**. New: API proxy 3, privacy 2.                                                                                                           |
| Playwright (desktop and mobile, production build, axe)                                             | **34**. New: `security.spec.ts` (headers/CSP, no CSP violations, proxy confinement). `/privacy` and `/settings/privacy` added to the axe sweep. |
| Agent pytest / ruff / mypy                                                                         | 66 / clean / clean                                                                                                                              |
| Packages (affiliate, billing, catalog, connectors, db, intelligence, notifications, queue, shared) | 7, 10, 18, 36, 5, 53, 17, 5, 43                                                                                                                 |
| Load (k6)                                                                                          | §5                                                                                                                                              |

**Security tests in the new suites:**

- **IDOR:** sessions, push subscriptions; plus the existing per-feature suites.
- **Escalation:** mass assignment of `role`/`id` (422), USER on admin routes (403), forged `x-user-id`, and a client-supplied owner id on create.
- **Push SSRF.**
- **Transport:** security headers, no CORS grant for unknown origins, cross-origin write blocked, 413 body limit, malformed JSON gives a safe error, SQL metacharacters treated as text.
- **Internal API:** token required (including a near-miss token) and not reachable under `/api`.
- **Export:** own data only, no token hashes, encrypted tokens, push keys or IP hashes.
- **Deletion:** confirmation and password, paid-plan guard, cascade and detachment, other users intact.
- **Metrics:** token required, no ids, query text or emails in labels.
- **Request-id validation.**

**Not executed:** OWASP ZAP (no running staging environment in this phase), Lighthouse/CWV, and a penetration test by an independent party.

## 9. Privacy assessment (DPDP Act, 2023)

**What the code now provides:**

- a notice at `/privacy` (purposes, recipients, retention, rights), with a sign-up notice linking to it;
- self-service access (export), correction (profile), erasure (account deletion) and withdrawal of messaging consent (notification settings, one-click unsubscribe);
- session revocation;
- data minimisation (retention jobs, salted IP hashes, device class only, referrer host only, log path-only URLs, push-keys and token material excluded from exports);
- **no** sale or sharing of personal data with marketplaces (users are redirected; partners report orders, not identities).

| Data                            | Purpose                    | Retention                                   |
| ------------------------------- | -------------------------- | ------------------------------------------- |
| Profile                         | Account                    | Until deletion                              |
| Sessions (IP, user agent)       | Sign-in, security          | Active + 30 d                               |
| Searches                        | Feature, history           | 365 d                                       |
| Watchlists, alerts              | Feature                    | Until deleted; evaluations 90 d             |
| Notifications                   | Feature                    | 365 d; deliveries 90 d                      |
| Affiliate clicks                | Commission attribution     | Identifiers 30 d; unconverted 13 months     |
| Subscription and webhook ledger | Billing, financial records | Ledger detached from the person on deletion |
| Audit log                       | Security                   | Retained; actor nulled on deletion          |

**Gaps that need the operator or legal review before launch** (no compliance claim is made):

- **Legal and contact details:** the operator's legal name and a contact/grievance officer (`PRIVACY_OPERATOR_NAME`, `PRIVACY_CONTACT_EMAIL`; the page shows a warning until set).
- **Notice review:** legal review of the notice text against the DPDP Rules in force at deployment (notice content, consent manager and breach-notification timelines).
- **Breach response:** a procedure for notifying the Data Protection Board and affected users.
- **Data-processing terms** with the LLM provider and the shared EasyDev services.
- **Account erasure in the shared IAM**, which is outside DealMind.
- **Children's data:** DealMind does not verify age. If minors may use it, verifiable parental consent is required.
- **Cross-border transfer:** check the LLM provider's processing location against any government restrictions.
- **Audit-log retention:** set a defined period.

## 10. Remaining risks and external approvals

**Remaining risks:**

- **Dependencies:** DM-19 (zod 4 migration), DM-20 (Prisma 7).
- **Images and infrastructure:** DM-22 to DM-25 (image bases and pruning, Traefik socket).
- **Defence in depth:** DM-27 (RLS).
- **Not yet built or wired:** Sentry and OpenTelemetry exporters, backups and restore drill, OWASP ZAP and an external penetration test.

**External approvals required:**

- Razorpay production activation through the shared payment service.
- Marketplace API approvals (Amazon Creators API / Associates, Flipkart Affiliate, others pending programs).
- Affiliate program approvals.
- The operator's legal review of the privacy notice.
- A TLS certificate and DNS for the production domain.

See [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
