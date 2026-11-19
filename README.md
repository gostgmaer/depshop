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

### Start here

| I want to…                                                                                              | Read                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run it on my machine                                                                                    | [Getting started](#getting-started) below                                                                                                                                                      |
| Know every env variable / API key, which service needs it, how to generate it                           | [docs/SECRETS.md](docs/SECRETS.md)                                                                                                                                                             |
| Connect an external service (AI model, sign-in, e-mail, push, payments, marketplaces/affiliates, files) | [docs/integrations/](docs/integrations/README.md)                                                                                                                                              |
| Deploy to staging / production                                                                          | [docs/production-deployment.md](docs/production-deployment.md), then [docs/production-go-live.md](docs/production-go-live.md)                                                                  |
| Create the first administrator                                                                          | [Making the first admin](#making-the-first-admin) below                                                                                                                                        |
| Operate, roll back, recover                                                                             | [docs/production-operations-handbook.md](docs/production-operations-handbook.md), [docs/rollback-runbook.md](docs/rollback-runbook.md), [docs/disaster-recovery.md](docs/disaster-recovery.md) |

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
pnpm db:seed            # plans + shopping sources (all disabled) + category tree
pnpm --filter @dealmind/catalog build && pnpm --filter @dealmind/catalog seed:sample
                        # optional, dev only: labeled SAMPLE catalog (fake prices, example.com)
pnpm dev                # API on :4000, web on :3000 (this machine: PORT=3100, see below)
```

The API and DB scripts load the repo-root `.env` automatically. `APP_URL` must
match where the web app runs **and** the `dealmind` application registered in
the IAM (here `http://localhost:3100`, since port 3000 is taken locally):
`PORT=3100 pnpm --filter @dealmind/web dev`. Optional
dev-only admin UIs (pgAdmin, RedisInsight): `pnpm infra:tools`.

**Local backend in Docker** (what this machine uses): the production images run in
development mode with their own PostgreSQL and Redis, the API on `127.0.0.1:4000`, and the
Next.js dev server on the host:

```bash
docker build -f infrastructure/docker/production/node.Dockerfile --target migrate -t local/dealmind-migrate:local .
docker build -f infrastructure/docker/production/node.Dockerfile --target api     -t local/dealmind-api:local .
docker build -f infrastructure/docker/production/node.Dockerfile --target worker  -t local/dealmind-worker:local .
docker build -f infrastructure/docker/production/agent.Dockerfile                 -t local/dealmind-agent:local .
docker compose -f infrastructure/docker/local/docker-compose.yml --project-directory . -p dealmind-local up -d
cd apps/web && API_INTERNAL_URL=http://127.0.0.1:4000 npx next dev -p 3100 -H localhost
```

Don't run `next build` or the Playwright tests while that dev server is running: they share
`apps/web/.next` and the dev UI loses its CSS (restart it with a clean `.next`).

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

On first start, while no administrator exists, the API prints a **one-time setup token** in
its log (or set your own with `ADMIN_SETUP_TOKEN`):

```bash
docker compose -f infrastructure/docker/local/docker-compose.yml --project-directory . -p dealmind-local logs api | grep "First-run setup"
```

Open `/setup` (the sign-in page links to it while setup is pending), enter the token and the
administrator's name, e-mail and password, then **sign in once**: that first sign-in makes the
account ADMIN. `/setup` then closes for good. Further admins: an existing admin calls
`PATCH /api/v1/admin/users/:userId/role` (there is no button for it in the admin UI yet).
Details: [docs/ADMIN.md](docs/ADMIN.md).
