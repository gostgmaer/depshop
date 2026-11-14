# Implementation phases

Each phase ends with: typecheck → lint → test → production build → docs update →
explicit report of incomplete work. Status is only marked **Done** when all of
those pass.

| #   | Phase                                                                                                                                                                       | Status                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Foundation: monorepo, tooling, data model, auth, RBAC, errors, API docs, web scaffold, Compose                                                                              | **Done** (see gaps below) |
| 1.2 | Docker development infrastructure: Postgres + pgvector, Redis (auth, BullMQ-safe), pgAdmin, RedisInsight, health checks, network, volumes, operations docs                  | **Done** (see gaps below) |
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

1. **Partially closed in 1.2.** Migrations now apply cleanly to real PostgreSQL 17, and `PrismaUserStore` was exercised end to end by a manual smoke test (register, login, refresh rotation, replay revocation, duplicate email). There is still **no automated** DB-backed integration test → add one in Phase 2.
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
