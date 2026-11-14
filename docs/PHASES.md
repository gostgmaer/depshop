# Implementation phases

Each phase ends with: typecheck → lint → test → production build → docs update →
explicit report of incomplete work. Status is only marked **Done** when all of
those pass.

| #   | Phase                                                                                                                                                                       | Status                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Foundation: monorepo, tooling, data model, auth, RBAC, errors, API docs, web scaffold, Compose                                                                              | **Done** (see gaps below) |
| 1.2 | Docker development infrastructure: Postgres + pgvector, Redis (auth, BullMQ-safe), pgAdmin, RedisInsight, health checks, network, volumes, operations docs                  | **Done** (see gaps below) |
| 1.3 | Database: UUIDv7 ids, UserSession, NotificationDelivery, BillingEvent, userId on every user-owned model, composite ownership FKs, CHECK constraints, seed, DB tests         | **Done** (see gaps below) |
| 2   | Web auth & account: login/register UI, session handling, profile, preferences API + UI                                                                                      | Not started               |
| 3   | Connector framework: registry, capability declarations, health checks, timeouts, rate limits, retries, normalization; admin connector management                            | Not started               |
| 4   | Search engine: parallel bounded-concurrency fan-out, partial results, per-source errors, variant matching, dedup, deterministic filters & ranking, persistence of searches  | Not started               |
| 5   | AI layer (LangGraph.js): intent extraction, planning, source selection, orchestration, evaluation, explanation; structured outputs; configurable provider; AgentRun records | Not started               |
| 6   | Search & comparison UI, new-launch discovery                                                                                                                                | Not started               |
| 7   | Price tracking: BullMQ scheduled jobs, per-source rate limits, price snapshots, alert evaluation, notifications                                                             | Not started               |
| 8   | Watchlists, alerts & notifications UI                                                                                                                                       | Not started               |
| 9   | Monetization: plans, usage limits & metering, affiliate links, click attribution, conversion/commission reporting                                                           | Not started               |
| 10  | Admin console: users, catalog, connectors, AI model config, platform settings, subscriptions, affiliate & usage analytics, job monitoring                                   | Not started               |
| 11  | Observability & hardening: OpenTelemetry, Sentry, production Traefik (TLS), slim images, security review, load testing                                                      | Not started               |

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
3. **Access tokens are not checked against user status.** A suspended user's existing access token remains valid until expiry (≤ 15 min); refresh is blocked immediately. Revisit if stricter revocation is needed.
4. **No email verification or password reset** (schema has `emailVerifiedAt`; flows are not implemented).
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
