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
COPY --from=build /repo /repo
USER node
WORKDIR /repo/apps/worker
CMD ["node", "dist/main.js"]
