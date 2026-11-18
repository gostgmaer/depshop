import { createRequire } from "node:module";
import { createPrismaClient } from "@dealmind/db";
import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

/**
 * pino-pretty is a dev dependency: present with `pnpm dev`, absent from the
 * production image. Running that image with NODE_ENV=development (the local
 * Docker backend) then logs JSON instead of crashing at start-up.
 */
function prettyLogsAvailable(): boolean {
  try {
    createRequire(import.meta.url).resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

const env = loadEnv();
const prisma = createPrismaClient({ url: env.DATABASE_URL });

const app = await buildApp({
  env,
  prisma,
  healthChecks: {
    database: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
  },
  ...(env.NODE_ENV === "development" && prettyLogsAvailable()
    ? { logger: { level: env.LOG_LEVEL, transport: { target: "pino-pretty" } } }
    : {}),
});

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: env.HOST, port: env.PORT });
} catch (err) {
  app.log.fatal(err, "Failed to start server");
  await prisma.$disconnect();
  process.exit(1);
}
