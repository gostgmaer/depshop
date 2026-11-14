# Build context: repository root.  docker build -f apps/api/Dockerfile .
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@dealmind/api...
# TODO(phase-10): slim the runtime image (prod-only deps via `pnpm deploy`,
# with Prisma client generated into the deploy output). The `build` stage is
# also the target for the `migrate` service, which needs the Prisma CLI.

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /repo /repo
USER node
WORKDIR /repo/apps/api
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
