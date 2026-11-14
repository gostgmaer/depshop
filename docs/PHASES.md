# Implementation phases

Each phase ends with: typecheck → lint → test → production build → docs update →
explicit report of incomplete work. Status is only marked **Done** when all of
those pass.

| #   | Phase                                                                                                                                                                       | Status                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 1   | Foundation: monorepo, tooling, data model, auth, RBAC, errors, API docs, web scaffold, Compose                                                                              | **Done** (see gaps below) |
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

1. **Not verified against a real database.** Docker was not running in the build environment. The initial migration was generated with `prisma migrate diff` from the schema, and API tests use an in-memory `UserStore`. `PrismaUserStore` has no integration test yet → add Testcontainers/Compose-backed integration tests (Phase 2).
2. **Docker images and Compose not built or run.** The Dockerfiles and `docker-compose.yml` are written but untested.
3. **Access tokens are not checked against user status.** A suspended user's existing access token remains valid until expiry (≤ 15 min); refresh is blocked immediately. Revisit if stricter revocation is needed.
4. **No email verification or password reset** (schema has `emailVerifiedAt`; flows are not implemented).
5. **No admin bootstrap command.** Promote the first admin manually: `UPDATE "User" SET role='ADMIN' WHERE email='…';` → CLI to be added in Phase 10.
6. **Redis is provisioned but unused**; rate-limit state is in-process memory (per-instance). Move to Redis store in Phase 7 when Redis becomes a hard dependency.
7. **No web tests yet**; web UI is a static landing page.
8. **Runtime API image is not slimmed** (includes dev dependencies).
