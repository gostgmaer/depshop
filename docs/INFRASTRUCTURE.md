# Local Docker infrastructure

DealMind is a single-platform, multi-user application: **one** PostgreSQL
database and **one** Redis serve every user. There are no tenant-specific
services, databases, schemas or configuration.

## Services

| Service                            | Image (pinned)                                            | Profile            | Host port (127.0.0.1 only) | In-network address |
| ---------------------------------- | --------------------------------------------------------- | ------------------ | -------------------------- | ------------------ |
| `postgres`                         | `pgvector/pgvector:0.8.0-pg17` (PostgreSQL 17 + pgvector) | default            | `POSTGRES_PORT` (5432)     | `postgres:5432`    |
| `redis`                            | `redis:7.4.2-alpine`                                      | default            | `REDIS_PORT` (6379)        | `redis:6379`       |
| `pgadmin`                          | `dpage/pgadmin4:9.0`                                      | `tools` (dev only) | `PGADMIN_PORT` (5050)      | n/a                |
| `redisinsight`                     | `redis/redisinsight:2.70.1`                               | `tools` (dev only) | `REDISINSIGHT_PORT` (5540) | n/a                |
| `traefik`, `migrate`, `api`, `web` | see `docker-compose.yml`                                  | `app`              | `HTTP_PORT` (80)           | n/a                |

- **Network:** every container joins the bridge network `dealmind`. Containers
  reach each other by service name; containers outside it cannot resolve them.
- **Volumes:** `dealmind_postgres-data`, `dealmind_redis-data`,
  `dealmind_pgadmin-data`, `dealmind_redisinsight-data`.
- **Restart policy:** `unless-stopped` on long-running services.
- **Health checks:** `pg_isready` (Postgres), authenticated `PING` (Redis),
  `/misc/ping` (pgAdmin), `/api/health` (RedisInsight). Dependent services wait
  on `service_healthy`.
- **Ports:** all published ports bind to `127.0.0.1`, so nothing is reachable
  from other machines. Production must not publish Postgres or Redis at all.

### PostgreSQL

- Extensions: `pg_trgm` (fuzzy title matching) and `vector` (pgvector).
  - The Prisma migration `20261114010000_extensions` is the source of truth. It
    creates `vector` only when the server offers it, so it also works on plain
    PostgreSQL.
  - `infrastructure/docker/postgres/init/01-extensions.sh` also installs both
    into `template1` on first start, so Prisma's shadow database (used by
    `prisma migrate dev`) has them too.
- `POSTGRES_USER` owns the database and can create databases (needed for the
  Prisma shadow DB in development).

### Redis

- Config: `infrastructure/docker/redis/redis.conf`. Password via
  `REDIS_PASSWORD` (`--requirepass`), never stored in the file.
- Persistence: AOF (`appendfsync everysec`) plus RDB snapshots.
- `maxmemory-policy noeviction` is **required by BullMQ**; evicting keys
  corrupts queues. Cache entries must always set a TTL.

### pgAdmin

`infrastructure/docker/pgadmin/entrypoint.sh` pre-registers a server called
"DealMind (local)" (host `postgres`) and writes its password file from `.env`,
so it connects without a password prompt. Server registration is only imported
on pgAdmin's **first** start (empty volume).

### RedisInsight

The DealMind Redis connection is pre-registered **only after RedisInsight's
EULA is accepted**. RedisInsight enforces this, not DealMind. Either:

- accept the EULA in the UI on first visit, then
  `docker compose --profile tools restart redisinsight`; or
- set `REDISINSIGHT_ACCEPT_EULA=true` in `.env` if you accept the
  [licence terms](https://redis.io/legal/redis-insight-license-terms/).

Otherwise add it manually: host `redis`, port `6379`, password `REDIS_PASSWORD`.

## First-time setup

```bash
cp .env.example .env    # replace every change_me (see generator command inside)
pnpm install
pnpm infra:up           # docker compose up -d
pnpm infra:ps           # wait until postgres and redis are "healthy"
pnpm db:generate
pnpm --filter @dealmind/db build
pnpm db:migrate         # prisma migrate deploy
pnpm db:seed            # plans + shopping sources (all disabled)
```

> **Port already in use?** Another project may already publish 5432, 6379 or 5050. Change `POSTGRES_PORT` / `REDIS_PORT` / `PGADMIN_PORT` /
> `REDISINSIGHT_PORT` in `.env` **and** the port in `DATABASE_URL` / `REDIS_URL`.
> Find the culprit with `docker ps --format '{{.Names}}\t{{.Ports}}'`.

> **Use `127.0.0.1`, not `localhost`, in host-side URLs.** Ports bind to IPv4
> loopback only, and some clients (including Prisma's engine on Windows) try
> IPv6 `::1` first and fail with `P1001`.

## Day-to-day commands

| Task                                       | Command                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| Start core infra (Postgres, Redis)         | `docker compose up -d` · `pnpm infra:up`                                |
| Start admin UIs too                        | `docker compose --profile tools up -d` · `pnpm infra:tools`             |
| Status and health                          | `docker compose --profile tools ps` · `pnpm infra:ps`                   |
| Follow all logs                            | `docker compose --profile tools logs -f --tail=100` · `pnpm infra:logs` |
| Logs for one service                       | `docker compose logs -f postgres`                                       |
| Restart a service                          | `docker compose restart redis`                                          |
| Stop (keep containers)                     | `docker compose --profile tools stop` · `pnpm infra:stop`               |
| Stop and remove containers (**data kept**) | `docker compose --profile tools down` · `pnpm infra:down`               |
| Health of one container                    | `docker inspect -f '{{.State.Health.Status}}' dealmind-postgres-1`      |

`down` removes containers and the network but **keeps named volumes**, so all
data survives. Avoid `docker compose down -v` in routine use: it deletes every
volume.

### Connecting to PostgreSQL

```bash
# psql inside the container (no local client needed)
docker compose exec postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'

# From the host with any client: use DATABASE_URL from .env (host 127.0.0.1)
# pgAdmin:  http://127.0.0.1:${PGADMIN_PORT}  → log in with PGADMIN_EMAIL / PGADMIN_PASSWORD
# Prisma Studio:  pnpm db:studio
```

### Connecting to Redis

```bash
docker compose exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli'
# From the host: REDIS_URL from .env.   RedisInsight: http://127.0.0.1:${REDISINSIGHT_PORT}
```

### Migrations

```bash
pnpm db:migrate        # apply pending migrations (prisma migrate deploy)
pnpm db:status         # show migration status
pnpm db:migrate:dev    # create a new migration from schema changes (dev only)
```

DB package scripts load the repo-root `.env` through `dotenv-cli`. Variables
already set in the environment (as in containers) take precedence.

### Resetting development data

Choose the narrowest option:

```bash
# 1. Wipe the app schema and re-apply migrations + seed (keeps the volume)
pnpm --filter @dealmind/db migrate:reset

# 2. Flush Redis only (queues, caches)
docker compose exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli FLUSHALL'

# 3. Recreate one volume from scratch (re-runs the Postgres init script)
docker compose stop postgres && docker compose rm -f postgres
docker volume rm dealmind_postgres-data
docker compose up -d postgres && pnpm db:migrate && pnpm db:seed
```

All three permanently delete local data. Never run them against a shared or
production database.

## Connecting the applications

| App                                                            | Runs on host (`pnpm dev`)                                    | Runs in Docker (`app` profile)                |
| -------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------- |
| `apps/api`                                                     | `DATABASE_URL`, `REDIS_URL` from `.env` (`127.0.0.1:<port>`) | `postgres:5432`, `redis:6379` via `x-app-env` |
| `apps/worker` (Phase 7)                                        | same                                                         | same (reuses `x-app-env`)                     |
| `packages/db` (Prisma; the brief calls it `packages/database`) | `.env` via `dotenv-cli`                                      | `migrate` service                             |
| `apps/web`                                                     | talks to the API only, never to Postgres or Redis            | same                                          |

## Security notes

- `.env` is git-ignored and excluded from the Docker build context.
  `.env.example` contains placeholders only.
- Credentials are passed as environment variables. The Redis password is
  visible to anyone who can run `docker inspect` on this machine, which is
  acceptable for local development. Production should use a secret manager or
  Docker secrets.
- The `tools` profile (pgAdmin, RedisInsight) is for development only and must
  never be enabled in production.
- Production must use unique strong credentials, must not publish
  Postgres or Redis ports, and should enable TLS (planned for Phase 11).

## Validation results (2026-11-14, Docker Desktop 29.0.1 on Windows 11)

Run against a fresh volume. Host ports were moved to 15432/16379/15050/15540
because other local projects already used the defaults.

| #   | Check                                                                                                                                                                                                       | Result                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | `docker compose up -d` and `--profile tools up -d` start all 4 containers                                                                                                                                   | ✅                                              |
| 2   | Postgres becomes `healthy`; init script installs `pg_trgm 1.6` and `vector 0.8.0` in `dealmind` and `template1`                                                                                             | ✅                                              |
| 3   | Redis becomes `healthy`; unauthenticated `PING` → `NOAUTH`; authenticated → `PONG`; `noeviction` and `appendonly yes` active                                                                                | ✅                                              |
| 4   | pgAdmin: logged in via its API, the pre-registered "DealMind (local)" server connected to `postgres:5432` (PostgreSQL 17.6) with no password prompt and listed the `dealmind` DB                            | ✅                                              |
| 5   | RedisInsight: `POST /api/databases/test` against `redis:6379` → 200 with the right password, 424 with a wrong one. Auto-registration needs the EULA (not accepted on your behalf)                           | ✅ connection · ⚠️ auto-registration needs EULA |
| 6   | Persistence: Postgres row and Redis key survived `docker compose restart` **and** `down` + `up`; the pgAdmin server registration also survived                                                              | ✅                                              |
| 7   | App network: a throwaway container on `dealmind` reached `postgres:5432` (queried seeded tables) and `redis:6379` (PING, stream XADD/XLEN). A container outside the network could not resolve `postgres`    | ✅                                              |
| 8   | Prisma from host: both migrations applied, seed ran, `migrate status` up to date; `similarity()` and `vector <->` work                                                                                      | ✅                                              |
| 9   | API (built) on host against real Postgres: readiness `database: ok`; register, me, login, refresh, replay → 401, duplicate → 409; DB shows a FREE subscription, preferences and correct session revocations | ✅                                              |

Not validated in this phase: building and running the `app` profile images
(`traefik`, `migrate`, `api`, `web`).
