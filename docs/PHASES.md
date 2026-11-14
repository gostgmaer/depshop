# Implementation phases

Each phase ends with: typecheck → lint → test → production build → docs update →
explicit report of incomplete work. Status is only marked **Done** when all of
those pass.

| #   | Phase                                                                                                                                                                                              | Status                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Foundation: monorepo, tooling, data model, auth, RBAC, errors, API docs, web scaffold, Compose                                                                                                     | **Done** (see gaps below) |
| 1.2 | Docker development infrastructure: Postgres + pgvector, Redis (auth, BullMQ-safe), pgAdmin, RedisInsight, health checks, network, volumes, operations docs                                         | **Done** (see gaps below) |
| 1.3 | Database: UUIDv7 ids, UserSession, NotificationDelivery, BillingEvent, userId on every user-owned model, composite ownership FKs, CHECK constraints, seed, DB tests                                | **Done** (see gaps below) |
| 1.4 | Individual user authentication: cookie sessions, CSRF, email verification, password reset/change, session management, profile & preferences, RBAC middleware, Mailpit, auth UI                     | **Done** (see gaps below) |
| 1.5 | Shared EasyDev services: identity via the shared IAM (BFF), notification and file-upload SDK adapters; DealMind's own password/email/Mailpit code removed                                          | **Done** (see gaps below) |
| 2.1 | Fastify API foundation: response envelope, modules (catalog, search, watchlists, alerts, notifications, subscriptions, admin), Redis cache/rate limits, BullMQ job contracts, `/health` + `/ready` | Partially done (see gaps) |
| 2.2 | Product catalog & data management: catalog model refinement (BIGINT paise), normalization, matching/dedup, import/upsert, catalog APIs, caching, seed + sample data, query plans                   | **Done** (see gaps below) |
| 2   | ~~Web auth & account~~: delivered in 1.4. Remaining: admin bootstrap CLI, email change flow                                                                                                        | Partially done (1.4)      |
| 3   | Connector framework: registry, capability declarations, health checks, timeouts, rate limits, retries, normalization; admin connector management                                                   | Not started               |
| 4   | Search engine: parallel bounded-concurrency fan-out, partial results, per-source errors, variant matching, dedup, deterministic filters & ranking, persistence of searches                         | Not started               |
| 5   | AI layer (LangGraph.js): intent extraction, planning, source selection, orchestration, evaluation, explanation; structured outputs; configurable provider; AgentRun records                        | Not started               |
| 6   | Search & comparison UI, new-launch discovery                                                                                                                                                       | Not started               |
| 7   | Price tracking: BullMQ scheduled jobs, per-source rate limits, price snapshots, alert evaluation, notifications                                                                                    | Not started               |
| 8   | Watchlists, alerts & notifications UI                                                                                                                                                              | Not started               |
| 9   | Monetization: plans, usage limits & metering, affiliate links, click attribution, conversion/commission reporting                                                                                  | Not started               |
| 10  | Admin console: users, catalog, connectors, AI model config, platform settings, subscriptions, affiliate & usage analytics, job monitoring                                                          | Not started               |
| 11  | Observability & hardening: OpenTelemetry, Sentry, production Traefik (TLS), slim images, security review, load testing                                                                             | Not started               |

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
