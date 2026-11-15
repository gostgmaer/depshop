# Implementation phases

Each phase ends with: typecheck → lint → test → production build → docs update →
explicit report of incomplete work. Status is only marked **Done** when all of
those pass.

| #   | Phase                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Foundation: monorepo, tooling, data model, auth, RBAC, errors, API docs, web scaffold, Compose                                                                                                                                                                                                                                                                                                                                           | **Done** (see gaps below) |
| 1.2 | Docker development infrastructure: Postgres + pgvector, Redis (auth, BullMQ-safe), pgAdmin, RedisInsight, health checks, network, volumes, operations docs                                                                                                                                                                                                                                                                               | **Done** (see gaps below) |
| 1.3 | Database: UUIDv7 ids, UserSession, NotificationDelivery, BillingEvent, userId on every user-owned model, composite ownership FKs, CHECK constraints, seed, DB tests                                                                                                                                                                                                                                                                      | **Done** (see gaps below) |
| 1.4 | Individual user authentication: cookie sessions, CSRF, email verification, password reset/change, session management, profile & preferences, RBAC middleware, Mailpit, auth UI                                                                                                                                                                                                                                                           | **Done** (see gaps below) |
| 1.5 | Shared EasyDev services: identity via the shared IAM (BFF), notification and file-upload SDK adapters; DealMind's own password/email/Mailpit code removed                                                                                                                                                                                                                                                                                | **Done** (see gaps below) |
| 2.1 | Fastify API foundation: response envelope, modules (catalog, search, watchlists, alerts, notifications, subscriptions, admin), Redis cache/rate limits, BullMQ job contracts, `/health` + `/ready`                                                                                                                                                                                                                                       | Partially done (see gaps) |
| 2.2 | Product catalog & data management: catalog model refinement (BIGINT paise), normalization, matching/dedup, import/upsert, catalog APIs, caching, seed + sample data, query plans                                                                                                                                                                                                                                                         | **Done** (see gaps below) |
| 2.3 | Marketplace connector framework: registry, parallel executor (bounded concurrency, timeouts, rate limits, retries + jitter, circuit breakers, cache, dedup), normalization, health/metrics, marketplace connectors, mock stores                                                                                                                                                                                                          | **Done** (see gaps below) |
| 3.1 | Python LangGraph shopping agent (FastAPI): 13-node graph, typed state, Pydantic schemas, LLM provider abstraction, internal APIs to the TS connectors/intelligence, BullMQ worker integration, checkpointing, SSE progress                                                                                                                                                                                                               | **Done** (see gaps below) |
| 3.2 | Product matching & deduplication engine: identifier/MPN/model/title/pg_trgm/semantic matchers, category-aware critical-attribute guards, variant placement, configurable thresholds, append-only audit, human-only review, internal match APIs, Python client, labelled accuracy tests, benchmarks                                                                                                                                       | **Done** (see gaps below) |
| 3.3 | Pricing, genuine-discount and deal-ranking engine: BigInt price ladder, conditional-offer validation, EMI transparency, coverage-aware price history, 6 ranking modes with hard filters and explanations, internal pricing/ranking APIs, signed ranking provenance, Python integration, tests, benchmarks                                                                                                                                | **Done** (see gaps below) |
| 4.1 | Frontend dashboard: app shell (sidebar + mobile sheet), dashboard, AI search with filters and live SSE progress, results, products/categories, product intelligence page with comparison and history chart, compare, watchlists, alerts, history, notifications, settings, billing; Vitest/RTL + Playwright (axe)                                                                                                                        | **Done** (see gaps below) |
| 4.2 | AI shopping search and real-time results: autocomplete (debounced catalog + history), optional voice input, category-driven dynamic filters, availability/launch/discount filters, ranking explanations, step timeline from real agent events, per-marketplace status with skip reasons, list/grid/sort/pagination, partial/expired/failed states, multi-product comparison with variant guards, edit/re-run, duplicate-submission guard | **Done** (see gaps below) |
| 2   | ~~Web auth & account~~: delivered in 1.4. Remaining: admin bootstrap CLI, email change flow                                                                                                                                                                                                                                                                                                                                              | Partially done (1.4)      |
| 3   | Connector framework: registry, capability declarations, health checks, timeouts, rate limits, retries, normalization; admin connector management                                                                                                                                                                                                                                                                                         | Not started               |
| 4   | Search engine: parallel bounded-concurrency fan-out, partial results, per-source errors, variant matching, dedup, deterministic filters & ranking, persistence of searches                                                                                                                                                                                                                                                               | Not started               |
| 5   | AI layer (LangGraph.js): intent extraction, planning, source selection, orchestration, evaluation, explanation; structured outputs; configurable provider; AgentRun records                                                                                                                                                                                                                                                              | Not started               |
| 6   | Search & comparison UI, new-launch discovery                                                                                                                                                                                                                                                                                                                                                                                             | Not started               |
| 7   | Price tracking: BullMQ scheduled jobs, per-source rate limits, price snapshots, alert evaluation, notifications                                                                                                                                                                                                                                                                                                                          | Not started               |
| 8   | Watchlists, alerts & notifications UI                                                                                                                                                                                                                                                                                                                                                                                                    | Not started               |
| 9   | Monetization: plans, usage limits & metering, affiliate links, click attribution, conversion/commission reporting                                                                                                                                                                                                                                                                                                                        | Not started               |
| 10  | Admin console: users, catalog, connectors, AI model config, platform settings, subscriptions, affiliate & usage analytics, job monitoring                                                                                                                                                                                                                                                                                                | Not started               |
| 11  | Observability & hardening: OpenTelemetry, Sentry, production Traefik (TLS), slim images, security review, load testing                                                                                                                                                                                                                                                                                                                   | Not started               |

## Phase 1 — delivered

- pnpm workspaces + Turborepo; TypeScript strict (`noUncheckedIndexedAccess`) everywhere; ESLint (type-aware) + Prettier.
- `@dealmind/shared`: integer-paise money utilities (parse ₹ strings without floats, Indian formatting, basis-point discounts), `AppError` + stable error codes, shared Zod schemas, default plan catalogue.
- `@dealmind/db`: complete Prisma schema for all of Phase 1–10's data (global catalog vs. user-owned data; no tenant concepts), initial SQL migration, reference-data seed (plans + 5 sources, all **disabled**).
- `@dealmind/api` (Fastify 5):
  - Zod-validated env config; centralized error handler with one error envelope and request IDs.
  - Auth: register / login / refresh / logout. Argon2id password hashing, 15-min HS256 access JWTs, opaque refresh tokens stored as SHA-256 hashes, rotation with reuse detection (family revocation), timing-safe unknown-email handling, per-route brute-force rate limits.
  - RBAC: `authenticate` and `requireRole("ADMIN")`; admin user listing and suspend/reactivate (suspension revokes sessions).
  - Health: `/health/live`, `/health/ready` (DB check, 503 when degraded).
  - OpenAPI at `/docs` (Swagger UI) and `/docs/json`.
  - Security headers (helmet), CORS allow-list, global rate limit, log redaction of credentials.
- `@dealmind/web`: Next.js 15 App Router, Tailwind 4, shadcn-style `Button` (Radix Slot + CVA), TanStack Query provider, landing page.
- Docker Compose: Postgres 17, Redis 7, and an `app` profile with Traefik v3, migrate job, API and web images.

### Phase 1 — known gaps (not hidden, carried forward)

1. **Closed in 1.3.** Migrations now apply cleanly to real PostgreSQL 17, and `PrismaUserStore` was exercised end to end by a manual smoke test (register, login, refresh rotation, replay revocation, duplicate email). Phase 1.3 added 56 automated DB integration tests (`pnpm test:db`). An automated API-over-real-DB test is still missing (Phase 2).
2. **Partially closed in 1.2.** The core Compose services are built, run and validated (see INFRASTRUCTURE.md). The `app` profile images (`migrate`, `api`, `web`, `traefik`) are still **not built or run**.
3. **Closed in 1.4.** JWT access tokens were replaced by server-side sessions checked on every request; suspension and role changes apply immediately.
4. **Closed in 1.4.** Email verification, password reset and change are implemented.
5. **No admin bootstrap command.** Promote the first admin manually: `UPDATE "User" SET role='ADMIN' WHERE email='…';` → CLI to be added in Phase 10.
6. **Redis is provisioned but unused**; rate-limit state is in-process memory (per-instance). Move to Redis store in Phase 7 when Redis becomes a hard dependency.
7. **No web tests yet**; web UI is a static landing page.
8. **Runtime API image is not slimmed** (includes dev dependencies).

## Phase 1.2 — delivered

- `docker-compose.yml`: `postgres` (`pgvector/pgvector:0.8.0-pg17`), `redis` (`7.4.2-alpine`, password auth, AOF + RDB, `noeviction` for BullMQ), dev-only `tools` profile with `pgadmin` (`9.0`) and `redisinsight` (`2.70.1`). Pinned images, health checks, `service_healthy` dependencies, `unless-stopped` restarts, named volumes, a `dealmind` bridge network, and all ports bound to 127.0.0.1.
- `infrastructure/docker/`: Postgres init script (`pg_trgm`, `vector` in the app DB and `template1`), `redis.conf`, and a pgAdmin entrypoint that pre-registers the server and password from env.
- New Prisma migration `20261114010000_extensions` (portable: `vector` only if available).
- `.env.example` documents every variable. `.dockerignore` excludes secrets. `.gitattributes` forces LF for container scripts.
- DB scripts load the root `.env` via `dotenv-cli`; root `infra:*` / `db:*` convenience scripts.
- `docs/INFRASTRUCTURE.md`: operations, troubleshooting, security notes and **actual validation results**.

### Phase 1.2 — known gaps / deviations

1. **Package naming:** the brief refers to `packages/database`. The existing package is `packages/db` (`@dealmind/db`) and was kept to avoid churn. Rename on request.
2. **`apps/worker` does not exist yet** (Phase 7). Compose provides the shared `x-app-env` anchor and network it will use; no worker service is defined.
3. **RedisInsight auto-registration needs its EULA accepted.** It is opt-in via `REDISINSIGHT_ACCEPT_EULA` and was **not** accepted during validation. The RedisInsight → Redis connection itself was verified.
4. **Secrets are plain environment variables** (visible via `docker inspect`). Fine for local development; production needs Docker secrets or a secret manager (Phase 11).
5. **`app` profile not validated** (see Phase 1 gap 2).

## Phase 1.3 — delivered

- Schema (see [DATABASE.md](DATABASE.md)): all ids are native `uuid` (UUIDv7). `Session` renamed to `UserSession`. New `NotificationDelivery` and `BillingEvent`. `userId` FK on **every** user-owned model, including `SearchResult`, `SearchSourceRun`, `WatchlistItem` and `NotificationDelivery`. Composite `(parentId, userId)` ownership FKs. `SearchResult` snapshots price/MRP at search time. Trigram index on product titles. Explicit `onDelete` semantics (Cascade / SetNull / Restrict).
- Migrations rebuilt as `extensions` → `init` → `constraints` (36 CHECK constraints + `NULLS NOT DISTINCT` alert uniqueness). Drift check (`prisma migrate diff` against a shadow DB) is empty.
- Seed: idempotent `seedReferenceData()` (plans, disabled sources, 15-category tree) that preserves admin edits.
- `@dealmind/db` exports ownership helpers (`ownedBy`, `assertOwnedBy`, `isOwnershipViolation`).
- API: uses `UserSession`; UUID validation on id params; ownership FK violations map to 404 and other FK violations to 409.
- Tests: 56 DB integration tests on a dedicated, guarded `*_test` database (`pnpm test:db`), plus 5 unit tests.

### Phase 1.3 — known gaps / deviations

1. **Local dev database not yet migrated.** It still has the pre-1.3 schema. `prisma migrate reset` is destructive, and Prisma blocks AI agents from running it without explicit user consent, which is pending. Until then, `pnpm dev` against the dev DB will fail on the new schema. Run `pnpm --filter @dealmind/db migrate:reset` yourself, or give consent.
2. **Migration baseline was rebuilt** rather than altered (never deployed anywhere). Any other environment that applied the old migrations must be reset too.
3. **`test:db` is not part of `pnpm check`**, so `check` still runs without Docker. Run it explicitly, and in CI once CI exists.
4. **Users with billing history cannot be hard-deleted** (by design). An anonymisation/erasure flow is still to be built (Phase 10).
5. Ownership helpers exist, but most user-owned features (watchlists, alerts, …) have no API yet. They arrive in Phases 4–9.

## Phase 1.4 — delivered

See [AUTH.md](AUTH.md).

- **Sessions:** JWT and refresh tokens replaced by server-side sessions in HttpOnly cookies (`__Host-` + Secure over HTTPS), with absolute and idle expiry, rotation on login and password change, revocation of the target's sessions on role change, and family revocation on token replay.
- **CSRF:** signed double-submit tokens on all state-changing requests (including login), `Origin` allow-list, `Sec-Fetch-Site` check.
- **Endpoints:** all 14 requested endpoints, plus `GET /auth/csrf` and admin role and status management (audit-logged).
- **Enumeration safety:** registration and forgot-password respond identically for known and unknown emails; login uses one generic error with timing equalisation.
- **Brute force:** per-IP rate limits plus per-account lockout.
- **Database:** new `AuthToken` model (hashed, single-use) and `UserSession.lastUsedAt` in an incremental migration; drift check empty.
- **Email:** `EmailTransport` abstraction (SMTP, console, memory) with HTML-escaped templates for verification, reset, password-changed and account-exists emails. Mailpit (`axllent/mailpit:v1.27.11`) added to Compose.
- **Web:** Next.js same-origin `/api` proxy; login, register, forgot/reset password, verify email, settings/profile and settings/security pages; React Hook Form with the shared Zod schemas; server-side route protection; cross-tab session sync. No tokens in localStorage.
- **Tests:** 39 API integration tests (mutation-checked), 14 API unit tests, 3 shared schema tests, 14 web unit tests. Validated end to end through the real Next.js server, the API and Mailpit SMTP.
- **Security fix found during validation:** the web proxy initially forwarded client-supplied `X-Forwarded-For`, which allowed IP spoofing past the per-IP rate limits. It now trusts only `TRUSTED_PROXY_COUNT` proxy hops. Re-tested against the real stack.

### Phase 1.4 — known gaps / deviations

1. **Local dev database still not migrated** (Phase 1.3 gap 1, consent pending). All validation used the dedicated `*_test` databases. `pnpm dev` against the dev DB fails until it is reset (`pnpm --filter @dealmind/db migrate:reset`, destructive).
2. **Registration does not sign the user in.** This is required for enumeration-safe registration: the user verifies via email, then signs in. Unverified users can still sign in; no feature is gated on verification yet.
3. **Email delivery is fire-and-forget in-process** (failures are logged, not retried). Move to a BullMQ queue in Phase 7.
4. **Login lockout state is in-memory per API instance**, and per-IP rate limits likewise. Move both to Redis before running multiple API instances.
5. **`TRUSTED_PROXY_COUNT=0` in local dev** means the API sees every request as coming from the web server, so per-IP limits are shared by all local users. Fine for dev; production must sit behind Traefik with `TRUSTED_PROXY_COUNT=1`.
6. **Not built:** email-address change, account deletion/data export, 2FA/passkeys, admin bootstrap CLI, a browser-level E2E suite (Playwright). Pages were validated over HTTP (server rendering, redirects, proxy, cookies), not by clicking through in a browser.
7. **The `app` Compose profile (Docker images) is still unbuilt and untested.**
8. The dev web port 3000 is taken on this machine by another project (`ai-email-api`). Use `PORT=3100` together with `APP_URL=http://localhost:3100`.

## Phase 1.5 — Shared EasyDev services (delivered)

See [SHARED_SERVICES.md](SHARED_SERVICES.md) and [AUTH.md](AUTH.md).

- **Identity:** DealMind's own identity code was replaced by the shared IAM, with DealMind's API acting as a BFF. The browser contract is unchanged (same endpoints and cookies, so no web changes were needed). IAM tokens are stored encrypted in DealMind sessions and refreshed single-flight with a row lock. Tokens are verified via the IAM's JWKS (custom fetcher, because the IAM wraps the JWKS in its envelope). There is a local `User` mirror keyed by `iamUserId`, and IAM outages map to `503 DEPENDENCY_UNAVAILABLE`.
- **Removed duplicates:** Argon2 hashing, the `AuthToken` table, `EmailService`/nodemailer and DealMind's Mailpit. Identity emails are now sent by the IAM through the shared notification service.
- **Notifications and files:** `NotificationGateway` (`@easydev_org/notification-sdk@1.0.3`) and `FileGateway` (`@easydev_org/file-upload-sdk@1.0.4`, HMAC-signed identity built only from the verified principal). Both are reported as optional readiness checks; no feature uses them yet.
- **Password policy** aligned with the IAM (lowercase, uppercase, digit, one of `@$!%*?&`).
- **Migration** `20261114300000_iam_integration`, guarded: it refuses to run while pre-IAM users exist.
- **Shared-service changes** (with approval, via admin API): created tenant `dealmind`; enabled `auth.registration.enabled` (platform-wide). Documented with revert steps.
- **Tests:** 44 API integration tests against a contract-faithful fake IAM (mutation-checked), a live IAM contract suite (`test:contract`), and new unit tests. The contract suite caught two real behaviours the fake initially got wrong; both are documented.

### Phase 1.5 — known gaps

1. ~~Email links point to EasyDev's frontend~~ **Fixed:** the IAM now accepts a registered `appUrl` (IAM branch `feat/per-app-email-link-base`, uncommitted; local IAM image rebuilt; DealMind registered as an application). The delivered email itself couldn't be inspected because the local notification service can't send mail right now (pre-existing).
2. **Users join the IAM's `easydev` tenant**, not `dealmind`: the IAM ignores `x-tenant-id` at registration, and the membership workaround was dropped because it would need a cross-tenant escalation credential.
3. **Opening sign-up was platform-wide:** every EasyDev product sharing this IAM now allows self-registration.
4. **IAM-side revocation reaches DealMind within ~15 min** (at the next refresh), not instantly. IAM 2FA challenges aren't supported at DealMind login.
5. **IAM security issues** (password hash in the login response; unscoped `tenant:user_add`; reuse revocation not clearing the session cache; others) were reported, not fixed. See SHARED_SERVICES.md.
6. **Local dev database still on an old schema** (consent to reset pending since Phase 1.3). All validation used the `*_test` databases.
7. **Notification and file adapters are wired but unused** until Phase 7 (price alerts) and the admin catalog.

## Phase 2.1 — Fastify API foundation (partially delivered)

**Delivered:**

- Envelope `{success, data, meta:{requestId, pagination?}}` and the error envelope.
- Modules: users, categories, products, sources, search (async via BullMQ, 202), watchlists, alerts, notifications, subscriptions, and admin.
- Redis read-through cache with namespaced keys, Redis-backed rate limits and login throttle.
- Typed job contracts with deterministic job ids (`@dealmind/queue`).
- `/health`, `/ready`, and infrastructure outages mapped to 503.

The minimal worker (`apps/worker`, shopping-search consumer) was added in Phase 2.2.

**Still open:**

- Dedicated integration tests for search enqueue, watchlists, alerts, notifications, subscriptions and admin modules. Only auth (46 tests) and catalog (17 tests) have API suites.
- Price-refresh, alert-evaluation and notification-delivery consumers.
- OpenTelemetry preparation.

## Phase 2.2 — Product catalog & data management (delivered)

See [CATALOG.md](CATALOG.md).

- **Schema:**
  - Catalog models refined to the spec fields; every money column is BIGINT paise.
  - `ProductMatchReview` added for uncertain matches.
  - Price history is append-only, enforced by a trigger and tested.
  - Composite FK keeps an offer's product equal to its variant's product.
  - Hand-written migration with no data loss; drift check empty.
- **`@dealmind/catalog`:**
  - Deterministic normalization: brands, model numbers, barcodes with check digits, RAM/storage/capacity units, colours, titles.
  - Matcher: identifier → model number → normalized name → pg_trgm, with generation/qualifier/model-number guards, configurable thresholds and stored evidence.
  - Transactional importer: per-brand advisory lock, duplicate-offer prevention, change-driven snapshots, enrich-never-overwrite, manual review resolution.
  - Cache key scheme and invalidation helpers.
- **API:**
  - Category and product endpoints with filters (category subtree, canonical brand, price, stock, launch date, specification), sorting and pagination.
  - `/products/:id/history`.
  - Offer freshness: stale offers are never shown as live; sample data is flagged.
  - Per-kind cache TTLs with invalidation, and a Redis-outage fallback.
  - Admin match-review queue.
- **Seed data:** 28-category Indian tree; marketplaces stay DISABLED; dev-only sample catalog that is clearly labeled and refuses to run in production.
- **Query plans:** EXPLAIN ANALYZE on 50k products / 300k offers; the listing query now picks LATERAL vs aggregate by filter selectivity.
- **Worker:** minimal `apps/worker` consumes shopping-search jobs. With no connectors yet, it records `SKIPPED`/`NO_CONNECTOR` runs and completes with zero results.
- **Tests:**
  - db: 62
  - catalog: 16 unit + 24 DB
  - api: 63 DB (46 auth + 17 catalog) + 21 unit
  - worker: 2 DB
  - shared: 31; queue: 3; web: 14
  - `pnpm check`: 29/29 tasks green

- **Build pipeline fix:** `@dealmind/web#typecheck` now runs after `@dealmind/web#build`. `next build` rewrites `.next/types`, which `tsc` includes, so running them concurrently failed intermittently. Verified with an uncached `pnpm check --force` (29/29).

### Phase 2.2 — known gaps

1. **No real marketplace data:** no connectors exist yet (Phase 3), so matching thresholds aren't calibrated on real listings, and there's no semantic matching.
2. **Barcodes are stored on variants;** product-level identifiers are only for curated data.
3. **Product listing isn't cached.** A denormalized offer summary is the planned scale step.
4. **No admin UI** for the review queue, and no admin catalog editing (which must invalidate caches when it's added).
5. **Local dev database still needs a reset** (consent pending since Phase 1.3). All validation used `*_test` databases and a scratch DB.

## Phase 2.3 — Marketplace connector framework (delivered)

See [CONNECTORS.md](CONNECTORS.md) for the architecture and the per-marketplace integration status.

- **`@dealmind/connectors`:**
  - Zod-validated connector contract and a dynamic registry driven by `ShoppingSource`.
  - Parallel executor: bounded pool, failure-isolated, per-source timeout with abort, shared Redis rate limit, retries with exponential backoff and full jitter, circuit breakers, response cache keyed by normalized request, single-flight dedup, item-level validation.
  - Normalizers: exact rupee→paise conversion, conditional promotions kept apart from the price, price basis (`LISTED`/`VERIFIED_CHECKOUT`/`INDICATIVE`), provenance.
  - Health monitor, metrics (Redis store and OpenTelemetry instruments) and pino logs.
- **Connectors:**
  - Flipkart Affiliate API 1.0 is implemented from the public docs. It is **not live-verified** and awaits credentials.
  - Amazon Creators API is credential-gated with no client yet, because key details can't be verified from public docs.
  - Croma, Reliance Digital and Tata CLiQ await partner approval.
  - Web discovery has a provider interface but no provider.
  - Two mock stores serve fictional data for dev and tests.
  - **No connector is live.**
- **Schema:** `SourceStatus` gains `PENDING_CREDENTIALS`/`PENDING_APPROVAL`. Sources gain `statusReason`, `lastSuccessAt`, cache TTL and circuit settings. The seed sets every marketplace's researched status and reason.
- **Worker:**
  - Searches run through the executor. Offers are persisted via the catalog importer, and the worker writes per-source runs (with skip reasons) and ranked results using a deterministic baseline ranking. Status is COMPLETED/PARTIAL/FAILED.
  - A `connector-health` job scheduler runs health checks.
  - Smoke-tested by running the built worker against a disposable database: it processed a queued search and ran the health job.
- **API:** `GET /api/v1/sources` (all sources with `connectorStatus` and reason) and `GET /api/v1/sources/:id` (by id or slug, with tuning and metrics; never secrets).
- **Bug fixed (from Phase 2.1):**
  - BullMQ rejects job ids containing `:`, and every deterministic job id used colons, so **searches could never be enqueued**.
  - The ids now use `.` as the separator.
  - A new API test enqueues into real BullMQ; it was mutation-checked and fails with the old format.
- **Tests:**
  - connectors: 30 unit tests (all 13 required categories, Flipkart contract, pending connectors, normalization) + 6 Redis/DB
  - worker: 6 DB
  - api: 67 DB (+3 search, +2 sources)
  - db: 63; queue: 4

### Phase 2.3 — known gaps

1. **No live marketplace integration.** Every real source is pending credentials or approval. Flipkart's connector has never run against the real API, and its `offers` strings are classified by keyword, which is a heuristic.
2. **Circuit breaker state is per process,** not shared across workers. Health status is shared through the database.
3. **Single-flight dedup is per process.** Across processes, the shared cache prevents repeats only once the first response is cached.
4. **Results ranking is a simple baseline** (text relevance, then price). The real ranking engine is Phase 4.
5. **No OpenTelemetry SDK or exporter is installed yet** (Phase 11), so the instruments are no-ops.
6. **No admin API to change source status or tuning;** it's a database change for now.

## Phase 3.1 — Python LangGraph shopping agent (delivered)

See [AGENT.md](AGENT.md).

- **`apps/agent`** (Python 3.12, LangGraph 1.2, FastAPI, Pydantic 2, SQLAlchemy 2, httpx, structlog, OpenTelemetry API):
  - 13 nodes with conditional edges and bounded iterations, plus a TypedDict state.
  - Pydantic validation of all LLM output and external data; budget grounding (no invented or adjusted budgets).
  - Provider abstraction (Gemini, OpenAI, explicit fallback, dev-only rules) and grounded response narration.
  - Postgres checkpointing in its own schema, with resume on retry.
  - Internal API (`/internal/agent`) protected by a service token.
  - Dockerfile: non-root, uv-locked.
- **Fastify `/internal/v1`** (service token; never routed by Traefik):
  - Reuses `@dealmind/connectors` (eligibility, parallel search) and `@dealmind/catalog` (normalization, matching, canonical specs).
  - Reuses the new deterministic `@dealmind/intelligence` package (genuine-discount pricing engine and deal ranking, integer bp).
  - Owner-checked persistence driven by a **signed user context** (HMAC), with prices always taken from the database.
- **Public API:** `GET /api/v1/search/:id` now includes interpretation, summary, warnings and the agent run. Added `POST /api/v1/search/:id/cancel` and `GET /api/v1/search/:id/events` (SSE).
- **Worker:** supervises the agent. It reuses the execution id across retries (checkpoint resume), times out, cancels, and marks FAILED only on the final attempt.
- **Compose:** `worker` and `agent` services added (app profile, internal network only).
- **Verification:**
  - `pnpm check --force` 40/40 tasks, including ruff, mypy --strict and pytest.
  - pytest: 47.
  - API DB tests: 80, including 13 internal-API and 3 search tests.
  - Worker DB tests: 6.
  - Cross-language E2E: built API + worker + Python agent with Postgres checkpointer, on a disposable database.
  - The agent Docker image was built and smoke-tested: healthy, non-root, 401 without a token.
- **Bugs found by the E2E and fixed:**
  - psycopg async can't use Windows' Proactor loop, so the service now runs through `python -m app` with a selector loop.
  - The rule-based extractor parsed the prompt wrapper into the keywords.
  - Ranking relevance was measured against filler words instead of the planned keywords.

### Phase 3.1 — known gaps

1. **No real LLM was exercised** (no API key here). Gemini and OpenAI are tested with a stub chat model; the E2E used the dev-only `rules` extractor.
2. **No live marketplaces** (Phase 2.3 status), so results come from mock stores only.
3. **The agent's in-memory execution registry is per instance.** Multiple replicas need sticky routing or a shared registry.
4. **Cancellation happens at node boundaries.**
5. **The worker image was not built** (same pattern as the API image).
6. **Ranking is a baseline:** no semantic relevance or personalization.
7. **The local dev database still needs the pending reset.**

## Phase 3.2 — Product matching & deduplication (delivered)

See [MATCHING.md](MATCHING.md).

- **Engine** (`packages/intelligence/src/matching`, independent of LangGraph/LLMs):
  - Normalizers, matchers (GTIN/EAN/UPC → MPN → brand+model → title → pg_trgm → optional pgvector), `scorePair` with evidence and conflicts, variant placement, category profiles.
  - Thresholds configurable and validated (fuzzy/semantic can never reach auto-merge).
- **Deduplication:** transactional importer (moved from `@dealmind/catalog`), duplicate offers by canonical URL, bounded duplicate-product scan (always review), duplicate variant/offer reports, `mergeProducts` on approval only.
- **Audit + review:** append-only `ProductMatchAudit` (trigger-enforced). Reviews resolved once, by an ACTIVE ADMIN only; via the internal API additionally a short-lived, match-bound reviewer context signed with `REVIEW_CONTEXT_SECRET`, which the agent never has.
- **Internal API:** `POST /internal/v1/intelligence/match`, `/match/batch`, `GET /intelligence/matches/:id`, `POST /intelligence/matches/:id/review`.
- **Python agent:** `match`, `match_batch`, `get_match` client methods (no review method).
- **Connectors:** optional `mpn` in the normalized product contract.
- **Migration** `20261118100000_matching_engine` (see DATABASE.md).
- **Verification:** `pnpm check --force` 40/40 tasks. DB suites: db 63, intelligence 26, API 88 (8 new matching-endpoint tests), connectors 6, worker 6. Unit: intelligence 13 (labelled accuracy), catalog 18. pytest 53. Migration drift check is empty.
- **Benchmark** (`bench:matching`, synthetic data): 0 false auto-merges and 0 wrong product/variant at 2k and 10k products. Numbers are in MATCHING.md.
- **Normalizer fixes found by the labelled dataset:** `S25+` vs `S25`, lone storage capacity, title colour in the variant key, colour spelling/order.

### Phase 3.2 — known gaps

1. **Thresholds are validated on 46 hand-labelled pairs and synthetic benchmarks only** — no real marketplace corpus exists yet (no live connectors).
2. **Semantic matching uses a lexical hash embedder**, not a learned embedding model; it is off by default and can only surface review candidates.
3. **No issuer for reviewer contexts yet** (admin UI/backend is Phase 10); listing reviews still work through the cookie-authenticated admin API.
4. **Throughput:** import 35 → 26 listings/s and `matchListing` p50 8 → 29 ms from 2k → 10k synthetic products. The trigram candidate query is a seq scan on near-identical synthetic titles. A stored brand key and an index would be the next step.
5. **The local dev database still needs the pending reset** before this migration can be applied there.

## Phase 3.3 — Pricing, genuine discounts and deal ranking (delivered)

See [PRICING.md](PRICING.md).

- **Pricing engine** (`packages/intelligence/src/pricing`, BigInt paise, basis points rounded down):
  - direct discount with validation (missing MRP → no discount; price above MRP only with an explicit exception);
  - price ladder: delivered, coupon, bank offer, membership and best verified payable (no stacking);
  - cashback and exchange shown separately;
  - EMI cost transparency;
  - conditional-offer status (VERIFIED / UNVERIFIED / EXPIRED / INELIGIBLE; only verified, eligible benefits apply);
  - coverage-aware 7/30/90/180-day history with honest lowest-price wording and verified drops.
- **Ranking engine** (`packages/intelligence/src/ranking`):
  - hard filters with reported exclusions, null-aware score components and per-mode strategies;
  - modes: highest_discount, lowest_price, best_value, recently_launched, price_drop, trending_deals (honest fallback) and relevance;
  - data-derived explanations, including why a deal beat the next one;
  - affiliate-neutral by construction.
- **Internal API:** `pricing/calculate`, `pricing/batch`, `pricing/history/:offerId`, `ranking/rank`, `ranking/compare`, with Zod request and response schemas. The old `/intelligence/pricing` and `/intelligence/rank` were removed.
- **Ranking provenance:** `agent-result` only accepts ranks and scores matching a ranking token signed by the API, so the agent can't forge, reorder or rescore deals.
- **Connectors:** promotions gain eligibility terms and `verified` (default false); products gain `fees` and `emiOptions`.
- **Python agent:** stated-only eligibility extraction; pricing and ranking through the new endpoints (hard filters re-applied on DB prices); persists the engine's explanations; new sort modes.
- **Also fixed:** `discountBasisPoints` used float division (now exact BigInt); a flaky auth test asserted ciphertext never contains "eyJ" (random ciphertext can), and now checks the actual JWT parts instead.
- **Verification:**
  - `pnpm check --force` 40/40 tasks.
  - Unit: intelligence 50 (26 pricing, 14 ranking), shared 31, catalog 18, connectors 30.
  - DB: API 96 (8 new pricing/ranking tests), db 63, intelligence 26, connectors 6, worker 6.
  - pytest 58 (5 new); `prisma validate` OK; no migration needed (everything is in `offerConditions` JSON).
  - Cross-language E2E (built API + worker + Python agent, Postgres checkpointer, disposable DB): COMPLETED, 4 variant-correct offers persisted with engine ranks, scores and explanations accepted via the ranking token, 15 checkpoints.

### Phase 3.3 — known gaps

1. **No benefit can be VERIFIED yet.** No authorized connector exposes checkout-verified offers, so coupon, bank and membership prices stay null and rankings use delivered prices.
2. **No quality or popularity data:** `quality` is unused and `trending_deals` falls back to best_value with a warning.
3. **History is per marketplace listing** and only exists while an offer is observed; claims get more frequent once price tracking (Phase 7) observes offers regularly.
4. **DB batch pricing loads raw snapshots** (~640 ms for 400 offers × 180 days); SQL-side aggregation is the next step if needed.
5. **best_value weights are reasoned defaults**, not tuned on user outcomes.
6. **The local dev database still needs the pending reset.**

## Phase 4.1 — Frontend dashboard (delivered)

See [FRONTEND.md](FRONTEND.md).

- **`apps/web`:** every route listed in FRONTEND.md, built on the existing auth pages, proxy and cookie sessions. Settings moved into the app shell.
- **Design system:** "ink & emerald" tokens (light and dark), with emerald for verified data, amber for conditional data and indigo for the AI. Shadcn-style components are on Radix.
- **Price history chart:** validated categorical palette, legend, direct labels, dashes, keyboard crosshair and table view.
- **Typed services and TanStack Query hooks** over the real Fastify endpoints. Session-expiry handling; retries for transient errors only.
- **Backend additions for the UI:**
  - `GET /api/v1/products/:id/pricing`;
  - current `pricing` on each search result;
  - `sortMode`/`specs` search filters (explicit overrides honoured by the agent);
  - `sources_planned`/`source_finished` SSE events;
  - pricing result schemas moved to `@dealmind/shared`.
- **Proxy fix:** the Next.js proxy now **streams** Server-Sent Events. It previously buffered them, so live progress would not have worked.
- **Verification:**
  - `pnpm check --force` 40/40 tasks.
  - Web: Vitest 34, Playwright 14 (desktop + mobile, axe on 9 pages in light and dark mode), production build OK.
  - API DB 97 (1 new: product pricing endpoint), intelligence 26, db 63, connectors 6, worker 6; pytest 59 (2 new: marketplace events, explicit sort/spec overrides).
  - Cross-language E2E: COMPLETED, all 29 progress events, including the new ones, accepted by the API.
- **Found by tests and fixed:**
  - axe: low-contrast emerald and amber text in light mode;
  - invalid ARIA on the search input;
  - Radix Tabs used as filters without panels (replaced by a segmented control);
  - TanStack passing its mutation context into service functions.

### Phase 4.1 — known gaps

1. **Data is mock or sample only** until a marketplace connector is authorized; the UI labels it.
2. **Price alerts are saved but not evaluated** (no price-tracking worker until Phase 7); the UI says so.
3. **No payments:** plan upgrades are disabled.
4. **No saved eligibility profile** (banks, cards, memberships), so displayed prices never apply conditional benefits.
5. **No Playwright run against the real Fastify API.** Web ↔ API is covered with a contract-checked mock API; API ↔ worker ↔ agent with the cross-language E2E.
6. **Dashboard and search pages load about 260 kB of JS**, not yet profiled.
7. **The local dev database still needs the pending reset.**

## Phase 4.2 — AI shopping search and real-time results (delivered)

See [FRONTEND.md](FRONTEND.md#ai-shopping-search-phase-42).

- **Web:**
  - Combobox search with recent, catalog (debounced, aborted when superseded) and example suggestions; optional voice input; edit and re-run.
  - Dynamic filters from category data; ranking explanations.
  - Timeline driven only by agent events; every marketplace with its real state and reason.
  - List/grid/sort/pagination in the URL; partial, expired, failed and no-match states.
  - Compare tray and a multi-product compare page that labels different variants and products.
  - 20 s request timeout.
- **API:**
  - `GET /categories/:slug/filters`;
  - `GET /search/:id/results?sort=` (re-orders stored results, never re-ranks);
  - `searchDetail.ranking` (mode, and whether the user or the AI chose it);
  - results carry `modelNumber`, `launchDate` and `variantAttributes`;
  - a duplicate-submission guard (same user, query and filters, still running, within 30 s);
  - canonical-specs keeps canonical capacity keys.
- **Shared:**
  - `searchFilters` gains `minDiscountPercent`, `launchedWithinDays` and `inStockOnly`;
  - `categoryFilters` and `searchResultsQuery` contracts;
  - `USER_RANKING_MODES`;
  - spec label helpers.
- **Agent:** explicit discount, launch-window and availability filters are hard filters (an unknown launch date is excluded when a window is required).
- **Verification:**
  - `pnpm check --force` 40/40.
  - Web: tsc and eslint clean; Vitest 63 (29 new), Playwright 16 (axe on 11 pages in light and dark mode), production build OK.
  - API DB 103 (6 new); shared 36 (5 new); pytest 61 (2 new).
  - Cross-language E2E (real API, worker and Python agent) with explicit filters: COMPLETED. The interpretation shows `in_stock_only`, `min_discount_bp: 500`, `sort_mode: lowest_price`, and `required_specs: {ram_gb: 8}` from the facet value "8 GB". Results came back in lowest-delivered order, and the 5 unauthorized marketplaces were recorded as skipped (`SOURCE_NOT_ACTIVE`).
- **Found and fixed:**
  - Capacity facet values (`capacity_l`) would have been dropped by canonical-specs.
  - The screen-reader name "Marketplacesfor …".
  - A "Search by voice" button collided with test selectors for "Search".
  - Finished searches without replayed events showed steps as "not reached"; they are now "not reported".

### Phase 4.2 — known gaps

1. **Marketplace data is still mock or sample only;** real marketplaces show as pending approval, credentials unavailable or disabled.
2. **Skip reasons while running.** A marketplace skipped at planning shows its current connector status until the run is saved, because `sources_planned` has no reasons.
3. **The comparison selection isn't persisted** across reloads; the compare URL is.
4. **No rating filter** (no verified rating data).
5. **The E2E mock prices every variant the same;** real per-variant pricing is covered by API tests.
6. **Phase 4.1 gaps 2–5 still apply,** and **the local dev database still needs the pending reset.**
