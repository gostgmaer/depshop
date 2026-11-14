# DealMind AI

India-first shopping intelligence: search multiple stores in natural language,
compare identical products, find genuine discounts, and track prices.

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Roadmap & status (including known gaps): [docs/PHASES.md](docs/PHASES.md)
- API docs: run the API and open `http://localhost:4000/docs`

## Requirements

Node.js ≥ 22, pnpm 10 (`corepack enable`), Docker (for Postgres/Redis).

## Getting started

```bash
cp .env.example .env              # then set JWT_ACCESS_SECRET and POSTGRES_PASSWORD
pnpm install
docker compose up -d postgres redis
pnpm db:generate
pnpm --filter @dealmind/db build
pnpm db:migrate                   # applies prisma/migrations
pnpm db:seed                      # plans + shopping sources (all disabled)
pnpm dev                          # API on :4000, web on :3000
```

The API and Prisma read `DATABASE_URL` from the environment. When running
outside Docker, export the variables from `.env` (e.g. with `dotenv-cli` or
your shell) before running `pnpm db:migrate` / `pnpm dev`.

Full containerised stack behind Traefik (web at `http://localhost`, API at
`http://api.localhost`):

```bash
docker compose --profile app up -d --build
```

## Quality gates

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm check      # all of the above
```

## Making the first admin

There is no self-service admin signup. Register normally, then:

```sql
UPDATE "User" SET role = 'ADMIN' WHERE email = 'you@example.com';
```

Log in again to receive an access token carrying the new role.
