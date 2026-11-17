# Build context: repository root.  docker build -f apps/worker/Dockerfile .
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@dealmind/worker...

FROM base AS runtime
ENV NODE_ENV=production
# Phase 7.1: apply Debian security updates; drop the package managers the
# runtime never uses (the bundled npm CLI carries its own vulnerable deps).
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
     /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/pnpm /usr/local/bin/pnpx
COPY --from=build /repo /repo
USER node
WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js"]
