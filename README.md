# DealMind AI

India-first shopping intelligence: search multiple stores in natural language,
compare identical products, find genuine discounts, and track prices.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Roadmap & status (including known gaps): [docs/PHASES.md](docs/PHASES.md)
- Docker infrastructure, operations & troubleshooting: [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md)
- Database schema, ownership model & tests: [docs/DATABASE.md](docs/DATABASE.md)
- Authentication, sessions, CSRF & configuration: [docs/AUTH.md](docs/AUTH.md)
- Shared EasyDev services (IAM, notifications, files), changes made, known issues: [docs/SHARED_SERVICES.md](docs/SHARED_SERVICES.md)
- API docs: run the API and open `http://127.0.0.1:4000/docs`

## Requirements

Node.js ≥ 22, pnpm 10 (`corepack enable`), Docker with Compose v2, and the
shared EasyDev services running (IAM, notification and file-upload services;
see [docs/SHARED_SERVICES.md](docs/SHARED_SERVICES.md)).

## Getting started

```bash
cp .env.example .env    # replace every change_me and set SESSION_SECRET
pnpm install
pnpm infra:up           # Postgres (+pgvector) and Redis; wait for "healthy" in `pnpm infra:ps`
pnpm db:generate
pnpm --filter @dealmind/db build
pnpm db:migrate         # applies prisma/migrations
pnpm db:seed            # plans + shopping sources (all disabled)
pnpm dev                # API on :4000, web on :3000 (this machine: PORT=3100, see below)
```

The API and DB scripts load the repo-root `.env` automatically. `APP_URL` must
match where the web app runs **and** the `dealmind` application registered in
the IAM (here `http://localhost:3100`, since port 3000 is taken locally):
`PORT=3100 pnpm --filter @dealmind/web dev`. Optional
dev-only admin UIs (pgAdmin, RedisInsight): `pnpm infra:tools`.

Full containerised stack behind Traefik (web at `http://localhost`, API at
`http://localhost/api`; not yet validated, see PHASES.md):

```bash
docker compose --profile app up -d --build
```

## Quality gates

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check      # all of the above (no Docker needed)
pnpm test:db    # database integration tests (needs `pnpm infra:up`)
pnpm --filter @dealmind/api test:contract   # live contract test against the shared IAM
```

## Making the first admin

There is no self-service admin signup. Register normally, then:

```sql
UPDATE "User" SET role = 'ADMIN' WHERE email = 'you@example.com';
```

Log in again to receive an access token carrying the new role.
