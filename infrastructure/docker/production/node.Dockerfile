# syntax=docker/dockerfile:1.7
# DealMind AI — production images for the Node services (api, worker, migrate).
# Build context: repository root.
#   docker build -f infrastructure/docker/production/node.Dockerfile --target api     -t dealmind-api .
#   docker build -f infrastructure/docker/production/node.Dockerfile --target worker  -t dealmind-worker .
#   docker build -f infrastructure/docker/production/node.Dockerfile --target migrate -t dealmind-migrate .
#
# - Base image pinned by version AND digest (rebuilds are reproducible).
# - api/worker runtime images contain only production dependencies
#   (`pnpm deploy --prod`), the compiled code, and a generated Prisma client.
# - No package managers, compilers or dev tools at runtime; non-root user; tini as PID 1.
# - No secrets are baked in: configuration is injected at run time.

ARG NODE_IMAGE=node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

# ── build: full workspace, compile once ────────────────────────────────────
FROM ${NODE_IMAGE} AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate
WORKDIR /repo
ENV CI=1 NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@dealmind/api... --filter=@dealmind/worker...

# Deployable trees. api/worker: production dependencies only. The Prisma client
# is generated INTO each tree with the build-stage CLI (the CLI is a dev tool and
# is not shipped there). migrate: the one image that needs the Prisma CLI.
RUN pnpm --filter @dealmind/api deploy --prod --legacy /deploy/api \
  && pnpm --filter @dealmind/worker deploy --prod --legacy /deploy/worker \
  && pnpm --filter @dealmind/db deploy --legacy /deploy/migrate
# Generate the Prisma client once (same locked @prisma/client version everywhere),
# then place the generated `.prisma` directory next to the @prisma/client that
# each deployed tree resolves (found with Node's own module resolution).
RUN pnpm --filter @dealmind/db generate >/dev/null \
  && for d in api worker migrate; do \
       from="$( [ "$d" = migrate ] && echo /deploy/migrate || echo "/deploy/$d/node_modules/@dealmind/db" )"; \
       src="$(node -p "require('path').dirname(require('fs').realpathSync(require.resolve('@prisma/client/package.json',{paths:['/repo/packages/db']})))")/../../.prisma"; \
       dst="$(node -p "const fs=require('fs');require('path').dirname(fs.realpathSync(require.resolve('@prisma/client/package.json',{paths:[fs.realpathSync('$from')]})))")/../../.prisma"; \
       rm -rf "$dst" && cp -a "$src" "$dst" && test -f "$dst/client/index.js" || exit 1; \
     done

# ── shared hardened runtime base ───────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime-base
ENV NODE_ENV=production
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx
WORKDIR /app
# tini: PID 1 that forwards SIGTERM so graceful shutdown runs.
ENTRYPOINT ["/usr/bin/tini", "--"]

# ── api ────────────────────────────────────────────────────────────────────
FROM runtime-base AS api
COPY --from=build --chown=node:node /deploy/api /app
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]

# ── worker ─────────────────────────────────────────────────────────────────
FROM runtime-base AS worker
COPY --from=build --chown=node:node /deploy/worker /app
USER node
# Healthy while the heartbeat file (written every 15 s after a Redis PING) is fresh.
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD node -e "const s=require('fs').statSync(process.env.WORKER_HEARTBEAT_FILE||'/tmp/dealmind-worker.heartbeat');process.exit(Date.now()-s.mtimeMs<60000?0:1)"
CMD ["node", "dist/main.js"]

# ── migrate: Prisma CLI + migrations + reference-data seed (release job) ──
FROM runtime-base AS migrate
COPY --from=build --chown=node:node /deploy/migrate /app
USER node
# `migrate deploy` applies committed migrations only (never `db push`).
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy --schema prisma/schema.prisma && node dist/seed.js"]
